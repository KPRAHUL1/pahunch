/**
 * Validation. Run with `npm run validate`.
 *
 * Pahanch's whole claim is that the probability it prints is honest. That claim
 * is checkable, and this script checks it, on trips the calibration layer never
 * saw:
 *
 *   1. Does the calibration recover each vehicle's hidden efficiency offset?
 *   2. Are the probabilities calibrated -- do the 80% calls come true about 80%
 *      of the time -- measured by Brier score and expected calibration error?
 *   3. Does it beat the two things a driver has today: the nameplate range
 *      figure, and an uncalibrated physics point estimate?
 *
 * A model that fails (2) should not ship a percentage, and this is the test
 * that would catch it.
 */

import { PLACES, SEGMENTS } from "@/lib/data/network";
import { TRIP_LOGS, TRUE_BIAS, type TripLog } from "@/lib/data/trips";
import {
  brierScore,
  expectedCalibrationError,
  fitCalibration,
  predictiveSigma,
  reliabilityBins,
  UNCALIBRATED,
  type Calibration,
} from "@/lib/energy/calibration";
import { simulate } from "@/lib/energy/montecarlo";
import { packDerate } from "@/lib/energy/physics";
import { vehicleById } from "@/lib/energy/vehicles";
import { makeRng, mean } from "@/lib/rng";
import type { Segment, TripRequest } from "@/lib/types";

const SAMPLES_PER_TRIP = 500;
const RESERVE_PCT = 10;
const TRAIN_FRACTION = 0.7;

const places = new Map(PLACES.map((p) => [p.id, p]));
const segmentsById = new Map(SEGMENTS.map((s) => [s.id, s]));

/** Deterministic train/test split, stable across runs and machines. */
function split(logs: TripLog[]): { train: TripLog[]; test: TripLog[] } {
  const rng = makeRng(99221);
  const train: TripLog[] = [];
  const test: TripLog[] = [];
  for (const log of logs) {
    (rng.next() < TRAIN_FRACTION ? train : test).push(log);
  }
  return { train, test };
}

/**
 * Each held-out trip is turned into a yes/no question by assigning it a
 * departure SoC. The SoC is drawn so that the questions span the interesting
 * range -- some comfortable, some impossible, most genuinely uncertain. A test
 * set of only easy trips would score well and prove nothing.
 */
function scenarioFor(log: TripLog, rng: ReturnType<typeof makeRng>) {
  const vehicle = vehicleById(log.vehicleId);
  const fullUsableKwh =
    vehicle.capacityKwh * vehicle.usableFraction * packDerate(log.reported.ambientC);
  // Tightness: how much of the trip's observed energy the driver sets out with.
  // 0.75 means they left with three-quarters of what the trip actually took.
  const tightness = 0.75 + rng.next() * 0.65;
  const startSocPct = Math.min(
    100,
    Math.max(
      15,
      ((log.observedKwh * tightness) / fullUsableKwh) * 100 + RESERVE_PCT,
    ),
  );

  const request: TripRequest = {
    vehicleId: log.vehicleId,
    originId: log.originId,
    destinationId: log.destinationId,
    startSocPct,
    departureHour: log.departureHour,
    ambientC: log.reported.ambientC,
    occupants: log.reported.occupants,
    payloadKg: log.reported.payloadKg,
    drivingStyle: log.reported.drivingStyle,
    reservePct: RESERVE_PCT,
    hvacOn: log.reported.hvacOn,
  };

  // Ground truth: what the vehicle's own energy counter says happened.
  const availableKwh = (fullUsableKwh * (startSocPct - RESERVE_PCT)) / 100;
  const madeIt = log.observedKwh <= availableKwh;

  return { request, madeIt, fullUsableKwh, availableKwh, vehicle };
}

function predictProbability(log: TripLog, request: TripRequest, calibration: Calibration): number | null {
  const segs = log.routeSegmentIds.map((id) => segmentsById.get(id));
  if (segs.some((s) => !s)) return null;
  const sim = simulate(
    vehicleById(log.vehicleId),
    segs as Segment[],
    places,
    request,
    calibration,
    { samples: SAMPLES_PER_TRIP, seed: 7000 + log.routeSegmentIds.length * 31 + log.id.length },
  );
  return sim.successRate;
}

/** Baseline 1: the number on the brochure. What a driver has today. */
function nameplateBaseline(log: TripLog, request: TripRequest): number {
  const vehicle = vehicleById(log.vehicleId);
  const usableRangeKm =
    (vehicle.claimedRangeKm * (request.startSocPct - RESERVE_PCT)) / 100;
  // A deterministic claim, which is exactly the problem with it.
  return log.distanceKm <= usableRangeKm ? 1 : 0;
}

/** Baseline 2: our physics, uncalibrated, reported as a point estimate. */
function pointEstimateBaseline(log: TripLog, request: TripRequest): number | null {
  const p = predictProbability(log, request, UNCALIBRATED(log.vehicleId));
  if (p === null) return null;
  return p >= 0.5 ? 1 : 0;
}

