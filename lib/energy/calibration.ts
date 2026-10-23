import { PLACES, SEGMENTS } from "@/lib/data/network";
import { TRIP_LOGS, type TripLog } from "@/lib/data/trips";
import { sampleConditions } from "@/lib/energy/conditions";
import { routeEnergy } from "@/lib/energy/physics";
import { vehicleById } from "@/lib/energy/vehicles";
import { makeRng, mean } from "@/lib/rng";
import type { Place, Segment, TripRequest } from "@/lib/types";

/**
 * Calibration: the layer that makes the confidence number mean something.
 *
 * A physics model of a car is biased. Not noisy -- biased, consistently, per
 * model, because of everything it leaves out. If you ship the raw model and
 * attach a confidence interval to it, the interval is centred in the wrong
 * place and the "87%" you print is decoration.
 *
 * So: for every logged trip, run the model on the conditions the driver
 * reported and take the ratio of observed to predicted energy. Fit those ratios
 * in log space. The mean becomes a multiplicative bias correction; the spread
 * becomes the model-error term the Monte Carlo samples. With few trips for a
 * vehicle the estimate is shrunk toward no-correction, so a vehicle with four
 * logged trips does not get a confident 11% correction off four noisy numbers.
 *
 * The subtlety that matters, and that the validation harness caught the hard
 * way: the raw spread of those ratios is NOT the model error. It also contains
 * the traffic, wind, load and driving-style variation that the predictor's own
 * Monte Carlo represents separately. Hand the raw spread to the predictor and
 * every one of those sources is counted twice, the arrival distribution comes
 * out too wide, and the probabilities collapse toward 50%. Measured on the
 * held-out set, that version reported 84% for trips that succeeded 100% of the
 * time and 16% for trips that succeeded 7% of the time.
 *
 * So each logged trip is predicted as a DISTRIBUTION, drawn from the same
 * sampler the predictor uses. The variance that sampler explains is subtracted
 * from the total residual variance, and only the remainder -- the part that
 * knowing the conditions would not fix -- is handed forward as model error.
 * That subtraction is why the stated confidence survives a reliability diagram.
 */

/** Prior spread of per-vehicle bias in log space, across the fleet. */
const BIAS_PRIOR_SIGMA = 0.08;
/** Prior MODEL-error spread when there are no trips at all. Deliberately wide. */
const RESIDUAL_PRIOR_SIGMA = 0.11;
/** Pseudo-count giving the model-error prior its weight. */
const RESIDUAL_PRIOR_WEIGHT = 6;
/**
 * Floor on model error. A physics model of a car with a claimed residual of
 * zero is not calibrated, it is overfitted, and the floor stops the predictor
 * from ever claiming more precision than this exercise can support.
 */
const MODEL_SIGMA_FLOOR = 0.04;
/** Draws per logged trip when measuring how much variance the sampler explains. */
const EXPLAIN_DRAWS = 96;

export interface Calibration {
  vehicleId: string;
  /** Multiply model energy by this. 1.0 means the physics needs no correction. */
  bias: number;
  /** Model-only residual spread after bias removal, as a fraction. */
  residualSigma: number;
  /** Standard error on the bias itself, log space. Folded into predictions. */
  biasSigma: number;
  tripsObserved: number;
}

export const UNCALIBRATED = (vehicleId: string): Calibration => ({
  vehicleId,
  bias: 1,
  residualSigma: RESIDUAL_PRIOR_SIGMA,
  biasSigma: BIAS_PRIOR_SIGMA,
  tripsObserved: 0,
});

/**
 * The trip as the predictor would have seen it before departure: only what the
 * driver reported, with no knowledge of how the conditions turned out.
 */
