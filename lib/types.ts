/**
 * Pahunch domain types.
 *
 * Units are SI unless the field name says otherwise. Anything user-facing that
 * is not SI carries the unit in the name (`distanceKm`, `socPct`, `capacityKwh`)
 * because mixing kWh and joules silently is how range estimators get wrong.
 */

export type RoadClass =
  | "expressway" // access-controlled, 100-120 km/h, no cross traffic
  | "national"   // NH, 80-100 km/h, mixed traffic, occasional village slowdowns
  | "state"      // SH, 60-80 km/h, rough surface
  | "urban"      // city arterial, heavy stop-go
  | "ghat";      // mountain road, sustained gradient, low speed

export interface Place {
  id: string;
  name: string;
  city: string;
  lat: number;
  lon: number;
  /** Metres above sea level. Drives the gradient term, which dominates on ghats. */
  elevationM: number;
}

export interface Segment {
  id: string;
  from: string;
  to: string;
  distanceKm: number;
  roadClass: RoadClass;
  /** Posted limit, km/h. Free-flow speed is derived from this, not equal to it. */
  speedLimitKmph: number;
  /**
   * Multiplier on free-flow speed, indexed 0..23 by hour of day (IST).
   * 1.0 = free flow, 0.35 = crawling. Sourced from the segment's observed
   * travel-time spread; this is the single biggest lever on AC energy because
   * a slow segment runs the compressor for longer over the same distance.
   */
  trafficByHour: number[];
  /** Rolling-resistance penalty for surface condition. 1.0 = good tarmac. */
  surfacePenalty: number;
  /** Mean stops per km from signals, toll plazas, village chokepoints. */
  stopsPerKm: number;
}

export interface Charger {
  id: string;
  name: string;
  operator: string;
  placeId: string;
  /** Rated output of the fastest gun at the site. */
  powerKw: number;
  connectors: string[];
  /**
   * Fraction of attempted sessions that actually delivered charge over the
   * trailing 90 days. This is the number public charger maps do not show and
   * the reason a "charger exists" is not the same as "I can charge".
   */
  reliability: number;
  /** Mean queue wait in minutes when the site is up, from session logs. */
  meanQueueMin: number;
  /** Guns at the site. More guns absorb queue variance. */
  bays: number;
}

export interface Vehicle {
  id: string;
  name: string;
  segment: "car" | "scooter" | "threewheeler";
  /** Nameplate pack energy. */
  capacityKwh: number;
  /** Fraction of the pack the BMS will actually hand over. */
  usableFraction: number;
  /** Kerb mass, kg. */
  massKg: number;
  /** Drag coefficient. */
  cd: number;
  /** Frontal area, m^2. */
  frontalAreaM2: number;
  /** Rolling resistance coefficient on good tarmac. */
  crr: number;
  /** Inverter + motor + gearbox efficiency, traction direction. */
  drivetrainEff: number;
  /** Fraction of braking energy that reaches the pack. */
  regenEff: number;
  /** Non-HVAC accessory draw, W (lights, ECUs, pumps, infotainment). */
  auxBaseW: number;
  /** Peak HVAC compressor draw, W. Scooters have none. */
  hvacPeakW: number;
  /** Manufacturer-claimed range, km. Shown only to contrast with reality. */
  claimedRangeKm: number;
  claimedRangeStandard: "MIDC" | "IDC" | "WLTP" | "manufacturer";
}

export interface TripRequest {
  vehicleId: string;
  originId: string;
  destinationId: string;
  /** Battery state of charge at departure, 0..100. */
  startSocPct: number;
  /** Hour of day of departure, 0..23 IST. */
  departureHour: number;
  /** Forecast ambient temperature at departure, deg C. */
  ambientC: number;
  /** Occupants including driver. Each adds mass and HVAC load. */
  occupants: number;
  /** Extra cargo, kg. */
  payloadKg: number;
  /** How hard the driver pushes. 0 = hypermiler, 1 = typical, 2 = aggressive. */
  drivingStyle: number;
  /** SoC the driver refuses to go below, 0..100. Range anxiety, quantified. */
  reservePct: number;
  /** Whether HVAC will be used. Defaults to a temperature-driven guess. */
  hvacOn?: boolean;
}

