// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Layer 2 Research: Output Validation & Quality Signals
// ═══════════════════════════════════════════════════════════════════

import { z } from "zod";

// ─── Driver Weighting Output ──────────────────────────────────────

const DriverWeightingEntry = z.object({
  driver_name: z.string().min(1),
  weighting: z.number().min(0).max(1),
  weighting_delta: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  supporting_event_ids: z.array(z.string()),
  rationale: z.string().min(10),
});

const EmergingDriver = z.object({
  proposed_name: z.string().min(3),
  justification: z.string().min(20),
  suggested_weighting: z.number().min(0).max(0.2),
});

export const DriverWeightingOutputSchema = z
  .object({
    analysis_summary: z.string().min(20),
    driver_weightings: z.array(DriverWeightingEntry).min(1),
    emerging_drivers: z.array(EmergingDriver),
    unused_events: z.array(z.string()),
  })
  .refine(
    (d) => {
      const sum = d.driver_weightings.reduce((a, e) => a + e.weighting, 0);
      return Math.abs(sum - 1.0) <= 0.05; // Allow 5% deviation; we'll normalize
    },
    { message: "driver_weightings must sum to approximately 1.0 (±0.05)" }
  )
  .refine(
    (d) =>
      d.driver_weightings
        .filter((w) => w.weighting > 0.1)
        .every((w) => w.supporting_event_ids.length >= 1),
    { message: "weightings > 0.10 must cite at least one supporting_event_id" }
  );

export type DriverWeightingOutput = z.infer<typeof DriverWeightingOutputSchema>;

// ─── Future Events Output ─────────────────────────────────────────

const FutureEventEntry = z.object({
  event_type: z.string().min(3), // More lenient - accept any string
  headline: z.string().min(10).max(200),
  summary: z.string().min(20),
  driver_name: z.string().min(1),
  impact_score: z.number().int().min(1).max(10),
  sentiment_score: z.number().min(-1).max(1),
  supply_or_demand: z.enum(["supply", "demand", "both", "neither"]),
  quantitative_or_qualitative: z.enum(["quantitative", "qualitative", "both"]),
  probability: z.number().min(0.25).max(0.95),
  timeline_score: z.number().int().min(1).max(10),
  expected_date_range: z.string().min(10),
  supporting_event_ids: z.array(z.string()), // Allow empty - LLMs may not always have supporting events
  invalidation_signal: z.string().min(10),
});

export const FutureEventsOutputSchema = z.object({
  market_context: z.string().min(20),
  future_events: z.array(FutureEventEntry).min(3).max(5),
  confidence_overall: z.number().min(0).max(1),
});

export type FutureEventsOutput = z.infer<typeof FutureEventsOutputSchema>;

// ─── Cross-validation ─────────────────────────────────────────────

export interface ResearchValidationContext {
  known_driver_names: Set<string>;
  valid_event_ids: Set<string>;
}

export function validateDriverWeightings(
  output: DriverWeightingOutput,
  ctx: ResearchValidationContext
): { ok: true; warnings?: string[] } | { ok: false; reason: string } {
  const warnings: string[] = [];
  
  // Check driver names - must match known drivers
  for (const dw of output.driver_weightings) {
    if (!ctx.known_driver_names.has(dw.driver_name)) {
      return { ok: false, reason: `Unknown driver: "${dw.driver_name}"` };
    }
  }

  // Check for missing drivers - warn but don't fail
  const outputDrivers = new Set(output.driver_weightings.map((d) => d.driver_name));
  for (const known of ctx.known_driver_names) {
    if (!outputDrivers.has(known)) {
      return { ok: false, reason: `Missing driver: "${known}"` };
    }
  }

  // Check event IDs - strip invalid ones instead of failing
  // LLMs frequently hallucinate event IDs; the weightings themselves are still valid
  let invalidIdCount = 0;
  for (const dw of output.driver_weightings) {
    const validIds = dw.supporting_event_ids.filter(eid => {
      if (ctx.valid_event_ids.has(eid)) return true;
      invalidIdCount++;
      return false;
    });
    if (validIds.length !== dw.supporting_event_ids.length) {
      warnings.push(`Driver "${dw.driver_name}": stripped ${dw.supporting_event_ids.length - validIds.length} invalid event_id(s)`);
      dw.supporting_event_ids = validIds;
    }
  }
  
  if (invalidIdCount > 0) {
    warnings.push(`Total invalid event_ids stripped: ${invalidIdCount}`);
  }

  return { ok: true, warnings };
}

