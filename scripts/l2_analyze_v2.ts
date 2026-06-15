// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Layer 2 Analyze v2
// Hybrid architecture: LLM scores impacts, code computes V_real.
// ═══════════════════════════════════════════════════════════════════

import type { Asset, Driver, Event, FutureEvent } from "./types";

// ─── Configuration ──────────────────────────────────────────────────

interface L2AnalyzeConfig {
  future_damper: number;
  future_damper_v3: number;
  min_time_decay: number;
  decay_window_days: number;
  max_alpha_gap_pct: (asset: Asset) => number;
}

export const DEFAULT_L2_CONFIG: L2AnalyzeConfig = {
  future_damper: 0.5,           // Vergleichsbasis (bleibt 0.5)
  future_damper_v3: 0.3,        // Produktivwert (neu)
  min_time_decay: 0.3,
  decay_window_days: 7,
  max_alpha_gap_pct: (asset) => {
    const cls = asset.asset_class.toLowerCase();
    const ticker = asset.ticker.toLowerCase();
    if (cls === "forex") return 3.0;
    if (/gold|silver|gc|si/.test(ticker)) return 8.0;
    if (/wti|brent|oil|ng|natural/.test(ticker)) return 15.0;
    return 10.0;
  },
};

// ─── LLM-facing types ───────────────────────────────────────────────

interface EventScoring {
  event_id: string;
  priced_in: number;
  rationale: string;
}

interface FutureEventScoring {
  future_event_id: string;
  quality_discount: number;
  rationale: string;
}

export interface L2AnalyzeLLMOutput {
  market_narrative: string;
  event_scorings: EventScoring[];
  future_event_scorings: FutureEventScoring[];
  suggested_timeframe_days: number;
  abort_analysis: boolean;
  abort_reason: string | null;
}

// ─── Final result ───────────────────────────────────────────────────

export interface AlphaResult {
  vreal: number;
  alpha_gap: number;
  alpha_gap_pct: number;
  confidence: number;
  timeframe_days: number;
  reasoning: string;
  contributions: ContributionBreakdown[];
  net_impact: number;
  net_impact_legacy: number;
  net_impact_uncapped_v2: number;
  net_impact_damper05: number;
  quality: {
    event_coverage: number;
    future_coverage: number;
    directional_agreement: number;
    capped_at_max: boolean;
  };
}

interface ContributionBreakdown {
  source_type: "event" | "future_event";
  source_id: string;
  headline: string;
  driver_name: string;
  raw_impact: number;
  direction: "up" | "down";
  components: {
    sentiment: number;
    impact_normalized: number;
    driver_weight: number;
    time_decay?: number;
    priced_in?: number;
    probability?: number;
    quality_discount?: number;
    damper?: number;
  };
}

// ─── Extended types with driver weights ─────────────────────────────

interface EventWithDriverWeight extends Event {
  driver_weighting: number;
}

interface FutureEventWithDriverWeight extends FutureEvent {
  driver_weighting: number;
}

// ─── Time utilities ────────────────────────────────────────────────

function ageHours(d: Date | string): number {
  const ts = typeof d === 'string' ? new Date(d) : d;
  return (Date.now() - ts.getTime()) / 3_600_000;
}

