"use client";

/**
 * AMM price after each block (and the mock's reference price), hand-rolled SVG.
 * Floats exist only for geometry; every number shown as text is formatted from the exact BigInt string.
 * Hover or arrow keys show one block's values; "Table" shows the same data without a chart.
 */
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { toBigInt } from "../lib/contract";
import { formatPrice, toFloat } from "../lib/format";
import type { PricePoint } from "../lib/reducer";
import { useElementWidth } from "./hooks";
import { Panel } from "./ui";

const HEIGHT = 240;
const MARGIN = { top: 12, right: 14, bottom: 24, left: 58 };

interface Row {
  point: PricePoint;
  height: number;
  amm: number;
  reference: number | null;
}

export function PriceChart({ points, baseAsset, quoteAsset }: { points: PricePoint[]; baseAsset: string; quoteAsset: string }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const rows: Row[] = useMemo(
    () =>
      points.map((p) => ({
        point: p,
        height: p.height,
        amm: toFloat(p.price),
        reference: p.referencePrice ? toFloat(p.referencePrice) : null,
      })),
    [points],
  );
  const latest = points.at(-1);
  const hasReference = points.some((p) => p.referencePrice);

  return (
    <Panel
      title={`${baseAsset}/${quoteAsset} price`}
      meta={`after each block · last ${Math.max(0, points.length - 1)} blocks`}
      actions={
        <div className="flex rounded border border-line text-xs" role="group" aria-label="Chart or table">
          {(["chart", "table"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`px-2 py-0.5 capitalize ${view === v ? "bg-raised font-medium text-ink" : "text-ink-2 hover:bg-raised"}`}
            >
              {v}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-wrap gap-x-5 gap-y-1 px-3 pt-2 text-xs">
        <LegendItem colorClass="stroke-amm" label="AMM price" value={latest ? `${formatPrice(latest.price, quoteAsset)} ${quoteAsset}` : "–"} />
        {hasReference && (
          <LegendItem
            colorClass="stroke-reference"
            label="Reference price (arb bot's target, mock only)"
            value={latest?.referencePrice ? `${formatPrice(latest.referencePrice, quoteAsset)} ${quoteAsset}` : "–"}
          />
        )}
      </div>
      {view === "chart" ? <Chart rows={rows} quoteAsset={quoteAsset} /> : <PriceTable rows={rows} quoteAsset={quoteAsset} />}
    </Panel>
  );
}

function LegendItem({ colorClass, label, value }: { colorClass: string; label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="16" height="8" aria-hidden>
        <line x1="1" y1="4" x2="15" y2="4" strokeWidth="2" strokeLinecap="round" className={colorClass} />
      </svg>
      <span className="font-medium text-ink tabular-nums">{value}</span>
      <span className="text-ink-2">{label}</span>
    </span>
  );
}

function Chart({ rows, quoteAsset }: { rows: Row[]; quoteAsset: string }) {
  const [containerRef, width] = useElementWidth<HTMLDivElement>();
  const [hoverHeight, setHoverHeight] = useState<number | null>(null);

  const ready = width > 0 && rows.length >= 2;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const geometry = useMemo(() => {
    if (rows.length < 2) return null;
    const h0 = rows[0].height;
    const h1 = rows[rows.length - 1].height;
    const values = rows.flatMap((r) => (r.reference === null ? [r.amm] : [r.amm, r.reference]));
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = (hi - lo) * 0.08 || hi * 0.002 || 1;
    lo -= pad;
    hi += pad;
    return { h0, h1, lo, hi, yTicks: niceTicks(lo, hi, 4), xTicks: niceTicks(h0, h1, 6, true) };
  }, [rows]);

  if (!ready || !geometry) {
    return (
      <div ref={containerRef} className="relative px-1" style={{ height: HEIGHT }}>
        {rows.length < 2 && <p className="absolute inset-0 flex items-center justify-center text-xs text-ink-2">Waiting for the first blocks…</p>}
      </div>
    );
  }

  const { h0, h1, lo, hi, yTicks, xTicks } = geometry;
  const x = (h: number) => MARGIN.left + ((h - h0) / (h1 - h0)) * plotW;
  const y = (v: number) => MARGIN.top + (1 - (v - lo) / (hi - lo)) * plotH;

  const ammPath = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(r.height).toFixed(1)},${y(r.amm).toFixed(1)}`).join("");
  let refPath = "";
  let penDown = false;
  for (const r of rows) {
    if (r.reference === null) {
      penDown = false;
      continue;
    }
    refPath += `${penDown ? "L" : "M"}${x(r.height).toFixed(1)},${y(r.reference).toFixed(1)}`;
    penDown = true;
  }

  const hovered = hoverHeight === null ? null : (rows.find((r) => r.height === hoverHeight) ?? null);
  const last = rows[rows.length - 1];
  const yDecimals = decimalsFor(yTicks.length > 1 ? yTicks[1] - yTicks[0] : 1);

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const target = h0 + ((px - MARGIN.left) / plotW) * (h1 - h0);
    let nearest = rows[0];
    for (const r of rows) if (Math.abs(r.height - target) < Math.abs(nearest.height - target)) nearest = r;
    setHoverHeight(nearest.height);
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const index = hovered ? rows.indexOf(hovered) : rows.length - 1;
    const move: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: rows.length - 1 };
    if (e.key === "Escape") setHoverHeight(null);
    if (!(e.key in move)) return;
    e.preventDefault();
    setHoverHeight(rows[Math.max(0, Math.min(rows.length - 1, move[e.key]))].height);
  };

  const tooltipLeft = hovered ? x(hovered.height) : 0;
  const flip = tooltipLeft > width - 200;

  return (
    <div ref={containerRef} className="relative px-1" style={{ height: HEIGHT }}>
      <svg
        width={width}
        height={HEIGHT}
        className="block touch-none outline-none focus-visible:outline-2 focus-visible:outline-amm"
        tabIndex={0}
        role="img"
        aria-label={`AMM price over the last ${rows.length - 1} blocks. Use the arrow keys to read one block.`}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverHeight(null)}
        onFocus={() => setHoverHeight(last.height)}
        onBlur={() => setHoverHeight(null)}
        onKeyDown={onKeyDown}
      >
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(t)} y2={y(t)} strokeWidth={1} className="stroke-grid" />
            <text x={MARGIN.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[10px] tabular-nums">
              {t.toLocaleString("en-US", { minimumFractionDigits: yDecimals, maximumFractionDigits: yDecimals })}
            </text>
          </g>
        ))}
        <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={MARGIN.top + plotH} y2={MARGIN.top + plotH} strokeWidth={1} className="stroke-axis" />
        {xTicks.map((t) => (
          <text key={`x${t}`} x={x(t)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted text-[10px] tabular-nums">
            #{t}
          </text>
        ))}

        {refPath && <path d={refPath} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-reference" />}
        <path d={ammPath} fill="none" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="stroke-amm" />

        {/* end markers: 8px dots with a 2px surface ring */}
        {last.reference !== null && <circle cx={x(last.height)} cy={y(last.reference)} r={4} strokeWidth={2} className="fill-reference stroke-surface" />}
        <circle cx={x(last.height)} cy={y(last.amm)} r={4} strokeWidth={2} className="fill-amm stroke-surface" />

        {hovered && (
          <g pointerEvents="none">
            <line x1={x(hovered.height)} x2={x(hovered.height)} y1={MARGIN.top} y2={MARGIN.top + plotH} strokeWidth={1} className="stroke-axis" />
            {hovered.reference !== null && <circle cx={x(hovered.height)} cy={y(hovered.reference)} r={4} strokeWidth={2} className="fill-reference stroke-surface" />}
            <circle cx={x(hovered.height)} cy={y(hovered.amm)} r={4} strokeWidth={2} className="fill-amm stroke-surface" />
          </g>
        )}
      </svg>

      {hovered && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute z-10 min-w-44 rounded border border-line bg-surface px-2.5 py-2 text-xs shadow-md"
          style={{ top: MARGIN.top, left: flip ? undefined : tooltipLeft + 14, right: flip ? width - tooltipLeft + 14 : undefined }}
        >
          <div className="mb-1 text-ink-2">After block #{hovered.height}</div>
          <TooltipRow colorClass="stroke-amm" value={`${formatPrice(hovered.point.price, quoteAsset)} ${quoteAsset}`} label="AMM" />
          {hovered.point.referencePrice && (
            <>
              <TooltipRow colorClass="stroke-reference" value={`${formatPrice(hovered.point.referencePrice, quoteAsset)} ${quoteAsset}`} label="reference" />
              <div className="mt-1 text-ink-2">
                gap <span className="font-semibold text-ink tabular-nums">{gapBps(hovered.point)} bps</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TooltipRow({ colorClass, value, label }: { colorClass: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="12" height="8" aria-hidden>
        <line x1="1" y1="4" x2="11" y2="4" strokeWidth="2" strokeLinecap="round" className={colorClass} />
      </svg>
      <span className="font-semibold text-ink tabular-nums">{value}</span>
      <span className="text-ink-2">{label}</span>
    </div>
  );
}

function PriceTable({ rows, quoteAsset }: { rows: Row[]; quoteAsset: string }) {
  return (
    <div className="overflow-auto px-3 pb-2" style={{ height: HEIGHT }}>
      <table className="w-full text-xs tabular-nums">
        <thead className="sticky top-0 bg-surface text-left text-ink-2">
          <tr>
            <th className="py-1 font-normal">After block</th>
            <th className="py-1 text-right font-normal">AMM ({quoteAsset})</th>
            <th className="py-1 text-right font-normal">Reference ({quoteAsset})</th>
            <th className="py-1 text-right font-normal">Gap</th>
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.height} className="border-t border-line">
              <td className="py-0.5">#{r.height}</td>
              <td className="py-0.5 text-right">{formatPrice(r.point.price, quoteAsset)}</td>
              <td className="py-0.5 text-right">{r.point.referencePrice ? formatPrice(r.point.referencePrice, quoteAsset) : "–"}</td>
              <td className="py-0.5 text-right">{r.point.referencePrice ? `${gapBps(r.point)} bps` : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** (reference - AMM) / AMM in bps, exact. Positive: the pool is cheaper than the reference. */
function gapBps(p: PricePoint): string {
  if (!p.referencePrice) return "–";
  const amm = toBigInt(p.price);
  const bps = Number(((toBigInt(p.referencePrice) - amm) * 10_000n) / amm);
  return bps > 0 ? `+${bps}` : bps < 0 ? `−${-bps}` : "0";
}

/** About `count` round tick values between lo and hi (steps of 1, 2 or 5 x 10^n). */
function niceTicks(lo: number, hi: number, count: number, integers = false): number[] {
  const range = hi - lo;
  if (!(range > 0)) return [lo];
  const raw = range / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  if (integers) step = Math.max(1, Math.round(step));
  const first = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let i = 0; first + i * step <= hi + step * 1e-9; i++) ticks.push(Number((first + i * step).toFixed(10)));
  return ticks;
}

function decimalsFor(step: number): number {
  return step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
}
