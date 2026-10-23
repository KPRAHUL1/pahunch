import type { Charger, Place, RoadClass, Segment } from "@/lib/types";

/**
 * Bundled road network: the Delhi NCR corridors plus the Chandigarh-Shimla
 * climb. This is the fallback graph. The same nodes and edges are loaded into
 * Neo4j by `scripts/seed-neo4j.ts`, and the app prefers Neo4j when it can reach
 * it. Keeping an identical in-process copy means the demo still runs on a
 * conference wifi with no database, which is not a hypothetical risk.
 *
 * Distances are driving distances, not great-circle. Elevations matter: the
 * Shimla leg climbs 1900 m over 117 km and no nameplate range figure survives it.
 */

type TrafficProfile = "expressway" | "highway-ncr" | "highway-open" | "urban-dense" | "ghat";

/** Free-flow speed multiplier by hour of day (IST), indexed 0..23. */
function trafficCurve(profile: TrafficProfile): number[] {
  const curves: Record<TrafficProfile, number[]> = {
    // Access-controlled. Barely degrades; toll plazas are the only chokepoint.
    expressway: [
      1.0, 1.0, 1.0, 1.0, 1.0, 0.98, 0.95, 0.92, 0.9, 0.9, 0.92, 0.94, 0.95, 0.95,
      0.94, 0.92, 0.9, 0.88, 0.86, 0.88, 0.92, 0.96, 0.98, 1.0,
    ],
    // NH inside the NCR catchment: real peak-hour collapse in both directions.
    "highway-ncr": [
      0.98, 1.0, 1.0, 1.0, 0.98, 0.92, 0.82, 0.68, 0.55, 0.52, 0.62, 0.72, 0.76,
      0.78, 0.76, 0.7, 0.6, 0.48, 0.45, 0.52, 0.66, 0.8, 0.9, 0.95,
    ],
    // NH past the metro shadow: village chokepoints, not commuter peaks.
    "highway-open": [
      1.0, 1.0, 1.0, 1.0, 1.0, 0.96, 0.9, 0.85, 0.82, 0.84, 0.86, 0.86, 0.85,
      0.85, 0.86, 0.86, 0.84, 0.8, 0.76, 0.8, 0.88, 0.94, 0.98, 1.0,
    ],
    // City arterial. The 0.30 at 18:00 is why urban Wh/km nearly doubles.
    "urban-dense": [
      0.95, 1.0, 1.0, 1.0, 0.95, 0.85, 0.7, 0.52, 0.38, 0.35, 0.45, 0.55, 0.6,
      0.62, 0.6, 0.52, 0.42, 0.32, 0.3, 0.36, 0.5, 0.68, 0.82, 0.9,
    ],
    // Ghat sections are speed-limited by geometry, not by traffic volume.
    ghat: [
      0.9, 0.9, 0.9, 0.9, 0.9, 0.88, 0.82, 0.78, 0.72, 0.7, 0.7, 0.72, 0.74,
      0.74, 0.72, 0.7, 0.68, 0.66, 0.7, 0.78, 0.84, 0.88, 0.9, 0.9,
    ],
  };
  return curves[profile];
}

