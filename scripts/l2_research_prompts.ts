// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Layer 2 Research v2: Split Prompts
// ═══════════════════════════════════════════════════════════════════

import type { Asset, Driver, ClassifiedEvent } from "./types";

interface EventForPrompt extends ClassifiedEvent {
  selection_reason?: "driver_balance" | "high_impact_global";
}

// ─── Shared formatting helpers ─────────────────────────────────────

function formatEvent(e: EventForPrompt, index: number): string {
  const age = humanAge(new Date(e.created_at));
  const sentimentLabel =
    e.sentiment_score > 0.3 ? "bullish" :
    e.sentiment_score < -0.3 ? "bearish" : "neutral";
  return `${index + 1}. [${age}] ${e.headline}
   driver: ${e.driver_name} | impact: ${e.impact_score}/10 | sentiment: ${e.sentiment_score.toFixed(2)} (${sentimentLabel})
   type: ${e.supply_or_demand} / ${e.quantitative_or_qualitative}
   id: ${e.id}
   summary: ${e.summary}`;
}

function humanAge(ts: Date): string {
  const hours = (Date.now() - ts.getTime()) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDriver(d: Driver, index: number): string {
  const weight = typeof d.act_weighting === 'number' ? d.act_weighting : parseFloat(d.act_weighting as string) || 0;
  return `${index + 1}. ${d.driver_name}
   class: ${d.class || 'n/a'} | type: ${d.supply_or_demand} / ${d.quantitative_or_qualitative}
   current_weighting: ${weight.toFixed(2)}
   description: ${d.description || 'No description'}`;
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT 1: DRIVER WEIGHTINGS (Diagnostic)
// ═══════════════════════════════════════════════════════════════════

export function buildDriverWeightingPrompt(
  asset: { name: string; ticker: string; asset_class: string },
  drivers: Driver[],
  events: EventForPrompt[]
): string {
  const eventList = events.map(formatEvent).join("\n\n");
  const driverList = drivers.map(formatDriver).join("\n\n");

  return `You are a quantitative market analyst specializing in ${asset.asset_class}.
Your task is DIAGNOSTIC: based on current evidence, determine how much each
price driver is influencing ${asset.ticker} right now.

═══════════════════════════════════════
TARGET ASSET
═══════════════════════════════════════
Name:  ${asset.name} (${asset.ticker})
Class: ${asset.asset_class}

═══════════════════════════════════════
KNOWN DRIVERS (${drivers.length})
═══════════════════════════════════════
${driverList}

═══════════════════════════════════════
RECENT EVIDENCE (${events.length} events, last 7d, impact ≥ 4)
═══════════════════════════════════════
${eventList}

═══════════════════════════════════════
YOUR TASK
═══════════════════════════════════════

Assign a weighting (0.0 to 1.0) to EACH known driver, representing its
current influence on ${asset.ticker}'s price formation.

RULES:
1. Weightings across ALL drivers MUST sum to exactly 1.0
2. A driver with no supporting evidence gets weighting ≤ 0.05
3. A driver with multiple high-impact events gets weighting ≥ 0.15
4. Recent events (< 24h) should influence weightings more than older ones
5. If you think a new driver is emerging, flag it in "emerging_drivers"
   DO NOT give weighting to unlisted drivers

EVIDENCE STANDARD:
For each driver with weighting > 0.10, cite AT LEAST ONE event_id from the
evidence list. Weightings without citations will be rejected.

═══════════════════════════════════════
OUTPUT FORMAT (strict JSON, no markdown)
═══════════════════════════════════════
{
  "analysis_summary": "2-3 sentence overview of what's currently driving ${asset.ticker}.",
  "driver_weightings": [
    {
      "driver_name": "OPEC Production Decisions",
      "weighting": 0.35,
      "weighting_delta": 0.10,
      "confidence": 0.82,
      "supporting_event_ids": ["uuid-1", "uuid-2"],
      "rationale": "1 sentence explaining WHY this weighting."
    }
  ],
  "emerging_drivers": [
    {
      "proposed_name": "Strategic Petroleum Reserve releases",
      "justification": "Multiple events mention SPR activity not covered by existing drivers.",
      "suggested_weighting": 0.08
    }
  ],
  "unused_events": ["event_id_x"]
}

═══════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════
▸ SUM of all weightings = 1.00 (±0.001 tolerance)
▸ EVERY driver from the input list MUST appear in driver_weightings
▸ Weightings ∈ [0.0, 1.0]
▸ supporting_event_ids MUST reference IDs from the evidence list
▸ Respond with JSON only. No markdown, no preamble, no commentary.`;
}

// ═══════════════════════════════════════════════════════════════════
// PROMPT 2: FUTURE EVENTS (Prognostic)
// ═══════════════════════════════════════════════════════════════════

export function buildFutureEventsPrompt(
  asset: { name: string; ticker: string; asset_class: string },
  drivers: Driver[],
  events: EventForPrompt[],
  horizonDays: number = 14
): string {
  const eventList = events.map(formatEvent).join("\n\n");
  const driverList = drivers
    .map((d, i) => {
      const weight = typeof d.act_weighting === 'number' ? d.act_weighting : parseFloat(d.act_weighting as string) || 0;
      return `${i + 1}. ${d.driver_name} (current weight: ${weight.toFixed(2)})`;
    })
    .join("\n");

  return `You are a ${asset.asset_class} market forecaster.
Your task is PROGNOSTIC: identify 3-5 plausible future events that could
move ${asset.ticker} in the next ${horizonDays} days.

═══════════════════════════════════════
TARGET ASSET
═══════════════════════════════════════
Name:     ${asset.name} (${asset.ticker})
Class:    ${asset.asset_class}
Horizon:  ${horizonDays} days from now

═══════════════════════════════════════
KNOWN DRIVERS
═══════════════════════════════════════
${driverList}

═══════════════════════════════════════
CURRENT EVIDENCE (${events.length} recent events)
═══════════════════════════════════════
${eventList}

═══════════════════════════════════════
YOUR TASK
═══════════════════════════════════════

Generate 3-5 future events that could plausibly occur within the next
${horizonDays} days, based on the current evidence and your knowledge of
${asset.asset_class} market dynamics.

QUALITY BAR:
Each future event must be:
▸ SPECIFIC — "OPEC meeting announces 500kbpd cut" not "OPEC might act"
▸ LINKED — every event must cite a known driver from the list above
▸ GROUNDED — each event should follow from current evidence (cite event_ids)
▸ PROBABILISTIC — honest probability, not defaulting to 0.5 or 0.9
▸ NEW — do not re-state events that already happened

PROBABILITY CALIBRATION:
  0.80-0.95 = scheduled events with very high likelihood
  0.50-0.75 = plausible developments based on trending evidence
  0.25-0.45 = possible tail risks worth monitoring
  < 0.25    = don't generate — too speculative

AVOID THESE FAILURE MODES:
- Generic events ("geopolitical tensions may rise") → too vague
- Orphan events not tied to any driver → can't be weighted
- Contradicting the current evidence → if evidence shows dovish OPEC,
  don't predict a surprise hawkish move at 0.70 probability
- Recency bias — don't just extrapolate the latest headline

═══════════════════════════════════════
OUTPUT FORMAT (strict JSON, no markdown)
═══════════════════════════════════════
{
  "market_context": "2-3 sentences: what's the current market setup?",
  "future_events": [
    {
      "event_type": "supply_shock",
      "headline": "OPEC+ extends voluntary cuts through Q3",
      "summary": "Based on recent Saudi signals, production cuts likely extended at June meeting.",
      "driver_name": "OPEC Production Decisions",
      "impact_score": 8,
      "sentiment_score": 0.65,
      "supply_or_demand": "supply",
      "quantitative_or_qualitative": "quantitative",
      "probability": 0.65,
      "timeline_score": 3,
      "expected_date_range": "2026-05-01 to 2026-05-15",
      "supporting_event_ids": ["uuid-1"],
      "invalidation_signal": "A Saudi statement reversing recent guidance"
    }
  ],
  "confidence_overall": 0.68
}

═══════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════
▸ Generate BETWEEN 3 and 5 future events
▸ Each event's driver_name MUST match a known driver
▸ probability ∈ [0.25, 0.95]
▸ impact_score ∈ [1, 10], integer
▸ timeline_score ∈ [1, 10], integer
▸ sentiment_score ∈ [-1.0, 1.0]
▸ supporting_event_ids MUST reference IDs from current evidence
▸ expected_date_range within next ${horizonDays} days
▸ Respond with JSON only. No markdown, no preamble, no commentary.`;
}