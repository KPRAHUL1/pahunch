/**
 * Cypher for Pahunch.
 *
 * The road network is a graph, and the questions a range planner has to answer
 * are graph questions, not table questions:
 *
 *   - "give me the plausible routes"  -> weighted path enumeration
 *   - "which chargers can I still reach on what is left in the pack"
 *                                     -> bounded traversal with an accumulator
 *   - "which corridor is most likely to have a working charger when I need one"
 *                                     -> maximum-reliability path, where the
 *                                        edge weight is a probability and the
 *                                        path cost is a product, not a sum
 *
 * That last one is the reason this is in Neo4j rather than Postgres. Composing
 * probabilities along a path is natural in Cypher with `reduce` over the
 * relationships and awkward in SQL at any depth beyond two joins.
 */

export const SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT place_id IF NOT EXISTS FOR (p:Place) REQUIRE p.id IS UNIQUE",
  "CREATE CONSTRAINT charger_id IF NOT EXISTS FOR (c:Charger) REQUIRE c.id IS UNIQUE",
  "CREATE INDEX place_city IF NOT EXISTS FOR (p:Place) ON (p.city)",
  "CREATE INDEX charger_reliability IF NOT EXISTS FOR (c:Charger) ON (c.reliability)",
];

export const WIPE = "MATCH (n) WHERE n:Place OR n:Charger DETACH DELETE n";

export const UPSERT_PLACES = `
UNWIND $places AS row
MERGE (p:Place {id: row.id})
SET p.name = row.name,
    p.city = row.city,
    p.lat = row.lat,
    p.lon = row.lon,
    p.elevationM = row.elevationM
`;

export const UPSERT_SEGMENTS = `
UNWIND $segments AS row
MATCH (a:Place {id: row.from})
MATCH (b:Place {id: row.to})
MERGE (a)-[r:ROAD {id: row.id}]->(b)
SET r.distanceKm = row.distanceKm,
    r.roadClass = row.roadClass,
    r.speedLimitKmph = row.speedLimitKmph,
    r.trafficByHour = row.trafficByHour,
    r.surfacePenalty = row.surfacePenalty,
    r.stopsPerKm = row.stopsPerKm,
    r.riseM = b.elevationM - a.elevationM
`;

export const UPSERT_CHARGERS = `
UNWIND $chargers AS row
MATCH (p:Place {id: row.placeId})
MERGE (c:Charger {id: row.id})
SET c.name = row.name,
    c.operator = row.operator,
    c.powerKw = row.powerKw,
    c.connectors = row.connectors,
    c.reliability = row.reliability,
    c.meanQueueMin = row.meanQueueMin,
    c.bays = row.bays
MERGE (c)-[:AT]->(p)
`;

export const FETCH_PLACES = `
MATCH (p:Place)
RETURN p.id AS id, p.name AS name, p.city AS city,
       p.lat AS lat, p.lon AS lon, p.elevationM AS elevationM
ORDER BY p.city, p.name
`;

export const FETCH_SEGMENTS = `
MATCH (a:Place)-[r:ROAD]->(b:Place)
RETURN r.id AS id, a.id AS from, b.id AS to,
       r.distanceKm AS distanceKm, r.roadClass AS roadClass,
       r.speedLimitKmph AS speedLimitKmph, r.trafficByHour AS trafficByHour,
       r.surfacePenalty AS surfacePenalty, r.stopsPerKm AS stopsPerKm
`;

export const FETCH_CHARGERS = `
MATCH (c:Charger)-[:AT]->(p:Place)
RETURN c.id AS id, c.name AS name, c.operator AS operator, p.id AS placeId,
       c.powerKw AS powerKw, c.connectors AS connectors,
       c.reliability AS reliability, c.meanQueueMin AS meanQueueMin, c.bays AS bays
ORDER BY c.reliability DESC
`;

/**
 * Candidate routes, shortest first.
 *
 * `reduce` over the relationships is the whole trick: it turns a path into a
 * scalar cost that ORDER BY can use, without a projection step.
 *
 * The hop bound is 12 and that number is load-bearing. Delhi to Shimla is TEN
 * road segments (NH44 through Murthal, Panipat, Karnal, Ambala, Zirakpur and
 * Chandigarh, then the ghat through Parwanoo, Solan and Kandaghat), and eleven
 * from the Dwarka approach. An earlier bound of 9 returned no route at all for
 * the single most interesting trip in the network -- and because the provider
 * falls back to the in-process search when Cypher returns nothing, it would
 * have done so silently. Expansion stays cheap because Neo4j enforces
 * relationship uniqueness on variable-length patterns, and the WHERE clause
 * adds node uniqueness on top.
 */
