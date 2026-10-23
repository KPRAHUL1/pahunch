import { describe, expect, it } from "vitest";

import { CHARGERS, PLACES, SEGMENTS } from "@/lib/data/network";
import {
  brierScore,
  expectedCalibrationError,
  fitCalibration,
  predictiveSigma,
  reliabilityBins,
  UNCALIBRATED,
} from "@/lib/energy/calibration";
import { planCharger, rankLevers, rankRisks, simulate, summarise } from "@/lib/energy/montecarlo";
import { vehicleById } from "@/lib/energy/vehicles";
import { TRIP_LOGS, TRUE_BIAS } from "@/lib/data/trips";
import { buildGraph, findRoutes } from "@/lib/graph/routing";
import type { Charger, TripRequest } from "@/lib/types";

const places = new Map(PLACES.map((p) => [p.id, p]));
const graph = buildGraph(PLACES, SEGMENTS);
const nexon = vehicleById("nexon-ev-45");
const cal = UNCALIBRATED("nexon-ev-45");

const chargersByPlace = new Map<string, Charger[]>();
for (const c of CHARGERS) {
  const list = chargersByPlace.get(c.placeId);
  if (list) list.push(c);
  else chargersByPlace.set(c.placeId, [c]);
}

const request = (over: Partial<TripRequest> = {}): TripRequest => ({
  vehicleId: "nexon-ev-45",
  originId: "del-cp",
  destinationId: "jaipur",
  startSocPct: 90,
  departureHour: 9,
  ambientC: 38,
  occupants: 2,
  payloadKg: 20,
  drivingStyle: 1,
  reservePct: 10,
  hvacOn: true,
  ...over,
});

const [jaipurRoute] = findRoutes(graph, "del-cp", "jaipur");
const [agraRoute] = findRoutes(graph, "del-cp", "agra");
/** 153 km. Short enough that a Nexon has a real margin to be uncertain about. */
const [behrorRoute] = findRoutes(graph, "del-cp", "behror");

const run = (over: Partial<TripRequest> = {}, samples = 1200, seed = 42) =>
  simulate(nexon, jaipurRoute.segments, places, request(over), cal, { samples, seed });

const runOn = (
  route: typeof jaipurRoute,
  over: Partial<TripRequest> = {},
  samples = 1200,
  seed = 42,
) => simulate(nexon, route.segments, places, request(over), cal, { samples, seed });

describe("simulate", () => {
  it("is reproducible for a given seed", () => {
    expect(run().successRate).toBe(run().successRate);
  });

  it("returns the requested number of samples", () => {
    expect(run({}, 500).samples).toHaveLength(500);
  });

  it("is monotonic in starting charge", () => {
    const low = run({ startSocPct: 55 }).successRate;
    const mid = run({ startSocPct: 75 }).successRate;
    const high = run({ startSocPct: 100 }).successRate;
    expect(mid).toBeGreaterThanOrEqual(low);
    expect(high).toBeGreaterThanOrEqual(mid);
  });

  it("is monotonic in reserve, which is the point of a reserve", () => {
    expect(run({ reservePct: 25 }).successRate).toBeLessThanOrEqual(
      run({ reservePct: 5 }).successRate,
    );
  });

  it("makes a hot day with the AC on harder than a mild one", () => {
    const mild = run({ ambientC: 24, hvacOn: false }).successRate;
    const scorching = run({ ambientC: 46, hvacOn: true }).successRate;
    expect(scorching).toBeLessThanOrEqual(mild);
  });

  it("makes a loaded car harder than an empty one", () => {
    expect(run({ occupants: 5, payloadKg: 80 }).successRate).toBeLessThanOrEqual(
      run({ occupants: 1, payloadKg: 0 }).successRate,
    );
  });

  it("tightens its own error bar as samples grow", () => {
    const few = run({}, 400);
    const many = run({}, 6400);
    if (few.successRate > 0.02 && few.successRate < 0.98) {
      expect(many.successStderr).toBeLessThan(few.successStderr);
    }
  });

  it("splits energy into parts that add up to the total", () => {
    const sim = run();
    const split = sim.energySplit;
    const summed = split.tractionKwh + split.hvacKwh + split.auxKwh + split.regenKwh;
    const meanConsumed =
      sim.samples.reduce((a, s) => a + s.consumedKwh, 0) / sim.samples.length;
    expect(summed).toBeCloseTo(meanConsumed, 4);
  });

  it("charges nothing to HVAC when the driver turns it off", () => {
    expect(run({ hvacOn: false }).energySplit.hvacKwh).toBeCloseTo(0, 6);
  });

  it("widens the arrival spread when the model is less certain", () => {
    const tight = simulate(nexon, jaipurRoute.segments, places, request(), {
      ...cal,
      residualSigma: 0.03,
      biasSigma: 0.01,
    }, { samples: 3000, seed: 7 });
    const loose = simulate(nexon, jaipurRoute.segments, places, request(), {
      ...cal,
      residualSigma: 0.25,
      biasSigma: 0.05,
    }, { samples: 3000, seed: 7 });
    const spread = (s: typeof tight) => {
      const st = summarise(s.samples).arrivalSoc;
      return st.p90 - st.p10;
    };
    expect(spread(loose)).toBeGreaterThan(spread(tight));
  });

  it("pins a source when asked, which is what the risk ranking relies on", () => {
    const free = run({}, 3000);
    const pinned = simulate(nexon, jaipurRoute.segments, places, request(), cal, {
      samples: 3000,
      seed: 42,
      pin: "traffic",
    });
    expect(pinned.successRate).not.toBe(free.successRate);
  });
});

