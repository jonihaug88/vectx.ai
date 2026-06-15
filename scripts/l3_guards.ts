// ═══════════════════════════════════════════════════════════════════
// vectX.ai — L3 Analyze Guards v3
// ═══════════════════════════════════════════════════════════════════
//
// Core principle: LLMs can suggest, but RULES are enforced in code.
//
// Three layers of guards:
//   1. PRE-LLM GATE: Skip before calling LLM if basic gates fail
//   2. POST-LLM VALIDATION: Hard-reject LLM output that violates rules
//   3. HEDGE HARDENING: Explicit checks on hedge ratio validity
//
// ═══════════════════════════════════════════════════════════════════

import type { FullTradeOutput } from "./l3_analyze_v3";

// ─── Types ────────────────────────────────────────────────────────

interface AlphaContext {
  asset_ticker: string;
  asset_id: string;
  current_price: number;
  vreal: number;
  alpha_gap: number;
  alpha_gap_pct: number;
  alpha_confidence: number;
  timeframe_days: number;
  reasoning: string;
}

interface MarketMetrics {
  volatility_30d_pct: number;
  atr_14d: number;
  liquidity_score: number;
  trend_strength: number;
  trend_aligned_with_signal: boolean;
}

interface CorrelatedAsset {
  ticker: string;
  correlation: number;
  hedge_suitability: number;
  stability: "stable" | "moderate" | "unstable";
}

// ─── Pre-LLM gates ────────────────────────────────────────────────

export const PRE_LLM_RULES = {
  MIN_ALPHA_GAP_PCT: 1.5,
  MIN_CONFIDENCE: 0.40,
  MIN_LIQUIDITY: 3,
} as const;

export interface PreLLMSkipResult {
  skip: true;
  reason: string;
  rule: string;
}

/**
 * Check deterministic gates BEFORE calling the LLM.
 * If any gate fails, skip the asset without burning an API call.
 */
export function checkPreLLMGates(
  alpha: AlphaContext,
  metrics: MarketMetrics
): PreLLMSkipResult | null {
  if (Math.abs(alpha.alpha_gap_pct) < PRE_LLM_RULES.MIN_ALPHA_GAP_PCT) {
    return {
      skip: true,
      rule: "alpha_gap_too_small",
      reason: `alpha_gap_pct ${alpha.alpha_gap_pct.toFixed(2)} below minimum ${PRE_LLM_RULES.MIN_ALPHA_GAP_PCT}`,
    };
  }
  if (alpha.alpha_confidence < PRE_LLM_RULES.MIN_CONFIDENCE) {
    return {
      skip: true,
      rule: "confidence_too_low",
      reason: `alpha_confidence ${alpha.alpha_confidence.toFixed(2)} below minimum ${PRE_LLM_RULES.MIN_CONFIDENCE}`,
    };
  }
  if (metrics.liquidity_score < PRE_LLM_RULES.MIN_LIQUIDITY) {
    return {
      skip: true,
      rule: "liquidity_too_low",
      reason: `liquidity_score ${metrics.liquidity_score} below minimum ${PRE_LLM_RULES.MIN_LIQUIDITY}`,
    };
  }
  return null;
}

// ─── Post-LLM validation ──────────────────────────────────────────

export const POST_LLM_RULES = {
  MIN_RISK_REWARD: 1.5,
  MIN_POSITION_SIZE_PCT: 1.0,
  MAX_POSITION_SIZE_PCT: 10.0,
  MIN_LEVERAGE: 1,
  MAX_LEVERAGE: 3,
  MAX_ENTRY_DEVIATION_PCT: 2.0,
} as const;

export const HEDGE_RULES = {
  MIN_RATIO: 0.2,
  MAX_RATIO: 0.5,
  MIN_ABS_CORRELATION: 0.5,
  MIN_SUITABILITY: 7,
} as const;

export interface PostLLMRejection {
  valid: false;
  rule: string;
  reason: string;
  should_retry: boolean;
}

export interface PostLLMAccepted {
  valid: true;
}

/**
 * Validate LLM output against all rules. Reject if any violation.
 */