export function validateFutureEvents(
  output: FutureEventsOutput,
  ctx: ResearchValidationContext
): { ok: true } | { ok: false; reason: string } {
  for (const fe of output.future_events) {
    if (!ctx.known_driver_names.has(fe.driver_name)) {
      return { ok: false, reason: `Unknown driver in future event: "${fe.driver_name}"` };
    }
    // Note: We don't validate supporting_event_ids because LLMs may hallucinate IDs
    // The novelty tracking will handle this separately
  }
  return { ok: true };
}

// ─── Quality Signals ───────────────────────────────────────────────

export interface L2QualitySignals {
  weighting_entropy: number;
  weighting_max: number;
  weighting_min_nonzero: number;
  evidence_coverage: number;
  emerging_drivers_count: number;
  future_events_count: number;
  probability_mean: number;
  probability_variance: number;
  driver_diversity: number;
  avg_timeline_score: number;
  avg_impact_score: number;
  unknown_driver_count: number;
  invalid_event_id_count: number;
  weighting_sum_error: number;
}

export function computeQualitySignals(
  weightings: DriverWeightingOutput,
  futures: FutureEventsOutput,
  inputEventIds: string[],
  knownDrivers: string[]
): L2QualitySignals {
  const weights = weightings.driver_weightings.map((d) => d.weighting).filter((w) => w > 0);
  const entropy = -weights.reduce((sum, w) => sum + w * Math.log2(w), 0);

  const allCitedIds = new Set<string>();
  for (const dw of weightings.driver_weightings) {
    dw.supporting_event_ids.forEach((id) => allCitedIds.add(id));
  }
  for (const fe of futures.future_events) {
    fe.supporting_event_ids.forEach((id) => allCitedIds.add(id));
  }

  const evidenceCoverage =
    inputEventIds.length > 0
      ? inputEventIds.filter((id) => allCitedIds.has(id)).length / inputEventIds.length
      : 0;

  const probs = futures.future_events.map((e) => e.probability);
  const probMean = probs.reduce((a, b) => a + b, 0) / probs.length;
  const probVar = probs.reduce((a, b) => a + (b - probMean) ** 2, 0) / probs.length;

  const knownSet = new Set(knownDrivers);
  const validEventIds = new Set(inputEventIds);

  let unknownDriverCount = 0;
  let invalidEventIdCount = 0;

  for (const dw of weightings.driver_weightings) {
    if (!knownSet.has(dw.driver_name)) unknownDriverCount++;
    dw.supporting_event_ids.forEach((id) => {
      if (!validEventIds.has(id)) invalidEventIdCount++;
    });
  }
  for (const fe of futures.future_events) {
    if (!knownSet.has(fe.driver_name)) unknownDriverCount++;
    fe.supporting_event_ids.forEach((id) => {
      if (!validEventIds.has(id)) invalidEventIdCount++;
    });
  }

  const futureDrivers = new Set(futures.future_events.map((e) => e.driver_name));
  const driverDiversity = futureDrivers.size / futures.future_events.length;

  const weightingSum = weightings.driver_weightings.reduce((a, d) => a + d.weighting, 0);

  return {
    weighting_entropy: Number(entropy.toFixed(3)),
    weighting_max: Math.max(...weightings.driver_weightings.map((d) => d.weighting)),
    weighting_min_nonzero: Math.min(...weights),
    evidence_coverage: Number(evidenceCoverage.toFixed(3)),
    emerging_drivers_count: weightings.emerging_drivers.length,
    future_events_count: futures.future_events.length,
    probability_mean: Number(probMean.toFixed(3)),
    probability_variance: Number(probVar.toFixed(4)),
    driver_diversity: Number(driverDiversity.toFixed(3)),
    avg_timeline_score: Number(
      (futures.future_events.reduce((a, e) => a + e.timeline_score, 0) / futures.future_events.length).toFixed(2)
    ),
    avg_impact_score: Number(
      (futures.future_events.reduce((a, e) => a + e.impact_score, 0) / futures.future_events.length).toFixed(2)
    ),
    unknown_driver_count: unknownDriverCount,
    invalid_event_id_count: invalidEventIdCount,
    weighting_sum_error: Number(Math.abs(weightingSum - 1.0).toFixed(4)),
  };
}