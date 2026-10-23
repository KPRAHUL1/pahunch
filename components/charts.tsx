"use client";

import type { SegmentEnergy, Verdict } from "@/lib/types";

/**
 * Hand-rolled SVG rather than a charting library, for two reasons. First, these
 * are four specific instruments, not generic charts, and each one needs to say
 * a particular thing -- a dial that shows a confidence interval as an arc, an
 * elevation profile with charger reliability on it. Second, no CDN and no map
 * tile server means the demo works on a venue wifi that cannot reach anything,
 * which at a hackathon is the difference between demoing and not.
 */

const CALL_COLOR: Record<Verdict["call"], string> = {
  yes: "#22c55e",
  tight: "#f59e0b",
  no: "#ef4444",
};

const CALL_WORD: Record<Verdict["call"], string> = {
  yes: "Yes",
  tight: "Tight",
  no: "No",
};

/** Polar to cartesian on a dial whose zero is at the lower left. */
function dialPoint(cx: number, cy: number, r: number, t: number): [number, number] {
  // 225 degrees of sweep starting at 157.5, so the gauge opens downward.
  const angle = (157.5 + t * 225) * (Math.PI / 180);
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = dialPoint(cx, cy, r, from);
  const [x2, y2] = dialPoint(cx, cy, r, to);
  const large = (to - from) * 225 > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export function ProbabilityDial({
  probability,
  call,
  ci,
}: {
  probability: number;
  call: Verdict["call"];
  ci: [number, number];
}) {
  const color = CALL_COLOR[call];
  const pct = Math.round(probability * 100);
  const size = 232;
  const cx = size / 2;
  const cy = size / 2;
  const r = 92;

  return (
    <figure className="flex flex-col items-center">
      <svg
        width={size}
        height={size * 0.82}
        viewBox={`0 0 ${size} ${size * 0.82}`}
        role="img"
        aria-label={`${pct} percent chance of arriving above your reserve, with a confidence interval of ${Math.round(ci[0] * 100)} to ${Math.round(ci[1] * 100)} percent.`}
      >
        {/* Track */}
        <path
          d={arcPath(cx, cy, r, 0, 1)}
          fill="none"
          stroke="#1f2731"
          strokeWidth={16}
          strokeLinecap="round"
        />
        {/* The confidence interval, drawn as a wider faint band behind the
            value. The point of the dial is that the number itself is uncertain. */}
        <path
          d={arcPath(cx, cy, r, ci[0], ci[1])}
          fill="none"
          stroke={color}
          strokeOpacity={0.28}
          strokeWidth={26}
          strokeLinecap="butt"
        />
        {/* Below 1% the arc is shorter than its own round line cap, which
            renders as a detached blob sitting off the start of the track and
            reads as a rendering fault. At that probability the "0%" and the
            verdict word carry the message on their own. */}
        {probability >= 0.01 && (
          <path
            d={arcPath(cx, cy, r, 0, probability)}
            fill="none"
            stroke={color}
            strokeWidth={16}
            strokeLinecap="round"
          />
        )}
        {/* The 92% and 70% thresholds where the verdict word changes. */}
        {[0.7, 0.92].map((t) => {
          const [x1, y1] = dialPoint(cx, cy, r - 13, t);
          const [x2, y2] = dialPoint(cx, cy, r + 13, t);
          return (
            <line
              key={t}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#07090d"
              strokeWidth={2}
            />
          );
        })}
        <text
          x={cx}
          y={cy + 2}
          textAnchor="middle"
          className="num"
          fill="#e6edf3"
          fontSize="54"
          fontWeight="700"
        >
          {pct}
          <tspan fontSize="24" fill="#8b949e">
            %
          </tspan>
        </text>
        <text
          x={cx}
          y={cy + 30}
          textAnchor="middle"
          fill={color}
          fontSize="19"
          fontWeight="600"
          letterSpacing="0.08em"
        >
          {CALL_WORD[call].toUpperCase()}
        </text>
      </svg>
      <figcaption className="num -mt-1 text-xs text-slate-500">
        95% interval {Math.round(ci[0] * 100)}–{Math.round(ci[1] * 100)}% · from{" "}
        {/* Stated so nobody mistakes Monte Carlo noise for model precision. */}
        simulation noise alone
      </figcaption>
    </figure>
  );
}

/**
 * Arrival state of charge, as a band rather than a number. The reserve line is
 * the thing the driver actually cares about: the question is not "what SoC"
 * but "is the band above my line".
 */
export function ArrivalBand({
  p10,
  p50,
  p90,
  reservePct,
}: {
  p10: number;
  p50: number;
  p90: number;
  reservePct: number;
}) {
  const w = 560;
  const h = 76;
  const padX = 14;
  const scaleX = (soc: number) =>
    padX + (Math.min(100, Math.max(-20, soc)) + 20) * ((w - padX * 2) / 120);
  const barY = 30;
  const barH = 20;
  const clears = p10 >= reservePct;

  return (
    <figure>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label={`Arrival charge between ${Math.round(p10)} and ${Math.round(p90)} percent, most likely ${Math.round(p50)} percent, against a reserve of ${reservePct} percent.`}
      >
        {/* Axis from -20% (stranded) to 100%. Showing negative SoC is
            deliberate: "you run out 30 km short" is information, and clipping
            at zero would hide it. */}
        <line x1={padX} y1={barY + barH + 9} x2={w - padX} y2={barY + barH + 9} stroke="#1f2731" />
        {[-20, 0, 20, 40, 60, 80, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={scaleX(tick)}
              y1={barY + barH + 9}
              x2={scaleX(tick)}
              y2={barY + barH + 14}
              stroke="#2d3846"
            />
            <text
              x={scaleX(tick)}
              y={barY + barH + 26}
              textAnchor="middle"
              className="num"
              fill="#6b7280"
              fontSize="10"
            >
              {tick}
            </text>
          </g>
        ))}

        {/* The region below the reserve: where the driver refuses to arrive. */}
        <rect
          x={padX}
          y={barY - 8}
          width={scaleX(reservePct) - padX}
          height={barH + 16}
          fill="#ef4444"
          fillOpacity={0.07}
        />
        <line
          x1={scaleX(reservePct)}
          y1={barY - 9}
          x2={scaleX(reservePct)}
          y2={barY + barH + 9}
          stroke="#ef4444"
          strokeWidth={1.5}
          strokeDasharray="3 3"
        />
        <text
          x={scaleX(reservePct)}
          y={barY - 14}
          textAnchor="middle"
          className="num"
          fill="#f87171"
          fontSize="10"
        >
          reserve {reservePct}%
        </text>

        {/* p10 to p90 band, then the median tick. */}
        <rect
          x={scaleX(p10)}
          y={barY}
          width={Math.max(2, scaleX(p90) - scaleX(p10))}
          height={barH}
          rx={3}
          fill={clears ? "#22c55e" : "#f59e0b"}
          fillOpacity={0.35}
        />
        <line
          x1={scaleX(p50)}
          y1={barY - 3}
          x2={scaleX(p50)}
          y2={barY + barH + 3}
          stroke={clears ? "#22c55e" : "#f59e0b"}
          strokeWidth={3}
        />
        <text
          x={scaleX(p50)}
          y={barY + barH / 2 + 4}
          textAnchor="middle"
          className="num"
          fill="#e6edf3"
          fontSize="11"
          fontWeight="700"
          dx={scaleX(p50) > w - 70 ? -26 : 26}
        >
          {Math.round(p50)}%
        </text>
      </svg>
      <figcaption className="num mt-1 text-xs text-slate-500">
        Arrival charge, 10th–90th percentile: {Math.round(p10)}% to {Math.round(p90)}%
      </figcaption>
    </figure>
  );
}

