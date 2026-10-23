import { calibrationFor, predictiveSigma } from "@/lib/energy/calibration";
import {
  planCharger,
  rankLevers,
  rankRisks,
  simulate,
  summarise,
} from "@/lib/energy/montecarlo";
import { vehicleById } from "@/lib/energy/vehicles";
import {
  corridorReliability,
  DEPENDABLE_RELIABILITY,
  findRouteOptions,
  loadGraphData,
} from "@/lib/graph/provider";
import { cumulativeDistances } from "@/lib/graph/routing";
import type { Charger, Route, TripRequest, Verdict } from "@/lib/types";

/**
 * Orchestration: request in, verdict out.
 *
 * Sample budget is split deliberately. The headline probability gets the most
 * samples because it is the number the driver acts on; route selection and the
 * sensitivity ablations get fewer, because they only need to rank options
 * rather than resolve a probability to a percentage point.
 */
const SAMPLES_HEADLINE = 4000;
const SAMPLES_ROUTE_PICK = 600;
const SAMPLES_ABLATION = 900;
const SAMPLES_CHARGER = 700;

/** Fixed base seed so the same request always returns the same verdict. */
function seedFor(req: TripRequest): number {
  const key = `${req.vehicleId}|${req.originId}|${req.destinationId}|${req.startSocPct}|${req.departureHour}|${req.ambientC}|${req.occupants}|${req.payloadKg}|${req.drivingStyle}|${req.reservePct}|${req.hvacOn}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The verdict wording. Three buckets, not a continuum, because "73%" alone
 * tells a driver nothing about what to do. The boundaries are a judgement call
 * and they are stated rather than hidden: above 0.92 the trip is routine,
 * below 0.70 it needs a charging stop, and the band between is the one where
 * the levers matter.
 */
function callFor(probability: number): Verdict["call"] {
  if (probability >= 0.92) return "yes";
  if (probability >= 0.7) return "tight";
  return "no";
}

function pct(x: number): string {
  return `${Math.round(x)}%`;
}

function buildExplanation(v: Omit<Verdict, "explanation">): string {
  const p = Math.round(v.probability * 100);
  // "a 0% chance" is wrong and sounds like a bug; the trip is merely very
  // unlikely, not impossible. Same at the top of the range.
  const odds = p === 0 ? "under 1%" : p === 100 ? "over 99%" : `${p}%`;
  const [lo, hi] = v.probabilityCi;
  const parts: string[] = [];

  const name = v.route.placeNames[v.route.placeNames.length - 1];
  const head =
    v.call === "yes"
      ? `Yes. ${odds} chance you reach ${name} above your reserve`
      : v.call === "tight"
        ? `Tight. ${odds} chance you make ${name} without stopping`
        : `No. Only ${odds === "under 1%" ? "an under-1%" : `a ${odds}`} chance you make ${name} on this charge`;
  parts.push(
    `${head} — confidence interval ${Math.round(lo * 100)}–${Math.round(hi * 100)}%.`,
  );

  parts.push(
    `Expect to arrive on ${pct(v.arrivalSoc.p50)}, with a bad-case floor of ${pct(v.arrivalSoc.p10)} and a good case of ${pct(v.arrivalSoc.p90)}.`,
  );

  parts.push(
    `This trip costs about ${Math.round(v.consumptionWhPerKm.p50)} Wh/km, against ${Math.round(v.claimed.impliedWhPerKm)} Wh/km implied by the ${v.claimed.standard} figure of ${v.claimed.rangeKm} km.`,
  );

  const hvacShare =
    v.energySplit.hvacKwh /
    Math.max(0.01, v.energySplit.tractionKwh + v.energySplit.hvacKwh + v.energySplit.auxKwh);
  if (hvacShare > 0.12) {
    parts.push(`Air conditioning alone is ${pct(hvacShare * 100)} of the energy.`);
  }

  const topRisk = v.risks[0];
  if (topRisk) {
    parts.push(
      `The biggest single unknown is ${topRisk.label.toLowerCase()} — pinning it down would move the answer by ${Math.round(Math.abs(topRisk.deltaProbability) * 100)} points.`,
    );
  }

  const topLever = v.levers[0];
  if (topLever && topLever.deltaProbability > 0.02) {
    // The label is not lowercased: it carries proper nouns and initialisms
    // ("Drive without AC", "Leave at 16:00 instead") that a blanket
    // toLowerCase turns into "drive without ac".
    parts.push(
      `Best thing you can do — ${topLever.label} — worth ${Math.round(topLever.deltaProbability * 100)} points.`,
    );
  }

  if (v.chargerPlan) {
    const c = v.chargerPlan;
    parts.push(
      `If you would rather not gamble, stop at ${c.chargerName} (${c.operator}) ${c.distanceIntoTripKm} km in — ${c.minutesToTargetSoc} min to ${c.targetSocPct}%, plus about ${c.expectedQueueMin} min of queue, and that site works ${pct(c.siteReliability * 100)} of the time. Taking it puts you at ${pct(c.probabilityWithStop * 100)}.`,
    );
  }

  if (v.corridor && v.corridor.longestGapKm > 60) {
    parts.push(
      `Worth knowing: the longest stretch of this corridor with no charger above ${Math.round(v.corridor.dependableThreshold * 100)}% uptime is ${Math.round(v.corridor.longestGapKm)} km.`,
    );
  }

  parts.push(
    `Calibrated on ${v.calibration.tripsObserved} logged trips for this model: physics corrected by ${((v.calibration.biasApplied - 1) * 100).toFixed(1)}%, residual spread ±${(v.calibration.residualSigma * 100).toFixed(1)}%.`,
  );

  return parts.join(" ");
}

export async function estimate(request: TripRequest): Promise<Verdict> {
  const vehicle = vehicleById(request.vehicleId);
  const calibration = calibrationFor(request.vehicleId);
  const seed = seedFor(request);

  const data = await loadGraphData();
  const places = new Map(data.places.map((p) => [p.id, p]));
  const chargersByPlace = new Map<string, Charger[]>();
  for (const c of data.chargers) {
    const list = chargersByPlace.get(c.placeId);
    if (list) list.push(c);
    else chargersByPlace.set(c.placeId, [c]);
  }

  const candidates = await findRouteOptions(data, request.originId, request.destinationId, 3);
  if (candidates.length === 0) {
    throw new Error(
      `No road route found from ${request.originId} to ${request.destinationId} in the loaded network`,
    );
  }

  // Score every candidate cheaply, then commit the sample budget to the winner.
  // Picking by probability rather than by distance matters: the Delhi-Agra
  // expressway is longer than the city route and wins anyway, because 100 km/h
  // of steady cruising beats three hours of stop-go with the compressor running.
  const scored = candidates.map((route: Route) => {
    const sim = simulate(vehicle, route.segments, places, request, calibration, {
      samples: SAMPLES_ROUTE_PICK,
      seed,
    });
    return { route, probability: sim.successRate };
  });
  scored.sort((a, b) => b.probability - a.probability);
  const chosen = scored[0].route;

  const headline = simulate(vehicle, chosen.segments, places, request, calibration, {
    samples: SAMPLES_HEADLINE,
    seed,
  });
  const stats = summarise(headline.samples);

  const risks = rankRisks(
    vehicle,
    chosen.segments,
    places,
    request,
    calibration,
    headline.successRate,
    seed,
    SAMPLES_ABLATION,
  );
  const levers = rankLevers(
    vehicle,
    chosen.segments,
    places,
    request,
    calibration,
    headline.successRate,
    seed,
    SAMPLES_ABLATION,
  );

  // Only plan a stop when the unassisted answer is not comfortable. Offering a
  // charging stop on a trip with 98% odds is noise.
  const chargerPlan =
    headline.successRate < 0.95
      ? planCharger(
          vehicle,
          chosen,
          places,
          chargersByPlace,
          request,
          calibration,
          seed,
          SAMPLES_CHARGER,
        )
      : null;

  const corridors = await corridorReliability(
    data,
    request.originId,
    request.destinationId,
    3,
  );
  const chosenKey = chosen.segments.map((s) => s.id).join(">");
  const corridorMatch =
    corridors.find((c) => c.segmentIds.join(">") === chosenKey) ?? corridors[0];

  const z = 1.96;
  const se = headline.successStderr;

  const shell: Omit<Verdict, "explanation"> = {
    probability: headline.successRate,
    call: callFor(headline.successRate),
    arrivalSoc: stats.arrivalSoc,
    probabilityCi: [
      Math.max(0, headline.successRate - z * se),
      Math.min(1, headline.successRate + z * se),
    ],
    consumptionWhPerKm: stats.consumptionWhPerKm,
    durationMin: stats.durationMin,
    route: {
      id: chosen.id,
      label: chosen.label,
      distanceKm: chosen.distanceKm,
      placeIds: chosen.placeIds,
      placeNames: chosen.placeIds.map((id) => places.get(id)?.name ?? id),
      elevationsM: chosen.placeIds.map((id) => places.get(id)?.elevationM ?? 0),
      cumulativeKm: cumulativeDistances(chosen),
      coords: chosen.placeIds.map((id) => {
        const p = places.get(id);
        return [p?.lon ?? 0, p?.lat ?? 0] as [number, number];
      }),
    },
    claimed: {
      rangeKm: vehicle.claimedRangeKm,
      standard: vehicle.claimedRangeStandard,
      impliedWhPerKm:
        (vehicle.capacityKwh * vehicle.usableFraction * 1000) / vehicle.claimedRangeKm,
    },
    risks,
    levers,
    chargerPlan,
    alternatives: scored.slice(1).map((s) => ({
      id: s.route.id,
      label: s.route.label,
      distanceKm: s.route.distanceKm,
      probability: s.probability,
    })),
    corridor: corridorMatch
      ? {
          longestGapKm: corridorMatch.longestGapKm,
          dependableSites: corridorMatch.dependableSites,
          weakestStopOdds: corridorMatch.weakestStopOdds,
          dependableThreshold: DEPENDABLE_RELIABILITY,
        }
      : null,
    segmentBreakdown: headline.medianSegments,
    energySplit: headline.energySplit,
    calibration: {
      biasApplied: calibration.bias,
      residualSigma: predictiveSigma(calibration),
      tripsObserved: calibration.tripsObserved,
    },
    graphSource: data.source,
    samples: SAMPLES_HEADLINE,
  };

  return { ...shell, explanation: buildExplanation(shell) };
}
