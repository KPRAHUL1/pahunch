import { NextResponse } from "next/server";
import { z } from "zod";

import { estimate } from "@/lib/estimate";
import { VEHICLES } from "@/lib/energy/vehicles";

export const dynamic = "force-dynamic";

/**
 * Validation is strict on purpose. A range answer built from a silently
 * coerced input is worse than an error, because the driver has no way to see
 * that the 32 degrees they meant arrived as a NaN.
 */
const RequestSchema = z.object({
  vehicleId: z.enum(VEHICLES.map((v) => v.id) as [string, ...string[]]),
  originId: z.string().min(1),
  destinationId: z.string().min(1),
  startSocPct: z.number().min(1).max(100),
  departureHour: z.number().int().min(0).max(23),
  ambientC: z.number().min(-10).max(52),
  occupants: z.number().int().min(1).max(7),
  payloadKg: z.number().min(0).max(400),
  drivingStyle: z.number().min(0).max(2),
  reservePct: z.number().min(0).max(50),
  hvacOn: z.boolean().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid trip request", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  if (parsed.data.originId === parsed.data.destinationId) {
    return NextResponse.json(
      { error: "Origin and destination are the same place" },
      { status: 400 },
    );
  }
  if (parsed.data.reservePct >= parsed.data.startSocPct) {
    return NextResponse.json(
      { error: "Reserve cannot be at or above the starting state of charge" },
      { status: 400 },
    );
  }

  try {
    const started = Date.now();
    const verdict = await estimate(parsed.data);
    return NextResponse.json({ ...verdict, computeMs: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Estimation failed";
    // 422 rather than 500: an unroutable pair is a problem with the request,
    // not with the server, and the UI should say so.
    const status = /No road route|Unknown/.test(message) ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
