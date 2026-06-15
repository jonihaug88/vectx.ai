// ═══════════════════════════════════════════════════════════════════
// vectX.ai — L3 Analyze v3 (Ultra-Compact, Last GLM-5 Attempt)
// ═══════════════════════════════════════════════════════════════════
//
// Goal: Reach ≥95% success rate on GLM-5 for trade generation.
// If this fails, L3 Analyze switches to Gemini Flash.
//
// Design principles:
//   1. Target output length: < 400 tokens (was ~800)
//   2. Single-character field names
//   3. NO nested objects except hedge (hedge is optional, signaled by boolean)
//   4. Prompt length < 3500 chars (was 7787)
//   5. Explicit "skip" path - GLM-5 can decline, rather than hallucinate
//   6. Deterministic defaults where LLM choice doesn't matter
//
// ═══════════════════════════════════════════════════════════════════

import { z } from "zod";
import { jsonrepair } from "jsonrepair";

// ─── Updated Zod schema — hedge as object (truncation-resilient) ──────────────────────────

export const CompactL3Output = z.discriminatedUnion("k", [
  // k="s" = skip
  z.object({
    k: z.literal("s"),
    r: z.string().min(5),
  }),
  // k="t" = trade
  z.object({
    k: z.literal("t"),
    d: z.enum(["L", "S"]),
    et: z.enum(["m", "l"]),
    e: z.number(),
    tp: z.number(),
    sl: z.number(),
    sz: z.number().min(1).max(10),
    lv: z.number().int().min(1).max(3),
    c: z.number().min(0).max(1),
    // Hedge as object - ratio 0.1-1.0 (guards enforce business rules)
    h: z.union([
      z.null(),
      z.object({
        t: z.string().min(1),              // ticker
        d: z.enum(["L", "S"]),             // direction
        r: z.number().min(0.1).max(1.0),  // ratio (positive)
      }),
    ]),
    th: z.string().min(10),
  }),
]);

export type CompactL3Output = z.infer<typeof CompactL3Output>;

// ─── Inputs from your existing code ────────────────────────────────

interface AlphaContext {
  asset_ticker: string;
  asset_name: string;
  asset_class: string;
  current_price: number;
  vreal: number;
  alpha_gap_pct: number;        // signed percentage, e.g. +8.4 or -3.2
  alpha_confidence: number;     // 0..1
  timeframe_days: number;
  reasoning: string;            // from L2 Analyze
}

interface MarketMetrics {
  volatility_30d_pct: number;   // e.g. 18.5 means 18.5% annualized
  atr_14d: number;              // in price units
  liquidity_score: number;      // 1-10
  trend_strength: number;       // -10 to +10
  momentum_14d: number;         // -10 to +10
  trend_aligned_with_signal: boolean;
}

interface CorrelatedAsset {
  ticker: string;
  name: string;
  correlation: number;          // -1..+1
  stability: "stable" | "moderate" | "unstable";
  hedge_suitability: number;    // 1-10
}

// ─── Ultra-compact prompt builder ──────────────────────────────────

export function buildL3PromptV3(
  alpha: AlphaContext,
  metrics: MarketMetrics,
  correlations: CorrelatedAsset[],
  opts: { strictRetry?: boolean } = {}
): string {
  const MAX_CORRS = 3;

  // Correlation lines — one per correlated asset
  const corrLines = correlations
    .slice(0, MAX_CORRS)
    .filter((c) => Math.abs(c.correlation) >= 0.5 && c.stability !== "unstable")
    .map((c) => {
      const corrStr = c.correlation >= 0 ? `+${c.correlation.toFixed(2)}` : c.correlation.toFixed(2);
      return `${c.ticker}|corr${corrStr}|suit${c.hedge_suitability}|${c.stability}`;
    })
    .join("\n");

  const validHedges = corrLines.length > 0 ? corrLines : "(none suitable)";

  const strictNote = opts.strictRetry ? "RETRY - PREVIOUS FAILED. STRICT JSON.\n\n" : "";

  // Determine direction hint to help GLM-5
  const direction = alpha.alpha_gap_pct > 0 ? "LONG (alpha > 0)" : "SHORT (alpha < 0)";

  // Base leverage suggestion based on confidence and volatility
  const baseLeverage =
    alpha.alpha_confidence >= 0.85 && metrics.volatility_30d_pct < 20 && metrics.trend_aligned_with_signal
      ? 3
      : alpha.alpha_confidence >= 0.75 && metrics.volatility_30d_pct < 25 && metrics.trend_aligned_with_signal
      ? 2
      : 1;

  return `${strictNote}Generate trade for ${alpha.asset_ticker} (${alpha.asset_class}).

MARKET:
price=${alpha.current_price.toFixed(4)} vreal=${alpha.vreal.toFixed(4)} gap=${alpha.alpha_gap_pct.toFixed(2)}% conf=${alpha.alpha_confidence.toFixed(2)} horizon=${alpha.timeframe_days}d
vol30=${metrics.volatility_30d_pct.toFixed(1)}% atr14=${metrics.atr_14d.toFixed(4)} liq=${metrics.liquidity_score} trend=${metrics.trend_strength} trend_aligned=${metrics.trend_aligned_with_signal}

DIRECTION HINT: ${direction}
SUGGESTED LEVERAGE: ${baseLeverage}x

HEDGE CANDIDATES (ticker|corr|suit|stability):
${validHedges}

THESIS: ${alpha.reasoning.slice(0, 200)}

RULES:
- SKIP if: |gap| < 1.5%, conf < 0.40, liq < 3, or no valid R:R ≥ 1.5
- Stop loss: 1.5-2x ATR from entry
- Target: toward vreal, max 80% of gap, must yield R:R ≥ 1.5
- Position size: 1-10% (cap c*10 if no better estimate)
- trade_confidence ≤ alpha_confidence (${alpha.alpha_confidence.toFixed(2)})
- Hedge rule:
    LONG + corr>0 → hedge SHORT the pair
    LONG + corr<0 → hedge LONG the pair
    SHORT + corr>0 → hedge LONG the pair
    SHORT + corr<0 → hedge SHORT the pair
  Only hedge if a candidate has suit ≥ 7 and |corr| ≥ 0.5.

OUTPUT — SKIP case:
{"k":"s","r":"<one sentence reason>"}

OUTPUT — TRADE case (fields: d=L/S, et=m/l, e=entry, tp=target, sl=stop, sz=size%, lv=leverage, c=trade_conf, h=hedge object or null, th=thesis):
{"k":"t","d":"L","et":"l","e":78.50,"tp":85.10,"sl":75.80,"sz":4.2,"lv":2,"c":0.72,"h":{"t":"USDCHF","d":"S","r":0.3},"th":"OPEC tightening combined with weakening dollar"}

NO HEDGE case: use "h":null

JSON ONLY. NO PROSE. NO MARKDOWN.

JSON:`;
}

