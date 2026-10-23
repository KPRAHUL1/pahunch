import type { Place, Segment, SegmentEnergy, Vehicle } from "@/lib/types";

const G = 9.80665;
/** Specific gas constant for dry air, J/(kg*K). */
const R_AIR = 287.05;
const SEA_LEVEL_PA = 101325;
const CABIN_TARGET_C = 24;
const J_PER_KWH = 3.6e6;

/**
 * Conditions for one deterministic evaluation of a route. The Monte Carlo layer
 * draws one of these per sample; on its own this module is pure and repeatable,
 * which is what makes the physics testable in isolation from the uncertainty.
 */
export interface Conditions {
  ambientC: number;
  /** Total mass added to kerb weight: occupants plus cargo, kg. */
  addedMassKg: number;
  /** Multiplier on free-flow speed, from the segment traffic curve. */
  trafficMultiplier: number;
  /** Driver speed preference against the posted limit. 1.0 = at the limit. */
  speedFactor: number;
  /** Headwind component along the direction of travel, m/s. Negative = tailwind. */
  headwindMps: number;
  /** Multiplier on rolling resistance: tyre pressure, load, road wear. */
  crrFactor: number;
  hvacOn: boolean;
  /** Fraction of the leg the compressor or heater is actually drawing. */
  hvacDuty: number;
  /** True if the sun is up, which adds cabin solar gain. */
  daylight: boolean;
}

/**
 * Air density from the barometric formula. This is not a rounding detail in
 * India: Delhi at 45 deg C runs about 12% below ISA density, and Shimla at
 * 2200 m is 23% below it, both of which cut the aero term noticeably. Working
 * in the opposite direction, thin air is also why the Shimla climb is still
 * brutal despite the lower drag -- the gradient term swamps everything.
 */
export function airDensity(altitudeM: number, tempC: number): number {
  const pressure = SEA_LEVEL_PA * Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588);
  return pressure / (R_AIR * (tempC + 273.15));
}

/**
 * Usable-energy derate from pack temperature, as a fraction of nameplate usable
 * energy. Lithium packs hand over materially less below 10 deg C, and a little
 * less above 40 deg C once the BMS starts protecting cells. Ambient stands in
 * for pack temperature here, which is wrong for the first twenty minutes of a
 * trip and close enough after that.
 */
export function packDerate(ambientC: number): number {
  if (ambientC <= -5) return 0.7;
  if (ambientC < 25) {
    // Linear from 0.70 at -5 C to 1.00 at 25 C.
    return 0.7 + (0.3 * (ambientC + 5)) / 30;
  }
  if (ambientC <= 40) return 1.0;
  // Mild protection derate in extreme heat.
  return Math.max(0.93, 1.0 - 0.0045 * (ambientC - 40));
}

/**
 * HVAC electrical draw, W. This is the term that makes Indian range figures
 * fiction. A 3.2 kW compressor held at 45 deg C ambient is, at an urban mean
 * speed of 18 km/h, about 178 Wh/km of pure accessory load -- comparable to the
 * entire traction demand of the same car on an expressway.
 */
export function hvacPowerW(vehicle: Vehicle, c: Conditions): number {
  if (!c.hvacOn || vehicle.hvacPeakW === 0) return 0;

  let load: number;
  if (c.ambientC > CABIN_TARGET_C) {
    // Cooling. Compressor load scales with the temperature lift it must sustain.
    load = (c.ambientC - CABIN_TARGET_C) / 18;
    if (c.daylight) load += 0.15; // Solar gain through glass.
  } else if (c.ambientC < 18) {
    // Heating. PTC resistive heaters have no COP advantage, so this is worse
    // per degree than cooling on most Indian EVs.
    load = ((18 - c.ambientC) / 20) * 1.1;
  } else {
    load = 0.12; // Blower and recirculation only.
  }

  return vehicle.hvacPeakW * Math.min(1, Math.max(0.1, load)) * c.hvacDuty;
}

/** Free-flow speed drivers actually hold, before traffic, km/h. */
function freeFlowKmph(segment: Segment, speedFactor: number): number {
  // Observed behaviour, not the law: expressway traffic sits near the limit,
  // open NH traffic drifts above it, ghat traffic is below it because of geometry.
  const classBias: Record<Segment["roadClass"], number> = {
    expressway: 0.98,
    national: 1.02,
    state: 0.95,
    urban: 0.9,
    ghat: 0.85,
  };
  return segment.speedLimitKmph * classBias[segment.roadClass] * speedFactor;
}