export function requestFromLog(log: TripLog): TripRequest {
  const r = log.reported;
  return {
    vehicleId: log.vehicleId,
    originId: log.originId,
    destinationId: log.destinationId,
    startSocPct: 100,
    departureHour: log.departureHour,
    ambientC: r.ambientC,
    occupants: r.occupants,
    payloadKg: r.payloadKg,
    drivingStyle: r.drivingStyle,
    reservePct: 0,
    hvacOn: r.hvacOn,
  };
}

interface Prediction {
  /** Mean predicted energy over the sampled conditions, kWh. */
  meanKwh: number;
  /** Spread the sampler itself explains, as a log-space standard deviation. */
  explainedSigma: number;
}

/**
 * Predicts one logged trip as a distribution rather than a point, using the
 * same condition sampler the live predictor uses. `explainedSigma` is the part
 * of the eventual residual that sampling already accounts for, and it is
 * subtracted rather than double-counted.
 */
function predictDistribution(
  log: TripLog,
  segmentsById: Map<string, Segment>,
  places: Map<string, Place>,
): Prediction | null {
  const segs = log.routeSegmentIds.map((id) => segmentsById.get(id));
  if (segs.some((s) => !s)) return null;
  const vehicle = vehicleById(log.vehicleId);
  const request = requestFromLog(log);

  // Seeded off the trip id, so calibration is reproducible run to run.
  let h = 0;
  for (let i = 0; i < log.id.length; i++) h = (h * 31 + log.id.charCodeAt(i)) >>> 0;
  const rng = makeRng(h || 1);

  const totals: number[] = [];
  for (let i = 0; i < EXPLAIN_DRAWS; i++) {
    const conditions = sampleConditions(request, vehicle, rng);
    const e = routeEnergy(vehicle, segs as Segment[], places, log.departureHour, conditions);
    if (e.totalKwh > 0) totals.push(e.totalKwh);
  }
  if (totals.length < 8) return null;

  const meanKwh = mean(totals);
  const logs = totals.map((t) => Math.log(t));
  const logMean = mean(logs);
  const variance = logs.reduce((acc, v) => acc + (v - logMean) ** 2, 0) / (logs.length - 1);

  return { meanKwh, explainedSigma: Math.sqrt(variance) };
}

/**
 * Fit per-vehicle calibration from a set of logs. Pass a subset to hold trips
 * out -- that is how `scripts/validate-calibration.ts` avoids grading itself on
 * the trips it learned from.
 */
export function fitCalibration(
  logs: TripLog[],
  segments: Segment[] = SEGMENTS,
  places: Place[] = PLACES,
): Map<string, Calibration> {
  const segmentsById = new Map(segments.map((s) => [s.id, s]));
  const placeMap = new Map(places.map((p) => [p.id, p]));

  interface Residual {
    logRatio: number;
    explainedVar: number;
  }
  const byVehicle = new Map<string, Residual[]>();

  for (const log of logs) {
    const prediction = predictDistribution(log, segmentsById, placeMap);
    if (!prediction) continue;
    const logRatio = Math.log(log.observedKwh / prediction.meanKwh);
    if (!Number.isFinite(logRatio)) continue;
    const entry = { logRatio, explainedVar: prediction.explainedSigma ** 2 };
    const list = byVehicle.get(log.vehicleId);
    if (list) list.push(entry);
    else byVehicle.set(log.vehicleId, [entry]);
  }

  const out = new Map<string, Calibration>();
  for (const [vehicleId, residuals] of byVehicle) {
    const n = residuals.length;
    const ratios = residuals.map((r) => r.logRatio);
    const sampleMean = mean(ratios);
    const totalVar =
      n >= 2
        ? ratios.reduce((acc, v) => acc + (v - sampleMean) ** 2, 0) / (n - 1)
        : RESIDUAL_PRIOR_SIGMA ** 2;

    // Variance decomposition: whatever the condition sampler already explains
    // comes off the top. What is left is model error, floored so the predictor
    // never claims a precision this exercise cannot support.
    const explainedVar = mean(residuals.map((r) => r.explainedVar));
    const modelVar = Math.max(MODEL_SIGMA_FLOOR ** 2, totalVar - explainedVar);

    // Pool with the prior so a two-trip vehicle does not claim a tight model.
    const residualSigma = Math.sqrt(
      ((n - 1) * modelVar + RESIDUAL_PRIOR_WEIGHT * RESIDUAL_PRIOR_SIGMA ** 2) /
        Math.max(1, n - 1 + RESIDUAL_PRIOR_WEIGHT),
    );

    // Normal-normal conjugate update on the log bias, prior centred at 0. The
    // precision uses the TOTAL residual variance, because that is the spread
    // the observed ratios actually have; using model variance alone would make
    // the bias look better determined than it is.
    const dataPrecision = n / Math.max(1e-6, totalVar);
    const priorPrecision = 1 / BIAS_PRIOR_SIGMA ** 2;
    const posteriorMean = (dataPrecision * sampleMean) / (dataPrecision + priorPrecision);
    const posteriorSigma = Math.sqrt(1 / (dataPrecision + priorPrecision));

    out.set(vehicleId, {
      vehicleId,
      bias: Math.exp(posteriorMean),
      residualSigma,
      biasSigma: posteriorSigma,
      tripsObserved: n,
    });
  }

  return out;
}