export function validateLLMTrade(
  trade: FullTradeOutput,
  alpha: AlphaContext,
  metrics: MarketMetrics,
  correlations: CorrelatedAsset[]
): PostLLMRejection | PostLLMAccepted {
  // Skip is always valid
  if (trade.recommendation === "skip") {
    return { valid: true };
  }

  // ─── Basic field presence ────────────────────────────────────
  const required = [
    "signal_direction", "entry_price", "take_profit_price",
    "stop_loss_price", "position_size_pct", "leverage", "trade_confidence",
  ] as const;
  for (const field of required) {
    if (trade[field] === undefined || trade[field] === null) {
      return {
        valid: false,
        rule: "missing_field",
        reason: `Required field "${field}" is missing`,
        should_retry: true,
      };
    }
  }

  // ─── Direction matches alpha_gap direction ──────────────────
  const expectedDir = alpha.alpha_gap_pct > 0 ? "long" : "short";
  if (trade.signal_direction !== expectedDir) {
    return {
      valid: false,
      rule: "direction_mismatch",
      reason: `Signal direction "${trade.signal_direction}" contradicts alpha_gap sign (expected "${expectedDir}")`,
      should_retry: true,
    };
  }

  // ─── Stop / Target on correct side ──────────────────────────
  const entry = trade.entry_price!;
  const tp = trade.take_profit_price!;
  const sl = trade.stop_loss_price!;

  if (trade.signal_direction === "long") {
    if (tp <= entry) {
      return {
        valid: false,
        rule: "target_wrong_side",
        reason: `Long trade: take_profit ${tp} <= entry ${entry}`,
        should_retry: true,
      };
    }
    if (sl >= entry) {
      return {
        valid: false,
        rule: "stop_wrong_side",
        reason: `Long trade: stop_loss ${sl} >= entry ${entry}`,
        should_retry: true,
      };
    }
  } else {
    if (tp >= entry) {
      return {
        valid: false,
        rule: "target_wrong_side",
        reason: `Short trade: take_profit ${tp} >= entry ${entry}`,
        should_retry: true,
      };
    }
    if (sl <= entry) {
      return {
        valid: false,
        rule: "stop_wrong_side",
        reason: `Short trade: stop_loss ${sl} <= entry ${entry}`,
        should_retry: true,
      };
    }
  }

  // ─── R:R ratio ───────────────────────────────────────────────
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  const rr = risk > 0 ? reward / risk : 0;
  if (rr < POST_LLM_RULES.MIN_RISK_REWARD) {
    return {
      valid: false,
      rule: "rr_too_low",
      reason: `R:R ${rr.toFixed(2)} below minimum ${POST_LLM_RULES.MIN_RISK_REWARD}`,
      should_retry: false,
    };
  }

  // ─── Position size in bounds ────────────────────────────────
  const size = trade.position_size_pct!;
  if (size < POST_LLM_RULES.MIN_POSITION_SIZE_PCT || size > POST_LLM_RULES.MAX_POSITION_SIZE_PCT) {
    return {
      valid: false,
      rule: "size_out_of_bounds",
      reason: `Position size ${size}% outside [${POST_LLM_RULES.MIN_POSITION_SIZE_PCT}, ${POST_LLM_RULES.MAX_POSITION_SIZE_PCT}]`,
      should_retry: true,
    };
  }

  // ─── Leverage in bounds ─────────────────────────────────────
  const lev = trade.leverage!;
  if (lev < POST_LLM_RULES.MIN_LEVERAGE || lev > POST_LLM_RULES.MAX_LEVERAGE) {
    return {
      valid: false,
      rule: "leverage_out_of_bounds",
      reason: `Leverage ${lev}x outside [${POST_LLM_RULES.MIN_LEVERAGE}, ${POST_LLM_RULES.MAX_LEVERAGE}]`,
      should_retry: true,
    };
  }

  // ─── Entry within market band ───────────────────────────────
  const entryDevPct = Math.abs(entry - alpha.current_price) / alpha.current_price * 100;
  if (entryDevPct > POST_LLM_RULES.MAX_ENTRY_DEVIATION_PCT) {
    return {
      valid: false,
      rule: "entry_too_far",
      reason: `Entry ${entry} deviates ${entryDevPct.toFixed(2)}% from market ${alpha.current_price} (max ${POST_LLM_RULES.MAX_ENTRY_DEVIATION_PCT}%)`,
      should_retry: true,
    };
  }

  // ─── Hedge validation (if present) ──────────────────────────
  if (trade.hedge) {
    const hedgeValidation = validateHedge(trade.hedge, trade.signal_direction!, correlations);
    if (hedgeValidation.valid === false) {
      return hedgeValidation;
    }
  }

  return { valid: true };
}

