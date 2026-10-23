import { describe, expect, it } from "vitest";

import { PLACES, SEGMENTS, placeById } from "@/lib/data/network";
import {
  airDensity,
  chargeMinutes,
  hvacPowerW,
  packDerate,
  routeEnergy,
  segmentEnergy,
  usableEnergyKwh,
  type Conditions,
} from "@/lib/energy/physics";
import { vehicleById } from "@/lib/energy/vehicles";

const nexon = vehicleById("nexon-ev-45");
const ather = vehicleById("ather-450x");
const places = new Map(PLACES.map((p) => [p.id, p]));
const segmentsById = new Map(SEGMENTS.map((s) => [s.id, s]));

const baseline = (over: Partial<Conditions> = {}): Conditions => ({
  ambientC: 28,
  addedMassKg: 68,
  trafficMultiplier: 1,
  speedFactor: 1,
  headwindMps: 0,
  crrFactor: 1,
  hvacOn: false,
  hvacDuty: 0,
  daylight: true,
  ...over,
});

const seg = (id: string) => {
  const s = segmentsById.get(id);
  if (!s) throw new Error(`test fixture missing segment ${id}`);
  return s;
};

const run = (segmentId: string, conditions: Conditions, hour = 11) => {
  const s = seg(segmentId);
  return segmentEnergy(nexon, s, placeById(s.from), placeById(s.to), hour, conditions);
};

describe("airDensity", () => {
  it("falls with altitude", () => {
    expect(airDensity(2205, 15)).toBeLessThan(airDensity(216, 15));
  });

  it("falls with temperature", () => {
    expect(airDensity(216, 45)).toBeLessThan(airDensity(216, 15));
  });

  it("matches the ISA value at sea level", () => {
    expect(airDensity(0, 15)).toBeCloseTo(1.225, 2);
  });
});

describe("packDerate", () => {
  it("is unity in the comfortable band", () => {
    expect(packDerate(25)).toBeCloseTo(1, 5);
    expect(packDerate(35)).toBeCloseTo(1, 5);
  });

  it("costs real capacity in the cold", () => {
    expect(packDerate(0)).toBeLessThan(0.9);
    expect(packDerate(5)).toBeGreaterThan(packDerate(0));
  });

  it("derates slightly in extreme heat", () => {
    expect(packDerate(48)).toBeLessThan(1);
    expect(packDerate(48)).toBeGreaterThan(0.9);
  });
});

describe("hvacPowerW", () => {
  it("is zero for a scooter, which has no cabin", () => {
    expect(hvacPowerW(ather, baseline({ hvacOn: true, hvacDuty: 1, ambientC: 45 }))).toBe(0);
  });

  it("is zero when the driver has it off", () => {
    expect(hvacPowerW(nexon, baseline({ hvacOn: false, ambientC: 45 }))).toBe(0);
  });

  it("rises with the temperature lift it has to sustain", () => {
    const warm = hvacPowerW(nexon, baseline({ hvacOn: true, hvacDuty: 1, ambientC: 32 }));
    const hot = hvacPowerW(nexon, baseline({ hvacOn: true, hvacDuty: 1, ambientC: 45 }));
    expect(hot).toBeGreaterThan(warm);
    expect(hot).toBeLessThanOrEqual(nexon.hvacPeakW);
  });

  it("draws power for heating too, not just cooling", () => {
    expect(hvacPowerW(nexon, baseline({ hvacOn: true, hvacDuty: 1, ambientC: 5 }))).toBeGreaterThan(
      1000,
    );
  });
});

describe("segmentEnergy", () => {
  it("costs more uphill than down over the same road", () => {
    const up = run("kandaghat__shimla", baseline());
    const down = run("shimla__kandaghat", baseline());
    expect(up.packKwh).toBeGreaterThan(down.packKwh);
    expect(up.gradePct).toBeGreaterThan(0);
    expect(down.gradePct).toBeLessThan(0);
  });

  it("returns energy to the pack on a long descent", () => {
    // Shimla to Kandaghat drops 772 m in 28 km. Net regen, not net draw.
    expect(run("shimla__kandaghat", baseline()).packKwh).toBeLessThan(0);
  });

  it("charges for air conditioning", () => {
    const off = run("jewar__mathura", baseline({ ambientC: 44 }));
    const on = run("jewar__mathura", baseline({ ambientC: 44, hvacOn: true, hvacDuty: 0.9 }));
    expect(on.packKwh).toBeGreaterThan(off.packKwh);
    expect(on.auxKwh).toBeGreaterThan(off.auxKwh);
  });

  it("punishes a headwind", () => {
    const calm = run("jewar__mathura", baseline());
    const windy = run("jewar__mathura", baseline({ headwindMps: 6 }));
    expect(windy.packKwh).toBeGreaterThan(calm.packKwh);
  });

  it("punishes extra mass", () => {
    const light = run("jewar__mathura", baseline({ addedMassKg: 68 }));
    const loaded = run("jewar__mathura", baseline({ addedMassKg: 68 * 5 }));
    expect(loaded.packKwh).toBeGreaterThan(light.packKwh);
  });

  it("slows down in traffic and takes longer", () => {
    const clear = run("del-cp__ggn-cyber", baseline(), 3);
    const peak = run("del-cp__ggn-cyber", baseline(), 18);
    expect(peak.meanSpeedKmph).toBeLessThan(clear.meanSpeedKmph);
    expect(peak.durationMin).toBeGreaterThan(clear.durationMin);
  });

  it("makes urban stop-go cost more per km than an expressway", () => {
    const urban = run("del-cp__ggn-cyber", baseline({ hvacOn: true, hvacDuty: 0.9, ambientC: 42 }), 18);
    const express = run("jewar__mathura", baseline({ hvacOn: true, hvacDuty: 0.9, ambientC: 42 }));
    const urbanWhPerKm = (urban.packKwh * 1000) / urban.distanceKm;
    const expressWhPerKm = (express.packKwh * 1000) / express.distanceKm;
    expect(urbanWhPerKm).toBeGreaterThan(expressWhPerKm);
  });

  it("never reports a negative duration or distance", () => {
    for (const s of SEGMENTS) {
      const e = segmentEnergy(nexon, s, placeById(s.from), placeById(s.to), 9, baseline());
      expect(e.durationMin).toBeGreaterThan(0);
      expect(e.distanceKm).toBeGreaterThan(0);
      expect(Number.isFinite(e.packKwh)).toBe(true);
    }
  });
});