function fmt(x: number, digits = 3): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function main(): void {
  const { train, test } = split(TRIP_LOGS);
  const calibration = fitCalibration(train);

  console.log("");
  console.log("Pahunch — calibration validation");
  console.log("=".repeat(78));
  console.log(
    `Logs: ${TRIP_LOGS.length} total, ${train.length} train, ${test.length} held out.`,
  );
  console.log(
    `Each held-out trip is a yes/no question: starting at its assigned SoC, did the`,
  );
  console.log(
    `vehicle's own energy counter come in under what the pack could deliver?`,
  );
  console.log("");

  // --- 1. Bias recovery ----------------------------------------------------
  console.log("1. Does calibration recover the hidden per-vehicle offset?");
  console.log("-".repeat(78));
  console.log(
    `${pad("vehicle", 24)}${padLeft("true", 8)}${padLeft("fitted", 9)}${padLeft("err", 8)}${padLeft("sigma", 9)}${padLeft("trips", 7)}`,
  );
  const errors: number[] = [];
  for (const [vehicleId, trueBias] of Object.entries(TRUE_BIAS)) {
    const c = calibration.get(vehicleId);
    if (!c) {
      console.log(`${pad(vehicleById(vehicleId).name, 24)}${padLeft(fmt(trueBias), 8)}   (no trips in train split)`);
      continue;
    }
    const err = c.bias - trueBias;
    errors.push(Math.abs(err));
    console.log(
      `${pad(vehicleById(vehicleId).name, 24)}` +
        `${padLeft(fmt(trueBias), 8)}` +
        `${padLeft(fmt(c.bias), 9)}` +
        `${padLeft((err >= 0 ? "+" : "") + fmt(err), 8)}` +
        `${padLeft(fmt(predictiveSigma(c)), 9)}` +
        `${padLeft(String(c.tripsObserved), 7)}`,
    );
  }
  console.log("");
  console.log(
    `Mean absolute bias error: ${fmt(mean(errors))}  (the offsets are 2-11%, so this`,
  );
  console.log(
    `is the margin by which the model's systematic error has been removed.)`,
  );
  console.log("");

  // --- 2. Are the probabilities honest? ------------------------------------
  const rng = makeRng(5150);
  const predictions: number[] = [];
  const outcomes: boolean[] = [];
  const namePlatePreds: number[] = [];
  const pointPreds: number[] = [];

  for (const log of test) {
    const { request, madeIt } = scenarioFor(log, rng);
    const cal = calibration.get(log.vehicleId) ?? UNCALIBRATED(log.vehicleId);
    const p = predictProbability(log, request, cal);
    if (p === null) continue;
    const point = pointEstimateBaseline(log, request);
    if (point === null) continue;

    predictions.push(p);
    outcomes.push(madeIt);
    namePlatePreds.push(nameplateBaseline(log, request));
    pointPreds.push(point);
  }

  console.log(`2. Are the probabilities calibrated? (${predictions.length} held-out trips)`);
  console.log("-".repeat(78));
  const bins = reliabilityBins(predictions, outcomes, 10);
  console.log(
    `${pad("predicted band", 18)}${padLeft("n", 6)}${padLeft("mean P", 10)}${padLeft("actual", 10)}${padLeft("gap", 9)}`,
  );
  for (const b of bins) {
    if (b.count === 0) continue;
    console.log(
      `${pad(`${(b.lo * 100).toFixed(0)}-${(b.hi * 100).toFixed(0)}%`, 18)}` +
        `${padLeft(String(b.count), 6)}` +
        `${padLeft(fmt(b.meanPredicted), 10)}` +
        `${padLeft(fmt(b.observedRate), 10)}` +
        `${padLeft(fmt(b.observedRate - b.meanPredicted), 9)}`,
    );
  }
  const ece = expectedCalibrationError(bins);
  console.log("");
  console.log(`Expected calibration error: ${fmt(ece)}`);
  console.log(
    `  (0 would be perfect. Below ~0.08 means the stated confidence is usable;`,
  );
  console.log(
    `   above ~0.15 means the number is decoration and should not be shown.)`,
  );
  console.log("");

  // --- 3. Against what a driver has today ----------------------------------
  const ourBrier = brierScore(predictions, outcomes);
  const nameplateBrier = brierScore(namePlatePreds, outcomes);
  const pointBrier = brierScore(pointPreds, outcomes);
  const baseRate = mean(outcomes.map((o) => (o ? 1 : 0)));
  const climatologyBrier = brierScore(predictions.map(() => baseRate), outcomes);

  console.log("3. Brier score against the alternatives (lower is better)");
  console.log("-".repeat(78));
  console.log(`${pad("Pahunch (calibrated, probabilistic)", 44)}${padLeft(fmt(ourBrier), 8)}`);
  console.log(`${pad("Physics point estimate (uncalibrated)", 44)}${padLeft(fmt(pointBrier), 8)}`);
  console.log(`${pad("Nameplate range figure", 44)}${padLeft(fmt(nameplateBrier), 8)}`);
  console.log(`${pad("Always predict the base rate", 44)}${padLeft(fmt(climatologyBrier), 8)}`);
  console.log("");
  const skill = 1 - ourBrier / climatologyBrier;
  console.log(
    `Brier skill score vs. the base rate: ${fmt(skill)} (0 = no better than knowing`,
  );
  console.log(`how often trips succeed in general; 1 = perfect).`);
  console.log(
    `Observed success rate in the held-out set: ${fmt(baseRate)} — a mixed test set,`,
  );
  console.log(`not a set of easy questions.`);
  console.log("");

  // --- Pass/fail -----------------------------------------------------------
  const checks: [string, boolean, string][] = [
    ["bias recovered to within 0.03", mean(errors) < 0.03, fmt(mean(errors))],
    ["expected calibration error < 0.08", ece < 0.08, fmt(ece)],
    ["beats the nameplate figure", ourBrier < nameplateBrier, `${fmt(ourBrier)} vs ${fmt(nameplateBrier)}`],
    ["beats an uncalibrated point estimate", ourBrier < pointBrier, `${fmt(ourBrier)} vs ${fmt(pointBrier)}`],
    ["has real skill over the base rate", skill > 0.25, fmt(skill)],
  ];
  console.log("Success criteria");
  console.log("-".repeat(78));
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${pad(name, 42)} ${detail}`);
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

main();