// ─── Hedge-specific hardening ─────────────────────────────────────

function validateHedge(
  hedge: NonNullable<FullTradeOutput["hedge"]>,
  mainDirection: "long" | "short",
  correlations: CorrelatedAsset[]
): PostLLMRejection | PostLLMAccepted {
  // Ratio must be positive and in range
  if (hedge.ratio < HEDGE_RULES.MIN_RATIO || hedge.ratio > HEDGE_RULES.MAX_RATIO) {
    return {
      valid: false,
      rule: "hedge_ratio_invalid",
      reason: `Hedge ratio ${hedge.ratio} outside valid range [${HEDGE_RULES.MIN_RATIO}, ${HEDGE_RULES.MAX_RATIO}]`,
      should_retry: true,
    };
  }

  // Explicitly reject negatives
  if (hedge.ratio < 0) {
    return {
      valid: false,
      rule: "hedge_ratio_negative",
      reason: `Hedge ratio must be positive. Got ${hedge.ratio}. Direction is captured in the "direction" field.`,
      should_retry: true,
    };
  }

  // Hedge ticker must match a known correlation
  const correlatedAsset = correlations.find((c) => c.ticker === hedge.ticker);
  if (!correlatedAsset) {
    return {
      valid: false,
      rule: "hedge_unknown_ticker",
      reason: `Hedge ticker "${hedge.ticker}" not in correlation list`,
      should_retry: true,
    };
  }

  // Check correlation threshold
  if (Math.abs(correlatedAsset.correlation) < HEDGE_RULES.MIN_ABS_CORRELATION) {
    return {
      valid: false,
      rule: "hedge_correlation_too_weak",
      reason: `Hedge ${hedge.ticker} correlation ${correlatedAsset.correlation} below |${HEDGE_RULES.MIN_ABS_CORRELATION}|`,
      should_retry: true,
    };
  }

  // Check suitability
  if (correlatedAsset.hedge_suitability < HEDGE_RULES.MIN_SUITABILITY) {
    return {
      valid: false,
      rule: "hedge_suitability_too_low",
      reason: `Hedge ${hedge.ticker} suitability ${correlatedAsset.hedge_suitability} below ${HEDGE_RULES.MIN_SUITABILITY}`,
      should_retry: true,
    };
  }

  // Check stability
  if (correlatedAsset.stability === "unstable") {
    return {
      valid: false,
      rule: "hedge_correlation_unstable",
      reason: `Hedge ${hedge.ticker} has unstable correlation`,
      should_retry: true,
    };
  }

  // Verify direction matches the hedge matrix rule
  const expectedHedgeDir =
    mainDirection === "long"
      ? correlatedAsset.correlation > 0 ? "short" : "long"
      : correlatedAsset.correlation > 0 ? "long" : "short";

  if (hedge.direction !== expectedHedgeDir) {
    return {
      valid: false,
      rule: "hedge_direction_wrong",
      reason: `Hedge direction "${hedge.direction}" violates matrix. Main=${mainDirection}, corr=${correlatedAsset.correlation}, expected=${expectedHedgeDir}`,
      should_retry: true,
    };
  }

  return { valid: true };
}

// ─── Wrapped runner with guards ───────────────────────────────────

export interface GuardedL3Result {
  outcome: "skip_pre_llm" | "skip_llm" | "trade_valid" | "rejected_after_retry";
  skip_reason?: string;
  skip_rule?: string;
  trade?: FullTradeOutput;
  llm_attempts: number;
  total_duration_ms: number;
  rejections: Array<{ rule: string; reason: string }>;
}

