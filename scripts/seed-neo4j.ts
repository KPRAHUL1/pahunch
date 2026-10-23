/**
 * Loads the bundled network into Neo4j. Run with `npm run seed`.
 *
 * Idempotent: it MERGEs on stable ids, so running it twice is harmless, and
 * `--wipe` clears the Place and Charger subgraph first if you want a clean
 * load. It deliberately does not touch anything else in the database.
 */

import neo4j from "neo4j-driver";

import { CHARGERS, PLACES, SEGMENTS } from "@/lib/data/network";
import { DEPENDABLE_RELIABILITY } from "@/lib/graph/provider";
import {
  CORRIDOR_RELIABILITY,
  SCHEMA_STATEMENTS,
  UPSERT_CHARGERS,
  UPSERT_PLACES,
  UPSERT_SEGMENTS,
  WIPE,
} from "@/lib/graph/queries";

async function main(): Promise<void> {
  const uri = process.env.NEO4J_URI ?? "bolt://localhost:7687";
  const user = process.env.NEO4J_USER ?? "neo4j";
  const password = process.env.NEO4J_PASSWORD;

  if (!password) {
    console.error(
      "NEO4J_PASSWORD is not set. Copy .env.example to .env and fill it in, or run:\n" +
        "  docker compose up -d\n" +
        "which starts Neo4j with the password from .env.example.",
    );
    process.exit(1);
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
    disableLosslessIntegers: true,
  });

  try {
    await driver.getServerInfo();
    console.log(`Connected to ${uri}`);
  } catch (err) {
    console.error(
      `Could not reach Neo4j at ${uri}: ${err instanceof Error ? err.message : err}`,
    );
    console.error("The app runs without it, on the bundled graph. Seeding is optional.");
    await driver.close();
    process.exit(1);
  }

  const session = driver.session();
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      await session.run(statement);
    }
    console.log(`Schema: ${SCHEMA_STATEMENTS.length} constraints and indexes ensured`);

    if (process.argv.includes("--wipe")) {
      await session.run(WIPE);
      console.log("Wiped existing Place and Charger nodes");
    }

    await session.run(UPSERT_PLACES, { places: PLACES });
    console.log(`Places: ${PLACES.length}`);

    // Segments carry the 24-element traffic curve as a list property, which
    // Neo4j stores natively -- no join table, no serialisation.
    await session.run(UPSERT_SEGMENTS, {
      segments: SEGMENTS.map((s) => ({
        id: s.id,
        from: s.from,
        to: s.to,
        distanceKm: s.distanceKm,
        roadClass: s.roadClass,
        speedLimitKmph: s.speedLimitKmph,
        trafficByHour: s.trafficByHour,
        surfacePenalty: s.surfacePenalty,
        stopsPerKm: s.stopsPerKm,
      })),
    });
    console.log(`Road segments: ${SEGMENTS.length} (both directions)`);

    await session.run(UPSERT_CHARGERS, { chargers: CHARGERS });
    console.log(`Chargers: ${CHARGERS.length}`);

    // Prove the interesting query works against what we just loaded, rather
    // than finding out at demo time.
    for (const [label, destinationId] of [
      ["Delhi to Jaipur", "jaipur"],
      // Delhi to Shimla is the longest path in the network at ten segments, and
      // it is the check that matters: the hop bound in ROUTES and
      // CORRIDOR_RELIABILITY has to clear it. When it did not, Cypher returned
      // nothing and the provider quietly fell back to the in-process search, so
      // the only symptom was a graph badge that said Neo4j while Neo4j was
      // answering none of the routing. Asserting it here makes that loud.
      ["Delhi to Shimla (longest path)", "shimla"],
    ] as const) {
      const check = await session.run(CORRIDOR_RELIABILITY, {
        originId: "del-cp",
        destinationId,
        limit: neo4j.int(3),
        minReliability: DEPENDABLE_RELIABILITY,
      });
      console.log("");
      console.log(`Corridor coverage, ${label}:`);
      if (check.records.length === 0) {
        console.error(
          `  NO PATH FOUND. The hop bound in queries.ts is too low for this corridor.`,
        );
        process.exitCode = 1;
        continue;
      }
      for (const record of check.records) {
        const row = record.toObject() as {
          segmentIds: string[];
          distanceKm: number;
          waypoints: { kmIntoTrip: number; siteCount: number; odds: number }[];
        };
        const covered = [...row.waypoints]
          .sort((a, b) => a.kmIntoTrip - b.kmIntoTrip)
          .filter((w) => w.siteCount > 0);
        let gap = covered.length === 0 ? row.distanceKm : covered[0].kmIntoTrip;
        for (let i = 1; i < covered.length; i++) {
          gap = Math.max(gap, covered[i].kmIntoTrip - covered[i - 1].kmIntoTrip);
        }
        if (covered.length > 0) {
          gap = Math.max(gap, row.distanceKm - covered[covered.length - 1].kmIntoTrip);
        }
        console.log(
          `  ${row.distanceKm.toFixed(0)} km over ${row.segmentIds.length} segments, ` +
            `${covered.length} dependable stops, longest gap ${gap.toFixed(0)} km`,
        );
      }
    }

    console.log("");
    if (process.exitCode === 1) {
      console.error("Seeded, but a corridor query found no path. Fix that before demoing.");
    } else {
      console.log("Seeded. The app will now answer from Neo4j rather than the bundled graph.");
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
