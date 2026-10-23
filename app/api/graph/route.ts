import { NextResponse } from "next/server";

import { TRIP_LOGS } from "@/lib/data/trips";
import { fleetCalibration, predictiveSigma } from "@/lib/energy/calibration";
import { VEHICLES } from "@/lib/energy/vehicles";
import { graphFallbackReason, loadGraphData } from "@/lib/graph/provider";
import { SUPPORTED_LANGUAGES } from "@/lib/sarvam";

export const dynamic = "force-dynamic";

/** Everything the form needs to render, in one round trip. */
export async function GET() {
  const data = await loadGraphData();
  const calibration = fleetCalibration();

  return NextResponse.json({
    source: data.source,
    // Surfaced rather than swallowed: if the app is on the bundled graph, the
    // person looking at it should be able to find out why without reading logs.
    fallbackReason: data.source === "bundled" ? graphFallbackReason() : null,
    places: data.places
      .map((p) => ({ id: p.id, name: p.name, city: p.city, elevationM: p.elevationM }))
      .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name)),
    chargers: data.chargers.map((c) => ({
      id: c.id,
      name: c.name,
      operator: c.operator,
      placeId: c.placeId,
      powerKw: c.powerKw,
      reliability: c.reliability,
    })),
    vehicles: VEHICLES.map((v) => {
      const cal = calibration.get(v.id);
      return {
        id: v.id,
        name: v.name,
        segment: v.segment,
        capacityKwh: v.capacityKwh,
        claimedRangeKm: v.claimedRangeKm,
        claimedRangeStandard: v.claimedRangeStandard,
        hasHvac: v.hvacPeakW > 0,
        calibration: cal
          ? {
              bias: cal.bias,
              sigma: predictiveSigma(cal),
              trips: cal.tripsObserved,
            }
          : null,
      };
    }),
    languages: SUPPORTED_LANGUAGES,
    fleet: { logsLoaded: TRIP_LOGS.length, sarvamConfigured: Boolean(process.env.SARVAM_API_KEY) },
  });
}