let cached: Map<string, Calibration> | null = null;

/** Fleet-wide calibration from the bundled logs, computed once per process. */
export function fleetCalibration(): Map<string, Calibration> {
  if (!cached) cached = fitCalibration(TRIP_LOGS);
  return cached;
}

export function calibrationFor(vehicleId: string): Calibration {
  return fleetCalibration().get(vehicleId) ?? UNCALIBRATED(vehicleId);
}

/**
 * Total predictive spread for a single trip, as a fraction of predicted energy.
 * Model error and bias uncertainty are independent in log space, so they add in
 * quadrature. This deliberately excludes the condition variance, which the
 * Monte Carlo represents directly -- folding it in here is the double-count the
 * validation harness caught.
 */
export function predictiveSigma(c: Calibration): number {
  return Math.sqrt(c.residualSigma ** 2 + c.biasSigma ** 2);
}

// --- Scoring, used by the validation script and by the tests ---------------

/** Brier score. Lower is better; 0.25 is what you get by always saying 50%. */
export function brierScore(predictions: number[], outcomes: boolean[]): number {
  if (predictions.length !== outcomes.length || predictions.length === 0) return NaN;
  let acc = 0;
  for (let i = 0; i < predictions.length; i++) {
    const y = outcomes[i] ? 1 : 0;
    acc += (predictions[i] - y) ** 2;
  }
  return acc / predictions.length;
}

export interface CalibrationBin {
  lo: number;
  hi: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

/** Reliability diagram data: are the 80% calls right about 80% of the time? */
export function reliabilityBins(
  predictions: number[],
  outcomes: boolean[],
  binCount = 10,
): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b++) {
    const lo = b / binCount;
    const hi = (b + 1) / binCount;
    const idx: number[] = [];
    for (let i = 0; i < predictions.length; i++) {
      const p = predictions[i];
      if (p >= lo && (p < hi || (b === binCount - 1 && p <= hi))) idx.push(i);
    }
    bins.push({
      lo,
      hi,
      count: idx.length,
      meanPredicted: idx.length ? mean(idx.map((i) => predictions[i])) : NaN,
      observedRate: idx.length ? idx.filter((i) => outcomes[i]).length / idx.length : NaN,
    });
  }
  return bins;
}

/** Expected calibration error: average |predicted - observed| weighted by bin size. */
export function expectedCalibrationError(bins: CalibrationBin[]): number {
  const total = bins.reduce((a, b) => a + b.count, 0);
  if (total === 0) return NaN;
  return (
    bins
      .filter((b) => b.count > 0)
      .reduce((a, b) => a + b.count * Math.abs(b.meanPredicted - b.observedRate), 0) / total
  );
}