export const PLACES: Place[] = [
  { id: "del-cp", name: "Connaught Place", city: "New Delhi", lat: 28.6315, lon: 77.2167, elevationM: 216 },
  { id: "del-dwarka", name: "Dwarka Sector 21", city: "New Delhi", lat: 28.552, lon: 77.058, elevationM: 215 },
  { id: "ggn-cyber", name: "Cyber City", city: "Gurugram", lat: 28.495, lon: 77.089, elevationM: 217 },
  { id: "manesar", name: "IMT Manesar", city: "Manesar", lat: 28.354, lon: 76.934, elevationM: 230 },
  { id: "dharuhera", name: "Dharuhera Toll", city: "Dharuhera", lat: 28.207, lon: 76.8, elevationM: 250 },
  { id: "behror", name: "Behror Midway", city: "Behror", lat: 27.89, lon: 76.28, elevationM: 310 },
  { id: "shahpura", name: "Shahpura", city: "Shahpura", lat: 27.39, lon: 75.96, elevationM: 400 },
  { id: "jaipur", name: "Chandpole", city: "Jaipur", lat: 26.9239, lon: 75.8267, elevationM: 431 },
  { id: "noida-18", name: "Sector 18", city: "Noida", lat: 28.57, lon: 77.321, elevationM: 200 },
  { id: "jewar", name: "Jewar Interchange", city: "Jewar", lat: 28.122, lon: 77.557, elevationM: 190 },
  { id: "mathura", name: "Mathura Interchange", city: "Mathura", lat: 27.4924, lon: 77.6737, elevationM: 174 },
  { id: "agra", name: "Taj East Gate", city: "Agra", lat: 27.16, lon: 78.05, elevationM: 171 },
  { id: "murthal", name: "Murthal Dhabas", city: "Murthal", lat: 29.033, lon: 77.026, elevationM: 225 },
  { id: "panipat", name: "Panipat Bypass", city: "Panipat", lat: 29.39, lon: 76.97, elevationM: 219 },
  { id: "karnal", name: "Karnal Bypass", city: "Karnal", lat: 29.686, lon: 76.99, elevationM: 245 },
  { id: "ambala", name: "Ambala Cantt", city: "Ambala", lat: 30.378, lon: 76.776, elevationM: 264 },
  { id: "zirakpur", name: "Zirakpur Junction", city: "Zirakpur", lat: 30.642, lon: 76.82, elevationM: 320 },
  { id: "chandigarh", name: "ISBT Sector 43", city: "Chandigarh", lat: 30.71, lon: 76.76, elevationM: 321 },
  { id: "parwanoo", name: "Parwanoo", city: "Parwanoo", lat: 30.837, lon: 76.96, elevationM: 640 },
  { id: "solan", name: "Solan", city: "Solan", lat: 30.908, lon: 77.099, elevationM: 1500 },
  { id: "kandaghat", name: "Kandaghat", city: "Kandaghat", lat: 30.97, lon: 77.12, elevationM: 1433 },
  { id: "shimla", name: "Shimla Lift", city: "Shimla", lat: 31.1048, lon: 77.1734, elevationM: 2205 },
  { id: "faridabad", name: "Sector 15", city: "Faridabad", lat: 28.4089, lon: 77.3178, elevationM: 206 },
  { id: "ghaziabad", name: "Vaishali", city: "Ghaziabad", lat: 28.6692, lon: 77.4538, elevationM: 214 },
];

interface SegDef {
  from: string;
  to: string;
  km: number;
  cls: RoadClass;
  limit: number;
  profile: TrafficProfile;
  surface: number;
  stopsPerKm: number;
}

const SEG_DEFS: SegDef[] = [
  // --- NH48 corridor: Delhi -> Jaipur
  { from: "del-cp", to: "ggn-cyber", km: 28, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.05, stopsPerKm: 0.9 },
  { from: "ggn-cyber", to: "manesar", km: 25, cls: "expressway", limit: 100, profile: "highway-ncr", surface: 1.0, stopsPerKm: 0.12 },
  { from: "manesar", to: "dharuhera", km: 30, cls: "national", limit: 90, profile: "highway-ncr", surface: 1.02, stopsPerKm: 0.15 },
  { from: "dharuhera", to: "behror", km: 70, cls: "national", limit: 100, profile: "highway-open", surface: 1.0, stopsPerKm: 0.08 },
  { from: "behror", to: "shahpura", km: 62, cls: "national", limit: 100, profile: "highway-open", surface: 1.02, stopsPerKm: 0.08 },
  { from: "shahpura", to: "jaipur", km: 55, cls: "national", limit: 90, profile: "highway-open", surface: 1.04, stopsPerKm: 0.2 },

  // --- Yamuna Expressway: Delhi -> Agra
  { from: "del-cp", to: "noida-18", km: 22, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.04, stopsPerKm: 1.1 },
  { from: "noida-18", to: "jewar", km: 62, cls: "expressway", limit: 100, profile: "expressway", surface: 1.0, stopsPerKm: 0.05 },
  { from: "jewar", to: "mathura", km: 72, cls: "expressway", limit: 100, profile: "expressway", surface: 1.0, stopsPerKm: 0.04 },
  { from: "mathura", to: "agra", km: 58, cls: "expressway", limit: 100, profile: "expressway", surface: 1.01, stopsPerKm: 0.06 },

  // --- NH44 corridor: Delhi -> Chandigarh -> Shimla
  { from: "del-cp", to: "murthal", km: 48, cls: "national", limit: 90, profile: "highway-ncr", surface: 1.02, stopsPerKm: 0.3 },
  { from: "murthal", to: "panipat", km: 42, cls: "national", limit: 100, profile: "highway-open", surface: 1.0, stopsPerKm: 0.1 },
  { from: "panipat", to: "karnal", km: 37, cls: "national", limit: 100, profile: "highway-open", surface: 1.0, stopsPerKm: 0.1 },
  { from: "karnal", to: "ambala", km: 85, cls: "national", limit: 100, profile: "highway-open", surface: 1.01, stopsPerKm: 0.09 },
  { from: "ambala", to: "zirakpur", km: 42, cls: "national", limit: 90, profile: "highway-open", surface: 1.02, stopsPerKm: 0.18 },
  { from: "zirakpur", to: "chandigarh", km: 12, cls: "urban", limit: 50, profile: "urban-dense", surface: 1.03, stopsPerKm: 1.3 },
  { from: "chandigarh", to: "parwanoo", km: 35, cls: "national", limit: 70, profile: "highway-open", surface: 1.05, stopsPerKm: 0.35 },
  { from: "parwanoo", to: "solan", km: 38, cls: "ghat", limit: 45, profile: "ghat", surface: 1.12, stopsPerKm: 0.4 },
  { from: "solan", to: "kandaghat", km: 16, cls: "ghat", limit: 45, profile: "ghat", surface: 1.12, stopsPerKm: 0.4 },
  { from: "kandaghat", to: "shimla", km: 28, cls: "ghat", limit: 40, profile: "ghat", surface: 1.15, stopsPerKm: 0.5 },

  // --- Intra-NCR
  { from: "del-dwarka", to: "del-cp", km: 23, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.04, stopsPerKm: 1.0 },
  { from: "del-dwarka", to: "ggn-cyber", km: 15, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.03, stopsPerKm: 0.8 },
  { from: "del-cp", to: "faridabad", km: 32, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.05, stopsPerKm: 1.2 },
  { from: "del-cp", to: "ghaziabad", km: 25, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.06, stopsPerKm: 1.3 },
  { from: "faridabad", to: "noida-18", km: 28, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.05, stopsPerKm: 1.1 },
  { from: "ghaziabad", to: "noida-18", km: 18, cls: "urban", limit: 60, profile: "urban-dense", surface: 1.05, stopsPerKm: 1.1 },
];

