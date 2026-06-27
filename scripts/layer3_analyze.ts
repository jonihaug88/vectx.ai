/**
 * VECTX V3 - Layer 3 Analyze Script (v3 Ultra-Compact)
 * 
 * Generates trade recommendations based on all layer data
 * Uses Gemini 2.5 Flash for reliable JSON output (switched from GLM-5)
 * 
 * v3 Changes:
 * - Ultra-compact prompt (< 3500 chars)
 * - Single-character field names (k, d, et, e, tp, sl, sz, lv, c, h, th)
 * - Explicit skip path: {"k":"s","r":"reason"}
 * - Hedge as tuple: ["USDCHF","S",0.3,"reason"]
 * - Deterministic calculations in code (take_profit_pct, risk_reward_ratio)
 * 
 * v3.1: Switched to Gemini Flash for 97%+ reliability
 * v3.2: Trade Adjustment System - prevents duplicate trades
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { buildL3PromptV3, parseCompactL3, compactToFullTrade, type AlphaContext, type MarketMetrics, type CorrelatedAsset } from './l3_analyze_v3';
import { runL3AnalyzeGeminiFlash } from './gemini_flash_provider';
import { refineTrade, toTradeRow } from './prompts/tradeOutputSchema';
import type { TradeOutput } from './prompts/tradeOutputSchema';
import { validateHedgeStrict } from './l3_hedge_validator';
import { processTradeProposal, type L3TradeProposal } from './trade_adjustment_integration.js';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;
const DRY_RUN = config.dry_run ?? true; // Default to dry_run for safety

// Batch processing
const BATCH_ASSETS = process.env.ASSETS?.split(',') || null;

interface Asset {
  id: string;
  ticker: string;
  name: string;
  asset_class: string;
  current_price: number | null;
  vreal: number | null;
  alpha_gap: number | null;
  act_trademarket_informations: {
    volatility_30d: number | null;
    atr_14d: number | null;
    liquidity_score: number;
    trend_strength: number;
    momentum_14d: number;
    data_recency: string | null;
  } | null;
}

interface Alpha {
  id: string;
  vreal: number;
  alpha_gap: number;
  confidence: number;
  timeframe: string;
  reasoning: string;
}

interface Correlation {
  asset_id_2: string;
  asset_name_2: string;
  correlation: number;
  stability: string;
  hedge_suitability: number;
  reasoning: string;
}

async function runSql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify({ sql: query, params }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`SQL error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.data || [];
}

async function getAssetsForTrade(): Promise<{ asset_id: string; asset_name: string; ticker: string }[]> {
  let query = `
    SELECT id as asset_id, name as asset_name, ticker
    FROM central.assets
    WHERE l3_ready = true
    AND l3_researched_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM central.trades t 
      WHERE t.asset_id = central.assets.id 
      AND t.status = 'open'
    )
    ORDER BY name
  `;

  let results = await runSql<{ asset_id: string; asset_name: string; ticker: string }>(query);
  
  if (BATCH_ASSETS) {
    // Fix: Match against ticker, not asset_name
    const before = results.length;
    results = results.filter(r => BATCH_ASSETS.includes(r.ticker));
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
    if (results.length === 0 && before > 0) {
      console.log(`  ⚠️ No matches. Available tickers: ${results.map(r => r.ticker).join(', ')}`);
    }
  }
  
  return results;
}

async function getAsset(assetId: string): Promise<Asset | null> {
  const query = `
    SELECT id, ticker, name, asset_class, current_price, vreal, alpha_gap, act_trademarket_informations
    FROM central.assets
    WHERE id = $1
  `;
  const results = await runSql<Asset>(query, [assetId]);
  return results[0] || null;
}

async function getLatestAlpha(assetId: string): Promise<Alpha | null> {
  const query = `
    SELECT id, vreal, alpha_gap, confidence, timeframe, reasoning
    FROM central.alpha
    WHERE asset_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const results = await runSql<Alpha>(query, [assetId]);
  return results[0] || null;
}

async function getCorrelations(assetId: string): Promise<Correlation[]> {
  const query = `
    SELECT asset_id_2, asset_name_2, correlation, stability, hedge_suitability, reasoning
    FROM central.correlations
    WHERE asset_id_1 = $1
    ORDER BY hedge_suitability DESC
    LIMIT 3
  `;
  return runSql<Correlation>(query, [assetId]);
}

async function insertTradeRow(
  row: Record<string, unknown>,
  context: { alpha_confidence: number; timeframe_days: number; momentum_14d?: number; trend_strength?: number }
): Promise<void> {
  const escapeSql = (str: string): string => {
    return `'${str.replace(/'/g, "''")}'`;
  };

  // Handle skip case - log to trade_skips
  if (row.recommendation === 'skip') {
    console.log(`  ⏭️ SKIPPED: ${row.skip_reason}`);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${row.asset_id}', '${(row.skip_reason || '').toString().replace(/'/g, "''")}', ${(row.trade_confidence as number) || 0}, NOW())
      ON CONFLICT DO NOTHING
    `);
    return;
  }

  // ─── PRICE VALIDATION ────────────────────────────────────────────────
  // Check for unrealistic prices (e.g., BRENT at $14 instead of ~$100)
  const PRICE_RANGES: Record<string, { min: number; max: number }> = {
    WTI: { min: 30, max: 200 },
    BRENT: { min: 30, max: 200 },
    NG: { min: 1, max: 20 },
    GC: { min: 1000, max: 5000 },
    SI: { min: 10, max: 100 },
    HG: { min: 2, max: 15 },
    ZC: { min: 200, max: 1000 },
    ZS: { min: 500, max: 2500 },
    ZW: { min: 200, max: 1500 },
    KC: { min: 100, max: 400 },
    EURUSD: { min: 0.8, max: 1.5 },
    GBPUSD: { min: 1.0, max: 2.0 },
    USDJPY: { min: 80, max: 200 },
    USDCHF: { min: 0.6, max: 1.2 },
    USDCAD: { min: 1.0, max: 1.8 },
    AUDUSD: { min: 0.5, max: 1.0 },
    NZDUSD: { min: 0.4, max: 0.9 },
    EURGBP: { min: 0.7, max: 1.1 },
    EURJPY: { min: 100, max: 250 },
    GBPJPY: { min: 120, max: 300 },
  };

  const assetTicker = (row.ticker as string) || (row.asset_name as string) || '';
  const entryPrice = Number(row.entry_price) || 0;
  const range = PRICE_RANGES[assetTicker];
  
  if (range && (entryPrice < range.min || entryPrice > range.max)) {
    console.log(`  ⚠️ PRICE ANOMALY: ${assetTicker} entry $${entryPrice} outside ${range.min}-${range.max}`);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${row.asset_id}', 'price_anomaly: ${assetTicker} entry ${entryPrice} outside ${range.min}-${range.max}', ${(row.trade_confidence as number) || 0}, NOW())
    `);
    return;
  }

  // ─── DEDUPLICATION ────────────────────────────────────────────────────
  // Check for existing trade with same setup within 24h
  const existing = await runSql<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM central.paper_trades
    WHERE asset_id = '${row.asset_id}'
      AND entry_price = ${entryPrice}
      AND take_profit_price = ${row.take_profit_price}
      AND stop_loss_price = ${row.stop_loss_price}
      AND opened_at > NOW() - INTERVAL '24 hours'
  `);
  
  if (existing[0]?.count > 0) {
    console.log(`  ⏭️ DUPLICATE: Already have ${existing[0].count} identical setup(s) in last 24h`);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${row.asset_id}', 'duplicate: identical setup exists in last 24h', ${(row.trade_confidence as number) || 0}, NOW())
    `);
    return;
  }

  // Choose table based on dry_run mode
  const table = DRY_RUN ? 'central.paper_trades' : 'central.trades';
  
  if (DRY_RUN) {
    console.log(`  📝 DRY RUN: Writing to paper_trades`);
  }

  // Helper to safely format SQL values
  const sql = {
    num: (v: any) => (v === null || v === undefined) ? 'null' : Number(v),
    str: (v: any) => (v === null || v === undefined) ? 'null' : `'${String(v).replace(/'/g, "''")}'`,
    bool: (v: any) => (v === null || v === undefined) ? 'null' : (v ? 'true' : 'false'),
  };

  // Debug: Log row values before INSERT
  const debugFields = ['asset_id', 'asset_name', 'alpha_id', 'signal_direction', 'risk_reward_ratio', 'entry_price', 'take_profit_price', 'stop_loss_price', 'leverage', 'trade_confidence'];
  const undefinedFields = debugFields.filter(f => row[f] === undefined);
  if (undefinedFields.length > 0) {
    console.log(`  ⚠️ Undefined fields: ${undefinedFields.join(', ')}`);
    console.log(`  Row: ${JSON.stringify(row, null, 2).substring(0, 500)}...`);
  }

  // Build query with safe null handling
  const query = `
    INSERT INTO ${table}
      (asset_id, alpha_id, asset_name, signal_direction, risk_reward_ratio, entry_price, take_profit_price, stop_loss_price,
       take_profit_pct, stop_loss_pct, position_size_pct, leverage, trade_confidence, entry_type,
       reasoning, hedge_ticker, hedge_direction, hedge_ratio, hedge_type, status,
       alpha_confidence, timeframe, correlation_held, opened_at, created_at,
       entry_momentum_14d, entry_trend_strength, vreal_version)
    VALUES (
      ${row.asset_id ? `'${row.asset_id}'` : 'null'},
      ${row.alpha_id ? `'${row.alpha_id}'` : 'null'},
      ${row.asset_name ? `'${row.asset_name}'` : 'null'},
      ${row.signal_direction ? `'${row.signal_direction}'` : 'null'},
      ${row.risk_reward_ratio != null ? row.risk_reward_ratio : 'null'},
      ${row.entry_price != null ? row.entry_price : 'null'},
      ${row.take_profit_price != null ? row.take_profit_price : 'null'},
      ${row.stop_loss_price != null ? row.stop_loss_price : 'null'},
      ${row.take_profit_pct != null ? row.take_profit_pct : 'null'},
      ${row.stop_loss_pct != null ? row.stop_loss_pct : 'null'},
      ${row.position_size_pct != null ? row.position_size_pct : 'null'},
      ${row.leverage != null ? row.leverage : 'null'},
      ${row.trade_confidence != null ? row.trade_confidence : 'null'},
      ${row.entry_type ? `'${row.entry_type}'` : "'market'"},
      '${JSON.stringify(row.reasoning ?? {}).replace(/'/g, "''")}'::jsonb,
      ${row.hedge_ticker ? `'${row.hedge_ticker}'` : 'null'},
      ${row.hedge_direction ? `'${row.hedge_direction}'` : 'null'},
      ${row.hedge_ratio != null ? row.hedge_ratio : 'null'},
      ${row.hedge_type ? `'${row.hedge_type}'` : 'null'},
      '${DRY_RUN ? 'pending' : 'open'}',
      ${context.alpha_confidence != null ? context.alpha_confidence : 'null'},
      '${context.timeframe_days}d',
      ${row.hedge_ticker ? 'true' : 'false'},
      NOW(),
      NOW(),
      ${context.momentum_14d != null && context.momentum_14d !== undefined ? context.momentum_14d : 'NULL'},
      ${context.trend_strength != null && context.trend_strength !== undefined ? context.trend_strength : 'NULL'},
      'future_damper_v3'
    )
  `;
  
  // Check for undefined in query
  if (query.includes('undefined')) {
    console.log(`  ❌ SQL contains undefined!`);
    console.log(`  Query preview: ${query.substring(0, 500)}...`);
    throw new Error('SQL contains undefined value');
  }
  
  try {
    await runSql(query);
  } catch (sqlError) {
    console.error(`  SQL Error: ${sqlError}`);
    console.error(`  Query: ${query.substring(0, 300)}...`);
    throw sqlError;
  }
}

// Note: GLM-5 removed, using Gemini Flash provider
// The runL3AnalyzeGeminiFlash function handles all LLM calls

// Log failures to database
async function logFailure(
  assetId: string,
  ticker: string,
  failureType: string,
  errorMessage: string,
  responsePreview: string = '',
  retryAttempt: number = 0,
  result?: { tokens_input?: number; tokens_output?: number; tokens_thinking?: number; estimated_cost_usd?: number }
): Promise<void> {
  try {
    await runSql(`
      INSERT INTO central.l2_analyze_failures 
        (asset_id, asset_ticker, failure_type, error_message, response_preview, retry_attempt,
         tokens_input, tokens_output, tokens_thinking, estimated_cost_usd)
      VALUES 
        ('${assetId}', '${ticker}', '${failureType}', '${errorMessage.replace(/'/g, "''")}', '${responsePreview.slice(0, 300).replace(/'/g, "''")}', ${retryAttempt},
         ${result?.tokens_input ?? 'NULL'}, ${result?.tokens_output ?? 'NULL'}, ${result?.tokens_thinking ?? 'NULL'}, ${result?.estimated_cost_usd ?? 'NULL'})
    `);
  } catch (e) {
    console.error(`  Failed to log failure: ${e}`);
  }
}

async function logL3Run(
  assetId: string,
  assetName: string,
  success: boolean,
  latencyMs: number,
  result?: { tokens_input?: number; tokens_output?: number; tokens_thinking?: number; estimated_cost_usd?: number; error_detail?: string; failure_type?: string }
): Promise<void> {
  try {
    await runSql(`
      INSERT INTO central.l3_analyze_runs 
        (asset_id, asset_name, llm_model, llm_latency_ms, success, 
         tokens_input, tokens_output, tokens_thinking, estimated_cost_usd, error_message)
      VALUES 
        ('${assetId}', '${assetName.replace(/'/g, "''")}', '${process.env.L3_MODEL || 'gemini-2.5-pro'}', ${latencyMs}, ${success},
         ${result?.tokens_input ?? 'NULL'}, ${result?.tokens_output ?? 'NULL'}, ${result?.tokens_thinking ?? 'NULL'}, ${result?.estimated_cost_usd ?? 'NULL'},
         ${result?.error_detail ? `'${result.error_detail.replace(/'/g, "''").slice(0, 500)}'` : 'NULL'})
    `);
  } catch (e) {
    console.error(`  Failed to log L3 run: ${e}`);
  }
}

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ trade: TradeOutput | null; success: boolean }> {
  console.log(`\n[${assetName}] Analyzing for trade...`);

  const asset = await getAsset(assetId);
  if (!asset) {
    console.error(`  Asset not found`);
    return { trade: null, success: false };
  }

  const alpha = await getLatestAlpha(assetId);
  if (!alpha) {
    console.log(`  No alpha found, skipping`);
    return { trade: null, success: false };
  }

  const correlations = await getCorrelations(assetId);
  console.log(`  Correlations: ${correlations.length}`);
  correlations.forEach(c => {
    console.log(`    - ${c.asset_name_2}: ${Number(c.correlation).toFixed(2)} (hedge: ${Number(c.hedge_suitability)}/10, ${c.stability})`);
  });

  // Get metrics from asset - convert to numbers (DB returns strings)
  const rawMetrics = asset.act_trademarket_informations || {
    volatility_30d: null,
    atr_14d: null,
    liquidity_score: 5,
    trend_strength: 0,
    momentum_14d: 0,
  };
  const metrics = {
    volatility_30d: rawMetrics.volatility_30d != null ? Number(rawMetrics.volatility_30d) : null,
    atr_14d: rawMetrics.atr_14d != null ? Number(rawMetrics.atr_14d) : null,
    liquidity_score: Number(rawMetrics.liquidity_score) || 5,
    trend_strength: Number(rawMetrics.trend_strength) || 0,
    momentum_14d: Number(rawMetrics.momentum_14d) || 0,
  };

  // Build ultra-compact prompt v3
  const alphaContext: AlphaContext = {
    asset_ticker: asset.ticker,
    asset_name: asset.name,
    asset_class: asset.asset_class,
    current_price: Number(asset.current_price) || 0,
    vreal: Number(alpha.vreal) || 0,
    alpha_gap_pct: (Number(alpha.alpha_gap) / (Number(asset.current_price) || 1)) * 100,
    alpha_confidence: Number(alpha.confidence) || 0,
    timeframe_days: Number(alpha.timeframe) || 14,
    reasoning: alpha.reasoning || '',
  };

  const marketMetrics: MarketMetrics = {
    volatility_30d_pct: metrics.volatility_30d ?? 20,
    atr_14d: metrics.atr_14d ?? Number(asset.current_price) * 0.02,
    liquidity_score: metrics.liquidity_score ?? 5,
    trend_strength: metrics.trend_strength ?? 5,
    momentum_14d: metrics.momentum_14d ?? 0,
    trend_aligned_with_signal: (alphaContext.alpha_gap_pct > 0 && metrics.momentum_14d > 0) ||
                               (alphaContext.alpha_gap_pct < 0 && metrics.momentum_14d < 0),
  };

  const correlatedAssets: CorrelatedAsset[] = correlations.map(c => ({
    ticker: c.asset_name_2,
    name: c.asset_name_2,
    correlation: Number(c.correlation) || 0,
    stability: (c.stability || 'moderate') as 'stable' | 'moderate' | 'unstable',
    hedge_suitability: Number(c.hedge_suitability) || 5,
  }));

  // ─── PRE-LLM GATES: Skip before API call ──────────────────────────────
  const PRE_LLM_RULES = {
    MIN_ALPHA_GAP_PCT: 1.5,
    MIN_CONFIDENCE: 0.50,
    MIN_LIQUIDITY: 3,
  } as const;

  // Gate 1: Alpha gap too small
  if (Math.abs(alphaContext.alpha_gap_pct) < PRE_LLM_RULES.MIN_ALPHA_GAP_PCT) {
    console.log(`  ⏭️ SKIPPED: alpha_gap ${alphaContext.alpha_gap_pct.toFixed(2)}% < ${PRE_LLM_RULES.MIN_ALPHA_GAP_PCT}%`);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${assetId}', 'alpha_gap ${alphaContext.alpha_gap_pct.toFixed(2)}% < ${PRE_LLM_RULES.MIN_ALPHA_GAP_PCT}%', ${alphaContext.alpha_confidence}, NOW())
    `);
    return { trade: null, success: false, skipped: true };
  }

  // Gate 2: Confidence too low
  if (alphaContext.alpha_confidence < PRE_LLM_RULES.MIN_CONFIDENCE) {
    console.log(`  ⏭️ SKIPPED: confidence ${alphaContext.alpha_confidence.toFixed(2)} < ${PRE_LLM_RULES.MIN_CONFIDENCE}`);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${assetId}', 'confidence ${alphaContext.alpha_confidence.toFixed(2)} < ${PRE_LLM_RULES.MIN_CONFIDENCE}', ${alphaContext.alpha_confidence}, NOW())
    `);
    return { trade: null, success: false, skipped: true };
  }

  // Gate 3: Liquidity too low
  if (marketMetrics.liquidity_score < PRE_LLM_RULES.MIN_LIQUIDITY) {
    console.log(`  ⏭️ SKIPPED: liquidity ${marketMetrics.liquidity_score} < ${PRE_LLM_RULES.MIN_LIQUIDITY}`);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${assetId}', 'liquidity ${marketMetrics.liquidity_score} < ${PRE_LLM_RULES.MIN_LIQUIDITY}', ${alphaContext.alpha_confidence}, NOW())
    `);
    return { trade: null, success: false, skipped: true };
  }

  // First attempt with Gemini Flash
  const prompt = buildL3PromptV3(alphaContext, marketMetrics, correlatedAssets, { strictRetry: false });
  console.log(`  Prompt length: ${prompt.length} chars`);
  
  // Call Gemini Flash
  const startTime = Date.now();
  const callResult = await runL3AnalyzeGeminiFlash(
    (opts) => buildL3PromptV3(alphaContext, marketMetrics, correlatedAssets, opts),
    Number(asset.current_price) || 100
  );
  const elapsed = Date.now() - startTime;
  
  console.log(`  Gemini response time: ${elapsed}ms (provider: ${callResult.provider}, attempts: ${callResult.attempts})`);
  
  if (!callResult.success) {
    const failureType = callResult.failure_type || 'unknown';
    await logFailure(assetId, asset.ticker, failureType, callResult.error_detail || '', '', callResult.attempts, callResult);
    await logL3Run(assetId, asset.ticker, false, callResult.duration_ms, callResult);
    console.error(`  Gemini error (${failureType}): ${callResult.error_detail}`);
    return { trade: null, success: false };
  }
  
  console.log(`  Gemini done_reason: ${callResult.done_reason}, tokens: ${callResult.eval_count || '-'}, cost: $${(callResult.estimated_cost_usd ?? 0).toFixed(6)}`);
  console.log(`  Gemini response preview: ${callResult.text.slice(0, 150)}...`);
  
  // Parse compact format
  const parsed = parseCompactL3(callResult.text);
  if (!parsed.success || !parsed.data) {
    await logFailure(assetId, asset.ticker, 'json_parse', parsed.error || 'parse failed', callResult.text, callResult.attempts, callResult);
    await logL3Run(assetId, asset.ticker, false, callResult.duration_ms, callResult);
    console.error(`  Parse failed (${parsed.method}): ${parsed.error}`);
    return { trade: null, success: false };
  }

  console.log(`  Parse: ${parsed.method} ✓`);
  
  // Convert to full format
  const fullTrade = compactToFullTrade(parsed.data, Number(asset.current_price) || 100);
  
  // Handle skip case
  if (fullTrade.recommendation === 'skip') {
    console.log(`  ⏭️ SKIPPED: ${fullTrade.skip_reason}`);
    await logL3Run(assetId, asset.ticker, true, callResult.duration_ms, callResult);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${assetId}', '${(fullTrade.skip_reason || '').replace(/'/g, "''")}', ${Number(alpha.confidence) || 0}, NOW())
      ON CONFLICT DO NOTHING
    `);
    return { trade: fullTrade as TradeOutput, success: true };
  }

  // Apply refinement (confidence cap, R:R validation, etc.)
  const refined = refineTrade(fullTrade as TradeOutput, {
    alphaConfidence: Number(alpha.confidence) || 0,
    currentPrice: Number(asset.current_price) || 100,
    entryTolerancePct: 0.02,
  });

  if (!refined.ok) {
    await logFailure(assetId, asset.ticker, 'refinement_failed', refined.reason || '', callResult.text, callResult.attempts, callResult);
    await logL3Run(assetId, asset.ticker, false, callResult.duration_ms, callResult);
    console.error(`  Refinement failed: ${refined.reason}`);
    return { trade: null, success: false };
  }

  // ─── POST-LLM VALIDATION: ATR-based Stop Floor + R:R Plausibility Cap ─────
  const stopDistance = Math.abs(refined.trade.entry_price - (refined.trade.stop_loss_price || 0));
  const atr = marketMetrics.atr_14d;
  // Fallback: if ATR missing, use 1% of entry price as minimum stop distance
  const minStopDistance = (atr && atr > 0)
    ? 0.5 * atr
    : refined.trade.entry_price * 0.01;

  let stopAdjusted = false;
  let originalStop = refined.trade.stop_loss_price;
  let originalTp = refined.trade.take_profit_price;
  let originalRR = refined.trade.risk_reward_ratio || 0;

  if (stopDistance < minStopDistance) {
    // Adjust stop to ATR minimum
    const adjustedStop = refined.trade.signal_direction === 'long'
      ? refined.trade.entry_price - minStopDistance
      : refined.trade.entry_price + minStopDistance;
    console.log(`  ⚠️ Stop too tight: ${((stopDistance / refined.trade.entry_price) * 100).toFixed(2)}% < ${((minStopDistance / refined.trade.entry_price) * 100).toFixed(2)}% (0.5× ATR). Adjusting $${refined.trade.stop_loss_price?.toFixed(2)} → $${adjustedStop.toFixed(2)}`);
    refined.trade.stop_loss_price = adjustedStop;
    refined.trade.stop_loss_pct = refined.trade.signal_direction === 'long'
      ? -((adjustedStop - refined.trade.entry_price) / refined.trade.entry_price) * 100
      : ((refined.trade.entry_price - adjustedStop) / refined.trade.entry_price) * 100;
    // Recompute R:R with adjusted stop
    const tpDist = Math.abs((refined.trade.take_profit_price || 0) - refined.trade.entry_price);
    refined.trade.risk_reward_ratio = tpDist / minStopDistance;
    console.log(`  R:R recomputed: ${refined.trade.risk_reward_ratio.toFixed(2)} (was ${originalRR.toFixed(2)})`);
    stopAdjusted = true;
  }

  // R:R Plausibility Cap — even with valid stops, R:R > 5 is suspicious
  const RR_PLAUSIBILITY_CAP = 5.0;
  let rrCapped = false;
  if ((refined.trade.risk_reward_ratio || 0) > RR_PLAUSIBILITY_CAP) {
    const direction = refined.trade.signal_direction;
    const finalStopDist = Math.abs(refined.trade.entry_price - (refined.trade.stop_loss_price || 0));
    const newTpDist = finalStopDist * RR_PLAUSIBILITY_CAP;
    refined.trade.take_profit_price = direction === 'long'
      ? refined.trade.entry_price + newTpDist
      : refined.trade.entry_price - newTpDist;
    refined.trade.take_profit_pct = direction === 'long'
      ? (newTpDist / refined.trade.entry_price) * 100
      : -(newTpDist / refined.trade.entry_price) * 100;
    const oldRR = refined.trade.risk_reward_ratio || 0;
    refined.trade.risk_reward_ratio = RR_PLAUSIBILITY_CAP;
    console.log(`  ⚠️ R:R capped at ${RR_PLAUSIBILITY_CAP}: ${oldRR.toFixed(2)} → ${RR_PLAUSIBILITY_CAP}, target $${originalTp?.toFixed(2)} → $${refined.trade.take_profit_price.toFixed(4)}`);
    rrCapped = true;
  }

  // Log adjustments for post-hoc analysis
  if (stopAdjusted || rrCapped) {
    const reason = [
      stopAdjusted ? 'stop_atr_adjusted' : '',
      rrCapped ? 'rr_capped_at_5' : ''
    ].filter(Boolean).join('+');
    try {
      // Will link to paper_trade_id once trade is inserted (update after insert)
      await runSql(`
        INSERT INTO central.trade_adjustments
          (alpha_id, old_stop_loss_price, new_stop_loss_price, old_take_profit_price, new_take_profit_price,
           old_risk_reward_ratio, new_risk_reward_ratio, adjustment_reason, created_at)
        VALUES (
          ${alpha.id ? `'${alpha.id}'` : 'NULL'},
          ${originalStop != null && originalStop !== undefined ? originalStop : 'NULL'},
          ${refined.trade.stop_loss_price != null ? refined.trade.stop_loss_price : 'NULL'},
          ${originalTp != null && originalTp !== undefined ? originalTp : 'NULL'},
          ${refined.trade.take_profit_price != null ? refined.trade.take_profit_price : 'NULL'},
          ${originalRR != null && originalRR !== undefined ? originalRR : 'NULL'},
          ${refined.trade.risk_reward_ratio != null ? refined.trade.risk_reward_ratio : 'NULL'},
          '${reason}',
          NOW()
        )
      `);
    } catch (e) {
      console.error(`  Failed to log trade adjustment: ${e}`);
    }
  }

  // ─── POST-LLM VALIDATION: R:R ≥ 1.5 ──────────────────────────────
  const rr = refined.trade.risk_reward_ratio || 0;
  if (rr < 1.5) {
    console.log(`  ⏭️ SKIPPED: R:R ${rr.toFixed(2)} < 1.5 (Post-LLM Guard)`);
    await logL3Run(assetId, asset.ticker, true, callResult.duration_ms, callResult);
    await runSql(`
      INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
      VALUES ('${assetId}', 'R:R ${rr.toFixed(2)} < 1.5 (Post-LLM Guard)', ${Number(alpha.confidence) || 0}, NOW())
    `);
    return { trade: null, success: false };
  }

  // ─── POST-LLM VALIDATION: Hedge Compliance ──────────────────────────────
  if (refined.trade.hedge) {
    const hedgeCheck = validateHedgeStrict(
      {
        ticker: refined.trade.hedge.ticker,
        direction: refined.trade.hedge.direction,
        ratio: refined.trade.hedge.ratio,
      },
      refined.trade.signal_direction || 'long',
      correlatedAssets.map(c => ({
        ticker: c.ticker,
        correlation: c.correlation,
        hedge_suitability: c.hedge_suitability,
        stability: c.stability,
      }))
    );

    if (!hedgeCheck.valid) {
      console.log(`  ⚠️ HEDGE REJECTED: ${hedgeCheck.reason}`);
      
      // Log rejection for analytics (with null safety)
      await runSql(`
        INSERT INTO central.hedge_rejections
        (asset_ticker, hedge_ticker, hedge_direction, hedge_ratio, rejection_rule, rejection_reason)
        VALUES ('${asset.ticker ?? 'unknown'}', '${refined.trade.hedge?.ticker ?? 'unknown'}', '${refined.trade.hedge?.direction ?? 'unknown'}', ${refined.trade.hedge?.ratio ?? 0}, '${hedgeCheck.rule}', '${hedgeCheck.reason.replace(/'/g, "''")}')
      `);
      
      // Option A: Reject entire trade (strict)
      await runSql(`
        INSERT INTO central.trade_skips (asset_id, skip_reason, alpha_confidence, created_at)
        VALUES ('${assetId}', 'Hedge: ${hedgeCheck.rule}', ${Number(alpha.confidence) || 0}, NOW())
      `);
      return { trade: null, success: false };
      
      // Option B: Remove hedge, keep trade (lenient) - uncomment if preferred:
      // refined.trade.hedge = null;
      // console.log(`  Hedge removed, continuing with unhedged trade`);
    }
  }

  // Log the trade
  console.log(`  ✅ SIGNAL: ${refined.trade.signal_direction?.toUpperCase()}`);
  console.log(`  Entry: $${refined.trade.entry_price?.toFixed(2)} (${refined.trade.entry_type})`);
  console.log(`  Target: $${refined.trade.take_profit_price?.toFixed(2)} (${refined.trade.take_profit_pct?.toFixed(1)}%)`);
  console.log(`  Stop: $${refined.trade.stop_loss_price?.toFixed(2)} (${refined.trade.stop_loss_pct?.toFixed(1)}%)`);
  console.log(`  R:R: ${refined.trade.risk_reward_ratio?.toFixed(2)}`);
  console.log(`  Position: ${refined.trade.position_size_pct?.toFixed(1)}% | Leverage: ${refined.trade.leverage}x`);
  console.log(`  Confidence: ${((refined.trade.trade_confidence || 0) * 100).toFixed(0)}%`);
  if (refined.trade.hedge) {
    console.log(`  Hedge: ${refined.trade.hedge.ticker} (${refined.trade.hedge.direction}) ${(refined.trade.hedge.ratio * 100).toFixed(0)}%`);
  }

  // Insert trade using Trade Adjustment System
  const tradeRow = toTradeRow(refined.trade, assetId, asset.ticker, alpha?.id);
  if (tradeRow) {
    // Build proposal for trade adjustment system
    const proposal: L3TradeProposal = {
      asset_id: assetId,
      asset_name: asset.name,
      alpha_id: alpha?.id || '',
      signal_direction: refined.trade.signal_direction || 'long',
      entry_price: Number(refined.trade.entry_price) || 0,
      take_profit_price: Number(refined.trade.take_profit_price) || 0,
      stop_loss_price: Number(refined.trade.stop_loss_price) || 0,
      take_profit_pct: Number(refined.trade.take_profit_pct) || 0,
      stop_loss_pct: Number(refined.trade.stop_loss_pct) || 0,
      position_size_pct: Number(refined.trade.position_size_pct) || 5,
      leverage: Number(refined.trade.leverage) || 1,
      risk_reward_ratio: Number(refined.trade.risk_reward_ratio) || 0,
      trade_confidence: Number(refined.trade.trade_confidence) || 0,
      reasoning: (refined.trade.reasoning as Record<string, any>) || {},
      hedge_ticker: refined.trade.hedge?.ticker,
      hedge_direction: refined.trade.hedge?.direction,
      hedge_ratio: refined.trade.hedge?.ratio,
      hedge_type: refined.trade.hedge ? 'correlation' : undefined,
      vreal: alpha?.vreal || 0,
      alpha_gap_pct: alpha ? (alpha.alpha_gap / (alpha.vreal - alpha.alpha_gap) * 100) : 0,
    };

    // Insert function for new trades (called by processTradeProposal)
    const insertNewTrade = async (p: L3TradeProposal): Promise<string> => {
      await insertTradeRow(tradeRow!, {
        alpha_confidence: alphaContext.alpha_confidence,
        timeframe_days: alphaContext.timeframe_days,
        momentum_14d: marketMetrics.momentum_14d,
        trend_strength: marketMetrics.trend_strength
      });
      // Return the asset_id as a pseudo-ID (actual ID is generated by DB)
      return assetId;
    };

    const result = await processTradeProposal(proposal, insertNewTrade);
    console.log(`  ✅ Trade ${result.action}: ${result.details}`);
  }

  await logL3Run(assetId, asset.ticker, true, callResult.duration_ms, callResult);
  return { trade: refined.trade, success: true };
}

// Concurrency-limited parallel processing
const CONCURRENCY_LIMIT = 4;
const ASSET_TIMEOUT_MS = 120000; // 2 minutes per asset

async function processAssetsConcurrently(
  assets: { asset_id: string; asset_name: string; ticker: string }[]
): Promise<{ trades: number; errors: number }> {
  let totalTrades = 0;
  let totalErrors = 0;
  
  // Process in batches of CONCURRENCY_LIMIT
  for (let i = 0; i < assets.length; i += CONCURRENCY_LIMIT) {
    const batch = assets.slice(i, i + CONCURRENCY_LIMIT);
    
    const results = await Promise.allSettled(
      batch.map(async ({ asset_id, asset_name }) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), ASSET_TIMEOUT_MS);
        
        try {
          const result = await processAsset(asset_id, asset_name);
          clearTimeout(timeout);
          return result;
        } catch (error) {
          clearTimeout(timeout);
          throw error;
        }
      })
    );
    
    for (const result of results) {
      if (result.status === 'fulfilled') {
        if (result.value.trade) {
          totalTrades++;
        } else {
          totalErrors++;
        }
      } else {
        // Log full error for debugging
        const err = result.reason;
        console.error(`  Asset processing failed: ${err.message || err}`);
        if (err.stack) {
          const stackLines = err.stack.split('\n').slice(0, 5);
          console.error(`  Stack: ${stackLines.join('\n         ')}`);
        }
        totalErrors++;
      }
    }
  }
  
  return { trades: totalTrades, errors: totalErrors };
}

async function analyze() {
  console.log('=== VECTX V3 - Layer 3 Analyze ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Model: ${process.env.L3_MODEL || 'gemini-2.5-pro'}`);
  console.log(`Dry Run: ${DRY_RUN ? '✅ ENABLED (paper_trades)' : '⚠️ LIVE MODE (trades)'}`);
  console.log(`Concurrency: ${CONCURRENCY_LIMIT}`);
  console.log('');

  const assets = await getAssetsForTrade();
  console.log(`Found ${assets.length} assets ready for trade analysis`);

  if (assets.length === 0) {
    console.log('No assets ready. Run Layer 3 Research first.');
    return { trades: 0, errors: 0 };
  }

  const { trades, errors } = await processAssetsConcurrently(assets);

  console.log('\n=== Summary ===');
  console.log(`Trades generated: ${trades}`);
  console.log(`Errors: ${errors}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { trades, errors };
}

analyze().catch(console.error);