/**
 * VECTX V3 — Driver-First Research (Phase 1, Shadow Mode)
 * 
 * Isolated parallel operation for 5 test assets (ZS, EURUSD, GC, WTI, HG).
 * Researches events BY DRIVER (not by RSS feed), using Gemini google_search grounding.
 * Writes ONLY to central.driver_first_shadow_events — does NOT touch production tables.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { jsonrepair } from 'jsonrepair';
import { GEMINI_INPUT_PRICE_PER_M, GEMINI_OUTPUT_PRICE_PER_M } from './gemini_flash_provider.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;
const GEMINI_API_KEY = config.gemini_api_key;

// ─── Config ────────────────────────────────────────────────────────

const TEST_ASSETS = ['ZS', 'EURUSD', 'GC', 'WTI', 'HG'];
const CALL_TIMEOUT_MS = 120_000; // per-call timeout (2 min)
const JOB_LOCK_NAME = 'driver_first_research';
const JOB_LOCK_STALE_MIN = 25;

const WEIGHTING_CLASSES = {
  A_CORE: { min: 0.20, label: 'A-Core', depth: 'deep' },
  B_SEKUNDAER: { min: 0.08, max: 0.20, label: 'B-Sekundär', depth: 'brief' },
  C_HINTERGRUND: { min: 0.03, max: 0.08, label: 'C-Hintergrund', depth: 'passive' },
  CUTOFF: { max: 0.03, label: 'Cutoff', depth: 'ignore' },
} as const;

// ─── Types ─────────────────────────────────────────────────────────

interface Driver {
  id: string;
  driver_name: string;
  act_weighting: number;
  supply_or_demand: string | null;
  description: string | null;
}

interface Asset {
  id: string;
  ticker: string;
  name: string;
  asset_class: string;
  current_price: number | null;
}

interface ShadowEvent {
  asset_id: string;
  driver_name: string;
  headline: string;
  summary: string;
  impact_score: number;
  sentiment_score: number;
  quantitative_or_qualitative: string;
  supply_or_demand: string;
  timeline_score: number;
  grounding_url: string | null;
  grounding_missing: boolean;
  weighting_klasse: string;
  search_query: string;
}

interface GeminiGroundingResult {
  text: string;
  tokens_input: number;
  tokens_output: number;
  tokens_thinking: number;
  estimated_cost_usd: number;
  duration_ms: number;
  grounding_urls: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────

async function runSql<T>(query: string): Promise<T[]> {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ sql: query }),
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(data.error || 'SQL error');
  return data.data;
}

function classifyDriver(weight: number): { label: string; depth: string } {
  if (weight >= 0.20) return { label: WEIGHTING_CLASSES.A_CORE.label, depth: WEIGHTING_CLASSES.A_CORE.depth };
  if (weight >= 0.08) return { label: WEIGHTING_CLASSES.B_SEKUNDAER.label, depth: WEIGHTING_CLASSES.B_SEKUNDAER.depth };
  if (weight >= 0.03) return { label: WEIGHTING_CLASSES.C_HINTERGRUND.label, depth: WEIGHTING_CLASSES.C_HINTERGRUND.depth };
  return { label: WEIGHTING_CLASSES.CUTOFF.label, depth: WEIGHTING_CLASSES.CUTOFF.depth };
}

// ─── Gemini with Google Search Grounding ───────────────────────────

async function callGeminiWithSearch(prompt: string): Promise<GeminiGroundingResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  clearTimeout(timeout);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokens_input = data.usageMetadata?.promptTokenCount ?? 0;
  const tokens_output = data.usageMetadata?.candidatesTokenCount ?? 0;
  const tokens_thinking = data.usageMetadata?.thoughtsTokenCount ?? 0;
  const estimated_cost_usd = Math.round(
    ((tokens_input * GEMINI_INPUT_PRICE_PER_M / 1_000_000) + 
     ((tokens_output + tokens_thinking) * GEMINI_OUTPUT_PRICE_PER_M / 1_000_000)) * 1_000_000
  ) / 1_000_000;
  const duration_ms = Date.now() - start;

  // Extract grounding URLs
  const groundingChunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const grounding_urls: string[] = groundingChunks
    .map((chunk: any) => chunk?.web?.uri)
    .filter((url: string | null): url is string => url != null);

  return { text, tokens_input, tokens_output, tokens_thinking, estimated_cost_usd, duration_ms, grounding_urls };
}

// ─── Prompt Builders ────────────────────────────────────────────────

function buildDeepResearchPrompt(asset: Asset, driver: Driver): string {
  return `You are a commodity/forex market analyst specializing in ${asset.asset_class} markets.
Your task: Find CURRENT, MARKET-RELEVANT events from the last 7 days related to this specific driver for ${asset.name} (${asset.ticker}).

Driver: "${driver.driver_name}"
Driver context: ${driver.description || 'No additional context'}
Supply/demand side: ${driver.supply_or_demand || 'mixed'}
Current price: ${asset.current_price || 'N/A'}

Search for recent developments, data releases, policy changes, or market events that directly affect this driver.
Focus on events that would move the ${asset.ticker} price through the "${driver.driver_name}" channel.

Return a JSON array of events (2-5 events for a core driver). Each event:
{
  "headline": "Concise headline (max 100 chars)",
  "summary": "2-3 sentence summary with specific numbers/dates",
  "impact_score": 1-10 (1=minor noise, 10=major structural shift),
  "sentiment_score": -1.0 to 1.0 (negative=bearish for asset, positive=bullish),
  "quantitative_or_qualitative": "quantitative" or "qualitative",
  "supply_or_demand": "supply" or "demand" or "both",
  "timeline_score": 1-5 (1=already priced in, 5=6+ months ahead)
}

Rules:
- Only include events from the last 7 days
- Skip generic market commentary — only concrete, actionable developments
- If no meaningful events found, return empty array []
- Do NOT fabricate events or numbers`;
}

function buildBriefResearchPrompt(asset: Asset, driver: Driver): string {
  return `You are a market analyst. Find the single most important recent development (last 7 days) for this driver of ${asset.name} (${asset.ticker}).

Driver: "${driver.driver_name}"
Context: ${driver.description || ''}

Return a JSON array with at most 1-2 events:
{
  "headline": "Concise headline",
  "summary": "1-2 sentence summary",
  "impact_score": 1-10,
  "sentiment_score": -1.0 to 1.0,
  "quantitative_or_qualitative": "quantitative" or "qualitative",
  "supply_or_demand": "supply" or "demand" or "both",
  "timeline_score": 1-5
}

If no significant development, return []`;
}

// ─── Event Deduplication ───────────────────────────────────────────

function dedupEvents(events: ShadowEvent[], existing: Set<string>): ShadowEvent[] {
  const unique: ShadowEvent[] = [];
  for (const event of events) {
    // Normalize headline for comparison: lowercase, remove punctuation, first 50 chars
    const normalized = event.headline
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .slice(0, 50);
    
    if (!existing.has(normalized)) {
      existing.add(normalized);
      unique.push(event);
    }
  }
  return unique;
}

// ─── Main Logic ────────────────────────────────────────────────────

async function loadAsset(ticker: string): Promise<Asset | null> {
  const rows = await runSql<Asset[]>(`
    SELECT id, ticker, name, asset_class, current_price 
    FROM central.assets 
    WHERE ticker = '${ticker}'
  `);
  return rows[0] || null;
}

async function loadDrivers(assetId: string): Promise<Driver[]> {
  return runSql<Driver[]>(`
    SELECT id, driver_name, act_weighting, supply_or_demand, description
    FROM central.drivers
    WHERE asset_id = '${assetId}' AND active = TRUE
    ORDER BY act_weighting DESC
  `);
}

async function insertShadowEvents(events: ShadowEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  
  const values = events.map(e => `(
    '${e.asset_id}',
    '${e.driver_name.replace(/'/g, "''")}',
    '${e.headline.replace(/'/g, "''")}',
    '${e.summary.replace(/'/g, "''")}',
    ${e.impact_score},
    ${e.sentiment_score},
    '${e.quantitative_or_qualitative}',
    '${e.supply_or_demand}',
    ${e.timeline_score},
    'driver_first_shadow',
    ${e.grounding_url ? `'${e.grounding_url.replace(/'/g, "''")}'` : 'NULL'},
    ${e.grounding_missing ? 'true' : 'false'},
    '${e.weighting_klasse}',
    '${e.search_query.replace(/'/g, "''")}',
    NOW()
  )`).join(',\n    ');

  await runSql(`
    INSERT INTO central.driver_first_shadow_events
      (asset_id, driver_name, headline, summary, impact_score, sentiment_score,
       quantitative_or_qualitative, supply_or_demand, timeline_score,
       source_method, grounding_url, grounding_missing, weighting_klasse, search_query, created_at)
    VALUES
      ${values}
  `);
  return events.length;
}

// ─── Process Single Asset ──────────────────────────────────────────

interface AssetResult {
  ticker: string;
  driver_count: number;
  a_core: number;
  b_sek: number;
  events_found: number;
  events_inserted: number;
  duplicates_removed: number;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens_thinking: number;
  total_cost_usd: number;
  total_duration_ms: number;
}

async function processAsset(asset: Asset): Promise<AssetResult> {
  console.log(`\n[${asset.ticker}] ${asset.name} (${asset.asset_class})`);
  
  const drivers = await loadDrivers(asset.id);
  console.log(`  Drivers: ${drivers.length}`);
  
  // Classify drivers
  const classified = drivers.map(d => ({
    ...d,
    ...classifyDriver(Number(d.act_weighting)),
  }));
  
  const aCore = classified.filter(d => d.depth === 'deep');
  const bSek = classified.filter(d => d.depth === 'brief');
  const cHinter = classified.filter(d => d.depth === 'passive');
  
  console.log(`  A-Core: ${aCore.length}, B-Sekundär: ${bSek.length}, C-Hintergrund: ${cHinter.length} (passive)`);
  
  // Only research A and B drivers
  const toResearch = [...aCore, ...bSek];
  console.log(`  Drivers to research: ${toResearch.length}`);
  
  let totalEvents = 0;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalTokensInput = 0;
  let totalTokensOutput = 0;
  let totalTokensThinking = 0;
  let totalCost = 0;
  let totalDuration = 0;
  
  // Dedup set: tracks normalized headlines across all drivers for this asset
  const seenHeadlines = new Set<string>();
  
  for (const driver of toResearch) {
    const isDeep = driver.depth === 'deep';
    const prompt = isDeep
      ? buildDeepResearchPrompt(asset, driver)
      : buildBriefResearchPrompt(asset, driver);
    
    console.log(`  [${driver.label}] ${driver.driver_name} (weight: ${Number(driver.act_weighting).toFixed(3)}) → ${isDeep ? 'deep' : 'brief'} research...`);
    
    let result: GeminiGroundingResult;
    try {
      result = await callGeminiWithSearch(prompt);
    } catch (err) {
      console.error(`    ❌ Gemini error: ${err}`);
      continue;
    }
    
    totalTokensInput += result.tokens_input;
    totalTokensOutput += result.tokens_output;
    totalTokensThinking += result.tokens_thinking;
    totalCost += result.estimated_cost_usd;
    totalDuration += result.duration_ms;
    
    console.log(`    Tokens: ${result.tokens_input}in/${result.tokens_output}out/${result.tokens_thinking}think, cost: $${result.estimated_cost_usd.toFixed(6)}, grounding URLs: ${result.grounding_urls.length}`);
    
    // Parse events from response
    let rawEvents: any[];
    let parseSuccess = false;
    
    // Try 1: standard parsing
    try {
      let cleanText = result.text
        .replace(/^```json?\s*/i, '')
        .replace(/\s*```$/m, '')
        .trim();
      // If text starts with non-JSON preamble, find the first [ or {
      const jsonStart = cleanText.search(/[\[{]/);
      if (jsonStart > 0) cleanText = cleanText.slice(jsonStart);
      const parsed = JSON.parse(jsonrepair(cleanText));
      rawEvents = Array.isArray(parsed) ? parsed : (parsed.events || []);
      parseSuccess = true;
    } catch (e) {
      console.log(`    ⚠️ Parse attempt 1 failed: ${(e as Error).message?.slice(0, 60)}`);
    }
    
    // Try 2: retry with explicit JSON-only instruction
    if (!parseSuccess) {
      console.log(`    Retrying with strict JSON prompt...`);
      const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY a JSON array. No prose, no explanation, no markdown. Start with [ and end with ].';
      try {
        const retryResult = await callGeminiWithSearch(retryPrompt);
        totalTokensInput += retryResult.tokens_input;
        totalTokensOutput += retryResult.tokens_output;
        totalTokensThinking += retryResult.tokens_thinking;
        totalCost += retryResult.estimated_cost_usd;
        totalDuration += retryResult.duration_ms;
        
        let cleanText = retryResult.text
          .replace(/^```json?\s*/i, '')
          .replace(/\s*```$/m, '')
          .trim();
        const jsonStart = cleanText.search(/[\[{]/);
        if (jsonStart > 0) cleanText = cleanText.slice(jsonStart);
        const parsed = JSON.parse(jsonrepair(cleanText));
        rawEvents = Array.isArray(parsed) ? parsed : (parsed.events || []);
        parseSuccess = true;
        // Merge grounding URLs from retry
        if (result.grounding_urls.length === 0 && retryResult.grounding_urls.length > 0) {
          result.grounding_urls = retryResult.grounding_urls;
        }
        console.log(`    ✅ Retry succeeded: ${rawEvents.length} events`);
      } catch (e2) {
        console.error(`    ❌ Retry also failed: ${(e2 as Error).message?.slice(0, 60)}`);
        continue;
      }
    }
    
    console.log(`    Raw events: ${rawEvents.length}`);
    
    // Map to ShadowEvent
    const searchQuery = `${driver.driver_name} ${asset.name} latest developments`;
    const shadowEvents: ShadowEvent[] = rawEvents.map((e: any) => ({
      asset_id: asset.id,
      driver_name: driver.driver_name,
      headline: String(e.headline || '').slice(0, 200),
      summary: String(e.summary || '').slice(0, 1000),
      impact_score: Math.min(10, Math.max(1, Math.round(Number(e.impact_score) || 1))),
      sentiment_score: Math.min(1, Math.max(-1, Number(e.sentiment_score) || 0)),
      quantitative_or_qualitative: e.quantitative_or_qualitative === 'quantitative' ? 'quantitative' : 'qualitative',
      supply_or_demand: ['supply', 'demand', 'both'].includes(e.supply_or_demand) ? e.supply_or_demand : 'both',
      timeline_score: Math.min(5, Math.max(1, Math.round(Number(e.timeline_score) || 3))),
      grounding_url: result.grounding_urls[0] || null,
      grounding_missing: result.grounding_urls.length === 0,
      weighting_klasse: driver.label,
      search_query: searchQuery,
    }));
    
    // Dedup
    const beforeDedup = shadowEvents.length;
    const uniqueEvents = dedupEvents(shadowEvents, seenHeadlines);
    const dupesRemoved = beforeDedup - uniqueEvents.length;
    
    totalEvents += beforeDedup;
    totalDuplicates += dupesRemoved;
    
    if (dupesRemoved > 0) {
      console.log(`    Dedup: ${dupesRemoved} duplicate(s) removed`);
    }
    
    // Insert
    if (uniqueEvents.length > 0) {
      const inserted = await insertShadowEvents(uniqueEvents);
      totalInserted += inserted;
      console.log(`    ✅ Inserted ${inserted} events (impact: ${uniqueEvents.map(e => e.impact_score).join('/')})`);
    } else {
      console.log(`    No unique events to insert`);
    }
  }
  
  // C-Hintergrund: log but don't research
  for (const driver of cHinter) {
    console.log(`  [${driver.label}] ${driver.driver_name} — passive, no research`);
  }
  
  console.log(`  Summary: ${totalEvents} raw → ${totalInserted} inserted (${totalDuplicates} deduped)`);
  
  return {
    ticker: asset.ticker,
    driver_count: drivers.length,
    a_core: aCore.length,
    b_sek: bSek.length,
    events_found: totalEvents,
    events_inserted: totalInserted,
    duplicates_removed: totalDuplicates,
    total_tokens_input: totalTokensInput,
    total_tokens_output: totalTokensOutput,
    total_tokens_thinking: totalTokensThinking,
    total_cost_usd: totalCost,
    total_duration_ms: totalDuration,
  };
}

// ─── Main ───────────────────────────────────────────────────────────

async function acquireJobLock(): Promise<boolean> {
  try {
    const result = await runSql<{ locked: boolean }[]>(`
      INSERT INTO central.jobs (name, active, last_run)
      VALUES ('${JOB_LOCK_NAME}', true, NOW())
      ON CONFLICT (name) DO UPDATE SET active = true, last_run = NOW()
      WHERE central.jobs.active = false OR central.jobs.last_run < NOW() - INTERVAL '${JOB_LOCK_STALE_MIN} minutes'
      RETURNING true AS locked
    `);
    return result.length > 0;
  } catch {
    return false;
  }
}

async function releaseJobLock(): Promise<void> {
  try {
    await runSql(`UPDATE central.jobs SET active = false WHERE name = '${JOB_LOCK_NAME}'`);
  } catch { /* ignore */ }
}

// ─── SIGTERM/SIGINT Handler for Robust Lock Release ───────────────────
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n⚠️ Received ${signal}, releasing job lock...`);
  await releaseJobLock();
  console.log('Lock released. Exiting.');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