/**
 * Elevation profile with charger reliability marked on it. This is the view
 * that makes the Chandigarh-to-Shimla problem obvious at a glance: a 1900 m
 * wall with two sub-60%-reliability chargers on it.
 */
export function RouteProfile({
  placeNames,
  elevationsM,
  cumulativeKm,
  chargers,
  placeIds,
}: {
  placeNames: string[];
  elevationsM: number[];
  cumulativeKm: number[];
  placeIds: string[];
  chargers: { placeId: string; reliability: number; operator: string; powerKw: number }[];
}) {
  const w = 760;
  const h = 190;
  const padL = 44;
  const padR = 18;
  const padT = 26;
  const padB = 44;

  const maxKm = Math.max(1, cumulativeKm[cumulativeKm.length - 1]);
  const maxEl = Math.max(...elevationsM);
  const minEl = Math.min(...elevationsM);
  // Always give the profile some vertical room, so a flat plains route does not
  // render as a jagged line through rounding noise.
  const elLo = Math.max(0, minEl - Math.max(60, (maxEl - minEl) * 0.2));
  const elHi = maxEl + Math.max(80, (maxEl - minEl) * 0.2);

  const x = (km: number) => padL + (km / maxKm) * (w - padL - padR);
  const y = (el: number) => h - padB - ((el - elLo) / (elHi - elLo)) * (h - padT - padB);

  const line = cumulativeKm.map((km, i) => `${x(km).toFixed(1)},${y(elevationsM[i]).toFixed(1)}`);
  const area = `M ${x(0)},${h - padB} L ${line.join(" L ")} L ${x(maxKm)},${h - padB} Z`;

  const bestCharger = (placeId: string) => {
    const atPlace = chargers.filter((c) => c.placeId === placeId);
    if (atPlace.length === 0) return null;
    return atPlace.reduce((a, b) => (b.reliability > a.reliability ? b : a));
  };

  return (
    <figure>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full"
        role="img"
        aria-label={`Elevation profile from ${placeNames[0]} to ${placeNames[placeNames.length - 1]}, climbing from ${Math.round(elevationsM[0])} to ${Math.round(elevationsM[elevationsM.length - 1])} metres over ${Math.round(maxKm)} kilometres.`}
      >
        <defs>
          <linearGradient id="profileFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[elLo, (elLo + elHi) / 2, elHi].map((el) => (
          <g key={el}>
            <line x1={padL} y1={y(el)} x2={w - padR} y2={y(el)} stroke="#151b24" />
            <text
              x={padL - 7}
              y={y(el) + 3}
              textAnchor="end"
              className="num"
              fill="#6b7280"
              fontSize="9"
            >
              {Math.round(el)}
            </text>
          </g>
        ))}
        <text
          x={6}
          y={padT - 12}
          className="num"
          fill="#6b7280"
          fontSize="9"
        >
          m
        </text>

        <path d={area} fill="url(#profileFill)" />
        <polyline points={line.join(" ")} fill="none" stroke="#38bdf8" strokeWidth={2} />

        {cumulativeKm.map((km, i) => {
          const charger = bestCharger(placeIds[i]);
          const cy = y(elevationsM[i]);
          // Alternate the labels above and below so adjacent stops on a short
          // leg do not overlap into illegibility.
          const above = i % 2 === 0;
          return (
            <g key={placeIds[i]}>
              <circle cx={x(km)} cy={cy} r={3.5} fill="#07090d" stroke="#38bdf8" strokeWidth={2} />
              {charger && (
                <circle
                  cx={x(km)}
                  cy={cy}
                  r={8}
                  fill="none"
                  stroke={
                    charger.reliability >= 0.85
                      ? "#22c55e"
                      : charger.reliability >= 0.7
                        ? "#f59e0b"
                        : "#ef4444"
                  }
                  strokeWidth={2}
                  strokeOpacity={0.9}
                />
              )}
              <text
                x={x(km)}
                y={above ? cy - 15 : cy + 22}
                textAnchor={i === 0 ? "start" : i === cumulativeKm.length - 1 ? "end" : "middle"}
                fill="#9aa4b2"
                fontSize="9.5"
              >
                {placeNames[i]}
              </text>
              {charger && (
                <text
                  x={x(km)}
                  y={above ? cy - 26 : cy + 33}
                  textAnchor={i === 0 ? "start" : i === cumulativeKm.length - 1 ? "end" : "middle"}
                  className="num"
                  fill={
                    charger.reliability >= 0.85
                      ? "#4ade80"
                      : charger.reliability >= 0.7
                        ? "#fbbf24"
                        : "#f87171"
                  }
                  fontSize="9"
                >
                  {charger.powerKw}kW · {Math.round(charger.reliability * 100)}%
                </text>
              )}
              <text
                x={x(km)}
                y={h - 8}
                textAnchor="middle"
                className="num"
                fill="#4b5563"
                fontSize="9"
              >
                {Math.round(km)}
              </text>
            </g>
          );
        })}
        {/* The unit label lives at the left, under the y-axis gutter. At the
            right edge it printed on top of the final distance tick. */}
        <text x={padL - 7} y={h - 8} textAnchor="end" className="num" fill="#6b7280" fontSize="9">
          km
        </text>
      </svg>
      <figcaption className="mt-1 text-xs text-slate-500">
        Rings mark charger sites, coloured by the share of sessions that actually
        deliver charge. Green ≥ 85%, amber ≥ 70%, red below.
      </figcaption>
    </figure>
  );
}