describe("routeEnergy", () => {
  const route = ["del-cp__noida-18", "noida-18__jewar", "jewar__mathura", "mathura__agra"].map(seg);

  it("sums the leg distances", () => {
    const e = routeEnergy(nexon, route, places, 10, baseline());
    expect(e.distanceKm).toBeCloseTo(
      route.reduce((a, s) => a + s.distanceKm, 0),
      5,
    );
  });

  it("advances the clock, so a departure into the evening peak costs more", () => {
    const morning = routeEnergy(nexon, route, places, 11, baseline());
    const evening = routeEnergy(nexon, route, places, 17, baseline());
    expect(evening.durationMin).toBeGreaterThan(morning.durationMin);
  });

  it("attributes HVAC energy only when HVAC is on", () => {
    const off = routeEnergy(nexon, route, places, 10, baseline({ ambientC: 44 }));
    const on = routeEnergy(
      nexon,
      route,
      places,
      10,
      baseline({ ambientC: 44, hvacOn: true, hvacDuty: 0.9 }),
    );
    expect(off.hvacKwh).toBeCloseTo(0, 6);
    expect(on.hvacKwh).toBeGreaterThan(0);
    expect(on.hvacKwh).toBeLessThanOrEqual(on.auxKwh + 1e-9);
  });

  it("produces a Delhi-Agra figure in the plausible band for a Nexon", () => {
    // Sanity anchor, not a regression lock: a 214 km expressway run with the AC
    // on in 40 C weather should land somewhere in 140-230 Wh/km. Outside that
    // band the physics is wrong, not merely differently tuned.
    const e = routeEnergy(
      nexon,
      route,
      places,
      10,
      baseline({ ambientC: 40, hvacOn: true, hvacDuty: 0.8 }),
    );
    expect(e.whPerKm).toBeGreaterThan(140);
    expect(e.whPerKm).toBeLessThan(230);
  });
});

describe("usableEnergyKwh", () => {
  it("is bounded by the nameplate pack", () => {
    expect(usableEnergyKwh(nexon, 100, 25)).toBeLessThan(nexon.capacityKwh);
  });

  it("scales with state of charge", () => {
    expect(usableEnergyKwh(nexon, 50, 25)).toBeCloseTo(usableEnergyKwh(nexon, 100, 25) / 2, 6);
  });

  it("gives less usable energy on a cold morning", () => {
    expect(usableEnergyKwh(nexon, 100, 2)).toBeLessThan(usableEnergyKwh(nexon, 100, 25));
  });
});

describe("chargeMinutes", () => {
  it("is zero when there is nothing to add", () => {
    expect(chargeMinutes(nexon, 60, 60, 60, 30)).toBe(0);
    expect(chargeMinutes(nexon, 80, 60, 60, 30)).toBe(0);
  });

  it("tapers, so the top of the pack is slower per percent", () => {
    const low = chargeMinutes(nexon, 20, 50, 150, 30);
    const high = chargeMinutes(nexon, 50, 80, 150, 30);
    expect(high).toBeGreaterThan(low);
  });

  it("does not let a small pack swallow a big gun", () => {
    // A 17.3 kWh Comet on a 150 kW gun is limited by its own C-rate.
    const comet = vehicleById("comet-ev");
    const on150 = chargeMinutes(comet, 20, 80, 150, 30);
    const on60 = chargeMinutes(comet, 20, 80, 60, 30);
    expect(on150).toBeCloseTo(on60, 1);
  });

  it("is slower on a cold pack", () => {
    expect(chargeMinutes(nexon, 20, 80, 60, 2)).toBeGreaterThan(
      chargeMinutes(nexon, 20, 80, 60, 30),
    );
  });
});