/**
 * Energy drawn from the pack over one segment. Returns a negative `packKwh` on
 * long descents, which is correct and is exactly what the Shimla-to-Chandigarh
 * direction looks like.
 */
export function segmentEnergy(
  vehicle: Vehicle,
  segment: Segment,
  from: Place,
  to: Place,
  hourOfDay: number,
  conditions: Conditions,
): SegmentEnergy {
  const distanceM = segment.distanceKm * 1000;
  const mass = vehicle.massKg + conditions.addedMassKg;

  const hourTraffic = segment.trafficByHour[((hourOfDay % 24) + 24) % 24];
  const traffic = Math.min(1, Math.max(0.15, hourTraffic * conditions.trafficMultiplier));
  const meanKmph = Math.max(8, freeFlowKmph(segment, conditions.speedFactor) * traffic);
  const v = meanKmph / 3.6;

  const rise = to.elevationM - from.elevationM;
  const grade = rise / distanceM;
  const theta = Math.atan(grade);

  const meanAltitude = (from.elevationM + to.elevationM) / 2;
  const rho = airDensity(meanAltitude, conditions.ambientC);

  // Air-relative speed for the drag term; a headwind raises it.
  const vAir = Math.max(0, v + conditions.headwindMps);

  const fRoll = vehicle.crr * segment.surfacePenalty * conditions.crrFactor * mass * G * Math.cos(theta);
  const fAero = 0.5 * rho * vehicle.cd * vehicle.frontalAreaM2 * vAir * vAir;
  const fGrade = mass * G * Math.sin(theta);

  const fTotal = fRoll + fAero + fGrade;
  const wheelJ = fTotal * distanceM;

  let tractionJ = 0;
  let regenJ = 0;
  if (wheelJ >= 0) {
    tractionJ = wheelJ / vehicle.drivetrainEff;
  } else {
    // Net downhill. Only part of the surplus comes back: regen is limited by
    // motor torque and by the pack's charge acceptance, so above roughly a
    // 5% descent the friction brakes take the remainder and it is lost.
    const capture = Math.min(1, 0.05 / Math.max(0.005, Math.abs(grade)));
    regenJ = wheelJ * vehicle.regenEff * capture; // negative
  }

  // Stop-go losses. Stops multiply as traffic worsens: each one throws away the
  // kinetic energy regen does not recover, then pays again to rebuild it.
  //
  // The gross cost and the regen credit are tracked separately rather than
  // netted, because netting them made the energy breakdown claim a car doing
  // 1.3 stops per km through Delhi recovers nothing. It recovers a great deal;
  // that is most of what regen is for in a city.
  const stopSpeed = Math.min(v, 50 / 3.6);
  const stopCount = segment.stopsPerKm * segment.distanceKm * Math.min(3, 2 - traffic);
  const stopKineticJ = (stopCount * 0.5 * mass * stopSpeed * stopSpeed) / vehicle.drivetrainEff;
  const stopRegenJ = -stopKineticJ * vehicle.regenEff;

  const durationH = segment.distanceKm / meanKmph;
  const auxW = vehicle.auxBaseW + hvacPowerW(vehicle, conditions);
  const auxJ = auxW * durationH * 3600;

  const packJ = tractionJ + stopKineticJ + stopRegenJ + regenJ + auxJ;

  return {
    segmentId: segment.id,
    distanceKm: segment.distanceKm,
    packKwh: packJ / J_PER_KWH,
    tractionKwh: (tractionJ + stopKineticJ) / J_PER_KWH,
    auxKwh: auxJ / J_PER_KWH,
    regenKwh: (regenJ + stopRegenJ) / J_PER_KWH,
    meanSpeedKmph: meanKmph,
    durationMin: durationH * 60,
    gradePct: grade * 100,
  };
}

export interface RouteEnergy {
  segments: SegmentEnergy[];
  totalKwh: number;
  tractionKwh: number;
  auxKwh: number;
  regenKwh: number;
  hvacKwh: number;
  durationMin: number;
  distanceKm: number;
  whPerKm: number;
}

/**
 * Walks the route segment by segment, advancing the clock as it goes so that a
 * trip leaving at 17:00 hits the evening peak on the first hundred kilometres
 * and clear road after that. Estimators that apply one traffic factor to the
 * whole trip get this materially wrong on long corridors.
 */
