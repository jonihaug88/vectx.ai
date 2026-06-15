// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Layer 2 Analyze v2.1 (Compact JSON for GLM-5)
// ═══════════════════════════════════════════════════════════════════

import { z } from "zod";
import type { Asset, Driver } from "./types";

// ─── Compact LLM output shape ──────────────────────────────────────

export const CompactL2Output = z
  .object({
    market_narrative: z.string().min(10),
    event_scorings: z.array(
      z.object({
        id: z.string().min(1),
        p: z.number().min(0).max(1), // priced_in
      })
    ),
    future_event_scorings: z.array(
      z.object({
        id: z.string().min(1),
        q: z.number().min(0).max(1), // quality_discount
      })
    ),
    timeframe_days: z.number().int().min(3).max(60),
    abort: z.boolean(),
    abort_reason: z.string().nullable(),
  })
  .refine(
    (d) => !d.abort || (d.abort_reason !== null && d.abort_reason.length > 3),
    { message: "abort_reason required when abort=true" }
  );

export type CompactL2Output = z.infer<typeof CompactL2Output>;

// ─── Normalize compact → full internal format ─────────────────────

export interface FullL2Output {
  market_narrative: string;
  event_scorings: Array<{ event_id: string; priced_in: number; rationale: string }>;
  future_event_scorings: Array<{
    future_event_id: string;
    quality_discount: number;
    rationale: string;
  }>;
  suggested_timeframe_days: number;
  abort_analysis: boolean;
  abort_reason: string | null;
}

export function toFullFormat(compact: CompactL2Output): FullL2Output {
  return {
    market_narrative: compact.market_narrative,
    event_scorings: compact.event_scorings.map((s) => ({
      event_id: s.id,
      priced_in: s.p,
      rationale: "",
    })),
    future_event_scorings: compact.future_event_scorings.map((s) => ({
      future_event_id: s.id,
      quality_discount: s.q,
      rationale: "",
    })),
    suggested_timeframe_days: compact.timeframe_days,
    abort_analysis: compact.abort,
    abort_reason: compact.abort_reason,
  };
}

// ─── Compact prompt builder ────────────────────────────────────────

interface EventWithDriverWeight {
  id: string;
  headline: string;
  driver_name: string;
  driver_weighting: number;
  impact_score: number;
  sentiment_score: number;
  created_at: Date | string;
}

interface FutureEventWithDriverWeight {
  id: string;
  headline: string;
  driver_name: string;
  driver_weighting: number;
  impact_score: number;
  sentiment_score: number;
  probability: number;
}