function timeDecay(d: Date | string, windowDays: number, floor: number): number {
  const ageDays = ageHours(d) / 24;
  return Math.max(floor, 1 - ageDays / windowDays);
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════

export function buildL2AnalyzePrompt(
  asset: Asset,
  drivers: Driver[],
  events: EventWithDriverWeight[],
  futureEvents: FutureEventWithDriverWeight[],
  config: L2AnalyzeConfig = DEFAULT_L2_CONFIG
): string {
  const currentPrice = typeof asset.current_price === 'number' ? asset.current_price : parseFloat(asset.current_price as string) || 0;
  if (!currentPrice || currentPrice <= 0) {
    throw new Error(`Cannot run L2 Analyze: invalid current_price for ${asset.ticker}`);
  }

  const eventBlock = events.slice(0, 15).map((e, i) => {
    const decay = timeDecay(e.created_at, config.decay_window_days, config.min_time_decay);
    const driverWeight = typeof e.driver_weighting === 'number' ? e.driver_weighting : parseFloat(e.driver_weighting as string) || 0;
    const sentiment = typeof e.sentiment_score === 'number' ? e.sentiment_score : parseFloat(e.sentiment_score as string) || 0;
    const impact = typeof e.impact_score === 'number' ? e.impact_score : parseInt(e.impact_score as string) || 0;
    const preliminary = sentiment * (impact / 10) * driverWeight * decay;
    const dir = preliminary >= 0 ? "↑" : "↓";
    return `[E${i + 1}] id=${e.id}
  headline: ${e.headline}
  driver: ${e.driver_name} (weight: ${driverWeight.toFixed(2)})
  impact: ${impact}/10 | sentiment: ${sentiment.toFixed(2)} | age: ${ageHours(e.created_at).toFixed(1)}h
  preliminary contribution if fully unpriced: ${(preliminary * 100).toFixed(2)}% ${dir}`;
  }).join("\n\n");

  const futureBlock = futureEvents.slice(0, 10).map((f, i) => {
    const driverWeight = typeof f.driver_weighting === 'number' ? f.driver_weighting : parseFloat(f.driver_weighting as string) || 0;
    const sentiment = typeof f.sentiment_score === 'number' ? f.sentiment_score : parseFloat(f.sentiment_score as string) || 0;
    const impact = typeof f.impact_score === 'number' ? f.impact_score : parseInt(f.impact_score as string) || 0;
    const probability = typeof f.probability === 'number' ? f.probability : parseFloat(f.probability as string) || 0;
    const preliminary = sentiment * (impact / 10) * driverWeight * probability * config.future_damper;
    const dir = preliminary >= 0 ? "↑" : "↓";
    return `[F${i + 1}] id=${f.id}
  prediction: ${f.headline}
  driver: ${f.driver_name} (weight: ${driverWeight.toFixed(2)})
  impact: ${impact}/10 | sentiment: ${sentiment.toFixed(2)} | probability: ${(probability * 100).toFixed(0)}%
  preliminary contribution at quality_discount=1.0: ${(preliminary * 100).toFixed(2)}% ${dir}`;
  }).join("\n\n");

  const driverList = drivers.map(d => {
    const weight = typeof d.act_weighting === 'number' ? d.act_weighting : parseFloat(d.act_weighting as string) || 0;
    return `  - ${d.driver_name}: ${weight.toFixed(2)} weight`;
  }).join("\n");
  const maxGap = config.max_alpha_gap_pct(asset);

  return `You are a ${asset.asset_class} market analyst.
Your output will be processed by a deterministic formula to compute V_real.
You DO NOT output V_real directly — your job is to score INPUTS for the formula.

═══════════════════════════════════════
TARGET ASSET
═══════════════════════════════════════
Name:            ${asset.name} (${asset.ticker})
Class:           ${asset.asset_class}
Current Price:   ${currentPrice.toFixed(4)}
Sanity bound:    alpha-gap will be capped at ±${maxGap}%

═══════════════════════════════════════
ACTIVE DRIVERS (from L2 Research)
═══════════════════════════════════════
${driverList}

═══════════════════════════════════════
REALIZED EVENTS (${events.length} shown, max 15)
═══════════════════════════════════════
${eventBlock}

═══════════════════════════════════════
PREDICTED FUTURE EVENTS (${futureEvents.length} shown, max 10)
═══════════════════════════════════════
${futureBlock}

═══════════════════════════════════════
YOUR TASK
═══════════════════════════════════════

For each REALIZED EVENT, score:
  priced_in ∈ [0, 1]
    0.00 = brand new, market has not reacted yet
    0.50 = mostly priced in
    1.00 = fully priced in (event is old news)
  rationale: 1 sentence

For each PREDICTED FUTURE EVENT, score:
  quality_discount ∈ [0, 1]
    1.00 = well-supported prediction
    0.50 = reasonable with uncertainty
    0.00 = reject entirely
  rationale: 1 sentence

Then provide:
  market_narrative: 2-3 sentences
  suggested_timeframe_days: integer (7-30)
  abort_analysis: true ONLY if evidence is too thin
  abort_reason: if aborting, explain why

═══════════════════════════════════════
OUTPUT FORMAT (strict JSON, no markdown)
═══════════════════════════════════════
{
  "market_narrative": "Brief summary.",
  "event_scorings": [
    { "event_id": "uuid-1", "priced_in": 0.60, "rationale": "Event 3 days old." }
  ],
  "future_event_scorings": [
    { "future_event_id": "uuid-F1", "quality_discount": 0.75, "rationale": "Well-supported." }
  ],
  "suggested_timeframe_days": 14,
  "abort_analysis": false,
  "abort_reason": null
}

HARD CONSTRAINTS:
- Every event_id from REALIZED EVENTS MUST appear in event_scorings
- Every future_event_id from PREDICTED FUTURE EVENTS MUST appear in future_event_scorings
- priced_in ∈ [0, 1], quality_discount ∈ [0, 1]
- suggested_timeframe_days: integer in [3, 60]
- Respond with JSON only. No markdown.`;
}

// ═══════════════════════════════════════════════════════════════════
// DETERMINISTIC COMPUTATION
// ═══════════════════════════════════════════════════════════════════

export function computeAlpha(
  asset: Asset,
  events: EventWithDriverWeight[],
  futureEvents: FutureEventWithDriverWeight[],
  llmOutput: L2AnalyzeLLMOutput,
  config: L2AnalyzeConfig = DEFAULT_L2_CONFIG
): AlphaResult {
  if (llmOutput.abort_analysis) {
    throw new Error(`L2 Analyze aborted: ${llmOutput.abort_reason}`);
  }

  const currentPrice = asset.current_price;
  if (!currentPrice || currentPrice <= 0) throw new Error("Invalid current_price");

  const scoringMap = new Map(llmOutput.event_scorings.map(s => [s.event_id, s]));
  const futureScoringMap = new Map(llmOutput.future_event_scorings.map(s => [s.future_event_id, s]));

  const contributions: ContributionBreakdown[] = [];
  let netImpact = 0;

  // ─── V_real Aggregation v2 (Variant A): Driver-weighted mean ────────
  // Instead of summing sentiment×impact×weight per event (which lets
  // high-weight drivers dominate proportionally to event count),
  // we average the base impact per driver, then multiply by driver_weight once.
  // This makes netImpact reflect driver influence, not event volume.
  
  // Step 1: Compute per-event contributions (for logging) and track per-driver aggregates
  const driverAggregates = new Map<string, { totalBaseImpact: number; eventCount: number; driverWeight: number }>();

  // Realized events
  for (const e of events) {
    const scoring = scoringMap.get(e.id);
    if (!scoring) continue;

    const sentiment = e.sentiment_score;
    const impactNorm = e.impact_score / 10;
    const driverWeight = e.driver_weighting;
    const decay = timeDecay(e.created_at, config.decay_window_days, config.min_time_decay);
    const pricedInFactor = 1 - scoring.priced_in;

    const contribution = sentiment * impactNorm * driverWeight * decay * pricedInFactor;
    netImpact += contribution;

    // Track driver aggregates for Variant A
    const driverKey = e.driver_name || 'unknown';
    if (driverWeight > 0) {
      const baseImpact = contribution / driverWeight; // = sentiment * impactNorm * decay * pricedInFactor
      const existing = driverAggregates.get(driverKey);
      if (existing) {
        existing.totalBaseImpact += baseImpact;
        existing.eventCount += 1;
      } else {
        driverAggregates.set(driverKey, { totalBaseImpact: baseImpact, eventCount: 1, driverWeight });
      }
    }

    contributions.push({
      source_type: "event",
      source_id: e.id,
      headline: e.headline,
      driver_name: e.driver_name,
      raw_impact: contribution,
      direction: contribution >= 0 ? "up" : "down",
      components: { sentiment, impact_normalized: impactNorm, driver_weight: driverWeight, time_decay: decay, priced_in: scoring.priced_in },
    });
  }

  // ─── Snapshot: Real-Events-only (VOR Future-Events-Loop) ──────────
  // Needed for parallel logging: compute V2 with damper=0.5 separately
  const driverAggregatesRealOnly = new Map<string, { totalBaseImpact: number; eventCount: number; driverWeight: number }>();
  for (const [driverName, agg] of driverAggregates) {
    driverAggregatesRealOnly.set(driverName, { ...agg });
  }

  // Future events
  for (const f of futureEvents) {
    const scoring = futureScoringMap.get(f.id);
    if (!scoring) continue;

    const sentiment = f.sentiment_score;
    const impactNorm = f.impact_score / 10;
    const driverWeight = f.driver_weighting;
    const probability = f.probability;
    const qualityDiscount = scoring.quality_discount;
    const damper = config.future_damper_v3;

    const contribution = sentiment * impactNorm * driverWeight * probability * qualityDiscount * damper;
    netImpact += contribution;

    // Track driver aggregates for Variant A (future events)
    const driverKey = f.driver_name || 'unknown';
    if (driverWeight > 0) {
      const baseImpact = contribution / driverWeight; // = sentiment * impactNorm * probability * qualityDiscount * damper
      const existing = driverAggregates.get(driverKey);
      if (existing) {
        existing.totalBaseImpact += baseImpact;
        existing.eventCount += 1;
      } else {
        driverAggregates.set(driverKey, { totalBaseImpact: baseImpact, eventCount: 1, driverWeight });
      }
    }

    contributions.push({
      source_type: "future_event",
      source_id: f.id,
      headline: f.headline,
      driver_name: f.driver_name,
      raw_impact: contribution,
      direction: contribution >= 0 ? "up" : "down",
      components: { sentiment, impact_normalized: impactNorm, driver_weight: driverWeight, probability, quality_discount: qualityDiscount, damper },
    });
  }

  // Step 2: Compute Variant A netImpact (driver-weighted mean) with damper_v3 (0.3)
  let netImpactVariantA = 0;
  for (const [driverName, agg] of driverAggregates) {
    const avgBaseImpact = agg.totalBaseImpact / agg.eventCount;
    netImpactVariantA += avgBaseImpact * agg.driverWeight;
  }

  // ─── Doppel-Berechnung: V2-Mean mit damper=0.5 für Parallel-Logging ──
  // Seed from real-events-only snapshot, then add future events with damper=0.5
  const damperLegacy = config.future_damper; // 0.5

  const driverAggregatesLegacy = new Map<string, { totalBaseImpact: number; eventCount: number; driverWeight: number }>();
  for (const [driverName, agg] of driverAggregatesRealOnly) {
    driverAggregatesLegacy.set(driverName, { ...agg });
  }

  for (const f of futureEvents) {
    const scoring = futureScoringMap.get(f.id);
    if (!scoring) continue;

    const sentiment = f.sentiment_score;
    const impactNorm = f.impact_score / 10;
    const driverWeight = f.driver_weighting;
    const probability = f.probability;
    const qualityDiscount = scoring.quality_discount;

    const contributionLegacy = sentiment * impactNorm * driverWeight * probability * qualityDiscount * damperLegacy;

    const driverKey = f.driver_name || 'unknown';
    if (driverWeight > 0) {
      const baseImpactLegacy = contributionLegacy / driverWeight;
      const existing = driverAggregatesLegacy.get(driverKey);
      if (existing) {
        existing.totalBaseImpact += baseImpactLegacy;
        existing.eventCount += 1;
      } else {
        driverAggregatesLegacy.set(driverKey, { totalBaseImpact: baseImpactLegacy, eventCount: 1, driverWeight });
      }
    }
  }

  let netImpactVariantALegacy = 0;
  for (const [driverName, agg] of driverAggregatesLegacy) {
    const avgBaseImpact = agg.totalBaseImpact / agg.eventCount;
    netImpactVariantALegacy += avgBaseImpact * agg.driverWeight;
  }

  // Preserve legacy netImpact for parallel logging
  const netImpactLegacy = netImpact;
  
  // Use Variant A as the actual netImpact for V_real calculation
  netImpact = netImpactVariantA;

  // Store uncapped V2 value before cap application
  const netImpactUncappedV2 = netImpactVariantA;

  // Sanity bounds
  const maxGapPct = config.max_alpha_gap_pct(asset);
  const maxNetImpact = maxGapPct / 100;
  let capped = false;
  if (Math.abs(netImpact) > maxNetImpact) {
    netImpact = Math.sign(netImpact) * maxNetImpact;
    capped = true;
  }

  const vreal = currentPrice * (1 + netImpact);
  const alphaGap = vreal - currentPrice;
  const alphaGapPct = (alphaGap / currentPrice) * 100;

  // Confidence
  const confidence = computeConfidence(events, futureEvents, contributions, capped);

  // Quality signals
  const eventCoverage = events.length > 0 ? scoringMap.size / events.length : 0;
  const futureCoverage = futureEvents.length > 0 ? futureScoringMap.size / futureEvents.length : 0;
  const directionalAgreement = computeDirectionalAgreement(contributions);

  // Reasoning
  const top3 = contributions.slice().sort((a, b) => Math.abs(b.raw_impact) - Math.abs(a.raw_impact)).slice(0, 3);
  const reasoning = `${llmOutput.market_narrative} Net impact: ${(netImpact * 100).toFixed(2)}%${capped ? ` (capped at ±${maxGapPct}%)` : ""}. Top: ${top3.map(c => `${c.headline.slice(0, 50)}... (${(c.raw_impact * 100).toFixed(2)}%)`).join("; ")}`;

  return {
    vreal: Number(vreal.toFixed(6)),
    alpha_gap: Number(alphaGap.toFixed(6)),
    alpha_gap_pct: Number(alphaGapPct.toFixed(3)),
    confidence: Number(confidence.toFixed(3)),
    timeframe_days: llmOutput.suggested_timeframe_days,
    reasoning,
    contributions,
    net_impact: Number(netImpact.toFixed(6)),
    net_impact_legacy: Number(netImpactLegacy.toFixed(6)),
    net_impact_uncapped_v2: Number(netImpactUncappedV2.toFixed(6)),
    net_impact_damper05: Number(netImpactVariantALegacy.toFixed(6)),
    quality: {
      event_coverage: Number(eventCoverage.toFixed(3)),
      future_coverage: Number(futureCoverage.toFixed(3)),
      directional_agreement: Number(directionalAgreement.toFixed(3)),
      capped_at_max: capped,
    },
  };
}

// ─── Confidence derivation ─────────────────────────────────────────

function computeConfidence(
  events: EventWithDriverWeight[],
  futureEvents: FutureEventWithDriverWeight[],
  contributions: ContributionBreakdown[],
  capped: boolean
): number {
  if (contributions.length === 0) return 0;

  const volumeScore = Math.min(1, contributions.length / 10);
  const agreement = computeDirectionalAgreement(contributions);

  const realizedWeight = contributions.filter(c => c.source_type === "event").reduce((sum, c) => sum + Math.abs(c.raw_impact), 0);
  const futureWeight = contributions.filter(c => c.source_type === "future_event").reduce((sum, c) => sum + Math.abs(c.raw_impact), 0);
  const totalWeight = realizedWeight + futureWeight;
  const realizedRatio = totalWeight > 0 ? realizedWeight / totalWeight : 0;

  const capPenalty = capped ? 0.15 : 0;

  const rawConfidence = 0.25 * volumeScore + 0.35 * agreement + 0.30 * realizedRatio + 0.10;
  return Math.max(0, Math.min(0.95, rawConfidence - capPenalty));
}

function computeDirectionalAgreement(contributions: ContributionBreakdown[]): number {
  if (contributions.length === 0) return 0;
  const upMass = contributions.filter(c => c.raw_impact > 0).reduce((s, c) => s + Math.abs(c.raw_impact), 0);
  const downMass = contributions.filter(c => c.raw_impact < 0).reduce((s, c) => s + Math.abs(c.raw_impact), 0);
  const total = upMass + downMass;
  if (total === 0) return 0;
  return Math.max(upMass, downMass) / total;
}