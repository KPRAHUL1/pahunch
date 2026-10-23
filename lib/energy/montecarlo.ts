import { predictiveSigma, type Calibration } from "@/lib/energy/calibration";
import { hvacDefault, sampleConditions, type Pinned } from "@/lib/energy/conditions";
import { chargeMinutes, routeEnergy, usableEnergyKwh } from "@/lib/energy/physics";
import { makeRng, mean, percentile } from "@/lib/rng";
import type {
  Charger,
  ChargerPlan,
  Lever,
  Place,
  RiskFactor,
  Route,
  Segment,
  TripRequest,
  TripSample,
  Vehicle,
} from "@/lib/types";

/**
 * The uncertainty layer.
 *
 * The physics model answers "how much energy will this trip take, given exactly
 * these conditions". Nobody knows those conditions. Ambient temperature is a
 * forecast, traffic is a distribution, the driver's own right foot varies, and
 * the model itself is wrong by a measured amount. Pahunch samples all of it and
 * reports the resulting distribution over arrival SoC, which is the only honest
 * form the answer can take.
 *
 * Every draw below is justified in a comment. Made-up spreads produce
 * made-up confidence, so the spreads are the part that has to be defensible.
 */

export interface SimOptions {
  samples: number;
  seed: number;
  /** Pin this source to its expected value instead of sampling it. */
  pin?: Pinned;
  /** Overrides applied on top of the request, for lever evaluation. */
  override?: Partial<TripRequest>;
}

export interface SimResult {
  samples: TripSample[];
  successRate: number;
  /** Standard error on successRate, from the binomial. */
  successStderr: number;
  energySplit: { tractionKwh: number; hvacKwh: number; auxKwh: number; regenKwh: number };
  /** Median-case per-segment breakdown, for the UI waterfall. */
  medianSegments: ReturnType<typeof routeEnergy>["segments"];
}

export function simulate(
  vehicle: Vehicle,
  segments: Segment[],
  places: Map<string, Place>,
  request: TripRequest,
  calibration: Calibration,
  options: SimOptions,
): SimResult {
  const req = { ...request, ...options.override };
  const rng = makeRng(options.seed);
  const pin = options.pin ?? null;
  const sigma = predictiveSigma(calibration);

  const out: TripSample[] = [];
  let tractionAcc = 0;
  let hvacAcc = 0;
  let auxAcc = 0;
  let regenAcc = 0;
  let medianSegments: SimResult["medianSegments"] = [];
  let medianDistance = Infinity;

  for (let i = 0; i < options.samples; i++) {
    // Conditions come from the shared sampler, which is also what the
    // calibrator uses. That is not a tidiness choice: it is what lets the
    // calibrator subtract the variance represented here and leave behind only
    // genuine model error, instead of counting the same spread twice.
    const conditions = sampleConditions(req, vehicle, rng, pin);

    // Model error: measured, not guessed. This is the residual spread that
    // survives after the sampled conditions above are accounted for, plus the
    // uncertainty on the calibration constant itself.
    const modelError =
      pin === "model" ? calibration.bias : calibration.bias * rng.lognormal(1.0, sigma);

    const e = routeEnergy(vehicle, segments, places, req.departureHour, conditions);
    const consumedKwh = e.totalKwh * modelError;

    const fullUsableKwh = usableEnergyKwh(vehicle, 100, conditions.ambientC);
    const consumedPct = (consumedKwh / fullUsableKwh) * 100;
    const arrivalSocPct = req.startSocPct - consumedPct;

    out.push({
      arrivalSocPct,
      consumedKwh,
      durationMin: e.durationMin,
      meanWhPerKm: e.distanceKm > 0 ? (consumedKwh * 1000) / e.distanceKm : 0,
      neededCharge: arrivalSocPct < req.reservePct,
    });

    tractionAcc += e.tractionKwh * modelError;
    hvacAcc += e.hvacKwh * modelError;
    auxAcc += (e.auxKwh - e.hvacKwh) * modelError;
    regenAcc += e.regenKwh * modelError;

    // Keep the breakdown from the sample closest to the median total, so the
    // UI waterfall is a real simulated trip rather than an average of trips.
    const dist = Math.abs(consumedPct - (req.startSocPct - req.reservePct));
    if (dist < medianDistance) {
      medianDistance = dist;
      medianSegments = e.segments;
    }
  }

  const successes = out.filter((s) => s.arrivalSocPct >= req.reservePct).length;
  const p = successes / out.length;

  return {
    samples: out,
    successRate: p,
    successStderr: Math.sqrt((p * (1 - p)) / out.length),
    energySplit: {
      tractionKwh: tractionAcc / out.length,
      hvacKwh: hvacAcc / out.length,
      auxKwh: auxAcc / out.length,
      regenKwh: regenAcc / out.length,
    },
    medianSegments,
  };
}

/**
 * Ranks uncertainty sources by how much of the doubt each one owns: rerun with
 * that source pinned to its expected value and see how far P(make it) moves
 * toward certainty. This is a one-at-a-time sensitivity, so the deltas do not
 * sum to the total -- they are not meant to. They answer "what would I have to
 * know to stop guessing", and that is a different question from "what is the
 * variance decomposition", which would need a Sobol design and far more samples.
 */