// ─── Parse with recovery ───────────────────────────────────────────

export interface L3ParseResult {
  success: boolean;
  data: CompactL3Output | null;
  method: "direct" | "repaired" | "failed";
  error?: string;
}

export function parseCompactL3(rawText: string): L3ParseResult {
  let cleaned = rawText.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) {
    return { success: false, data: null, method: "failed", error: "no JSON block" };
  }

  // Direct parse
  try {
    const parsed = JSON.parse(match[0]);
    const v = CompactL3Output.safeParse(parsed);
    if (v.success) return { success: true, data: v.data, method: "direct" };
  } catch {
    // fall through
  }

  // Try jsonrepair for better recovery
  try {
    const repaired = jsonrepair(match[0]);
    const parsed = JSON.parse(repaired);
    const v = CompactL3Output.safeParse(parsed);
    if (v.success) return { success: true, data: v.data, method: "repaired" };
    return {
      success: false,
      data: null,
      method: "failed",
      error: `schema failed after repair: ${v.error?.message?.slice(0, 200) || 'unknown'}`,
    };
  } catch (err) {
    return {
      success: false,
      data: null,
      method: "failed",
      error: (err as Error).message.slice(0, 200),
    };
  }
}

// ─── Convert compact → full internal format ───────────────────────

export interface FullTradeOutput {
  recommendation: "execute" | "skip";
  skip_reason?: string;
  signal_direction?: "long" | "short";
  entry_type?: "market" | "limit";
  entry_price?: number;
  take_profit_price?: number;
  stop_loss_price?: number;
  take_profit_pct?: number;
  stop_loss_pct?: number;
  risk_reward_ratio?: number;
  position_size_pct?: number;
  leverage?: number;
  trade_confidence?: number;
  hedge?: {
    ticker: string;
    direction: "long" | "short";
    ratio: number;
    rationale: string;
  };
  reasoning?: {
    thesis: string;
  };
}

export function compactToFullTrade(
  c: CompactL3Output,
  currentPrice: number
): FullTradeOutput {
  if (c.k === "s") {
    return { recommendation: "skip", skip_reason: c.r };
  }

  const dir = c.d === "L" ? "long" : "short";
  const tpPct = ((c.tp - c.e) / c.e) * 100;
  const slPct = ((c.sl - c.e) / c.e) * 100;
  const risk = Math.abs(c.e - c.sl);
  const reward = Math.abs(c.tp - c.e);
  const rr = risk > 0 ? reward / risk : 0;

  const full: FullTradeOutput = {
    recommendation: "execute",
    signal_direction: dir,
    entry_type: c.et === "m" ? "market" : "limit",
    entry_price: c.e,
    take_profit_price: c.tp,
    stop_loss_price: c.sl,
    take_profit_pct: Number(tpPct.toFixed(3)),
    stop_loss_pct: Number(slPct.toFixed(3)),
    risk_reward_ratio: Number(rr.toFixed(2)),
    position_size_pct: c.sz,
    leverage: c.lv,
    trade_confidence: c.c,
    reasoning: { thesis: c.th },
  };

  // Hedge is now an object (or null)
  if (c.h !== null) {
    full.hedge = {
      ticker: c.h.t,
      direction: c.h.d === "L" ? "long" : "short",
      ratio: c.h.r,
    };
  }

  return full;
}