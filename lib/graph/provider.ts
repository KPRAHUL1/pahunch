import neo4j, { type Driver } from "neo4j-driver";

import { CHARGERS, PLACES, SEGMENTS } from "@/lib/data/network";
import {
  CORRIDOR_RELIABILITY,
  FETCH_CHARGERS,
  FETCH_PLACES,
  FETCH_SEGMENTS,
  REACHABLE_CHARGERS,
  ROUTES,
} from "@/lib/graph/queries";
import { buildGraph, findRoutes, labelRoute, type Graph } from "@/lib/graph/routing";
import type { Charger, Place, Route, Segment } from "@/lib/types";

/**
 * Graph access with a hard requirement: the app must work with Neo4j and must
 * work without it. Neo4j is where the network belongs and where the interesting
 * queries live, but a demo that dies when a container is not up is not a demo.
 *
 * So both paths return the same shapes, the bundled path reimplements the same
 * searches in process, and the response tells the UI which one answered. The
 * fallback is visible, not hidden -- a silent downgrade would be worse than a
 * failure, because you would not know which numbers you were looking at.
 */

export interface GraphData {
  places: Place[];
  segments: Segment[];
  chargers: Charger[];
  source: "neo4j" | "bundled";
}

/** A charger site reliable enough to count on as a backup. */
export const DEPENDABLE_RELIABILITY = 0.7;

export interface CorridorReliability {
  placeIds: string[];
  segmentIds: string[];
  distanceKm: number;
  /** Waypoints that have at least one site at or above DEPENDABLE_RELIABILITY. */
  dependableSites: number;
  /**
   * Longest stretch of this corridor with no dependable charger, km. This is
   * the number a driver is actually exposed to, and unlike "is there a working
   * charger somewhere on this road" it differs between corridors.
   */
  longestGapKm: number;
  /** Composed odds at the least dependable covered stop on the corridor. */
  weakestStopOdds: number;
}

export interface CorridorRow {
  placeIds: string[];
  segmentIds: string[];
  distanceKm: number;
  waypoints: { placeId: string; kmIntoTrip: number; siteCount: number; odds: number }[];
}

/**
 * Reduces the per-waypoint coverage Cypher returned to the longest stretch with
 * no dependable option. The gap before the first covered stop counts, because
 * leaving with no backup for 120 km is exactly the exposure being measured; the
 * run-in to the destination counts too, since arriving is not guaranteed.
 */
export function summariseCorridor(row: CorridorRow): CorridorReliability {
  const ordered = [...row.waypoints].sort((a, b) => a.kmIntoTrip - b.kmIntoTrip);
  const covered = ordered.filter((w) => w.siteCount > 0);

  let longestGapKm: number;
  if (covered.length === 0) {
    longestGapKm = row.distanceKm;
  } else {
    longestGapKm = covered[0].kmIntoTrip;
    for (let i = 1; i < covered.length; i++) {
      longestGapKm = Math.max(longestGapKm, covered[i].kmIntoTrip - covered[i - 1].kmIntoTrip);
    }
    longestGapKm = Math.max(
      longestGapKm,
      row.distanceKm - covered[covered.length - 1].kmIntoTrip,
    );
  }

  return {
    placeIds: row.placeIds,
    segmentIds: row.segmentIds,
    distanceKm: row.distanceKm,
    dependableSites: covered.length,
    longestGapKm,
    weakestStopOdds: covered.length === 0 ? 0 : Math.min(...covered.map((w) => w.odds)),
  };
}

let driver: Driver | null = null;
let driverFailed = false;
/** Why we are on the bundled graph, logged once so it is diagnosable. */
let fallbackReason: string | null = null;

/**
 * Records why Neo4j is not being used and says so on the server console, once.
 * The UI already shows which graph answered, but "bundled" without a reason is
 * not actionable -- an operator needs to know whether the container is down,
 * the credentials are missing, or the database is simply unseeded.
 */
function noteFallback(reason: string): void {
  if (fallbackReason === reason) return;
  fallbackReason = reason;
  console.warn(`[pahunch] Using the bundled road graph: ${reason}`);
}

export function graphFallbackReason(): string | null {
  return fallbackReason;
}

function getDriver(): Driver | null {
  if (driverFailed) return null;
  if (driver) return driver;

  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const password = process.env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    noteFallback(
      "NEO4J_URI, NEO4J_USER or NEO4J_PASSWORD is not set. Copy .env.example to .env.",
    );
    return null;
  }

  try {
    driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      // A conference network either works immediately or not at all. Fail fast
      // and fall back rather than making the user watch a 30 s timeout.
      connectionAcquisitionTimeout: 4000,
      connectionTimeout: 3000,
      maxConnectionPoolSize: 8,
      disableLosslessIntegers: true,
    });
    return driver;
  } catch (err) {
    driverFailed = true;
    noteFallback(
      `could not construct a driver for ${uri} (${err instanceof Error ? err.message : "unknown error"}).`,
    );
    return null;
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

const bundled = (): GraphData => ({
  places: PLACES,
  segments: SEGMENTS,
  chargers: CHARGERS,
  source: "bundled",
});

let cache: { data: GraphData; at: number } | null = null;
const CACHE_MS = 60_000;

export async function loadGraphData(): Promise<GraphData> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const d = getDriver();
  if (!d) {
    const data = bundled();
    cache = { data, at: Date.now() };
    return data;
  }

  const session = d.session({ defaultAccessMode: neo4j.session.READ });
  try {
    // Sequential, not Promise.all. A Neo4j session is a single logical
    // connection with one transaction at a time, so firing three queries at it
    // concurrently fails with "Queries cannot be run directly on a session with
    // an open transaction". This read was written as a Promise.all, and because
    // the catch below falls back to the bundled graph, the only symptom was the
    // UI quietly reporting "bundled" with a seeded database right there. Three
    // small reads of a 24-node graph gain nothing from parallelism anyway.
    const placeRes = await session.run(FETCH_PLACES);
    const segmentRes = await session.run(FETCH_SEGMENTS);
    const chargerRes = await session.run(FETCH_CHARGERS);

    const places = placeRes.records.map((r) => r.toObject() as unknown as Place);
    const segments = segmentRes.records.map((r) => r.toObject() as unknown as Segment);
    const chargers = chargerRes.records.map((r) => r.toObject() as unknown as Charger);

    // An empty database means it is up but unseeded. Falling back is the right
    // call -- better a correct answer from the bundled graph than no answer.
    if (places.length === 0 || segments.length === 0) {
      noteFallback("Neo4j is reachable but holds no road network. Run `npm run seed`.");
      const data = bundled();
      cache = { data, at: Date.now() };
      return data;
    }

    const data: GraphData = { places, segments, chargers, source: "neo4j" };
    cache = { data, at: Date.now() };
    return data;
  } catch (err) {
    driverFailed = true;
    noteFallback(
      `the query to Neo4j failed (${err instanceof Error ? err.message : "unknown error"}).`,
    );
    const data = bundled();
    cache = { data, at: Date.now() };
    return data;
  } finally {
    await session.close();
  }
}