describe("summarise", () => {
  it("orders its percentiles", () => {
    const s = summarise(run().samples);
    expect(s.arrivalSoc.p10).toBeLessThanOrEqual(s.arrivalSoc.p50);
    expect(s.arrivalSoc.p50).toBeLessThanOrEqual(s.arrivalSoc.p90);
    expect(s.consumptionWhPerKm.p10).toBeLessThanOrEqual(s.consumptionWhPerKm.p50);
    expect(s.durationMin.p10).toBeLessThanOrEqual(s.durationMin.p90);
  });

  it("reports a plausible consumption figure for a hot Delhi-Jaipur run", () => {
    const s = summarise(run().samples);
    expect(s.consumptionWhPerKm.p50).toBeGreaterThan(120);
    expect(s.consumptionWhPerKm.p50).toBeLessThan(300);
  });
});

/**
 * Finds a starting SoC that puts this trip in the genuinely uncertain band.
 *
 * Needed because sensitivity analysis is meaningless at a saturated
 * probability: if the trip is impossible, nothing you pin changes that, and
 * `rankRisks` correctly returns nothing. Hardcoding a SoC and hoping it lands
 * in the interesting range is how a test ends up asserting on an empty list.
 */
function marginalSoc(route: typeof jaipurRoute, over: Partial<TripRequest> = {}): number {
  let lo = 20;
  let hi = 100;
  // Same seed and sample count as the assertions that follow, so the SoC this
  // lands on really is the marginal one for the run being graded.
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const p = runOn(route, { ...over, startSocPct: mid }, 1500, 42).successRate;
    if (p < 0.5) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe("the uncertain band exists at all", () => {
  it("finds a starting charge where the trip is a genuine coin flip", () => {
    const soc = marginalSoc(behrorRoute);
    const p = runOn(behrorRoute, { startSocPct: soc }, 4000).successRate;
    expect(p).toBeGreaterThan(0.2);
    expect(p).toBeLessThan(0.8);
  });

  it("agrees that a Nexon EV 45 cannot do Delhi-Jaipur on one charge in the heat", () => {
    // 270 km needs about 155 Wh/km from a full pack. With the AC running at
    // 38 C this model says the trip costs more than that, so even at 100% the
    // answer is no. That is the real-world complaint this project exists for,
    // and if a refactor ever makes this trip comfortable, the model broke.
    expect(run({ startSocPct: 100, ambientC: 38, hvacOn: true }, 2000).successRate).toBeLessThan(
      0.5,
    );
  });
});

describe("rankRisks", () => {
  it("ranks by absolute effect and explains each one", () => {
    const soc = marginalSoc(behrorRoute);
    const baseline = runOn(behrorRoute, { startSocPct: soc }, 2000).successRate;
    const risks = rankRisks(
      nexon,
      behrorRoute.segments,
      places,
      request({ startSocPct: soc }),
      cal,
      baseline,
      42,
      800,
    );
    expect(risks.length).toBeGreaterThan(0);
    for (const r of risks) expect(r.detail.length).toBeGreaterThan(10);
    for (let i = 1; i < risks.length; i++) {
      expect(Math.abs(risks[i].deltaProbability)).toBeLessThanOrEqual(
        Math.abs(risks[i - 1].deltaProbability),
      );
    }
  });
});

describe("rankLevers", () => {
  it("only offers levers that actually help, best first", () => {
    const soc = marginalSoc(behrorRoute);
    const baseline = runOn(behrorRoute, { startSocPct: soc }, 2000).successRate;
    const levers = rankLevers(
      nexon,
      behrorRoute.segments,
      places,
      request({ startSocPct: soc }),
      cal,
      baseline,
      42,
      800,
    );
    expect(levers.length).toBeGreaterThan(0);
    for (const l of levers) expect(l.deltaProbability).toBeGreaterThan(0);
    for (let i = 1; i < levers.length; i++) {
      expect(levers[i].deltaProbability).toBeLessThanOrEqual(levers[i - 1].deltaProbability);
    }
  });

  it("does not suggest turning off an AC that is already off", () => {
    const req = request({
      hvacOn: false,
      startSocPct: marginalSoc(behrorRoute, { hvacOn: false }),
    });
    const baseline = simulate(nexon, behrorRoute.segments, places, req, cal, {
      samples: 2000,
      seed: 42,
    }).successRate;
    const levers = rankLevers(nexon, behrorRoute.segments, places, req, cal, baseline, 42, 600);
    expect(levers.find((l) => l.key === "hvac-off")).toBeUndefined();
  });
});

describe("planCharger", () => {
  it("finds a stop for a trip that cannot be done on one charge", () => {
    const req = request({ startSocPct: 45, destinationId: "jaipur" });
    const plan = planCharger(nexon, jaipurRoute, places, chargersByPlace, req, cal, 42, 600);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect(plan.probabilityWithStop).toBeGreaterThan(0);
    expect(plan.targetSocPct).toBeGreaterThan(plan.arrivalSocPct);
    expect(plan.minutesToTargetSoc).toBeGreaterThan(0);
    expect(plan.distanceIntoTripKm).toBeLessThan(jaipurRoute.distanceKm);
  });

  it("never parks the rescue stop at the destination", () => {
    const req = request({ startSocPct: 40, destinationId: "agra" });
    const plan = planCharger(nexon, agraRoute, places, chargersByPlace, req, cal, 42, 600);
    if (plan) {
      expect(plan.placeName).not.toBe("Taj East Gate");
    }
  });

  it("accounts for site reliability, so the score is never above the uptime", () => {
    const req = request({ startSocPct: 45 });
    const plan = planCharger(nexon, jaipurRoute, places, chargersByPlace, req, cal, 42, 600);
    if (plan) {
      expect(plan.probabilityWithStop).toBeLessThanOrEqual(plan.siteReliability + 1e-9);
    }
  });
});

describe("scoring helpers", () => {
  it("scores a perfect forecaster at zero and a backwards one at one", () => {
    expect(brierScore([1, 0, 1], [true, false, true])).toBeCloseTo(0, 9);
    expect(brierScore([0, 1, 0], [true, false, true])).toBeCloseTo(1, 9);
  });

  it("scores a coin flip at 0.25", () => {
    expect(brierScore([0.5, 0.5], [true, false])).toBeCloseTo(0.25, 9);
  });

  it("returns NaN rather than a wrong number on mismatched input", () => {
    expect(brierScore([0.5], [true, false])).toBeNaN();
    expect(brierScore([], [])).toBeNaN();
  });

  it("bins predictions and measures the calibration gap", () => {
    const preds = [0.05, 0.15, 0.95, 0.85];
    const bins = reliabilityBins(preds, [false, false, true, true], 10);
    expect(bins).toHaveLength(10);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(4);
    expect(expectedCalibrationError(bins)).toBeLessThan(0.2);
  });

  it("puts a prediction of exactly 1.0 in the top bin, not off the end", () => {
    const bins = reliabilityBins([1], [true], 10);
    expect(bins[9].count).toBe(1);
  });
});

describe("fitCalibration", () => {
  it("recovers each hidden per-vehicle offset to within three points", () => {
    const fitted = fitCalibration(TRIP_LOGS);
    for (const [vehicleId, trueBias] of Object.entries(TRUE_BIAS)) {
      const c = fitted.get(vehicleId);
      expect(c, vehicleId).toBeDefined();
      if (!c) continue;
      expect(Math.abs(c.bias - trueBias), `${vehicleId}: ${c.bias} vs ${trueBias}`).toBeLessThan(
        0.03,
      );
    }
  });

  it("shrinks toward no correction when it has almost no evidence", () => {
    const one = TRIP_LOGS.filter((t) => t.vehicleId === "nexon-ev-45").slice(0, 1);
    const fitted = fitCalibration(one).get("nexon-ev-45");
    expect(fitted).toBeDefined();
    if (!fitted) return;
    const full = fitCalibration(TRIP_LOGS).get("nexon-ev-45");
    expect(Math.abs(fitted.bias - 1)).toBeLessThan(Math.abs((full?.bias ?? 1) - 1));
  });

  it("keeps model error above the floor and below the raw residual", () => {
    for (const c of fitCalibration(TRIP_LOGS).values()) {
      expect(c.residualSigma).toBeGreaterThanOrEqual(0.04);
      // The point of the variance decomposition: model error is a fraction of
      // the total spread, not all of it.
      expect(c.residualSigma).toBeLessThan(0.3);
      expect(predictiveSigma(c)).toBeGreaterThanOrEqual(c.residualSigma);
    }
  });

  it("gets more certain about the bias as trips accumulate", () => {
    const logs = TRIP_LOGS.filter((t) => t.vehicleId === "nexon-ev-45");
    const few = fitCalibration(logs.slice(0, 5)).get("nexon-ev-45");
    const many = fitCalibration(logs).get("nexon-ev-45");
    expect(few && many).toBeTruthy();
    if (few && many) expect(many.biasSigma).toBeLessThan(few.biasSigma);
  });
});
