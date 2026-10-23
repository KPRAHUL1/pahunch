import type { Place, Route, Segment } from "@/lib/types";

/**
 * Route search over the bundled graph. The Neo4j provider runs the equivalent
 * search in Cypher; this exists so the app has identical behaviour with the
 * database down, and so the routing logic is unit-testable without a container.
 */

export interface Graph {
  places: Map<string, Place>;
  /** Adjacency: place id -> outgoing segments. */
  out: Map<string, Segment[]>;
}

export function buildGraph(places: Place[], segments: Segment[]): Graph {
  const out = new Map<string, Segment[]>();
  for (const s of segments) {
    const list = out.get(s.from);
    if (list) list.push(s);
    else out.set(s.from, [s]);
  }
  return { places: new Map(places.map((p) => [p.id, p])), out };
}

type Weight = (s: Segment) => number;

const byDistance: Weight = (s) => s.distanceKm;

/**
 * Dijkstra, optionally with a set of banned segment ids. The ban list is what
 * turns a single shortest path into Yen's k-shortest paths above.
 */
function shortestPath(
  graph: Graph,
  originId: string,
  destId: string,
  weight: Weight = byDistance,
  banned: Set<string> = new Set(),
  bannedNodes: Set<string> = new Set(),
): Segment[] | null {
  const dist = new Map<string, number>([[originId, 0]]);
  const prev = new Map<string, Segment>();
  const visited = new Set<string>();
  // The graph is two dozen nodes, so a linear-scan frontier is the right
  // trade: a binary heap here would be more code for no measurable gain.
  const frontier = new Set<string>([originId]);

  while (frontier.size > 0) {
    let current: string | null = null;
    let best = Infinity;
    for (const id of frontier) {
      const d = dist.get(id) ?? Infinity;
      if (d < best) {
        best = d;
        current = id;
      }
    }
    if (current === null) break;
    frontier.delete(current);
    visited.add(current);
    if (current === destId) break;

    for (const seg of graph.out.get(current) ?? []) {
      if (banned.has(seg.id)) continue;
      if (bannedNodes.has(seg.to)) continue;
      if (visited.has(seg.to)) continue;
      const candidate = best + weight(seg);
      if (candidate < (dist.get(seg.to) ?? Infinity)) {
        dist.set(seg.to, candidate);
        prev.set(seg.to, seg);
        frontier.add(seg.to);
      }
    }
  }

  if (!prev.has(destId) && originId !== destId) return null;

  const path: Segment[] = [];
  let cursor = destId;
  while (cursor !== originId) {
    const seg = prev.get(cursor);
    if (!seg) return null;
    path.unshift(seg);
    cursor = seg.from;
  }
  return path;
}

/**
 * Labels a route by the road character a driver would recognise -- "via Jewar,
 * Mathura (expressway)" is what a person checks an estimate against, not a
 * route id. Exported because the Neo4j provider hydrates its own paths and must
 * label them identically; two copies of this drifted apart once already.
 */
export function labelRoute(
  segments: Segment[],
  placeIds: string[],
  places: Map<string, Place>,
): string {
  const classes = new Set(segments.map((s) => s.roadClass));
  const endCities = new Set(
    [placeIds[0], placeIds[placeIds.length - 1]]
      .map((id) => places.get(id)?.city)
      .filter((c): c is string => Boolean(c)),
  );
  // Naming a waypoint by a city the trip already starts or ends in reads as
  // nonsense ("Dwarka to Noida via New Delhi"), so fall back to the place name.
  const via = placeIds
    .slice(1, -1)
    .map((id) => {
      const p = places.get(id);
      if (!p) return null;
      return endCities.has(p.city) ? p.name : p.city;
    })
    .filter((c, i, arr): c is string => Boolean(c) && arr.indexOf(c) === i);

  const character = classes.has("ghat")
    ? "ghat road"
    : classes.has("expressway")
      ? "expressway"
      : classes.has("urban") && classes.size === 1
        ? "city roads"
        : "national highway";

  return via.length > 0
    ? `via ${via.slice(0, 3).join(", ")} (${character})`
    : `direct (${character})`;
}

function toRoute(graph: Graph, segments: Segment[], index: number): Route {
  const placeIds = [segments[0].from, ...segments.map((s) => s.to)];
  return {
    id: `r${index}`,
    placeIds,
    segments,
    distanceKm: segments.reduce((a, s) => a + s.distanceKm, 0),
    label: labelRoute(segments, placeIds, graph.places),
  };
}

/**
 * Yen's k-shortest loopless paths, shortened to what this network needs. Two or
 * three candidates is the useful number: Delhi to Agra really does have an
 * expressway option and a city-roads option, and they differ by 30% in energy,
 * so collapsing them to one "the route" hides a decision the driver owns.
 */
export function findRoutes(
  graph: Graph,
  originId: string,
  destId: string,
  k = 3,
): Route[] {
  if (!graph.places.has(originId)) throw new Error(`Unknown origin: ${originId}`);
  if (!graph.places.has(destId)) throw new Error(`Unknown destination: ${destId}`);
  if (originId === destId) throw new Error("Origin and destination are the same place");

  const first = shortestPath(graph, originId, destId);
  if (!first) return [];

  const accepted: Segment[][] = [first];
  const candidates: Segment[][] = [];

  while (accepted.length < k) {
    const last = accepted[accepted.length - 1];

    for (let i = 0; i < last.length; i++) {
      const spurNode = last[i].from;
      const rootPath = last.slice(0, i);

      const banned = new Set<string>();
      for (const other of accepted) {
        if (
          other.length > i &&
          rootPath.every((s, j) => s.id === other[j]?.id)
        ) {
          banned.add(other[i].id);
        }
      }
      const bannedNodes = new Set(rootPath.map((s) => s.from));

      const spur = shortestPath(graph, spurNode, destId, byDistance, banned, bannedNodes);
      if (!spur) continue;

      const total = [...rootPath, ...spur];
      const key = total.map((s) => s.id).join(">");
      const seen = [...accepted, ...candidates].some(
        (p) => p.map((s) => s.id).join(">") === key,
      );
      if (!seen) candidates.push(total);
    }

    if (candidates.length === 0) break;
    candidates.sort(
      (a, b) =>
        a.reduce((x, s) => x + s.distanceKm, 0) - b.reduce((x, s) => x + s.distanceKm, 0),
    );
    accepted.push(candidates.shift()!);
  }

  // Drop near-duplicates: an alternate that is 40% longer is not a real choice.
  const shortest = accepted[0].reduce((a, s) => a + s.distanceKm, 0);
  return accepted
    .filter((p) => p.reduce((a, s) => a + s.distanceKm, 0) <= shortest * 1.4)
    .map((p, i) => toRoute(graph, p, i));
}

/** Cumulative distance from the origin to each place along a route, km. */
export function cumulativeDistances(route: Route): number[] {
  const out = [0];
  let acc = 0;
  for (const s of route.segments) {
    acc += s.distanceKm;
    out.push(acc);
  }
  return out;
}