export function rankRisks(
  vehicle: Vehicle,
  segments: Segment[],
  places: Map<string, Place>,
  request: TripRequest,
  calibration: Calibration,
  baseline: number,
  seed: number,
  samples: number,
): RiskFactor[] {
  const sources: { pin: Exclude<Pinned, null>; label: string; detail: string }[] = [
    {
      pin: "model",
      label: "Model error",
      detail: `Residual spread after calibrating on ${calibration.tripsObserved} logged trips: ±${(predictiveSigma(calibration) * 100).toFixed(1)}% on energy.`,
    },
    {
      pin: "traffic",
      label: "Traffic",
      detail: "Travel-time spread for this departure hour on these segments.",
    },
    {
      pin: "driver",
      label: "Your right foot",
      detail: "Trip-to-trip variation in how hard the same driver pushes.",
    },
    {
      pin: "ambient",
      label: "Temperature forecast",
      detail: "±2.5 °C forecast error, which moves both HVAC load and pack output.",
    },
    {
      pin: "hvac",
      label: "AC duty cycle",
      detail: "How much of the drive the compressor actually runs.",
    },
    {
      pin: "wind",
      label: "Headwind",
      detail: "No directional forecast is used, so this is pure unmodelled drag.",
    },
    {
      pin: "rolling",
      label: "Tyre pressure & surface",
      detail: "Under-inflation and road wear, which drivers almost never check.",
    },
  ];

  const risks: RiskFactor[] = sources.map((s, i) => {
    const pinned = simulate(vehicle, segments, places, request, calibration, {
      samples,
      // A different seed per source would add noise to the comparison, so the
      // seed is shared: every ablation sees the same draws for everything else.
      seed: seed + 1,
      pin: s.pin,
    });
    return {
      key: s.pin,
      label: s.label,
      deltaProbability: pinned.successRate - baseline,
      detail: s.detail,
    };
  });

  return risks
    .filter((r) => Math.abs(r.deltaProbability) > 0.004)
    .sort((a, b) => Math.abs(b.deltaProbability) - Math.abs(a.deltaProbability));
}

/**
 * What the driver can actually do. Each lever is a real re-simulation under a
 * changed request, not a heuristic nudge, so the numbers are consistent with
 * the headline probability by construction.
 */
export function rankLevers(
  vehicle: Vehicle,
  segments: Segment[],
  places: Map<string, Place>,
  request: TripRequest,
  calibration: Calibration,
  baseline: number,
  seed: number,
  samples: number,
): Lever[] {
  const run = (override: Partial<TripRequest>): number =>
    simulate(vehicle, segments, places, request, calibration, {
      samples,
      seed: seed + 2,
      override,
    }).successRate;

  const levers: Lever[] = [];

  if (hvacDefault(request, vehicle)) {
    levers.push({
      key: "hvac-off",
      label: "Drive without AC",
      deltaProbability: run({ hvacOn: false }) - baseline,
      cost:
        request.ambientC > 35
          ? `Unpleasant at ${Math.round(request.ambientC)} °C`
          : "Manageable in this weather",
    });
  }

  if (request.drivingStyle > 0.6) {
    const gentler = Math.max(0.3, request.drivingStyle - 0.5);
    levers.push({
      key: "slower",
      label: "Ease off by about 10 km/h",
      deltaProbability: run({ drivingStyle: gentler }) - baseline,
      cost: "Adds time, and the aero term rewards it more than you expect",
    });
  }

  // Scan every departure hour and offer the best one. Shifting a Delhi trip out
  // of the 18:00 peak is often worth more than any other single change.
  let bestHour = request.departureHour;
  let bestHourP = baseline;
  for (let h = 0; h < 24; h++) {
    if (h === request.departureHour) continue;
    const p = run({ departureHour: h });
    if (p > bestHourP + 0.015) {
      bestHourP = p;
      bestHour = h;
    }
  }
  if (bestHour !== request.departureHour) {
    levers.push({
      key: "departure",
      label: `Leave at ${String(bestHour).padStart(2, "0")}:00 instead`,
      deltaProbability: bestHourP - baseline,
      cost: `${Math.abs(bestHour - request.departureHour)} h shift in your plans`,
    });
  }

  if (request.startSocPct < 99) {
    levers.push({
      key: "full-charge",
      label: "Leave at 100% instead",
      deltaProbability: run({ startSocPct: 100 }) - baseline,
      cost: "Top-up time before you go, and a little pack wear",
    });
  }

  if (request.occupants > 1 || request.payloadKg > 15) {
    levers.push({
      key: "lighter",
      label: "Travel lighter",
      deltaProbability:
        run({ occupants: 1, payloadKg: Math.min(request.payloadKg, 10) }) - baseline,
      cost: "Usually not actually a choice",
    });
  }

  if (request.reservePct > 8) {
    levers.push({
      key: "reserve",
      label: `Accept arriving on ${Math.max(5, request.reservePct - 5)}% instead`,
      deltaProbability:
        run({ reservePct: Math.max(5, request.reservePct - 5) }) - baseline,
      cost: "Less margin if the destination charger is down",
    });
  }

  return levers
    .filter((l) => l.deltaProbability > 0.005)
    .sort((a, b) => b.deltaProbability - a.deltaProbability);
}

