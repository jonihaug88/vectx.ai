/**
 * VECTX V3 - Layer 2 Analyze Shadow (Driver-First)
 * 
 * Shadow V_real comparison: identical logic to layer2_analyze_v2.ts,
 * but reads events from driver_first_shadow_events instead of central.events.
 * 
 * ISOLATION:
 *   - Writes ONLY to central.alpha_shadow and central.l2_shadow_analyze_runs
 *   - NEVER writes to central.alpha, central.assets, central.vreal_history, central.paper_trades
 *   - Reads driver_first_shadow_events (read-only), central.future_events (shared), central.drivers (shared)
 *   - Asset filter: hardcoded EURUSD, GC, ZS only
 *   - vreal_version = 'shadow_df_v1'
 * 
 * SINGLE VARIABLE: Event source (DF shadow vs RSS). Everything else identical.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { buildCompactL2Prompt, parseCompactL2, toFullFormat, type FullL2Output } from './l2_analyze_compact.js';
import { computeAlpha, DEFAULT_L2_CONFIG, type AlphaResult } from './l2_analyze_v2.js';
import type { Asset, Driver, Event, FutureEvent } from './types.js';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;
const GEMINI_API_KEY = config.gemini_api_key;
const USE_GEMINI = true;
const OLLAMA_API_KEY = config.ollama_cloud.api_key;
const OLLAMA_MODEL = config.ollama_cloud.model;

const SHADOW_ASSETS = ['EURUSD', 'GC', 'ZS'];
const PROMPT_VERSION = 'shadow_v1';

// ─── Zod Schemas (identical to production) ──────────────────────────

const EventScoringSchema = z.object({
  event_id: z.string().min(1),
  priced_in: z.number().min(0).max(1),
  rationale: z.string().min(5),
});

const FutureEventScoringSchema = z.object({
  future_event_id: z.string().min(1),
  quality_discount: z.number().min(0).max(1),
  rationale: z.string().min(5),
});

const L2LLMOutputSchema = z.object({
  market_narrative: z.string().min(20),
  event_scorings: z.array(EventScoringSchema),
  future_event_scorings: z.array(FutureEventScoringSchema),
  suggested_timeframe_days: z.number().int().min(3).max(60),
  abort_analysis: z.boolean(),
  abort_reason: z.string().nullable(),
});

// ─── Database ──────────────────────────────────────────────────────

async function runSql<T>(query: string): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ sql: query }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SQL error: ${response.status} - ${text}`);
  }
  const data = await response.json();
  return data.data || [];
}

async function getAssetsForShadow(): Promise<{ asset_id: string; asset_name: string }[]> {
  // ONLY shadow test assets, with DF events in last 48h
  const query = `
    SELECT DISTINCT a.id as asset_id, a.name as asset_name
    FROM central.assets a
    WHERE a.ticker IN ('EURUSD', 'GC', 'ZS')
    AND EXISTS (
      SELECT 1 FROM central.driver_first_shadow_events df 
      WHERE df.asset_id = a.id 
      AND df.created_at >= NOW() - INTERVAL '48 hours'
      AND df.headline IS NOT NULL AND df.headline != ''
    )
    ORDER BY a.name
  `;
  return runSql<{ asset_id: string; asset_name: string }>(query);
}

async function getAsset(assetId: string): Promise<Asset | null> {
  const results = await runSql<Asset>(`SELECT id, ticker, name, asset_class, current_price FROM central.assets WHERE id = '${assetId}'`);
  return results[0] || null;
}

async function getDrivers(assetId: string): Promise<Driver[]> {
  return runSql<Driver>(`SELECT id, driver_name, act_weighting, description, supply_or_demand FROM central.drivers WHERE asset_id = '${assetId}' ORDER BY act_weighting DESC NULLS LAST`);
}

// ─── KEY DIFFERENCE: Read from driver_first_shadow_events instead of central.events ────
// Note: driver_first_shadow_events lacks event_type column (vs central.events which has it)
async function getEvents(assetId: string): Promise<(Event & { driver_weighting: number })[]> {
  const query = `
    SELECT e.id, e.headline, e.summary, e.impact_score, e.sentiment_score,
           e.timeline_score, e.driver_name, e.supply_or_demand, e.quantitative_or_qualitative,
           e.created_at, COALESCE(d.act_weighting, 0) as driver_weighting
    FROM central.driver_first_shadow_events e
    LEFT JOIN central.drivers d ON d.asset_id = e.asset_id AND d.driver_name = e.driver_name
    WHERE e.asset_id = '${assetId}'
    AND e.headline IS NOT NULL AND e.headline != ''
    ORDER BY e.created_at DESC
    LIMIT 15
  `;
  return runSql<Event & { driver_weighting: number }>(query);
}

// ─── IDENTICAL to production: Future events come from central.future_events ────
async function getFutureEvents(assetId: string): Promise<(FutureEvent & { driver_weighting: number })[]> {
  const query = `
    SELECT f.id, f.event_type, f.headline, f.summary, f.impact_score, f.sentiment_score,
           f.probability, f.timeline_score, f.driver_name, f.supply_or_demand,
           COALESCE(d.act_weighting, 0) as driver_weighting
    FROM central.future_events f
    LEFT JOIN central.drivers d ON d.asset_id = f.asset_id AND d.driver_name = f.driver_name
    WHERE f.asset_id = '${assetId}'
    AND f.created_at >= NOW() - INTERVAL '48 hours'
    ORDER BY f.probability DESC, f.impact_score DESC
    LIMIT 10
  `;
  return runSql<FutureEvent & { driver_weighting: number }>(query);
}

// ─── ISOLATED: Write to alpha_shadow ONLY ────────────────────────────
async function insertAlphaShadow(
  assetId: string,
  assetName: string,
  alpha: AlphaResult,
  currentPrice: number,
  eventCount: number,
  futureEventCount: number
): Promise<void> {
  const escapeSql = (str: string): string => `'${str.replace(/'/g, "''").replace(/\\/g, '\\\\')}'`;
  const escapeJson = (obj: unknown): string => {
    const json = JSON.stringify(obj);
    return `'${json.replace(/'/g, "''")}'`;
  };
  const validityHours = 24;

  await runSql(`
    INSERT INTO central.alpha_shadow (asset_id, asset_name, vreal, alpha_gap, alpha_gap_pct, current_price, 
      validity_hours, event_count, future_event_count, confidence, net_impact, 
      net_impact_uncapped_v2, net_impact_damper05, capped_at_max, source, vreal_version, contributions)
    VALUES ('${assetId}', ${escapeSql(assetName)}, ${alpha.vreal}, ${alpha.alpha_gap}, ${alpha.alpha_gap_pct}, ${currentPrice}, 
      ${validityHours}, ${eventCount}, ${futureEventCount}, ${alpha.confidence}, ${alpha.net_impact}, 
      ${alpha.net_impact_uncapped_v2}, ${alpha.net_impact_damper05}, ${alpha.quality.capped_at_max}, 
      'driver_first', 'shadow_df_v1', ${escapeJson(alpha.contributions)})
  `);
}

// ─── ISOLATED: Log to l2_shadow_analyze_runs ONLY ────────────────────
async function logShadowRun(assetId: string, assetName: string, data: {
  success: boolean;
  error?: string;
  vreal?: number;
  alpha_gap?: number;
  alpha_gap_pct?: number;
  confidence?: number;
  events_provided: number;
  future_events_provided: number;
  drivers_count: number;
  llm_latency_ms?: number;
  capped_at_max?: boolean;
  event_coverage?: number;
  directional_agreement?: number;
  abort_analysis?: boolean;
  abort_reason?: string;
}): Promise<void> {
  const escapeSql = (str: string | undefined): string => str ? `'${str.replace(/'/g, "''")}'` : 'null';
  await runSql(`
    INSERT INTO central.l2_shadow_analyze_runs (asset_id, asset_name, prompt_version, success, error, 
      vreal, alpha_gap, alpha_gap_pct, confidence, events_provided, future_events_provided, 
      drivers_count, llm_latency_ms, capped_at_max, event_coverage, directional_agreement, 
      abort_analysis, abort_reason)
    VALUES ('${assetId}', ${escapeSql(assetName)}, '${PROMPT_VERSION}', ${data.success}, ${escapeSql(data.error)}, 
      ${data.vreal || 'null'}, ${data.alpha_gap || 'null'}, ${data.alpha_gap_pct || 'null'}, ${data.confidence || 'null'}, 
      ${data.events_provided}, ${data.future_events_provided}, ${data.drivers_count}, 
      ${data.llm_latency_ms || 'null'}, ${data.capped_at_max || 'false'}, 
      ${data.event_coverage || 'null'}, ${data.directional_agreement || 'null'}, 
      ${data.abort_analysis || false}, ${escapeSql(data.abort_reason)})
  `);
}

// ─── LLM Call (identical to production) ──────────────────────────────

async function callLLM(prompt: string): Promise<{ text: string; latency_ms: number }> {
  const start = Date.now();
  
  if (USE_GEMINI) {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
        }),
      }
    );
    if (!response.ok) throw new Error(`Gemini error: ${response.status}`);
    const data = await response.json();
    return { text: data.candidates?.[0]?.content?.parts?.[0]?.text || '', latency_ms: Date.now() - start };
  } else {
    const response = await fetch(`https://api.ohmyglm.com/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OLLAMA_API_KEY}` },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.2, num_predict: 4096 },
      }),
    });
    if (!response.ok) throw new Error(`GLM-5 error: ${response.status}`);
    const data = await response.json();
    return { text: data.choices?.[0]?.message?.content || '', latency_ms: Date.now() - start };
  }
}

function parseLLMOutput(text: string): L2LLMOutputSchema | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return L2LLMOutputSchema.parse(JSON.parse(jsonMatch[0]));
  } catch { return null; }
}

function validateCoverage(output: L2LLMOutputSchema, eventIds: Set<string>, futureIds: Set<string>): { ok: true } | { ok: false; reason: string } {
  if (output.abort_analysis) return { ok: true };
  
  const scoredEvents = new Set(output.event_scorings.map(s => s.event_id));
  const scoredFutures = new Set(output.future_event_scorings.map(s => s.future_event_id));
  
  for (const id of eventIds) {
    if (!scoredEvents.has(id)) return { ok: false, reason: `Event ${id} not scored` };
  }
  for (const id of futureIds) {
    if (!scoredFutures.has(id)) return { ok: false, reason: `Future event ${id} not scored` };
  }
  for (const id of scoredEvents) {
    if (!eventIds.has(id)) return { ok: false, reason: `Invented event_id: ${id}` };
  }
  for (const id of scoredFutures) {
    if (!futureIds.has(id)) return { ok: false, reason: `Invented future_event_id: ${id}` };
  }
  return { ok: true };
}

// ─── Process Asset (isolated — writes to alpha_shadow ONLY) ──────────

async function processAsset(assetId: string, assetName: string): Promise<{ success: boolean }> {
  console.log(`\n[SHADOW] [${assetName}] Analyzing (DF source)...`);

  const asset = await getAsset(assetId);
  if (!asset || !asset.current_price || asset.current_price <= 0) {
    console.log(`  Skipping: No valid current_price`);
    await logShadowRun(assetId, assetName, { success: false, error: 'No valid current_price', events_provided: 0, future_events_provided: 0, drivers_count: 0 });
    return { success: false };
  }

  const drivers = await getDrivers(assetId);
  const events = await getEvents(assetId);
  const futureEvents = await getFutureEvents(assetId);

  console.log(`  Drivers: ${drivers.length}, DF Events: ${events.length}, Futures: ${futureEvents.length}`);

  if (events.length === 0 && futureEvents.length === 0) {
    console.log(`  Skipping: No events`);
    await logShadowRun(assetId, assetName, { success: false, error: 'No events', events_provided: 0, future_events_provided: 0, drivers_count: drivers.length });
    return { success: false };
  }

  // Build COMPACT prompt (identical to production)
  const prompt = buildCompactL2Prompt(asset, drivers, events, futureEvents, { maxEvents: 5, maxFutureEvents: 3 });

  // Call LLM
  let llmResult: { text: string; latency_ms: number };
  try {
    llmResult = await callLLM(prompt);
  } catch (err) {
    console.log(`  ❌ LLM error: ${(err as Error).message}`);
    await logShadowRun(assetId, assetName, { success: false, error: (err as Error).message, events_provided: events.length, future_events_provided: futureEvents.length, drivers_count: drivers.length });
    return { success: false };
  }

  // Parse with recovery (identical to production)
  console.log(`  LLM response (${llmResult.latency_ms}ms, ${llmResult.text.length} chars)`);
  
  const parseResult = parseCompactL2(llmResult.text);
  if (!parseResult.success || !parseResult.data) {
    console.log(`  ❌ Parse failed (${parseResult.method}): ${parseResult.error}`);
    
    // Retry once
    const retryPrompt = buildCompactL2Prompt(asset, drivers, events, futureEvents, { maxEvents: 5, maxFutureEvents: 3, strictRetry: true });
    try {
      const retryResult = await callLLM(retryPrompt);
      const retryParse = parseCompactL2(retryResult.text);
      if (!retryParse.success || !retryParse.data) {
        console.log(`  ❌ Retry also failed: ${retryParse.error}`);
        await logShadowRun(assetId, assetName, { success: false, error: retryParse.error || 'Parse failed after retry', events_provided: events.length, future_events_provided: futureEvents.length, drivers_count: drivers.length, llm_latency_ms: llmResult.latency_ms });
        return { success: false };
      }
      // Use retry result
      const output = toFullFormat(retryParse.data!);
      return await computeAndStore(asset, assetId, assetName, output, events, futureEvents, drivers, llmResult);
    } catch (err) {
      console.log(`  ❌ Retry error: ${(err as Error).message}`);
      await logShadowRun(assetId, assetName, { success: false, error: (err as Error).message, events_provided: events.length, future_events_provided: futureEvents.length, drivers_count: drivers.length, llm_latency_ms: llmResult.latency_ms });
      return { success: false };
    }
  }

  const output = toFullFormat(parseResult.data!);
  console.log(`  Parse: ${parseResult.method} ✓`);
  return await computeAndStore(asset, assetId, assetName, output, events, futureEvents, drivers, llmResult);
}

async function computeAndStore(
  asset: Asset,
  assetId: string,
  assetName: string,
  output: FullL2Output,
  events: (Event & { driver_weighting: number })[],
  futureEvents: (FutureEvent & { driver_weighting: number })[],
  drivers: Driver[],
  llmResult: { text: string; latency_ms: number }
): Promise<{ success: boolean }> {
  // Handle abort
  if (output.abort_analysis) {
    console.log(`  ⚠️ Aborted: ${output.abort_reason}`);
    await logShadowRun(assetId, assetName, { success: true, events_provided: events.length, future_events_provided: futureEvents.length, drivers_count: drivers.length, llm_latency_ms: llmResult.latency_ms, abort_analysis: true, abort_reason: output.abort_reason || undefined });
    return { success: true };
  }

  // Validate coverage
  const eventIds = new Set(events.map(e => e.id));
  const futureIds = new Set(futureEvents.map(f => f.id));
  const coverage = validateCoverage(output, eventIds, futureIds);
  if (!coverage.ok) {
    console.log(`  ❌ Coverage: ${coverage.reason}`);
    // Still try to compute with partial coverage
  }

  // Compute alpha deterministically (IDENTICAL logic to production)
  let alpha: AlphaResult;
  try {
    alpha = computeAlpha(asset, events, futureEvents, output, DEFAULT_L2_CONFIG);
  } catch (err) {
    console.log(`  ❌ Compute error: ${(err as Error).message}`);
    await logShadowRun(assetId, assetName, { success: false, error: (err as Error).message, events_provided: events.length, future_events_provided: futureEvents.length, drivers_count: drivers.length, llm_latency_ms: llmResult.latency_ms });
    return { success: false };
  }

  console.log(`  vreal: $${alpha.vreal.toFixed(2)} (gap: ${alpha.alpha_gap_pct >= 0 ? '+' : ''}${alpha.alpha_gap_pct.toFixed(2)}%)`);
  console.log(`  confidence: ${(alpha.confidence * 100).toFixed(0)}% | capped: ${alpha.quality.capped_at_max}`);
  console.log(`  net_impact: ${alpha.net_impact.toFixed(4)} | uncapped: ${alpha.net_impact_uncapped_v2.toFixed(4)} | damper05: ${alpha.net_impact_damper05.toFixed(4)}`);

  // ─── ISOLATED: Write to alpha_shadow ONLY ─────────────────────────
  await insertAlphaShadow(assetId, assetName, alpha, asset.current_price, events.length, futureEvents.length);
  // ─── NO writes to central.alpha, central.assets, central.vreal_history ──

  await logShadowRun(assetId, assetName, {
    success: true,
    vreal: alpha.vreal,
    alpha_gap: alpha.alpha_gap,
    alpha_gap_pct: alpha.alpha_gap_pct,
    confidence: alpha.confidence,
    events_provided: events.length,
    future_events_provided: futureEvents.length,
    drivers_count: drivers.length,
    llm_latency_ms: llmResult.latency_ms,
    capped_at_max: alpha.quality.capped_at_max,
    event_coverage: alpha.quality.event_coverage,
    directional_agreement: alpha.quality.directional_agreement,
  });

  return { success: true };
}

// ─── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log('=== VECTX V3 - Layer 2 Analyze SHADOW (Driver-First) ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Model: ${USE_GEMINI ? 'gemini-2.5-flash' : OLLAMA_MODEL}`);
  console.log(`Prompt version: ${PROMPT_VERSION}`);
  console.log(`Assets: ${SHADOW_ASSETS.join(', ')} (hardcoded)`);
  console.log(`Source: driver_first_shadow_events (NOT central.events)`);
  console.log(`Target: central.alpha_shadow (NOT central.alpha)\n`);

  const assets = await getAssetsForShadow();
  console.log(`Found ${assets.length} assets ready for shadow analysis\n`);

  if (assets.length === 0) {
    console.log('No assets ready. Check driver_first_shadow_events for recent data.');
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  for (const { asset_id, asset_name } of assets) {
    const result = await processAsset(asset_id, asset_name);
    if (result.success) successCount++;
    else errorCount++;
  }

  console.log('\n=== Shadow Summary ===');
  console.log(`Success: ${successCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Finished at: ${new Date().toISOString()}`);
}

main().catch(console.error);