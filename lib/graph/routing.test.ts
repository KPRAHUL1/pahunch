import { describe, expect, it } from "vitest";

import { CHARGERS, PLACES, SEGMENTS } from "@/lib/data/network";
import { buildGraph, cumulativeDistances, findRoutes } from "@/lib/graph/routing";

const graph = buildGraph(PLACES, SEGMENTS);

describe("network data integrity", () => {
  it("has no segment pointing at a place that does not exist", () => {
    const ids = new Set(PLACES.map((p) => p.id));
    for (const s of SEGMENTS) {
      expect(ids.has(s.from), `${s.id} from`).toBe(true);
      expect(ids.has(s.to), `${s.id} to`).toBe(true);
    }
  });

  it("has no charger attached to a place that does not exist", () => {
    const ids = new Set(PLACES.map((p) => p.id));
    for (const c of CHARGERS) expect(ids.has(c.placeId), c.id).toBe(true);
  });

  it("stores every road in both directions, so gradient can flip sign", () => {
    const ids = new Set(SEGMENTS.map((s) => s.id));
    for (const s of SEGMENTS) expect(ids.has(`${s.to}__${s.from}`), s.id).toBe(true);
  });

  it("gives every segment a full 24-hour traffic curve in a sane range", () => {
    for (const s of SEGMENTS) {
      expect(s.trafficByHour).toHaveLength(24);
      for (const v of s.trafficByHour) {
        expect(v).toBeGreaterThan(0.1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("keeps charger reliability a probability", () => {
    for (const c of CHARGERS) {
      expect(c.reliability).toBeGreaterThan(0);
      expect(c.reliability).toBeLessThanOrEqual(1);
      expect(c.bays).toBeGreaterThanOrEqual(1);
    }
  });

  it("has unique ids throughout", () => {
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
    expect(new Set(SEGMENTS.map((s) => s.id)).size).toBe(SEGMENTS.length);
    expect(new Set(CHARGERS.map((c) => c.id)).size).toBe(CHARGERS.length);
  });
});

describe("findRoutes", () => {
  it("finds the Delhi to Jaipur corridor at a plausible distance", () => {
    const routes = findRoutes(graph, "del-cp", "jaipur");
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].distanceKm).toBeGreaterThan(230);
    expect(routes[0].distanceKm).toBeLessThan(320);
  });

  it("returns a connected chain of segments", () => {
    for (const route of findRoutes(graph, "del-cp", "shimla")) {
      expect(route.segments[0].from).toBe("del-cp");
      expect(route.segments[route.segments.length - 1].to).toBe("shimla");
      for (let i = 1; i < route.segments.length; i++) {
        expect(route.segments[i].from).toBe(route.segments[i - 1].to);
      }
      expect(route.placeIds).toHaveLength(route.segments.length + 1);
    }
  });

  it("orders candidates shortest first", () => {
    const routes = findRoutes(graph, "del-cp", "agra");
    for (let i = 1; i < routes.length; i++) {
      expect(routes[i].distanceKm).toBeGreaterThanOrEqual(routes[i - 1].distanceKm);
    }
  });

  it("offers a genuine alternative where one exists", () => {
    // Delhi to Agra can go via the Yamuna Expressway or down through Faridabad.
    const routes = findRoutes(graph, "del-cp", "agra", 3);
    expect(routes.length).toBeGreaterThan(1);
    const signatures = new Set(routes.map((r) => r.segments.map((s) => s.id).join(">")));
    expect(signatures.size).toBe(routes.length);
  });

  it("never revisits a place within one route", () => {
    for (const route of findRoutes(graph, "del-dwarka", "shimla", 3)) {
      expect(new Set(route.placeIds).size).toBe(route.placeIds.length);
    }
  });

  it("labels routes with something a driver would recognise", () => {
    const [route] = findRoutes(graph, "chandigarh", "shimla");
    expect(route.label).toContain("ghat");
  });

  it("rejects an unknown place rather than guessing", () => {
    expect(() => findRoutes(graph, "del-cp", "atlantis")).toThrow(/Unknown destination/);
    expect(() => findRoutes(graph, "atlantis", "del-cp")).toThrow(/Unknown origin/);
  });

  it("rejects a trip to where you already are", () => {
    expect(() => findRoutes(graph, "del-cp", "del-cp")).toThrow(/same place/);
  });

  it("reaches every place from Delhi, so the network is connected", () => {
    for (const place of PLACES) {
      if (place.id === "del-cp") continue;
      expect(findRoutes(graph, "del-cp", place.id, 1).length, place.id).toBeGreaterThan(0);
    }
  });
});

describe("cumulativeDistances", () => {
  it("starts at zero and ends at the route distance", () => {
    const [route] = findRoutes(graph, "del-cp", "chandigarh");
    const cum = cumulativeDistances(route);
    expect(cum[0]).toBe(0);
    expect(cum[cum.length - 1]).toBeCloseTo(route.distanceKm, 6);
    expect(cum).toHaveLength(route.placeIds.length);
  });

  it("increases monotonically", () => {
    const [route] = findRoutes(graph, "del-cp", "shimla");
    const cum = cumulativeDistances(route);
    for (let i = 1; i < cum.length; i++) expect(cum[i]).toBeGreaterThan(cum[i - 1]);
  });
});
