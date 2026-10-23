"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  ArrivalBand,
  EnergySplit,
  ProbabilityDial,
  RouteProfile,
  SegmentTable,
} from "@/components/charts";
import type { TripRequest, Verdict } from "@/lib/types";

interface GraphMeta {
  source: "neo4j" | "bundled";
  places: { id: string; name: string; city: string; elevationM: number }[];
  chargers: {
    id: string;
    name: string;
    operator: string;
    placeId: string;
    powerKw: number;
    reliability: number;
  }[];
  vehicles: {
    id: string;
    name: string;
    segment: string;
    capacityKwh: number;
    claimedRangeKm: number;
    claimedRangeStandard: string;
    hasHvac: boolean;
    calibration: { bias: number; sigma: number; trips: number } | null;
  }[];
  languages: readonly { code: string; label: string; native: string }[];
  fleet: { logsLoaded: number; sarvamConfigured: boolean };
}

interface Spoken {
  language: string;
  text: string;
  audioBase64: string | null;
  available: boolean;
  reason?: string;
}

/**
 * Three scenarios that each break a different assumption, so the first thing a
 * visitor sees is the point of the project rather than an empty form:
 *   - Jaipur: a trip the brochure says is comfortable and that is not.
 *   - Shimla: gradient, where no flat Wh/km figure survives.
 *   - Agra at 18:00: the same distance, made harder by the clock.
 */
const PRESETS: { label: string; hint: string; request: Partial<TripRequest> }[] = [
  {
    label: "Delhi → Jaipur, May afternoon",
    hint: "The brochure says 465 km. It is 270 km and 42 °C.",
    request: {
      vehicleId: "nexon-ev-45",
      originId: "del-cp",
      destinationId: "jaipur",
      startSocPct: 100,
      departureHour: 13,
      ambientC: 42,
      occupants: 4,
      payloadKg: 40,
      drivingStyle: 1.2,
      reservePct: 10,
      hvacOn: true,
    },
  },
  {
    label: "Chandigarh → Shimla",
    hint: "1 900 m of climb in 117 km, on 52%-reliable chargers.",
    request: {
      vehicleId: "windsor-ev",
      originId: "chandigarh",
      destinationId: "shimla",
      startSocPct: 85,
      departureHour: 8,
      ambientC: 18,
      occupants: 3,
      payloadKg: 50,
      drivingStyle: 0.9,
      reservePct: 15,
      hvacOn: false,
    },
  },
  {
    label: "Delhi → Agra, evening peak",
    hint: "Same road, 18:00 departure. The clock is the variable.",
    request: {
      vehicleId: "tiago-ev-24",
      originId: "del-cp",
      destinationId: "agra",
      startSocPct: 95,
      departureHour: 18,
      ambientC: 34,
      occupants: 2,
      payloadKg: 15,
      drivingStyle: 1,
      reservePct: 10,
      hvacOn: true,
    },
  },
];

const DEFAULT_REQUEST: TripRequest = {
  vehicleId: "nexon-ev-45",
  originId: "del-cp",
  destinationId: "jaipur",
  startSocPct: 100,
  departureHour: 13,
  ambientC: 42,
  occupants: 4,
  payloadKg: 40,
  drivingStyle: 1.2,
  reservePct: 10,
  hvacOn: true,
};

const STYLE_WORDS = ["Hypermiling", "Gentle", "Normal", "Brisk", "Aggressive"];
const styleWord = (v: number) => STYLE_WORDS[Math.min(4, Math.round(v * 2))];

function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-xs font-medium text-slate-400">
        {label}
        {value !== undefined && <span className="num text-slate-200">{value}</span>}
      </span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

const selectClass =
  "w-full rounded-md border border-ink-600 bg-ink-800 px-2.5 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500";