/**
 * Finds the charging stop that best rescues a marginal trip.
 *
 * The key move is treating a charger as a probabilistic object. A site with
 * 0.52 reliability is not a plan, it is a coin flip, and planners that route
 * you through one because it is closest are the reason people run out. So the
 * score multiplies three things: the chance of physically reaching the site,
 * the chance it works when you get there, and the chance you finish from the
 * SoC it can give you in a reasonable dwell.
 */
export function planCharger(
  vehicle: Vehicle,
  route: Route,
  places: Map<string, Place>,
  chargersByPlace: Map<string, Charger[]>,
  request: TripRequest,
  calibration: Calibration,
  seed: number,
  samples: number,
): ChargerPlan | null {
  const candidates: ChargerPlan[] = [];
  let cumulativeKm = 0;

  for (let i = 0; i < route.segments.length; i++) {
    cumulativeKm += route.segments[i].distanceKm;
    const placeId = route.segments[i].to;
    // A charger at the destination does not rescue the trip to the destination.
    if (i === route.segments.length - 1) break;

    for (const charger of chargersByPlace.get(placeId) ?? []) {
      if (!charger.connectors.some((c) => c === "CCS2" || c === "Type2")) continue;

      const leg1 = route.segments.slice(0, i + 1);
      const leg2 = route.segments.slice(i + 1);

      // Can we even get there, with 5% left as the physical floor?
      const toCharger = simulate(vehicle, leg1, places, request, calibration, {
        samples,
        seed: seed + 11,
        override: { reservePct: 5 },
      });
      const reachP = toCharger.successRate;
      if (reachP < 0.5) continue;

      const arrivalSoc = percentile(
        toCharger.samples.map((s) => s.arrivalSocPct),
        0.5,
      );

      // Size the charge off the p90 of the remaining leg, not its median: the
      // point of stopping is to buy margin, so buy it against the bad case.
      const probe = simulate(vehicle, leg2, places, request, calibration, {
        samples,
        seed: seed + 12,
        override: { startSocPct: 100, reservePct: 0 },
      });
      const leg2P90Pct =
        100 - percentile(probe.samples.map((s) => s.arrivalSocPct), 0.1);
      const targetSocPct = Math.min(
        95,
        Math.ceil(leg2P90Pct + request.reservePct + 3),
      );
      if (targetSocPct <= arrivalSoc) {
        // Already have enough at this point; stopping here buys nothing.
        continue;
      }

      const fromLeg2 = simulate(vehicle, leg2, places, request, calibration, {
        samples,
        seed: seed + 13,
        override: { startSocPct: targetSocPct },
      });

      const minutes = chargeMinutes(
        vehicle,
        Math.max(0, arrivalSoc),
        targetSocPct,
        charger.powerKw,
        request.ambientC,
      );
      // More guns absorb queue variance, so wait falls faster than 1/bays would
      // suggest but slower than not at all.
      const expectedQueueMin = charger.meanQueueMin / Math.sqrt(charger.bays);

      candidates.push({
        chargerId: charger.id,
        chargerName: charger.name,
        operator: charger.operator,
        placeName: places.get(placeId)?.name ?? placeId,
        distanceIntoTripKm: Math.round(cumulativeKm),
        arrivalSocPct: Math.round(arrivalSoc),
        minutesToTargetSoc: Math.round(minutes),
        targetSocPct,
        siteReliability: charger.reliability,
        probabilityWithStop: reachP * charger.reliability * fromLeg2.successRate,
        expectedQueueMin: Math.round(expectedQueueMin),
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const byP = b.probabilityWithStop - a.probabilityWithStop;
    // Within a percentage point of each other, prefer the shorter stop.
    if (Math.abs(byP) > 0.01) return byP;
    return (
      a.minutesToTargetSoc + a.expectedQueueMin - (b.minutesToTargetSoc + b.expectedQueueMin)
    );
  });
  return candidates[0];
}

export function summarise(samples: TripSample[]) {
  const socs = samples.map((s) => s.arrivalSocPct);
  const whs = samples.map((s) => s.meanWhPerKm);
  const mins = samples.map((s) => s.durationMin);
  return {
    arrivalSoc: {
      p10: percentile(socs, 0.1),
      p50: percentile(socs, 0.5),
      p90: percentile(socs, 0.9),
    },
    consumptionWhPerKm: {
      p10: percentile(whs, 0.1),
      p50: percentile(whs, 0.5),
      p90: percentile(whs, 0.9),
    },
    durationMin: {
      p10: percentile(mins, 0.1),
      p50: percentile(mins, 0.5),
      p90: percentile(mins, 0.9),
    },
    meanArrivalSoc: mean(socs),
  };
}