export function buildCompactL2Prompt(
  asset: Asset,
  drivers: Driver[],
  events: EventWithDriverWeight[],
  futureEvents: FutureEventWithDriverWeight[],
  opts: { maxEvents?: number; maxFutureEvents?: number; strictRetry?: boolean } = {}
): string {
  const { maxEvents = 10, maxFutureEvents = 6, strictRetry = false } = opts;

  const currentPrice = typeof asset.current_price === 'number' ? asset.current_price : parseFloat(asset.current_price as string) || 0;
  if (!currentPrice || currentPrice <= 0) {
    throw new Error(`Invalid current_price for ${asset.ticker}`);
  }

  // Compact event list — one line per event
  const eventLines = events.slice(0, maxEvents).map((e) => {
    const ts = typeof e.created_at === 'string' ? new Date(e.created_at) : e.created_at;
    const ageH = ((Date.now() - ts.getTime()) / 3_600_000).toFixed(0);
    const s_raw = typeof e.sentiment_score === 'number' ? e.sentiment_score : parseFloat(e.sentiment_score as string) || 0;
    const s = s_raw >= 0 ? `+${s_raw.toFixed(2)}` : s_raw.toFixed(2);
    const i_raw = typeof e.impact_score === 'number' ? e.impact_score : parseInt(e.impact_score as string) || 0;
    return `${e.id} | imp=${i_raw}/10 sent=${s} age=${ageH}h drv=${e.driver_name.slice(0, 20)} | ${e.headline.slice(0, 80)}`;
  }).join("\n");

  const futureLines = futureEvents.slice(0, maxFutureEvents).map((f) => {
    const s_raw = typeof f.sentiment_score === 'number' ? f.sentiment_score : parseFloat(f.sentiment_score as string) || 0;
    const s = s_raw >= 0 ? `+${s_raw.toFixed(2)}` : s_raw.toFixed(2);
    const i_raw = typeof f.impact_score === 'number' ? f.impact_score : parseInt(f.impact_score as string) || 0;
    const p_raw = typeof f.probability === 'number' ? f.probability : parseFloat(f.probability as string) || 0;
    return `${f.id} | imp=${i_raw}/10 sent=${s} prob=${p_raw.toFixed(2)} drv=${f.driver_name.slice(0, 20)} | ${f.headline.slice(0, 80)}`;
  }).join("\n");

  const driverLines = drivers.map((d) => {
    const w = typeof d.act_weighting === 'number' ? d.act_weighting : parseFloat(d.act_weighting as string) || 0;
    return `${d.driver_name}: ${w.toFixed(2)}`;
  }).join("\n");

  const strictHeader = strictRetry
    ? `⚠ PREVIOUS ATTEMPT PRODUCED INVALID JSON. BE STRICT. VALIDATE YOUR OUTPUT BEFORE RESPONDING.\n\n`
    : "";

  return `${strictHeader}Analyze ${asset.name} (${asset.ticker}) at ${currentPrice.toFixed(4)}.

Task: For each event, score how much is already priced in (p, 0-1).
For each prediction, score quality (q, 0-1).

DRIVERS:
${driverLines}

EVENTS:
${eventLines}

PREDICTIONS:
${futureLines}

SCORING GUIDE:
p (priced_in):  0=fresh news  0.5=partially priced  1=fully priced
q (quality):    0=reject      0.5=moderate          1=well-supported

Return EXACTLY this JSON structure (no markdown, no text before/after):

{"market_narrative":"2-3 sentences on current setup","event_scorings":[{"id":"<event_id>","p":0.5}],"future_event_scorings":[{"id":"<future_id>","q":0.7}],"timeframe_days":14,"abort":false,"abort_reason":null}

RULES:
- Include ALL ${events.slice(0, maxEvents).length} events and ALL ${futureEvents.slice(0, maxFutureEvents).length} predictions
- Use the exact IDs shown above
- p and q: numbers between 0.0 and 1.0 (two decimals max)
- timeframe_days: integer 3-60
- If evidence too thin: set "abort":true and provide "abort_reason"
- Output JSON ONLY, nothing else

JSON:`;
}

// ═══════════════════════════════════════════════════════════════════
// PARSING WITH RECOVERY
// ═══════════════════════════════════════════════════════════════════

export interface ParseResult {
  success: boolean;
  data: CompactL2Output | null;
  method: "direct" | "repaired" | "failed";
  error?: string;
}

// Simple JSON repair function (avoiding external dependency)
function simpleJsonRepair(str: string): string {
  // Remove trailing commas
  let repaired = str.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  // Fix unquoted keys (simple cases)
  repaired = repaired.replace(/(\w+):/g, '"$1":');
  return repaired;
}

export function parseCompactL2(rawText: string): ParseResult {
  // Step 1: Clean markdown fences and any surrounding text
  let cleaned = rawText.trim();
  
  // Remove ```json and ``` markers
  cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  
  // Remove any text before { and after }
  const startBrace = cleaned.indexOf('{');
  const endBrace = cleaned.lastIndexOf('}');
  
  if (startBrace === -1 || endBrace === -1 || endBrace < startBrace) {
    return { success: false, data: null, method: "failed", error: "No JSON object found" };
  }
  
  const jsonStr = cleaned.substring(startBrace, endBrace + 1);

  // Step 2: Direct parse attempt
  try {
    const parsed = JSON.parse(jsonStr);
    const validated = CompactL2Output.safeParse(parsed);
    if (validated.success) {
      return { success: true, data: validated.data, method: "direct" };
    }
  } catch {
    // Fall through to repair
  }

  // Step 3: Repair attempt
  try {
    const repaired = simpleJsonRepair(jsonStr);
    const parsed = JSON.parse(repaired);
    const validated = CompactL2Output.safeParse(parsed);
    if (validated.success) {
      return { success: true, data: validated.data, method: "repaired" };
    }
    return {
      success: false,
      data: null,
      method: "failed",
      error: `Schema validation failed after repair: ${validated.error.message}`,
    };
  } catch (err) {
    return {
      success: false,
      data: null,
      method: "failed",
      error: `JSON repair failed: ${(err as Error).message}`,
    };
  }
}