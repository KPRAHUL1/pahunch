import { PLACES, SEGMENTS } from "@/lib/data/network";
import { routeEnergy, type Conditions } from "@/lib/energy/physics";
import { VEHICLES, OCCUPANT_MASS_KG, vehicleById } from "@/lib/energy/vehicles";
import { buildGraph, findRoutes } from "@/lib/graph/routing";
import { makeRng } from "@/lib/rng";

/**
 * SYNTHETIC FLEET LOGS -- read this before trusting any number downstream.
 *
 * Pahunch calibrates its physics model against observed trips. We do not have a
 * real telematics feed, so this module manufactures one. It is honest about
 * that, and it is built so the calibration layer is still doing real work:
 *
 *  1. Each vehicle is given a HIDDEN true efficiency offset (`TRUE_BIAS`) that
 *     the physics model has no way to know -- it stands in for everything the
 *     model omits: pack ageing, inverter losses off the efficiency island,
 *     tyre choice, 12V parasitics, the OEM's own BMS conservatism.
 *  2. Observed energy is the physics prediction under the trip's true
 *     conditions, multiplied by that offset and by lognormal trip noise.
 *  3. The driver-reported conditions stored on the log are DEGRADED copies of
 *     the true ones -- a driver who says "two people, no AC" when it was three
 *     people with the AC on. This is the realistic case, and it is why a naive
 *     fit would under-correct.
 *
 * `scripts/validate-calibration.ts` then checks that the calibration layer
 * recovers each hidden offset from the degraded logs, and that the resulting
 * probabilities are calibrated on trips it never saw. If the logs were real,
 * only this file would change.
 */

/** Ground truth the model is not allowed to see. Recovered in validation. */
export const TRUE_BIAS: Record<string, number> = {
  "nexon-ev-45": 1.085,
  "tiago-ev-24": 1.052,
  "windsor-ev": 0.975,
  "comet-ev": 1.11,
  "ather-450x": 0.962,
  "ola-s1-pro": 1.04,
  "mahindra-be6": 1.018,
};

/** Trip-to-trip multiplicative noise that no model can remove, as lognormal sigma. */
const IRREDUCIBLE_SIGMA = 0.075;

export interface TripLog {
  id: string;
  vehicleId: string;
  originId: string;
  destinationId: string;
  routeSegmentIds: string[];
  distanceKm: number;
  departureHour: number;
  /** What the driver logged, which is not necessarily what happened. */
  reported: {
    ambientC: number;
    occupants: number;
    payloadKg: number;
    drivingStyle: number;
    hvacOn: boolean;
  };
  /** Energy actually drawn from the pack, from the vehicle's own counter, kWh. */
  observedKwh: number;
  observedDurationMin: number;
}

/** Origin/destination pairs the synthetic fleet actually drives. */
const CORRIDORS: [string, string][] = [
  ["del-cp", "jaipur"],
  ["del-cp", "agra"],
  ["del-cp", "chandigarh"],
  ["chandigarh", "shimla"],
  ["del-cp", "shimla"],
  ["del-cp", "ggn-cyber"],
  ["del-dwarka", "noida-18"],
  ["del-cp", "faridabad"],
  ["ggn-cyber", "jaipur"],
  ["noida-18", "agra"],
  ["del-cp", "karnal"],
  ["ghaziabad", "del-cp"],
  ["del-cp", "behror"],
  ["jaipur", "del-cp"],
  ["shimla", "chandigarh"],
  ["agra", "del-cp"],
];

function generate(count: number, seed: number): TripLog[] {
  const rng = makeRng(seed);
  const graph = buildGraph(PLACES, SEGMENTS);
  const logs: TripLog[] = [];

  for (let i = 0; i < count; i++) {
    const vehicle = rng.pick(VEHICLES);
    // Scooters do not drive Delhi to Jaipur. Keep the fleet plausible.
    const pool =
      vehicle.segment === "scooter"
        ? CORRIDORS.filter(([a, b]) => {
            const routes = findRoutes(graph, a, b, 1);
            return routes.length > 0 && routes[0].distanceKm <= 90;
          })
        : CORRIDORS;
    if (pool.length === 0) continue;
    const [originId, destinationId] = rng.pick(pool);

    const routes = findRoutes(graph, originId, destinationId, 2);
    if (routes.length === 0) continue;
    // Drivers mostly take the shortest route, sometimes the alternate.
    const route = routes.length > 1 && rng.next() < 0.25 ? routes[1] : routes[0];

    const departureHour = Math.floor(rng.next() * 24);
    // Indian ambient spread: Delhi winter mornings to Rajasthan May afternoons.
    const trueAmbient = rng.normalIn(29, 9, 4, 48);
    const trueOccupants =
      vehicle.segment === "scooter"
        ? 1 + (rng.next() < 0.3 ? 1 : 0)
        : 1 + Math.floor(rng.next() * 4);
    const truePayload = vehicle.segment === "scooter" ? rng.next() * 12 : rng.next() * 60;
    const trueStyle = rng.normalIn(1.0, 0.3, 0.3, 1.9);
    const trueHvac =
      vehicle.hvacPeakW > 0 && (trueAmbient > 28 || trueAmbient < 14 || rng.next() < 0.3);

    const conditions: Conditions = {
      ambientC: trueAmbient,
      addedMassKg: trueOccupants * OCCUPANT_MASS_KG + truePayload,
      trafficMultiplier: rng.lognormal(1.0, 0.14),
      speedFactor: 0.85 + trueStyle * 0.17,
      headwindMps: rng.normal(0, 2.6),
      crrFactor: rng.normalIn(1.0, 0.07, 0.85, 1.25),
      hvacOn: trueHvac,
      hvacDuty: trueHvac ? rng.normalIn(0.8, 0.15, 0.3, 1.0) : 0,
      daylight: departureHour >= 7 && departureHour < 18,
    };

    const predicted = routeEnergy(
      vehicle,
      route.segments,
      graph.places,
      departureHour,
      conditions,
    );

    const bias = TRUE_BIAS[vehicle.id] ?? 1;
    const observedKwh = Math.max(
      0.2,
      predicted.totalKwh * bias * rng.lognormal(1.0, IRREDUCIBLE_SIGMA),
    );

    logs.push({
      id: `trip-${String(i).padStart(4, "0")}`,
      vehicleId: vehicle.id,
      originId,
      destinationId,
      routeSegmentIds: route.segments.map((s) => s.id),
      distanceKm: route.distanceKm,
      departureHour,
      reported: {
        // Drivers round the temperature and misremember the load.
        ambientC: Math.round(trueAmbient / 2) * 2,
        occupants: Math.max(1, trueOccupants - (rng.next() < 0.25 ? 1 : 0)),
        payloadKg: Math.round(truePayload / 10) * 10,
        drivingStyle: Math.round(trueStyle * 2) / 2,
        hvacOn: trueHvac && rng.next() > 0.12,
      },
      observedKwh,
      observedDurationMin: predicted.durationMin * rng.lognormal(1.0, 0.1),
    });
  }

  return logs;
}

/** Fixed seed: the fleet is the same on every machine, so results are comparable. */
export const TRIP_LOGS: TripLog[] = generate(420, 20260723);

export function logsForVehicle(vehicleId: string): TripLog[] {
  return TRIP_LOGS.filter((t) => t.vehicleId === vehicleId);
}

/** Sanity guard for the validation script and tests. */
export function vehicleWithMostLogs(): string {
  const counts = new Map<string, number>();
  for (const t of TRIP_LOGS) counts.set(t.vehicleId, (counts.get(t.vehicleId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export { vehicleById };