export interface SegmentEnergy {
  segmentId: string;
  distanceKm: number;
  /** Energy drawn from the pack over this segment, kWh. Can be negative on long descents. */
  packKwh: number;
  tractionKwh: number;
  auxKwh: number;
  regenKwh: number;
  meanSpeedKmph: number;
  durationMin: number;
  gradePct: number;
}

export interface RouteLeg {
  segments: Segment[];
  distanceKm: number;
}

export interface Route {
  id: string;
  placeIds: string[];
  segments: Segment[];
  distanceKm: number;
  label: string;
}

/** One sample from the Monte Carlo. */
export interface TripSample {
  arrivalSocPct: number;
  consumedKwh: number;
  durationMin: number;
  meanWhPerKm: number;
  /** Whether a charging stop was needed to stay above reserve. */
  neededCharge: boolean;
}

export interface RiskFactor {
  key: string;
  label: string;
  /**
   * Change in P(make it) if this variable were pinned to its best case instead
   * of sampled. Positive means removing this uncertainty helps.
   */
  deltaProbability: number;
  detail: string;
}

/**
 * An actionable change to the trip and what it does to P(make it). Risk factors
 * explain why the answer is uncertain; levers tell the driver what to do about
 * it. A range estimator that only prints a number offers neither.
 */
export interface Lever {
  key: string;
  label: string;
  /** Change in P(make it) if the driver takes this action. */
  deltaProbability: number;
  /** Cost of taking it, in plain words. Empty when it is free. */
  cost: string;
}

export interface ChargerPlan {
  chargerId: string;
  chargerName: string;
  operator: string;
  placeName: string;
  distanceIntoTripKm: number;
  /** SoC on arrival at the charger, median. */
  arrivalSocPct: number;
  minutesToTargetSoc: number;
  targetSocPct: number;
  /** P(site actually delivers charge), i.e. its reliability. */
  siteReliability: number;
  /** P(make it) for the whole trip if this stop is taken. */
  probabilityWithStop: number;
  expectedQueueMin: number;
}

export interface Verdict {
  /** Calibrated P(arrive at or above reserve SoC). */
  probability: number;
  /** Plain-language call, derived from probability and its own uncertainty. */
  call: "yes" | "tight" | "no";
  arrivalSoc: { p10: number; p50: number; p90: number };
  /** Credible interval on the probability itself, from MC standard error. */
  probabilityCi: [number, number];
  consumptionWhPerKm: { p10: number; p50: number; p90: number };
  durationMin: { p10: number; p50: number; p90: number };
  route: {
    id: string;
    label: string;
    distanceKm: number;
    placeIds: string[];
    placeNames: string[];
    /** Metres above sea level at each waypoint, for the elevation profile. */
    elevationsM: number[];
    /** Cumulative kilometres from the origin at each waypoint. */
    cumulativeKm: number[];
    coords: [number, number][];
  };
  /** Nameplate range vs what this trip will actually cost, for contrast. */
  claimed: { rangeKm: number; standard: string; impliedWhPerKm: number };
  risks: RiskFactor[];
  levers: Lever[];
  chargerPlan: ChargerPlan | null;
  /** Other routes considered, with the probability each would have given. */
  alternatives: { id: string; label: string; distanceKm: number; probability: number }[];
  /**
   * Neo4j-only charger coverage for the chosen corridor. Null on the bundled
   * graph, and shown as unavailable rather than silently omitted.
   */
  corridor: {
    /** Longest stretch with no dependable charger, km. */
    longestGapKm: number;
    dependableSites: number;
    /** Composed odds at the least dependable covered stop. */
    weakestStopOdds: number;
    /** The reliability floor that counts a site as dependable. */
    dependableThreshold: number;
  } | null;
  segmentBreakdown: SegmentEnergy[];
  energySplit: { tractionKwh: number; hvacKwh: number; auxKwh: number; regenKwh: number };
  calibration: {
    /** Multiplicative bias applied to the physics model for this vehicle. */
    biasApplied: number;
    /** Residual spread, fraction. Feeds the MC model-error term. */
    residualSigma: number;
    /** How many logged trips informed the bias. */
    tripsObserved: number;
  };
  graphSource: "neo4j" | "bundled";
  samples: number;
  explanation: string;
}
