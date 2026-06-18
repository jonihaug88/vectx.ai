/**
 * VECTX V3 - Layer 2 Research Script v2
 * 
 * Split Prompts: Driver Weightings + Future Events
 * Quality Signals: Validation + Logging
 * Runs 2x per day at 08:20 and 20:20 Europe/Berlin
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildDriverWeightingPrompt, buildFutureEventsPrompt } from './l2_research_prompts.js';
import { GEMINI_INPUT_PRICE_PER_M, GEMINI_OUTPUT_PRICE_PER_M } from './gemini_flash_provider.js';
import {
  DriverWeightingOutputSchema,
  FutureEventsOutputSchema,
  validateDriverWeightings,
  validateFutureEvents,
  computeQualitySignals,
  type DriverWeightingOutput,
  type FutureEventsOutput,
  type L2QualitySignals,
} from './l2_research_validation.js';
import type { Asset, Driver, ClassifiedEvent } from './types.js';
import { z } from 'zod';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;
const GEMINI_API_KEY = config.gemini_api_key;

const BATCH_ASSETS = process.env.ASSETS?.split(',') || null;
const PROMPT_VERSION = 'v2';

// ─── Database ──────────────────────────────────────────────────────

async function runSql<T>(query: string): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify({ sql: query }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SQL error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.data || [];
}

async function getAssetsForWeighting(): Promise<{ asset_id: string; asset_name: string }[]> {
  // ALL assets that have events with driver_name (from L1 Analyze)
  // Weightings should ALWAYS be updated — they must not be blocked by future_events
  let query = `
    SELECT DISTINCT a.id as asset_id, a.name as asset_name
    FROM central.assets a
    WHERE EXISTS (
      SELECT 1 FROM central.events e 
      WHERE e.asset_id = a.id 
      AND e.driver_name IS NOT NULL
      AND e.created_at >= NOW() - INTERVAL '7 days'
    )
    ORDER BY a.name
  `;

  let results = await runSql<{ asset_id: string; asset_name: string }>(query);

  if (BATCH_ASSETS) {
    // Match by ticker (from separate query) or by name (partial, case insensitive)
    const tickers = await runSql<{ id: string }>(`
      SELECT id::text FROM central.assets 
      WHERE ticker IN (${BATCH_ASSETS.map(t => `'${t}'`).join(',')})
    `);
    const tickerIds = new Set(tickers.map(t => t.id));
    results = results.filter(r => 
      tickerIds.has(r.asset_id) ||
      BATCH_ASSETS.some(b => 
        r.asset_name.toLowerCase().includes(b.toLowerCase())
      )
    );
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
  }

  return results;
}

async function needsFutureEvents(assetId: string): Promise<boolean> {
  // Only generate future events if none exist in the last 48 hours
  const result = await runSql<{ cnt: string }>(`
    SELECT COUNT(*)::text as cnt
    FROM central.future_events
    WHERE asset_id = '${assetId}'
    AND created_at >= NOW() - INTERVAL '48 hours'
  `);
  return Number(result[0]?.cnt || 0) === 0;
}

async function getAsset(assetId: string): Promise<Asset | null> {
  const query = `SELECT id::text, ticker, name, asset_class, current_price FROM central.assets WHERE id = '${assetId}'`;
  const results = await runSql<Asset>(query);
  return results[0] || null;
}

async function getDrivers(assetId: string): Promise<Driver[]> {
  const query = `
    SELECT id::text, asset_id::text, driver_name, class, description, supply_or_demand,
           quantitative_or_qualitative, impact_score, act_weighting
    FROM central.drivers
    WHERE asset_id = '${assetId}' AND active = TRUE
    ORDER BY driver_name
  `;
  return runSql<Driver>(query);
}

async function getFilteredEvents(assetId: string): Promise<ClassifiedEvent[]> {
  // Simple query: last 7 days, impact >= 4, ordered by impact
  const query = `
    SELECT 
      e.id::text, e.asset_id::text, e.event_type, e.headline, e.summary,
      e.driver_name, e.impact_score::float, e.sentiment_score::float,
      e.supply_or_demand, e.quantitative_or_qualitative,
      e.timeline_score::int, e.weighting::float, e.created_at
    FROM central.events e
    WHERE e.asset_id = '${assetId}'
      AND e.driver_name IS NOT NULL
      AND e.created_at > NOW() - INTERVAL '7 days'
      AND e.impact_score >= 4
    ORDER BY e.impact_score DESC, e.created_at DESC
    LIMIT 20
  `;
  return runSql<ClassifiedEvent>(query);
}

async function updateDriverWeightings(
  assetId: string,
  weightings: Array<{ driver_name: string; weighting: number; confidence: number }>,
  runId: string
): Promise<void> {
  // Step 1: Reset ALL driver weightings for this asset to NULL before setting new ones
  // This prevents accumulation of old weightings from previous runs
  await runSql(`
    UPDATE central.drivers
    SET act_weighting = NULL, last_analysis = NULL
    WHERE asset_id = '${assetId}'
  `);

  // Step 2: Write LLM-returned weightings
  for (const w of weightings) {
    const currentWeight = 0; // Always 0 after reset
    const delta = w.weighting - currentWeight;

    await runSql(`
      UPDATE central.drivers
      SET act_weighting = ${w.weighting}, last_analysis = NOW()
      WHERE asset_id = '${assetId}' AND driver_name = '${w.driver_name.replace(/'/g, "''")}'
    `);

    // Log history
    await runSql(`
      INSERT INTO central.driver_weighting_history (asset_id, driver_id, driver_name, weighting, weighting_delta, confidence, l2_run_id)
      SELECT '${assetId}', id, '${w.driver_name.replace(/'/g, "''")}', ${w.weighting}, ${delta}, ${w.confidence}, '${runId}'
      FROM central.drivers WHERE asset_id = '${assetId}' AND driver_name = '${w.driver_name.replace(/'/g, "''")}'
    `);
  }

  // Step 3: Floor unmentioned drivers with recent events (events_30d > 0) to MIN_WEIGHT
  // Dead drivers (0 events in 30 days) stay at NULL/0 — they are noise, not signal
  const MIN_WEIGHT = 0.01;
  const floored = await runSql<{ cnt: string }>(`
    UPDATE central.drivers d
    SET act_weighting = ${MIN_WEIGHT}, last_analysis = NOW()
    WHERE d.asset_id = '${assetId}'
      AND d.active = TRUE
      AND d.act_weighting IS NULL
      AND EXISTS (
        SELECT 1 FROM central.drivers_events de
        WHERE de.driver_id = d.id
          AND de.created_at >= NOW() - INTERVAL '30 days'
      )
    RETURNING (SELECT COUNT(*)::text) as cnt
  `);
  const flooredCount = floored.length;
  if (flooredCount > 0) {
    console.log(`  Floored ${flooredCount} alive-unmentioned drivers to MIN_WEIGHT=${MIN_WEIGHT}`);
  }

  // Step 4: Re-normalize ALL non-null drivers to sum exactly 1.0
  const totalResult = await runSql<{ total: string }>(`
    SELECT SUM(CAST(act_weighting AS FLOAT))::text as total
    FROM central.drivers
    WHERE asset_id = '${assetId}' AND act_weighting IS NOT NULL AND active = TRUE
  `);
  const totalWeight = parseFloat(totalResult[0]?.total || '0');

  if (totalWeight > 0 && Math.abs(totalWeight - 1.0) > 0.001) {
    const scale = 1.0 / totalWeight;
    // Use precise 4-decimal rounding to avoid drift, then adjust largest for exact sum
    await runSql(`
      UPDATE central.drivers
      SET act_weighting = ROUND(CAST(act_weighting AS FLOAT) * ${scale} * 10000) / 10000
      WHERE asset_id = '${assetId}' AND act_weighting IS NOT NULL AND active = TRUE
    `);

    // Fix rounding: adjust the largest-weighted driver to make sum exactly 1.0
    const recountResult = await runSql<{ total: string }>(`
      SELECT SUM(CAST(act_weighting AS FLOAT))::text as total
      FROM central.drivers
      WHERE asset_id = '${assetId}' AND act_weighting IS NOT NULL AND active = TRUE
    `);
    const recountWeight = parseFloat(recountResult[0]?.total || '0');
    const diff = Math.round((1.0 - recountWeight) * 10000) / 10000;
    if (Math.abs(diff) > 0 && Math.abs(diff) < 0.01) {
      await runSql(`
        UPDATE central.drivers
        SET act_weighting = CAST(act_weighting AS FLOAT) + ${diff}
        WHERE asset_id = '${assetId}'
          AND id = (
            SELECT id FROM central.drivers
            WHERE asset_id = '${assetId}' AND act_weighting IS NOT NULL AND active = TRUE
            ORDER BY CAST(act_weighting AS FLOAT) DESC LIMIT 1
          )
      `);
    }

    console.log(`  Re-normalized drivers: total was ${totalWeight.toFixed(4)}, scaled by ${scale.toFixed(4)} (${weightings.length} LLM + ${flooredCount} alive-unmentioned)`);
  }
}

async function insertFutureEvents(
  assetId: string,
  assetName: string,
  events: Array<{
    event_type: string;
    headline: string;
    summary: string;
    driver_name: string;
    impact_score: number;
    sentiment_score: number;
    supply_or_demand: string;
    quantitative_or_qualitative: string;
    probability: number;
    timeline_score: number;
    expected_date_range?: string;
    supporting_event_ids?: string[];
    invalidation_signal?: string;
  }>
): Promise<void> {
  for (const event of events) {
    const escapeSql = (str: string | undefined): string => {
      if (!str) return 'null';
      return `'${str.replace(/'/g, "''")}'`;
    };

    // Normalize numeric values to fit database constraints
    // sentiment_score: NUMERIC(3,2) -> max 9.99, but should be -1 to 1
    // If LLM returns percentage (e.g., 75), convert to 0-1 scale
    let sentimentScore = event.sentiment_score;
    if (Math.abs(sentimentScore) > 1) {
      sentimentScore = sentimentScore / 100; // Convert percentage to decimal
    }
    sentimentScore = Math.max(-1, Math.min(1, sentimentScore)); // Clamp to valid range

    // probability: should be 0-1, but LLM might return 0-100
    let probability = event.probability;
    if (probability > 1) {
      probability = probability / 100;
    }
    probability = Math.max(0, Math.min(1, probability));

    // impact_score and timeline_score: should be integers 1-10
    // DB column impact_score is DECIMAL(3,2) -> max 9.99, so clamp to 9.99
    let impactScore = Math.round(event.impact_score);
    if (impactScore >= 10) impactScore = 9.99;
    const timelineScore = Math.round(event.timeline_score);

    await runSql(`
      INSERT INTO central.future_events (
        asset_id, asset_name, event_type, headline, summary, driver_name,
        impact_score, sentiment_score, supply_or_demand,
        quantitative_or_qualitative, probability, timeline_score,
        expected_date_range, supporting_event_ids, invalidation_signal
      ) VALUES (
        '${assetId}',
        '${assetName.replace(/'/g, "''")}',
        ${escapeSql(event.event_type)},
        ${escapeSql(event.headline)},
        ${escapeSql(event.summary)},
        ${escapeSql(event.driver_name)},
        ${impactScore},
        ${sentimentScore.toFixed(2)},
        ${escapeSql(event.supply_or_demand)},
        ${escapeSql(event.quantitative_or_qualitative)},
        ${probability.toFixed(2)},
        ${timelineScore},
        ${escapeSql(event.expected_date_range)},
        '${JSON.stringify(event.supporting_event_ids || [])}',
        ${escapeSql(event.invalidation_signal)}
      )
    `);
  }
}

async function logL2Run(
  assetId: string,
  assetName: string,
  eventsProvided: number,
  driversKnown: number,
  signals: L2QualitySignals,
  latencyMs: number,
  success: boolean,
  errorMessage?: string
): Promise<string> {
  const runId = crypto.randomUUID();
  // Get token data from last Gemini call
  const lastTokens = (globalThis as any).__lastGeminiTokens as { tokens_input?: number; tokens_output?: number; tokens_thinking?: number; estimated_cost_usd?: number } | undefined;
  const tokensInput = lastTokens?.tokens_input ?? 'NULL';
  const tokensOutput = lastTokens?.tokens_output ?? 'NULL';
  const tokensThinking = lastTokens?.tokens_thinking ?? 'NULL';
  const estimatedCost = lastTokens?.estimated_cost_usd ?? 'NULL';
  
  await runSql(`
    INSERT INTO central.l2_research_runs (
      id, asset_id, asset_name, prompt_version,
      events_provided, events_high_impact, drivers_known,
      weighting_entropy, weighting_max, weighting_min_nonzero,
      weighting_sum_error, evidence_coverage, emerging_drivers_count,
      future_events_count, probability_mean, probability_variance,
      driver_diversity, avg_timeline_score, avg_impact_score,
      unknown_driver_count, invalid_event_id_count,
      llm_model, llm_latency_ms, success, error_message,
      tokens_input, tokens_output, tokens_thinking, estimated_cost_usd
    ) VALUES (
      '${runId}', '${assetId}', '${assetName}', '${PROMPT_VERSION}',
      ${eventsProvided}, ${eventsProvided}, ${driversKnown},
      ${signals.weighting_entropy}, ${signals.weighting_max}, ${signals.weighting_min_nonzero},
      ${signals.weighting_sum_error}, ${signals.evidence_coverage}, ${signals.emerging_drivers_count},
      ${signals.future_events_count}, ${signals.probability_mean}, ${signals.probability_variance},
      ${signals.driver_diversity}, ${signals.avg_timeline_score}, ${signals.avg_impact_score},
      ${signals.unknown_driver_count}, ${signals.invalid_event_id_count},
      'gemini-3-flash-preview', ${latencyMs}, ${success},
      ${errorMessage ? `'${errorMessage.replace(/'/g, "''")}'` : 'null'},
      ${tokensInput}, ${tokensOutput}, ${tokensThinking}, ${estimatedCost}
    )
  `);
  return runId;
}

// ─── Gemini API ─────────────────────────────────────────────────────

async function callGemini(prompt: string, debugLabel?: string): Promise<string> {
  const LLM_TIMEOUT_MS = 120_000; // 2 minutes hard limit per call

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { 
            temperature: 0.3, 
            maxOutputTokens: 32768,
            responseMimeType: 'application/json'
          },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gemini error: ${response.status} - ${text}`);
    }

    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const finishReason = data.candidates?.[0]?.finishReason;
    
    // ─── Token counting & cost estimation ────────────────────────────
    const tokens_input = data.usageMetadata?.promptTokenCount ?? 0;
    const tokens_output = data.usageMetadata?.candidatesTokenCount ?? 0;
    const tokens_thinking = data.usageMetadata?.thoughtsTokenCount ?? 0;
    const estimated_cost_usd = Math.round(((tokens_input * GEMINI_INPUT_PRICE_PER_M / 1_000_000) + ((tokens_output + tokens_thinking) * GEMINI_OUTPUT_PRICE_PER_M / 1_000_000)) * 1_000_000) / 1_000_000;
    
    // Store token data on the result for logging
    (globalThis as any).__lastGeminiTokens = { tokens_input, tokens_output, tokens_thinking, estimated_cost_usd };
    
    // Debug: log response details
    if (debugLabel) {
      console.log(`  [DEBUG] ${debugLabel}: response length: ${rawText.length}, tokens: ${tokens_input}in/${tokens_output}out/${tokens_thinking}think, cost: $${estimated_cost_usd.toFixed(6)}`);
      if (finishReason && finishReason !== 'STOP') {
        console.log(`  [DEBUG] ${debugLabel}: finishReason: ${finishReason}`);
      }
      if (rawText.length < 50) {
        console.log(`  [DEBUG] ${debugLabel}: short response:`, rawText);
      }
    }
    
    return rawText;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Gemini call timed out after ${LLM_TIMEOUT_MS / 1000}s (${debugLabel || 'unknown'})`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJson<T>(response: string, debugLabel?: string): T | null {
  try {
    if (!response || response.length < 2) {
      if (debugLabel) console.log(`  [DEBUG] ${debugLabel}: empty response`);
      return null;
    }
    
    let cleaned = response.trim();
    
    // Strip markdown code blocks (various formats)
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // Fix Gemini JSON quirks: "+0.11" -> "0.11" (JSON doesn't allow + prefix)
    cleaned = cleaned.replace(/":\s*\+(\d+\.?\d*)/g, '": $1');
    cleaned = cleaned.replace(/:\s*\+(\d+\.?\d*)/g, ': $1');

    // Try direct parse first
    try {
      return JSON.parse(cleaned) as T;
    } catch (directError) {
      // Log why direct parse failed
      if (debugLabel) {
        console.log(`  [DEBUG] ${debugLabel}: direct parse failed, attempting extraction`);
      }
    }

    // Extract JSON object using regex - find matching braces
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as T;
      } catch (matchError) {
        if (debugLabel) {
          console.log(`  [DEBUG] ${debugLabel}: JSON extraction parse failed`);
          console.log(`  [DEBUG] ${debugLabel}: extracted length: ${jsonMatch[0].length}`);
          // Check for common JSON issues
          const extracted = jsonMatch[0];
          const openBraces = (extracted.match(/\{/g) || []).length;
          const closeBraces = (extracted.match(/\}/g) || []).length;
          console.log(`  [DEBUG] ${debugLabel}: braces: ${openBraces} open, ${closeBraces} close`);
          // Log last 200 chars to see where it ends
          console.log(`  [DEBUG] ${debugLabel}: JSON ends with: ...${extracted.slice(-200)}`);
          // Log parse error
          console.log(`  [DEBUG] ${debugLabel}: parse error: ${(matchError as Error).message}`);
        }
        return null;
      }
    }
    
    if (debugLabel) {
      console.log(`  [DEBUG] ${debugLabel}: no JSON object found in:`, cleaned.substring(0, 200));
    }
    return null;
  } catch (e) {
    if (debugLabel) console.log(`  [DEBUG] ${debugLabel}: parseJson error:`, (e as Error).message);
    return null;
  }
}

function normalizeWeightings(output: DriverWeightingOutput): DriverWeightingOutput {
  const sum = output.driver_weightings.reduce((a, e) => a + e.weighting, 0);
  if (sum > 0 && Math.abs(sum - 1.0) > 0.001) {
    console.log(`  Normalizing weightings: sum was ${sum.toFixed(4)}, scaling to 1.0`);
    const scale = 1.0 / sum;
    for (const dw of output.driver_weightings) {
      dw.weighting = Math.round(dw.weighting * scale * 1000) / 1000;
    }
    // Fix rounding: adjust the largest weighting to make sum exactly 1.0
    const newSum = output.driver_weightings.reduce((a, e) => a + e.weighting, 0);
    const diff = Math.round((1.0 - newSum) * 1000) / 1000;
    if (diff !== 0) {
      const largest = output.driver_weightings.reduce((a, b) => a.weighting > b.weighting ? a : b);
      largest.weighting = Math.round((largest.weighting + diff) * 1000) / 1000;
    }
  }
  return output;
}

// ─── Main Process ────────────────────────────────────────────────────

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ success: boolean; error?: string }> {
  const startTime = Date.now();
  console.log(`\n[${assetName}] Starting L2 Research v2...`);

  // ── DEDUP: Skip if this asset was successfully processed in the last 2 hours ──
  const recentSuccess = await runSql<{ cnt: string }>(`
    SELECT COUNT(*)::text as cnt
    FROM central.l2_research_runs
    WHERE asset_id = '${assetId}'
      AND success = true
      AND created_at > NOW() - INTERVAL '2 hours'
  `);
  if (Number(recentSuccess[0]?.cnt || 0) > 0) {
    console.log(`  [${assetName}] Already successfully processed in last 2h. Skipping.`);
    return { success: true };
  }

  const asset = await getAsset(assetId);
  if (!asset) {
    return { success: false, error: 'Asset not found' };
  }

  const drivers = await getDrivers(assetId);
  console.log(`  Drivers: ${drivers.length}`);

  const events = await getFilteredEvents(assetId);
  console.log(`  Filtered events: ${events.length}`);

  if (events.length < 3) {
    return { success: false, error: 'Not enough events (need ≥3)' };
  }

  const knownDriverNames = new Set(drivers.map(d => d.driver_name));
  const validEventIds = new Set(events.map(e => e.id));

  // ─── Check if future events are needed (48h filter) ─────────────
  const shouldGenerateFutureEvents = await needsFutureEvents(assetId);
  if (!shouldGenerateFutureEvents) {
    console.log(`  Skipping future events (existing within 48h) — will still update weightings`);
  }

  // ─── Call 1: Driver Weightings (ALWAYS run, with retry) ──────────────

  const weightingsPrompt = buildDriverWeightingPrompt(asset, drivers, events);
  let weightingsOutput: DriverWeightingOutput | null = null;
  let weightingsError: string | null = null;

  const MAX_RETRIES = 1;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`  Retrying weightings (attempt ${attempt + 1}/${MAX_RETRIES + 1})...`);
      await new Promise(r => setTimeout(r, 3000));
    }
    try {
      const weightingsResponse = await callGemini(weightingsPrompt, 'weightings');
      weightingsOutput = parseJson<DriverWeightingOutput>(weightingsResponse, 'weightings');

      if (!weightingsOutput) {
        weightingsError = 'Failed to parse weightings JSON';
        console.log(`  [DEBUG] Raw weightings response length: ${weightingsResponse?.length || 0}`);
        continue; // retry
      } else {
        // Validate with Zod
        const parsed = DriverWeightingOutputSchema.safeParse(weightingsOutput);
        if (!parsed.success) {
          weightingsError = `Validation failed: ${parsed.error.message}`;
          weightingsOutput = null;
          continue; // retry
        } else {
          // Normalize weightings to sum exactly 1.0
          weightingsOutput = normalizeWeightings(weightingsOutput);
          // Cross-validate
          const validation = validateDriverWeightings(weightingsOutput, {
            known_driver_names: knownDriverNames,
            valid_event_ids: validEventIds,
          });
          if (!validation.ok) {
            weightingsError = validation.reason;
            weightingsOutput = null;
            continue; // retry
          } else if (validation.warnings && validation.warnings.length > 0) {
            console.log(`  ⚠️ Weightings warnings: ${validation.warnings.join('; ')}`);
          }
          break; // success — exit retry loop
        }
      }
    } catch (err) {
      weightingsError = (err as Error).message;
      continue; // retry
    }
  }

  // ─── Call 2: Future Events (only if needed) ──────────────────────

  let futureOutput: FutureEventsOutput | null = null;
  let futureError: string | null = null;

  if (shouldGenerateFutureEvents) {
    const futurePrompt = buildFutureEventsPrompt(asset, drivers, events);
    try {
      const futureResponse = await callGemini(futurePrompt, 'future_events');
      futureOutput = parseJson<FutureEventsOutput>(futureResponse, 'future_events');

      if (!futureOutput) {
        futureError = 'Failed to parse future events JSON';
        console.log(`  [DEBUG] Raw future response length: ${futureResponse?.length || 0}`);
      } else {
        const parsed = FutureEventsOutputSchema.safeParse(futureOutput);
        if (!parsed.success) {
          futureError = `Validation failed: ${parsed.error.message}`;
          futureOutput = null;
        } else {
          const validation = validateFutureEvents(futureOutput, {
            known_driver_names: knownDriverNames,
            valid_event_ids: validEventIds,
          });
          if (!validation.ok) {
            futureError = validation.reason;
            futureOutput = null;
          }
        }
      }
    } catch (err) {
      futureError = (err as Error).message;
    }
  }

  // ─── Compute Quality Signals ──────────────────────────────────────

  const defaultSignals: L2QualitySignals = {
    weighting_entropy: 0,
    weighting_max: 0,
    weighting_min_nonzero: 0,
    evidence_coverage: 0,
    emerging_drivers_count: 0,
    future_events_count: 0,
    probability_mean: 0,
    probability_variance: 0,
    driver_diversity: 0,
    avg_timeline_score: 0,
    avg_impact_score: 0,
    unknown_driver_count: 0,
    invalid_event_id_count: 0,
    weighting_sum_error: 1,
  };

  const signals = (weightingsOutput && futureOutput)
    ? computeQualitySignals(weightingsOutput, futureOutput, events.map(e => e.id), Array.from(knownDriverNames))
    : defaultSignals;

  // ─── Persist Results ──────────────────────────────────────────────

  const latencyMs = Date.now() - startTime;
  const weightingsSuccess = weightingsOutput !== null;
  const futureSuccess = !shouldGenerateFutureEvents || futureOutput !== null;
  const success = weightingsSuccess && futureSuccess;
  const errorMessage = weightingsError || (shouldGenerateFutureEvents ? futureError : null);

  const runId = await logL2Run(
    assetId, assetName,
    events.length, drivers.length,
    signals, latencyMs,
    success, errorMessage || undefined
  );

  if (weightingsOutput) {
    await updateDriverWeightings(
      assetId,
      weightingsOutput.driver_weightings.map(w => ({
        driver_name: w.driver_name,
        weighting: w.weighting,
        confidence: w.confidence,
      })),
      runId
    );
    console.log(`  Updated ${weightingsOutput.driver_weightings.length} driver weightings`);
  }

  if (futureOutput) {
    await insertFutureEvents(assetId, assetName, futureOutput.future_events);
    console.log(`  Inserted ${futureOutput.future_events.length} future events`);
  }

  if (!success) {
    console.log(`  ❌ Error: ${errorMessage}`);
  }

  return { success, error: errorMessage || undefined };
}

// ─── Job Lock ──────────────────────────────────────────────────────

async function acquireJobLock(jobName: string): Promise<boolean> {
  // Try to acquire lock: insert or update if stale (>25 min old)
  // Uses INSERT ... ON CONFLICT with condition to only take over stale locks
  const result = await runSql<{ locked: string }>(`
    INSERT INTO central.jobs (id, name, last_run, active)
    VALUES (gen_random_uuid(), '${jobName}', NOW(), true)
    ON CONFLICT (name) DO UPDATE
    SET last_run = NOW(), active = true
    WHERE central.jobs.active = false OR central.jobs.last_run < NOW() - INTERVAL '25 minutes'
    RETURNING 'true'::text as locked
  `);
  
  if (result.length === 0) {
    // Lock is held by another active process (<25 min old)
    const lockInfo = await runSql<{ last_run: string }>(`
      SELECT last_run::text FROM central.jobs WHERE name = '${jobName}'
    `);
    console.log(`Job lock held since ${lockInfo[0]?.last_run}. Another run is active. Skipping.`);
    return false;
  }
  console.log(`Job lock acquired for '${jobName}'.`);
  return true;
}

async function releaseJobLock(jobName: string): Promise<void> {
  await runSql(`
    UPDATE central.jobs SET active = false WHERE name = '${jobName}'
  `);
  console.log(`Job lock released for '${jobName}'.`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== VECTX V3 - Layer 2 Research v2 ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Prompt version: ${PROMPT_VERSION}`);

  // ── JOB LOCK: Prevent overlapping runs ──
  const locked = await acquireJobLock('l2_research_v2');
  if (!locked) {
    console.log('Exiting — another run is active.');
    return;
  }

  try {
    const assets = await getAssetsForWeighting();
    console.log(`Found ${assets.length} assets ready for weightings\n`);

    if (assets.length === 0) {
      console.log('No assets ready. Run Layer 2 Collect first.');
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    // Process assets with concurrency 4 to avoid 900s timeout
    // Sequential: 20 assets × ~65s = ~22min → exceeds timeout
    // Concurrency 4: 20 assets / 4 = ~5 batches × 65s = ~5min
    const CONCURRENCY = 4;
    
    for (let i = 0; i < assets.length; i += CONCURRENCY) {
      const batch = assets.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(({ asset_id, asset_name }) => processAsset(asset_id, asset_name))
      );
      for (const result of results) {
        if (result.success) successCount++;
        else errorCount++;
      }
    }

    console.log('\n=== Summary ===');
    console.log(`Success: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Finished at: ${new Date().toISOString()}`);
  } finally {
    await releaseJobLock('l2_research_v2');
  }
}

main().catch(console.error);