export function routeEnergy(
  vehicle: Vehicle,
  segments: Segment[],
  places: Map<string, Place>,
  departureHour: number,
  conditions: Conditions,
): RouteEnergy {
  const out: SegmentEnergy[] = [];
  let clockMin = departureHour * 60;
  let totalKwh = 0;
  let tractionKwh = 0;
  let auxKwh = 0;
  let regenKwh = 0;
  let hvacKwh = 0;
  let distanceKm = 0;

  for (const seg of segments) {
    const from = places.get(seg.from);
    const to = places.get(seg.to);
    if (!from || !to) throw new Error(`Segment ${seg.id} references an unknown place`);

    const hour = Math.floor(clockMin / 60) % 24;
    // Daylight is a property of the clock, not of the request, so a trip that
    // starts at 16:00 loses its solar gain partway along.
    const local: Conditions = { ...conditions, daylight: hour >= 7 && hour < 18 };

    const e = segmentEnergy(vehicle, seg, from, to, hour, local);
    out.push(e);

    const hvacShare =
      vehicle.auxBaseW + hvacPowerW(vehicle, local) > 0
        ? hvacPowerW(vehicle, local) / (vehicle.auxBaseW + hvacPowerW(vehicle, local))
        : 0;

    totalKwh += e.packKwh;
    tractionKwh += e.tractionKwh;
    auxKwh += e.auxKwh;
    regenKwh += e.regenKwh;
    hvacKwh += e.auxKwh * hvacShare;
    distanceKm += e.distanceKm;
    clockMin += e.durationMin;
  }

  return {
    segments: out,
    totalKwh,
    tractionKwh,
    auxKwh,
    regenKwh,
    hvacKwh,
    durationMin: clockMin - departureHour * 60,
    distanceKm,
    whPerKm: distanceKm > 0 ? (totalKwh * 1000) / distanceKm : 0,
  };
}

/** Usable pack energy at a given SoC and ambient temperature, kWh. */
export function usableEnergyKwh(vehicle: Vehicle, socPct: number, ambientC: number): number {
  return (
    vehicle.capacityKwh * vehicle.usableFraction * packDerate(ambientC) * (socPct / 100)
  );
}

/**
 * Minutes to charge from one SoC to another on a given gun. Uses a tapering
 * curve rather than rated power: real DC sessions hold near-rated power to
 * roughly 50% SoC and then fall away, so a 20->80% session takes far longer
 * than `energy / powerKw` suggests. Quoting the naive figure is the other way
 * range planners lie to drivers.
 *
 * Note what is deliberately NOT here: the `packDerate` temperature factor.
 * Charging fills the pack's nameplate window, and the cold-weather derate is
 * about how much of that the vehicle can usefully *deliver* under load, not
 * about how much goes in. An earlier version applied the derate here too, with
 * the result that charging a cold pack came out faster than charging a warm one
 * -- the smaller window cancelled the rate penalty. A unit test caught it.
 * Temperature belongs in this function only as the rate limit below.
 */
export function chargeMinutes(
  vehicle: Vehicle,
  fromSocPct: number,
  toSocPct: number,
  gunKw: number,
  ambientC: number,
): number {
  if (toSocPct <= fromSocPct) return 0;
  const packKwh = vehicle.capacityKwh * vehicle.usableFraction;
  // Pack C-rate ceiling: small packs cannot swallow 150 kW however big the gun is.
  const packCeilingKw = vehicle.capacityKwh * (vehicle.segment === "scooter" ? 1.2 : 2.2);
  const stepPct = 1;
  let minutes = 0;

  for (let soc = fromSocPct; soc < toSocPct; soc += stepPct) {
    // Taper: full power to 50%, then falling linearly to 30% of peak at 100%.
    const taper = soc <= 50 ? 1 : 1 - 0.7 * ((soc - 50) / 50);
    const kw = Math.min(gunKw, packCeilingKw) * taper;
    const kwh = packKwh * (stepPct / 100);
    minutes += (kwh / kw) * 60;
  }
  // Cold packs charge slower; the BMS limits current until the pack warms.
  const coldPenalty = ambientC < 10 ? 1 + (10 - ambientC) * 0.03 : 1;
  return minutes * coldPenalty;
}