/** Where the energy went. Regen is drawn as a credit, below the axis. */
export function EnergySplit({ split }: { split: Verdict["energySplit"] }) {
  const draws = [
    { key: "traction", label: "Moving the car", value: split.tractionKwh, color: "#38bdf8" },
    { key: "hvac", label: "Air conditioning", value: split.hvacKwh, color: "#f59e0b" },
    { key: "aux", label: "Electronics", value: split.auxKwh, color: "#a78bfa" },
  ].filter((d) => d.value > 0.001);

  const gross = draws.reduce((a, d) => a + d.value, 0);
  const regen = Math.abs(split.regenKwh);
  const net = gross - regen;
  if (gross <= 0) return null;

  return (
    <figure>
      <div className="flex h-7 w-full overflow-hidden rounded-md bg-ink-700">
        {draws.map((d) => (
          <div
            key={d.key}
            className="group relative"
            style={{ width: `${(d.value / gross) * 100}%`, background: d.color }}
            title={`${d.label}: ${d.value.toFixed(2)} kWh`}
          />
        ))}
      </div>
      <ul className="num mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {draws.map((d) => (
          <li key={d.key} className="flex items-center gap-1.5 text-slate-400">
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: d.color }}
            />
            {d.label} {d.value.toFixed(1)} kWh
            <span className="text-slate-600">({Math.round((d.value / gross) * 100)}%)</span>
          </li>
        ))}
        {regen > 0.01 && (
          <li className="flex items-center gap-1.5 text-emerald-400">
            <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
            Regen returns {regen.toFixed(1)} kWh
          </li>
        )}
        <li className="ml-auto font-semibold text-slate-200">Net {net.toFixed(1)} kWh</li>
      </ul>
    </figure>
  );
}