async function main() {
  console.log('=== VECTX V3 — Driver-First Research (Phase 1, Shadow Mode) ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Test assets: ${TEST_ASSETS.join(', ')}`);
  console.log('');
  
  // Job lock
  const locked = await acquireJobLock();
  if (!locked) {
    console.log('Job lock active — another run in progress. Exiting.');
    return;
  }
  
  const results: AssetResult[] = [];
  
  for (const ticker of TEST_ASSETS) {
    if (shuttingDown) {
      console.log(`⚠️ Shutdown in progress, skipping ${ticker}`);
      break;
    }
    
    const asset = await loadAsset(ticker);
    if (!asset) {
      console.error(`Asset ${ticker} not found, skipping`);
      continue;
    }
    let result = await processAsset(asset);
    
    // Retry once if 0 events
    if (result.events_inserted === 0 && !shuttingDown) {
      console.log(`  🔄 Retry: ${ticker} produced 0 events, retrying in 60s...`);
      await new Promise(resolve => setTimeout(resolve, 60_000));
      if (!shuttingDown) {
        result = await processAsset(asset);
      }
    }
    
    results.push(result);
  }
  
  // Summary
  console.log('\n=== Global Summary ===');
  const totalEvents = results.reduce((s, r) => s + r.events_inserted, 0);
  const totalCost = results.reduce((s, r) => s + r.total_cost_usd, 0);
  const totalTokens = results.reduce((s, r) => s + r.total_tokens_input + r.total_tokens_output + r.total_tokens_thinking, 0);
  
  for (const r of results) {
    console.log(`  ${r.ticker}: ${r.events_inserted} events (${r.a_core}A + ${r.b_sek}B drivers), cost: $${r.total_cost_usd.toFixed(4)}`);
  }
  console.log(`  Total: ${totalEvents} events, $${totalCost.toFixed(4)} cost, ${totalTokens} tokens`);
  console.log(`Finished at: ${new Date().toISOString()}`);
  
  // Alert on assets with 0 events
  const zeroEventAssets = results.filter(r => r.events_inserted === 0).map(r => r.ticker);
  if (zeroEventAssets.length > 0) {
    const alertMsg = `⚠️ Driver-First Alert: ${zeroEventAssets.join(', ')} produced 0 events this run`;
    console.log(alertMsg);
    await logHealthAlert(zeroEventAssets);
  }
  
  await releaseJobLock();
  return results;
}

async function logHealthAlert(zeroAssets: string[]): Promise<void> {
  try {
    await runSql(`
      INSERT INTO central.driver_first_health (asset_tickers, alert_type, created_at)
      VALUES ('${zeroAssets.join(',')}', 'zero_events', NOW())
    `);
  } catch (e) {
    console.error(`  Failed to log health alert: ${e}`);
  }
}

main().catch(async (err) => {
  console.error(`Fatal error: ${err}`);
  await releaseJobLock();
  process.exit(1);
});