/** Segments are stored directed, both ways, so the gradient term flips sign. */
export const SEGMENTS: Segment[] = SEG_DEFS.flatMap((d): Segment[] => {
  const base = {
    distanceKm: d.km,
    roadClass: d.cls,
    speedLimitKmph: d.limit,
    trafficByHour: trafficCurve(d.profile),
    surfacePenalty: d.surface,
    stopsPerKm: d.stopsPerKm,
  };
  return [
    { id: `${d.from}__${d.to}`, from: d.from, to: d.to, ...base },
    { id: `${d.to}__${d.from}`, from: d.to, to: d.from, ...base },
  ];
});

/**
 * Charger sites. `reliability` is the field that matters and the field no public
 * charger map exposes: the fraction of attempted sessions over the trailing 90
 * days that actually delivered charge. A 0.52 site on the Solan climb is a
 * materially different object from a 0.92 site at Murthal, and treating both as
 * "a charger" is how drivers get stranded.
 */
export const CHARGERS: Charger[] = [
  { id: "ch-cp-tata", name: "CP Block N Parking", operator: "Tata Power EZ", placeId: "del-cp", powerKw: 60, connectors: ["CCS2"], reliability: 0.88, meanQueueMin: 12, bays: 2 },
  { id: "ch-dwarka-tata", name: "Dwarka 21 Metro", operator: "Tata Power EZ", placeId: "del-dwarka", powerKw: 60, connectors: ["CCS2", "Type2"], reliability: 0.86, meanQueueMin: 10, bays: 2 },
  { id: "ch-ggn-jio", name: "Cyber Hub Pulse", operator: "Jio-bp pulse", placeId: "ggn-cyber", powerKw: 120, connectors: ["CCS2"], reliability: 0.93, meanQueueMin: 8, bays: 4 },
  { id: "ch-manesar-statiq", name: "IMT Manesar Plaza", operator: "Statiq", placeId: "manesar", powerKw: 60, connectors: ["CCS2"], reliability: 0.72, meanQueueMin: 15, bays: 2 },
  { id: "ch-dharuhera-tata", name: "Dharuhera Food Court", operator: "Tata Power EZ", placeId: "dharuhera", powerKw: 25, connectors: ["CCS2"], reliability: 0.65, meanQueueMin: 22, bays: 1 },
  { id: "ch-behror-jio", name: "Behror Midway Pulse", operator: "Jio-bp pulse", placeId: "behror", powerKw: 150, connectors: ["CCS2"], reliability: 0.9, meanQueueMin: 9, bays: 4 },
  { id: "ch-shahpura-statiq", name: "Shahpura Highway Stop", operator: "Statiq", placeId: "shahpura", powerKw: 50, connectors: ["CCS2"], reliability: 0.6, meanQueueMin: 25, bays: 1 },
  { id: "ch-jaipur-tata", name: "Chandpole Parking", operator: "Tata Power EZ", placeId: "jaipur", powerKw: 60, connectors: ["CCS2", "Type2"], reliability: 0.86, meanQueueMin: 14, bays: 3 },
  { id: "ch-noida-tata", name: "DLF Mall of India", operator: "Tata Power EZ", placeId: "noida-18", powerKw: 50, connectors: ["CCS2"], reliability: 0.84, meanQueueMin: 16, bays: 3 },
  { id: "ch-jewar-jio", name: "Jewar Interchange Pulse", operator: "Jio-bp pulse", placeId: "jewar", powerKw: 120, connectors: ["CCS2"], reliability: 0.91, meanQueueMin: 7, bays: 4 },
  { id: "ch-mathura-statiq", name: "Mathura Service Plaza", operator: "Statiq", placeId: "mathura", powerKw: 60, connectors: ["CCS2"], reliability: 0.7, meanQueueMin: 18, bays: 2 },
  { id: "ch-agra-tata", name: "Taj East Gate Lot", operator: "Tata Power EZ", placeId: "agra", powerKw: 50, connectors: ["CCS2"], reliability: 0.82, meanQueueMin: 15, bays: 2 },
  { id: "ch-murthal-jio", name: "Murthal Pulse Hub", operator: "Jio-bp pulse", placeId: "murthal", powerKw: 150, connectors: ["CCS2"], reliability: 0.92, meanQueueMin: 8, bays: 6 },
  { id: "ch-panipat-statiq", name: "Panipat Bypass Stop", operator: "Statiq", placeId: "panipat", powerKw: 60, connectors: ["CCS2"], reliability: 0.68, meanQueueMin: 20, bays: 2 },
  { id: "ch-karnal-tata", name: "Karnal Haveli", operator: "Tata Power EZ", placeId: "karnal", powerKw: 60, connectors: ["CCS2"], reliability: 0.85, meanQueueMin: 11, bays: 3 },
  { id: "ch-ambala-jio", name: "Ambala Cantt Pulse", operator: "Jio-bp pulse", placeId: "ambala", powerKw: 120, connectors: ["CCS2"], reliability: 0.89, meanQueueMin: 9, bays: 4 },
  { id: "ch-zirakpur-statiq", name: "Zirakpur Junction", operator: "Statiq", placeId: "zirakpur", powerKw: 50, connectors: ["CCS2"], reliability: 0.66, meanQueueMin: 21, bays: 1 },
  { id: "ch-chd-tata", name: "ISBT 43 Deck", operator: "Tata Power EZ", placeId: "chandigarh", powerKw: 60, connectors: ["CCS2", "Type2"], reliability: 0.87, meanQueueMin: 12, bays: 3 },
  { id: "ch-parwanoo-statiq", name: "Parwanoo Timber Trail", operator: "Statiq", placeId: "parwanoo", powerKw: 30, connectors: ["CCS2"], reliability: 0.58, meanQueueMin: 28, bays: 1 },
  { id: "ch-solan-hpseb", name: "Solan Bus Stand", operator: "HPSEB", placeId: "solan", powerKw: 25, connectors: ["CCS2"], reliability: 0.52, meanQueueMin: 32, bays: 1 },
  { id: "ch-shimla-hpseb", name: "Shimla Lift Parking", operator: "HPSEB", placeId: "shimla", powerKw: 50, connectors: ["CCS2"], reliability: 0.6, meanQueueMin: 26, bays: 2 },
  { id: "ch-faridabad-statiq", name: "Crown Interiorz Mall", operator: "Statiq", placeId: "faridabad", powerKw: 60, connectors: ["CCS2"], reliability: 0.7, meanQueueMin: 17, bays: 2 },
  { id: "ch-ghaziabad-tata", name: "Vaishali Metro Lot", operator: "Tata Power EZ", placeId: "ghaziabad", powerKw: 50, connectors: ["CCS2"], reliability: 0.8, meanQueueMin: 15, bays: 2 },
];

export const placeById = (id: string): Place => {
  const p = PLACES.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown place: ${id}`);
  return p;
};

export const chargersAtPlace = (placeId: string): Charger[] =>
  CHARGERS.filter((c) => c.placeId === placeId);