/**
 * Per-segment table for the median simulated trip. Included because a judge,
 * or a sceptical driver, should be able to find the one leg that is eating the
 * battery instead of taking the headline on faith.
 */
export function SegmentTable({ segments }: { segments: SegmentEnergy[] }) {
  if (segments.length === 0) return null;
  const worst = Math.max(...segments.map((s) => Math.abs((s.packKwh * 1000) / s.distanceKm)));

  return (
    <div className="overflow-x-auto">
      <table className="num w-full min-w-[34rem] text-left text-xs">
        <thead className="text-slate-500">
          <tr className="border-b border-ink-700">
            <th className="py-2 pr-3 font-medium">Leg</th>
            <th className="py-2 pr-3 text-right font-medium">km</th>
            <th className="py-2 pr-3 text-right font-medium">km/h</th>
            <th className="py-2 pr-3 text-right font-medium">grade</th>
            <th className="py-2 pr-3 text-right font-medium">kWh</th>
            <th className="py-2 pr-3 text-right font-medium">Wh/km</th>
            <th className="py-2 font-medium">intensity</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((s) => {
            const whPerKm = (s.packKwh * 1000) / s.distanceKm;
            const [from, to] = s.segmentId.split("__");
            return (
              <tr key={s.segmentId} className="border-b border-ink-800/70 text-slate-300">
                <td className="py-1.5 pr-3 whitespace-nowrap text-slate-400">
                  {from} → {to}
                </td>
                <td className="py-1.5 pr-3 text-right">{s.distanceKm.toFixed(0)}</td>
                <td className="py-1.5 pr-3 text-right">{s.meanSpeedKmph.toFixed(0)}</td>
                <td
                  className={`py-1.5 pr-3 text-right ${s.gradePct > 1 ? "text-amber-400" : s.gradePct < -1 ? "text-emerald-400" : ""}`}
                >
                  {s.gradePct > 0 ? "+" : ""}
                  {s.gradePct.toFixed(1)}%
                </td>
                <td className="py-1.5 pr-3 text-right">{s.packKwh.toFixed(2)}</td>
                <td className="py-1.5 pr-3 text-right font-semibold text-slate-200">
                  {whPerKm.toFixed(0)}
                </td>
                <td className="py-1.5">
                  <div className="h-1.5 w-full min-w-16 rounded-full bg-ink-700">
                    <div
                      className={`h-full rounded-full ${whPerKm < 0 ? "bg-emerald-500" : "bg-sky-500"}`}
                      style={{ width: `${(Math.abs(whPerKm) / worst) * 100}%` }}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