export const ROUTES = `
MATCH path = (a:Place {id: $originId})-[:ROAD*1..12]->(b:Place {id: $destinationId})
WHERE ALL(n IN nodes(path) WHERE single(m IN nodes(path) WHERE m = n))
WITH path,
     reduce(km = 0.0, r IN relationships(path) | km + r.distanceKm) AS distanceKm
ORDER BY distanceKm ASC
LIMIT $limit
RETURN [n IN nodes(path) | n.id] AS placeIds,
       [r IN relationships(path) | r.id] AS segmentIds,
       distanceKm
`;

/**
 * Chargers still reachable on the energy left in the pack, as a bounded
 * traversal from the current position. The energy bound is approximated with a
 * flat Wh/km figure here on purpose: this query is a *filter* that narrows two
 * dozen sites to the handful worth simulating properly, and the real physics
 * then runs on those. Doing full physics inside Cypher would be both slow and
 * the wrong place for it.
 */
export const REACHABLE_CHARGERS = `
MATCH path = (origin:Place {id: $originId})-[:ROAD*1..6]->(stop:Place)
WHERE ALL(n IN nodes(path) WHERE single(m IN nodes(path) WHERE m = n))
WITH stop,
     min(reduce(km = 0.0, r IN relationships(path) | km + r.distanceKm)) AS distanceKm
WHERE distanceKm * $whPerKm / 1000.0 <= $availableKwh
MATCH (c:Charger)-[:AT]->(stop)
RETURN c.id AS chargerId, c.name AS name, c.operator AS operator,
       c.powerKw AS powerKw, c.reliability AS reliability, c.bays AS bays,
       stop.id AS placeId, stop.name AS placeName, distanceKm
ORDER BY c.reliability * c.powerKw DESC
`;

/**
 * Charger coverage along each candidate corridor.
 *
 * The first version of this asked "what is the probability that at least one
 * charger on this corridor is working" -- 1 - prod(1 - reliability) over every
 * site on the path. It was elegant and it was useless: with seven to ten sites
 * on a corridor the answer is 1.0000 every time, for every route. A metric that
 * cannot distinguish the Jaipur run from the Shimla climb is decoration.
 *
 * The question a driver is actually exposed to is not "is there a working
 * charger somewhere on this road" but "how far must I go with no dependable
 * option". So this returns, per candidate path, each waypoint with its distance
 * into the trip and the composed odds that something dependable there works,
 * and the caller reduces that to the longest uncovered stretch.
 *
 * The split is deliberate. Path enumeration, per-site aggregation and composing
 * probabilities at a stop are graph operations and belong here -- note
 * `reduce` doing both the cumulative distance and the product over
 * reliabilities. Scanning an ordered list for its largest gap is not a graph
 * operation, and expressing it as a `reduce` over a range with a map
 * accumulator would be showing off at the cost of anyone ever reading it again.
 */
export const CORRIDOR_RELIABILITY = `
MATCH path = (a:Place {id: $originId})-[:ROAD*1..12]->(b:Place {id: $destinationId})
WHERE ALL(n IN nodes(path) WHERE single(m IN nodes(path) WHERE m = n))
WITH path, nodes(path) AS ns, relationships(path) AS rs,
     reduce(km = 0.0, r IN relationships(path) | km + r.distanceKm) AS distanceKm
ORDER BY distanceKm ASC
LIMIT $limit
UNWIND range(0, size(ns) - 1) AS i
WITH path, ns, rs, distanceKm, ns[i] AS stop,
     reduce(k = 0.0, j IN range(0, i - 1) | k + rs[j].distanceKm) AS kmIntoTrip
OPTIONAL MATCH (c:Charger)-[:AT]->(stop)
  WHERE c.reliability >= $minReliability
WITH path, ns, rs, distanceKm, stop, kmIntoTrip,
     collect(c.reliability) AS dependable
WITH path, ns, rs, distanceKm,
     collect({
       placeId: stop.id,
       kmIntoTrip: kmIntoTrip,
       siteCount: size(dependable),
       odds: 1.0 - reduce(p = 1.0, x IN dependable | p * (1.0 - x))
     }) AS waypoints
RETURN [n IN ns | n.id] AS placeIds,
       [r IN rs | r.id] AS segmentIds,
       distanceKm,
       waypoints
ORDER BY distanceKm ASC
`;
