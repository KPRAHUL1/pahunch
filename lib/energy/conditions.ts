import type { Conditions } from "@/lib/energy/physics";
import { OCCUPANT_MASS_KG } from "@/lib/energy/vehicles";
import type { Rng } from "@/lib/rng";
import type { TripRequest, Vehicle } from "@/lib/types";

/**
 * The nuisance-variable sampler, in one place.
 *
 * This module exists because of a bug that the validation harness caught, and
 * the fix is worth stating plainly because it is the difference between a
 * confidence number that means something and one that does not.
 *
 * The first version measured model residual spread by running the physics at
 * the *expected* traffic, wind, load and driving style, and comparing against
 * logged energy. That residual therefore already contained the variance those
 * four things contribute. The Monte Carlo then sampled all four again and
 * multiplied by the residual on top. The same uncertainty was counted twice,
 * the predictive distribution came out too wide, and the probabilities were
 * squashed toward 50% -- the reliability diagram showed 84% calls coming true
 * 100% of the time and 16% calls coming true 7% of the time.
 *
 * So both the calibrator and the predictor now draw from this one sampler, the
 * calibrator subtracts the variance it explains, and what is left is genuine
 * model error. Sharing the sampler is what makes that subtraction valid.
 */

/** Uncertainty sources that can be pinned to their expected value. */
export type Pinned =
  | "ambient"
  | "traffic"
  | "driver"
  | "wind"
  | "model"
  | "rolling"
  | "hvac"
  | null;

export function hvacDefault(req: TripRequest, vehicle: Vehicle): boolean {
  if (req.hvacOn !== undefined) return req.hvacOn;
  if (vehicle.hvacPeakW === 0) return false;
  // Nobody drives a Delhi summer afternoon with the windows down.
  return req.ambientC > 28 || req.ambientC < 14;
}

/**
 * One draw of the conditions a trip might actually encounter. Every spread here
 * is justified, because a made-up spread produces made-up confidence.
 */
export function sampleConditions(
  req: TripRequest,
  vehicle: Vehicle,
  rng: Rng,
  pin: Pinned = null,
): Conditions {
  // Ambient: a same-day forecast for an Indian city is good to about 2.5 C
  // one-sigma, and the route may run into a different micro-climate anyway.
  const ambientC = pin === "ambient" ? req.ambientC : rng.normalIn(req.ambientC, 2.5, -2, 50);

  // Traffic: lognormal around the segment's own hourly curve. Sigma 0.16 is the
  // spread of observed travel times on NCR corridors at a fixed hour -- one
  // accident or one convoy and the whole corridor shifts.
  const trafficMultiplier = pin === "traffic" ? 1 : rng.lognormal(1.0, 0.16);

  // Driver: the request gives a style, but the same driver varies trip to trip.
  // 0.06 one-sigma on the speed factor is roughly +/- 6 km/h at 100.
  const styleBase = 0.85 + req.drivingStyle * 0.17;
  const speedFactor = pin === "driver" ? styleBase : rng.normalIn(styleBase, 0.06, 0.6, 1.5);

  // Wind: no directional forecast is used, so the along-track component is
  // centred at zero with the magnitude of a typical plains breeze.
  const headwindMps = pin === "wind" ? 0 : rng.normal(0, 2.6);

  // Rolling resistance: tyre pressure drift and surface wear. Drivers check
  // pressure rarely, and 10% under-inflation is a real 4-6% range hit.
  const crrFactor = pin === "rolling" ? 1 : rng.normalIn(1.0, 0.06, 0.85, 1.22);

  const hvacOn = hvacDefault(req, vehicle);
  // HVAC duty cycle: once the cabin is cold the compressor cycles, so the mean
  // sits below 1 even in May.
  const hvacDuty = !hvacOn ? 0 : pin === "hvac" ? 0.8 : rng.normalIn(0.8, 0.15, 0.3, 1.0);

  return {
    ambientC,
    addedMassKg: req.occupants * OCCUPANT_MASS_KG + req.payloadKg,
    trafficMultiplier,
    speedFactor,
    headwindMps,
    crrFactor,
    hvacOn,
    hvacDuty,
    daylight: req.departureHour >= 7 && req.departureHour < 18,
  };
}