function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900/70 p-4 sm:p-5">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-slate-200">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export default function Console() {
  const [meta, setMeta] = useState<GraphMeta | null>(null);
  const [request, setRequest] = useState<TripRequest>(DEFAULT_REQUEST);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  /**
   * The request that produced the verdict on screen. Comparing it against the
   * live form is what lets the UI admit the answer is out of date. Without it,
   * changing the vehicle and destination left last trip's verdict sitting under
   * this trip's inputs, which is worse than showing nothing: it reads as an
   * answer to the question on screen.
   */
  const [answeredRequest, setAnsweredRequest] = useState<TripRequest | null>(null);
  const [computeMs, setComputeMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [language, setLanguage] = useState("hi-IN");
  const [spoken, setSpoken] = useState<Spoken | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/graph")
      .then((r) => r.json())
      .then((d: GraphMeta) => {
        if (alive) setMeta(d);
      })
      .catch(() => {
        if (alive) setError("Could not load the road network.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const vehicle = useMemo(
    () => meta?.vehicles.find((v) => v.id === request.vehicleId) ?? null,
    [meta, request.vehicleId],
  );

  /**
   * Takes the request explicitly so a caller that has just built a new one can
   * run it immediately, rather than waiting a render for the state to settle
   * and running the previous request by accident.
   */
  const run = useCallback(
    async (req: TripRequest) => {
      setLoading(true);
      setError(null);
      setSpoken(null);
      try {
        const res = await fetch("/api/estimate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(body.error ?? "Estimation failed.");
          setVerdict(null);
          setAnsweredRequest(null);
          return;
        }
        setVerdict(body as Verdict);
        setAnsweredRequest(req);
        setComputeMs(body.computeMs ?? null);
      } catch {
        setError("Could not reach the estimator.");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Run the default scenario once the network is loaded, so the page lands on a
  // real answer rather than on an invitation to fill in a form.
  const didInitialRun = useRef(false);
  useEffect(() => {
    if (meta && !didInitialRun.current) {
      didInitialRun.current = true;
      void run(DEFAULT_REQUEST);
    }
  }, [meta, run]);

  const speak = useCallback(async () => {
    if (!verdict) return;
    setSpeaking(true);
    try {
      const res = await fetch("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: verdict.explanation, language, withAudio: true }),
      });
      const body = (await res.json()) as Spoken;
      setSpoken(body);
      if (body.audioBase64 && audioRef.current) {
        audioRef.current.src = `data:audio/wav;base64,${body.audioBase64}`;
        void audioRef.current.play().catch(() => {
          /* Autoplay refusal is not an error worth surfacing; the control is there. */
        });
      }
    } catch {
      setSpoken({
        language,
        text: verdict.explanation,
        audioBase64: null,
        available: false,
        reason: "The translation request did not complete.",
      });
    } finally {
      setSpeaking(false);
    }
  }, [verdict, language]);

  const set = <K extends keyof TripRequest>(key: K, value: TripRequest[K]) =>
    setRequest((r) => ({ ...r, [key]: value }));

  const places = meta?.places ?? [];
  const sameEnds = request.originId === request.destinationId;
  const stale =
    answeredRequest !== null && JSON.stringify(answeredRequest) !== JSON.stringify(request);

  return (
    <div className="mx-auto max-w-[88rem] px-4 pb-20 pt-8 sm:px-6">
      <header className="mb-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
              Pahunch
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-400">
              Tell an Indian driver the truth, with a confidence level attached. This
              refuses to print a range figure. It prints the probability you arrive
              above your own reserve, and shows its working.
            </p>
          </div>
          <dl className="num flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-500">
            <div>
              <dt className="inline text-slate-600">graph </dt>
              <dd
                className={`inline font-semibold ${meta?.source === "neo4j" ? "text-emerald-400" : "text-amber-400"}`}
              >
                {meta ? (meta.source === "neo4j" ? "Neo4j" : "bundled fallback") : "…"}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-600">fleet logs </dt>
              <dd className="inline font-semibold text-slate-300">
                {meta?.fleet.logsLoaded ?? "…"}
              </dd>
            </div>
            <div>
              <dt className="inline text-slate-600">Sarvam </dt>
              <dd
                className={`inline font-semibold ${meta?.fleet.sarvamConfigured ? "text-emerald-400" : "text-slate-500"}`}
              >
                {meta?.fleet.sarvamConfigured ? "connected" : "no key"}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => {
              const next = { ...DEFAULT_REQUEST, ...p.request };
              setRequest(next);
              void run(next);
            }}
            className="group rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2 text-left transition hover:border-sky-600 hover:bg-ink-800"
          >
            <span className="block text-xs font-semibold text-slate-200">{p.label}</span>
            <span className="block text-[11px] text-slate-500 group-hover:text-slate-400">
              {p.hint}
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[20rem_1fr]">
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-4">
          <Panel title="The trip">
            <div className="space-y-3.5">
              <Field label="Vehicle">
                <select
                  className={selectClass}
                  value={request.vehicleId}
                  onChange={(e) => set("vehicleId", e.target.value)}
                >
                  {meta?.vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} — {v.capacityKwh} kWh
                    </option>
                  ))}
                </select>
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="From">
                  <select
                    className={selectClass}
                    value={request.originId}
                    onChange={(e) => set("originId", e.target.value)}
                  >
                    {places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.city} · {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="To">
                  <select
                    className={selectClass}
                    value={request.destinationId}
                    onChange={(e) => set("destinationId", e.target.value)}
                  >
                    {places.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.city} · {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <Field label="Charge at departure" value={`${request.startSocPct}%`}>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={1}
                  className="w-full"
                  value={request.startSocPct}
                  onChange={(e) => set("startSocPct", Number(e.target.value))}
                />
              </Field>

              <Field
                label="Reserve you refuse to go below"
                value={`${request.reservePct}%`}
              >
                <input
                  type="range"
                  min={0}
                  max={30}
                  step={1}
                  className="w-full"
                  value={request.reservePct}
                  onChange={(e) => set("reservePct", Number(e.target.value))}
                />
              </Field>

              <Field
                label="Departure"
                value={`${String(request.departureHour).padStart(2, "0")}:00 IST`}
              >
                <input
                  type="range"
                  min={0}
                  max={23}
                  step={1}
                  className="w-full"
                  value={request.departureHour}
                  onChange={(e) => set("departureHour", Number(e.target.value))}
                />
              </Field>

              <Field label="Ambient temperature" value={`${request.ambientC} °C`}>
                <input
                  type="range"
                  min={2}
                  max={50}
                  step={1}
                  className="w-full"
                  value={request.ambientC}
                  onChange={(e) => set("ambientC", Number(e.target.value))}
                />
              </Field>

              <div className="grid grid-cols-2 gap-2">
                <Field label="People" value={String(request.occupants)}>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    step={1}
                    className="w-full"
                    value={request.occupants}
                    onChange={(e) => set("occupants", Number(e.target.value))}
                  />
                </Field>
                <Field label="Luggage" value={`${request.payloadKg} kg`}>
                  <input
                    type="range"
                    min={0}
                    max={150}
                    step={5}
                    className="w-full"
                    value={request.payloadKg}
                    onChange={(e) => set("payloadKg", Number(e.target.value))}
                  />
                </Field>
              </div>

              <Field label="How you drive" value={styleWord(request.drivingStyle)}>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  className="w-full"
                  value={request.drivingStyle}
                  onChange={(e) => set("drivingStyle", Number(e.target.value))}
                />
              </Field>

              {vehicle?.hasHvac ? (
                <label className="flex items-center justify-between rounded-md border border-ink-700 bg-ink-800/60 px-3 py-2">
                  <span className="text-xs font-medium text-slate-300">
                    Air conditioning on
                  </span>
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-sky-500"
                    checked={request.hvacOn ?? false}
                    onChange={(e) => set("hvacOn", e.target.checked)}
                  />
                </label>
              ) : (
                <p className="rounded-md border border-ink-700 bg-ink-800/40 px-3 py-2 text-xs text-slate-500">
                  This one has no cabin to cool.
                </p>
              )}

              <button
                type="button"
                onClick={() => void run(request)}
                disabled={loading || sameEnds || request.reservePct >= request.startSocPct}
                className={`w-full rounded-md px-3 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:bg-ink-700 disabled:text-slate-500 ${
                  stale
                    ? "bg-amber-400 text-ink-950 hover:bg-amber-300"
                    : "bg-sky-500 text-ink-950 hover:bg-sky-400"
                }`}
              >
                {loading ? "Simulating…" : stale ? "Re-run with these changes" : "Will I make it?"}
              </button>
              {sameEnds && (
                <p className="text-xs text-amber-400">
                  Pick a destination you are not already at.
                </p>
              )}
              {request.reservePct >= request.startSocPct && !sameEnds && (
                <p className="text-xs text-amber-400">
                  Your reserve is above your starting charge.
                </p>
              )}
            </div>
          </Panel>

          {vehicle?.calibration && (
            <Panel title="Model calibration">
              <dl className="num space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Logged trips</dt>
                  <dd className="text-slate-200">{vehicle.calibration.trips}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Physics correction</dt>
                  <dd
                    className={
                      vehicle.calibration.bias > 1.02
                        ? "text-amber-400"
                        : vehicle.calibration.bias < 0.98
                          ? "text-emerald-400"
                          : "text-slate-200"
                    }
                  >
                    {vehicle.calibration.bias >= 1 ? "+" : ""}
                    {((vehicle.calibration.bias - 1) * 100).toFixed(1)}%
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Residual spread</dt>
                  <dd className="text-slate-200">
                    ±{(vehicle.calibration.sigma * 100).toFixed(1)}%
                  </dd>
                </div>
                <div className="flex justify-between border-t border-ink-700 pt-1.5">
                  <dt className="text-slate-500">
                    {vehicle.claimedRangeStandard} claim
                  </dt>
                  <dd className="text-slate-400">{vehicle.claimedRangeKm} km</dd>
                </div>
              </dl>
              <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
                The correction is what the physics gets wrong for this model, measured
                against logged trips. The spread is what no amount of knowing the
                conditions would fix. Run <code className="text-slate-400">npm run validate</code>{" "}
                to check both on held-out trips.
              </p>
            </Panel>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5">
          {error && (
            <div
              role="alert"
              className="rounded-xl border border-red-900/60 bg-red-950/40 p-4 text-sm text-red-300"
            >
              {error}
            </div>
          )}

          {verdict && stale && (
            <div
              role="status"
              className="rounded-xl border border-amber-800/70 bg-amber-950/30 px-4 py-3 text-sm text-amber-300"
            >
              You have changed the trip since this answer was computed. It is the
              verdict for the previous inputs, not these ones.
            </div>
          )}

          {verdict && (
            <div className={stale ? "space-y-5 opacity-50 transition-opacity" : "space-y-5"}>
              <Panel
                title="The answer"
                aside={
                  <span className="num text-xs text-slate-500">
                    {verdict.samples.toLocaleString()} simulated trips
                    {computeMs !== null && ` · ${computeMs} ms`}
                  </span>
                }
              >
                <div className="grid gap-6 md:grid-cols-[14rem_1fr] md:items-center">
                  <ProbabilityDial
                    probability={verdict.probability}
                    call={verdict.call}
                    ci={verdict.probabilityCi}
                  />
                  <div className="space-y-4">
                    <p className="text-sm leading-relaxed text-slate-300">
                      {verdict.explanation}
                    </p>
                    <ArrivalBand
                      p10={verdict.arrivalSoc.p10}
                      p50={verdict.arrivalSoc.p50}
                      p90={verdict.arrivalSoc.p90}
                      reservePct={request.reservePct}
                    />
                  </div>
                </div>

                <dl className="num mt-5 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-ink-700 pt-4 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-slate-500">Route</dt>
                    <dd className="font-semibold text-slate-100">
                      {Math.round(verdict.route.distanceKm)} km
                    </dd>
                    <dd className="text-[11px] text-slate-500">{verdict.route.label}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">This trip costs</dt>
                    <dd className="font-semibold text-slate-100">
                      {Math.round(verdict.consumptionWhPerKm.p50)} Wh/km
                    </dd>
                    <dd className="text-[11px] text-slate-500">
                      {Math.round(verdict.consumptionWhPerKm.p10)}–
                      {Math.round(verdict.consumptionWhPerKm.p90)} range
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">
                      {verdict.claimed.standard} implies
                    </dt>
                    <dd className="font-semibold text-amber-400">
                      {Math.round(verdict.claimed.impliedWhPerKm)} Wh/km
                    </dd>
                    <dd className="text-[11px] text-slate-500">
                      from {verdict.claimed.rangeKm} km claimed
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-slate-500">Driving time</dt>
                    <dd className="font-semibold text-slate-100">
                      {Math.floor(verdict.durationMin.p50 / 60)} h{" "}
                      {Math.round(verdict.durationMin.p50 % 60)} m
                    </dd>
                    <dd className="text-[11px] text-slate-500">
                      up to {Math.floor(verdict.durationMin.p90 / 60)} h{" "}
                      {Math.round(verdict.durationMin.p90 % 60)} m
                    </dd>
                  </div>
                </dl>
              </Panel>

              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="What would change my mind">
                  {verdict.levers.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      {verdict.probability > 0.95
                        ? "Nothing worth doing. This trip is comfortable."
                        : "No single change rescues this trip. It needs a charging stop."}
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {verdict.levers.map((l) => (
                        <li key={l.key} className="flex items-start gap-3">
                          <span className="num mt-0.5 w-12 shrink-0 rounded bg-emerald-950/70 px-1.5 py-0.5 text-right text-xs font-bold text-emerald-400">
                            +{Math.round(l.deltaProbability * 100)}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm text-slate-200">{l.label}</span>
                            <span className="block text-[11px] text-slate-500">{l.cost}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>

                <Panel title="Where the doubt comes from">
                  {verdict.risks.length === 0 ? (
                    <p className="text-sm text-slate-500">
                      The answer is not close enough to the line for any single unknown
                      to change it.
                    </p>
                  ) : (
                    <ul className="space-y-2.5">
                      {verdict.risks.map((r) => (
                        <li key={r.key} className="flex items-start gap-3">
                          <span className="num mt-0.5 w-12 shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-right text-xs font-bold text-slate-300">
                            {r.deltaProbability > 0 ? "+" : ""}
                            {Math.round(r.deltaProbability * 100)}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm text-slate-200">{r.label}</span>
                            <span className="block text-[11px] leading-snug text-slate-500">
                              {r.detail}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-3 border-t border-ink-700 pt-2.5 text-[11px] leading-relaxed text-slate-500">
                    Each figure is the change in the answer if that one thing were known
                    exactly. They do not sum to the total, and are not meant to.
                  </p>
                </Panel>
              </div>

              {verdict.chargerPlan && (
                <Panel
                  title="If you would rather not gamble"
                  aside={
                    <span className="num text-xs font-semibold text-emerald-400">
                      → {Math.round(verdict.chargerPlan.probabilityWithStop * 100)}% with
                      this stop
                    </span>
                  }
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                    <div>
                      <p className="text-base font-semibold text-slate-100">
                        {verdict.chargerPlan.chargerName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {verdict.chargerPlan.operator} · {verdict.chargerPlan.placeName} ·{" "}
                        <span className="num">
                          {verdict.chargerPlan.distanceIntoTripKm} km in
                        </span>
                      </p>
                    </div>
                    <dl className="num flex flex-wrap gap-x-6 gap-y-2 text-sm">
                      <div>
                        <dt className="text-xs text-slate-500">Arrive on</dt>
                        <dd className="text-slate-100">
                          {verdict.chargerPlan.arrivalSocPct}%
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">Charge to</dt>
                        <dd className="text-slate-100">
                          {verdict.chargerPlan.targetSocPct}%
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">Plugged in</dt>
                        <dd className="text-slate-100">
                          {verdict.chargerPlan.minutesToTargetSoc} min
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">Likely queue</dt>
                        <dd className="text-slate-100">
                          {verdict.chargerPlan.expectedQueueMin} min
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-slate-500">Site works</dt>
                        <dd
                          className={
                            verdict.chargerPlan.siteReliability >= 0.85
                              ? "text-emerald-400"
                              : verdict.chargerPlan.siteReliability >= 0.7
                                ? "text-amber-400"
                                : "text-red-400"
                          }
                        >
                          {Math.round(verdict.chargerPlan.siteReliability * 100)}% of the
                          time
                        </dd>
                      </div>
                    </dl>
                  </div>
                  <p className="mt-3 border-t border-ink-700 pt-2.5 text-[11px] leading-relaxed text-slate-500">
                    The stop is sized against the bad case for the remaining leg, not the
                    median, and scored on whether the site actually delivers charge —
                    which is why the nearest charger is often not the one chosen.
                  </p>
                </Panel>
              )}

              <Panel
                title="The road"
                aside={
                  verdict.corridor !== null ? (
                    <span className="num text-xs text-slate-400">
                      longest stretch with no{" "}
                      {Math.round(verdict.corridor.dependableThreshold * 100)}%+ charger ={" "}
                      <span
                        className={`font-semibold ${
                          verdict.corridor.longestGapKm > 120
                            ? "text-red-400"
                            : verdict.corridor.longestGapKm > 70
                              ? "text-amber-400"
                              : "text-emerald-400"
                        }`}
                      >
                        {Math.round(verdict.corridor.longestGapKm)} km
                      </span>
                      <span className="text-slate-600">
                        {" "}
                        · {verdict.corridor.dependableSites} dependable stop
                        {verdict.corridor.dependableSites === 1 ? "" : "s"}
                      </span>
                    </span>
                  ) : (
                    <span className="text-xs text-slate-600">
                      corridor coverage needs Neo4j
                    </span>
                  )
                }
              >
                <RouteProfile
                  placeNames={verdict.route.placeNames}
                  placeIds={verdict.route.placeIds}
                  elevationsM={verdict.route.elevationsM}
                  cumulativeKm={verdict.route.cumulativeKm}
                  chargers={meta?.chargers ?? []}
                />
                {verdict.alternatives.length > 0 && (
                  <div className="mt-4 border-t border-ink-700 pt-3">
                    <p className="mb-2 text-xs font-medium text-slate-400">
                      Routes considered and rejected
                    </p>
                    <ul className="num space-y-1 text-xs">
                      {verdict.alternatives.map((a) => (
                        <li key={a.id} className="flex justify-between gap-4 text-slate-500">
                          <span className="truncate">{a.label}</span>
                          <span className="shrink-0">
                            {Math.round(a.distanceKm)} km ·{" "}
                            {Math.round(a.probability * 100)}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>

              <div className="grid gap-5 xl:grid-cols-2">
                <Panel title="Where the energy goes">
                  <EnergySplit split={verdict.energySplit} />
                </Panel>

                <Panel title="Say it in my language" aside={undefined}>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className={`${selectClass} max-w-[12rem]`}
                      value={language}
                      onChange={(e) => {
                        setLanguage(e.target.value);
                        setSpoken(null);
                      }}
                    >
                      {meta?.languages.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.native} — {l.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void speak()}
                      disabled={speaking}
                      className="rounded-md border border-sky-700 bg-sky-950/60 px-3 py-2 text-sm font-semibold text-sky-300 transition hover:bg-sky-900/60 disabled:opacity-50"
                    >
                      {speaking ? "Translating…" : "Translate & speak"}
                    </button>
                  </div>

                  {spoken && (
                    <div className="mt-3 space-y-2">
                      <p className="text-sm leading-relaxed text-slate-200">{spoken.text}</p>
                      {spoken.audioBase64 && (
                        <audio ref={audioRef} controls className="w-full" />
                      )}
                      {spoken.reason && (
                        <p className="text-[11px] text-amber-500/90">{spoken.reason}</p>
                      )}
                    </div>
                  )}
                  {!spoken && (
                    <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                      The driver who most needs an honest answer is not reading Wh/km in
                      English. Sarvam translates the verdict and speaks it. Without a key
                      it stays in English and says so.
                    </p>
                  )}
                </Panel>
              </div>

              <Panel
                title="Leg by leg"
                aside={
                  <span className="text-xs text-slate-500">
                    the median simulated trip, not an average of trips
                  </span>
                }
              >
                <SegmentTable segments={verdict.segmentBreakdown} />
              </Panel>
            </div>
          )}

          {!verdict && !error && (
            <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-10 text-center text-sm text-slate-500">
              {loading ? "Simulating four thousand trips…" : "Loading the road network…"}
            </div>
          )}
        </div>
      </div>

      <footer className="mt-10 border-t border-ink-800 pt-5 text-xs leading-relaxed text-slate-600">
        <p>
          Built for hackFront India 2026, problem statement 01 — &ldquo;Will I Make
          It&rdquo;. Road network and charger reliability are a hand-built dataset for
          the Delhi NCR corridors; fleet logs are synthetic and generated by a perturbed
          process, documented in{" "}
          <code className="text-slate-500">lib/data/trips.ts</code>. The physics,
          calibration and uncertainty layers are real, and{" "}
          <code className="text-slate-500">npm run validate</code> grades them on
          held-out trips.
        </p>
      </footer>
    </div>
  );
}