/**
 * Full L3 execution with all guards.
 */
export async function runL3Guarded(
  alpha: AlphaContext,
  metrics: MarketMetrics,
  correlations: CorrelatedAsset[],
  runLLM: (strictRetry: boolean) => Promise<{
    success: boolean;
    trade: FullTradeOutput | null;
    attempts: number;
    total_duration_ms: number;
    failure_type?: string;
  }>
): Promise<GuardedL3Result> {
  const rejections: GuardedL3Result["rejections"] = [];
  let totalDuration = 0;

  // ─── Step 1: Pre-LLM gates ──────────────────────────────────
  const preCheck = checkPreLLMGates(alpha, metrics);
  if (preCheck) {
    return {
      outcome: "skip_pre_llm",
      skip_reason: preCheck.reason,
      skip_rule: preCheck.rule,
      llm_attempts: 0,
      total_duration_ms: 0,
      rejections: [],
    };
  }

  // ─── Step 2: First LLM call ─────────────────────────────────
  const r1 = await runLLM(false);
  totalDuration += r1.total_duration_ms;

  if (!r1.success || !r1.trade) {
    return {
      outcome: "rejected_after_retry",
      skip_reason: `LLM call failed: ${r1.failure_type ?? "unknown"}`,
      skip_rule: "llm_error",
      llm_attempts: r1.attempts,
      total_duration_ms: totalDuration,
      rejections: [],
    };
  }

  // Skip from LLM is always accepted
  if (r1.trade.recommendation === "skip") {
    return {
      outcome: "skip_llm",
      skip_reason: r1.trade.skip_reason ?? "LLM recommended skip",
      skip_rule: "llm_skip",
      trade: r1.trade,
      llm_attempts: r1.attempts,
      total_duration_ms: totalDuration,
      rejections: [],
    };
  }

  // ─── Step 3: Validate first attempt ─────────────────────────
  const v1 = validateLLMTrade(r1.trade, alpha, metrics, correlations);
  if (v1.valid) {
    return {
      outcome: "trade_valid",
      trade: r1.trade,
      llm_attempts: r1.attempts,
      total_duration_ms: totalDuration,
      rejections: [],
    };
  }

  rejections.push({ rule: v1.rule, reason: v1.reason });

  // ─── Step 4: Retry if applicable ────────────────────────────
  if (!v1.should_retry) {
    return {
      outcome: "rejected_after_retry",
      skip_reason: v1.reason,
      skip_rule: v1.rule,
      llm_attempts: r1.attempts,
      total_duration_ms: totalDuration,
      rejections,
    };
  }

  const r2 = await runLLM(true);
  totalDuration += r2.total_duration_ms;

  if (!r2.success || !r2.trade) {
    return {
      outcome: "rejected_after_retry",
      skip_reason: `Retry failed: ${r2.failure_type ?? "unknown"}`,
      skip_rule: "llm_error_retry",
      llm_attempts: r1.attempts + r2.attempts,
      total_duration_ms: totalDuration,
      rejections,
    };
  }

  if (r2.trade.recommendation === "skip") {
    return {
      outcome: "skip_llm",
      skip_reason: r2.trade.skip_reason ?? "LLM skipped on retry",
      skip_rule: "llm_skip_retry",
      trade: r2.trade,
      llm_attempts: r1.attempts + r2.attempts,
      total_duration_ms: totalDuration,
      rejections,
    };
  }

  // ─── Step 5: Validate retry ─────────────────────────────────
  const v2 = validateLLMTrade(r2.trade, alpha, metrics, correlations);
  if (v2.valid) {
    return {
      outcome: "trade_valid",
      trade: r2.trade,
      llm_attempts: r1.attempts + r2.attempts,
      total_duration_ms: totalDuration,
      rejections,
    };
  }

  rejections.push({ rule: v2.rule, reason: v2.reason });

  return {
    outcome: "rejected_after_retry",
    skip_reason: v2.reason,
    skip_rule: v2.rule,
    llm_attempts: r1.attempts + r2.attempts,
    total_duration_ms: totalDuration,
    rejections,
  };
}