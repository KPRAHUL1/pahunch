import { describe, expect, it } from "vitest";

import { summariseCorridor, type CorridorRow } from "@/lib/graph/provider";

/**
 * The corridor reduction, tested on its own.
 *
 * This is the part that replaced a metric which looked rigorous and was
 * useless: `1 - prod(1 - reliability)` over every charger on a route reads
 * 1.0000 for every corridor once there are more than about four sites, so it
 * could not tell the Jaipur expressway apart from the Shimla ghat. The
 * replacement measures the longest stretch with no dependable option, and these
 * cases pin down the edges that make it meaningful -- in particular that the
 * stretch BEFORE the first dependable site and the run-in AFTER the last one
 * both count as exposure.
 */
const row = (
  distanceKm: number,
  waypoints: [number, number, number][],
): CorridorRow => ({
  placeIds: waypoints.map((_, i) => `p${i}`),
  segmentIds: [],
  distanceKm,
  waypoints: waypoints.map(([kmIntoTrip, siteCount, odds]) => ({
    placeId: `p${kmIntoTrip}`,
    kmIntoTrip,
    siteCount,
    odds,
  })),
});

describe("summariseCorridor", () => {
  it("measures the gap between consecutive dependable stops", () => {
    const out = summariseCorridor(
      row(300, [
        [0, 1, 0.9],
        [100, 1, 0.9],
        [300, 1, 0.9],
      ]),
    );
    expect(out.longestGapKm).toBe(200);
    expect(out.dependableSites).toBe(3);
  });

  it("counts the stretch before the first dependable stop", () => {
    // Leaving with no backup for 150 km is the exposure, even though the rest
    // of the corridor is well covered.
    const out = summariseCorridor(
      row(300, [
        [0, 0, 0],
        [150, 1, 0.9],
        [200, 1, 0.9],
        [250, 1, 0.9],
        [300, 1, 0.9],
      ]),
    );
    expect(out.longestGapKm).toBe(150);
  });

  it("counts the run-in after the last dependable stop", () => {
    // The real Delhi-to-Shimla corridor: dependable sites at CP, Murthal,
    // Karnal, Ambala and Chandigarh, then nothing above 70% for the whole ghat
    // climb. The answer has to be that final 117 km, not one of the plains
    // hops, which means the run-in past the last covered stop must count.
    const out = summariseCorridor(
      row(383, [
        [0, 1, 0.88], // CP
        [48, 1, 0.92], // Murthal
        [127, 1, 0.85], // Karnal
        [212, 1, 0.89], // Ambala
        [266, 1, 0.87], // Chandigarh
        [301, 0, 0], // Parwanoo, 58%
        [339, 0, 0], // Solan, 52%
        [383, 0, 0], // Shimla, 60%
      ]),
    );
    expect(out.longestGapKm).toBe(383 - 266);
  });

  it("treats an entirely uncovered corridor as one long gap", () => {
    const out = summariseCorridor(
      row(200, [
        [0, 0, 0],
        [100, 0, 0],
        [200, 0, 0],
      ]),
    );
    expect(out.longestGapKm).toBe(200);
    expect(out.dependableSites).toBe(0);
    expect(out.weakestStopOdds).toBe(0);
  });

  it("reports the weakest covered stop, not the average", () => {
    const out = summariseCorridor(
      row(200, [
        [0, 2, 0.99],
        [100, 1, 0.71],
        [200, 1, 0.95],
      ]),
    );
    expect(out.weakestStopOdds).toBeCloseTo(0.71, 9);
  });

  it("does not depend on the order Cypher returned the waypoints in", () => {
    // `collect` after `UNWIND` gives no ordering guarantee, so the reduction
    // sorts. If it stopped sorting, this is the test that would catch it.
    const forward = summariseCorridor(
      row(300, [
        [0, 1, 0.9],
        [100, 0, 0],
        [300, 1, 0.9],
      ]),
    );
    const shuffled = summariseCorridor(
      row(300, [
        [300, 1, 0.9],
        [0, 1, 0.9],
        [100, 0, 0],
      ]),
    );
    expect(shuffled.longestGapKm).toBe(forward.longestGapKm);
    expect(forward.longestGapKm).toBe(300);
  });

  it("reports no gap worth worrying about on a well-covered short hop", () => {
    const out = summariseCorridor(
      row(45, [
        [0, 1, 0.86],
        [23, 1, 0.88],
        [45, 1, 0.84],
      ]),
    );
    expect(out.longestGapKm).toBe(23);
  });
});