/**
 * Candidate routes. When Neo4j answered for the graph itself, the path
 * enumeration runs there too, so the Cypher is on the demo path rather than
 * being decoration in a seed script.
 */
export async function findRouteOptions(
  data: GraphData,
  originId: string,
  destinationId: string,
  limit = 3,
): Promise<Route[]> {
  const graph = buildGraph(data.places, data.segments);

  if (data.source === "neo4j") {
    const d = getDriver();
    if (d) {
      const session = d.session({ defaultAccessMode: neo4j.session.READ });
      try {
        const res = await session.run(ROUTES, {
          originId,
          destinationId,
          limit: neo4j.int(limit),
        });
        const routes = hydrate(res.records.map((r) => r.toObject()), graph);
        if (routes.length > 0) return dedupe(routes);
      } catch {
        // Fall through to the in-process search.
      } finally {
        await session.close();
      }
    }
  }

  return findRoutes(graph, originId, destinationId, limit);
}

/**
 * The corridor-coverage question, which only Neo4j answers. Returns an empty
 * list on the bundled path rather than faking it, and the UI says so.
 */
export async function corridorReliability(
  data: GraphData,
  originId: string,
  destinationId: string,
  limit = 3,
): Promise<CorridorReliability[]> {
  if (data.source !== "neo4j") return [];
  const d = getDriver();
  if (!d) return [];

  const session = d.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(CORRIDOR_RELIABILITY, {
      originId,
      destinationId,
      limit: neo4j.int(limit),
      minReliability: DEPENDABLE_RELIABILITY,
    });
    return res.records.map((r) => summariseCorridor(r.toObject() as unknown as CorridorRow));
  } catch {
    return [];
  } finally {
    await session.close();
  }
}

/** Bounded traversal for chargers still in reach on the remaining pack energy. */
export async function reachableChargers(
  data: GraphData,
  originId: string,
  availableKwh: number,
  whPerKm: number,
): Promise<{ chargerId: string; placeId: string; distanceKm: number; reliability: number }[]> {
  if (data.source !== "neo4j") {
    // In-process equivalent, so the feature exists on both paths.
    const graph = buildGraph(data.places, data.segments);
    const out: { chargerId: string; placeId: string; distanceKm: number; reliability: number }[] = [];
    for (const charger of data.chargers) {
      if (charger.placeId === originId) continue;
      const routes = findRoutes(graph, originId, charger.placeId, 1);
      if (routes.length === 0) continue;
      const km = routes[0].distanceKm;
      if ((km * whPerKm) / 1000 <= availableKwh) {
        out.push({ chargerId: charger.id, placeId: charger.placeId, distanceKm: km, reliability: charger.reliability });
      }
    }
    return out.sort((a, b) => b.reliability - a.reliability);
  }

  const d = getDriver();
  if (!d) return [];
  const session = d.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(REACHABLE_CHARGERS, { originId, availableKwh, whPerKm });
    return res.records.map((r) => r.toObject() as unknown as {
      chargerId: string;
      placeId: string;
      distanceKm: number;
      reliability: number;
    });
  } catch {
    return [];
  } finally {
    await session.close();
  }
}

function hydrate(
  rows: Record<string, unknown>[],
  graph: Graph,
): Route[] {
  const segmentsById = new Map<string, Segment>();
  for (const list of graph.out.values()) {
    for (const s of list) segmentsById.set(s.id, s);
  }

  const routes: Route[] = [];
  for (const [i, row] of rows.entries()) {
    const segmentIds = row.segmentIds as string[];
    const placeIds = row.placeIds as string[];
    const segments = segmentIds.map((id) => segmentsById.get(id));
    if (segments.some((s) => !s)) continue;
    const segs = segments as Segment[];
    routes.push({
      id: `r${i}`,
      placeIds,
      segments: segs,
      distanceKm: segs.reduce((a, s) => a + s.distanceKm, 0),
      label: labelRoute(segs, placeIds, graph.places),
    });
  }
  return routes;
}

/** Drop routes that are materially longer than the best one. */
function dedupe(routes: Route[]): Route[] {
  if (routes.length === 0) return routes;
  const shortest = Math.min(...routes.map((r) => r.distanceKm));
  const seen = new Set<string>();
  return routes.filter((r) => {
    const key = r.segments.map((s) => s.id).join(">");
    if (seen.has(key)) return false;
    seen.add(key);
    return r.distanceKm <= shortest * 1.4;
  });
}
