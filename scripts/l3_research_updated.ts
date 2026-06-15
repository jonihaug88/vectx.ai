/**
 * VECTX V3 - Layer 3 Research Script (Updated)
 * 
 * Finds correlations and trading metrics for assets
 * Uses Gemini for market analysis
 * 
 * Processes assets where l3_collected_at > l3_researched_at (new data available)
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;
const GEMINI_API_KEY = config.gemini_api_key;

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
}

interface Alpha {
  vreal: number;
  alpha_gap: number;
  confidence: number;
  timeframe: string;
}

interface FutureEvent {
  event_type: string;
  headline: string;
  probability: number;
  impact_score: number;
  sentiment_score: number;
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

function toNum(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const num = parseFloat(String(val));
  return isNaN(num) ? null : num;
}

function convertAsset(row: Record<string, unknown>): Asset {
  return {
    id: String(row.id),
    ticker: String(row.ticker || ''),
    name: String(row.name || ''),
    asset_class: String(row.asset_class || ''),
    current_price: toNum(row.current_price),
    vreal: toNum(row.vreal),
    alpha_gap: toNum(row.alpha_gap),
  };
}

function convertAlpha(row: Record<string, unknown>): Alpha {
  return {
    vreal: toNum(row.vreal) || 0,
    alpha_gap: toNum(row.alpha_gap) || 0,
    confidence: toNum(row.confidence) || 0,
    timeframe: String(row.timeframe || ''),
  };
}

function convertFutureEvent(row: Record<string, unknown>): FutureEvent {
  return {
    event_type: String(row.event_type || ''),
    headline: String(row.headline || ''),
    probability: toNum(row.probability) || 0,
    impact_score: toNum(row.impact_score) || 0,
    sentiment_score: toNum(row.sentiment_score) || 0,
  };
}

// Updated query: assets where collected_at > researched_at OR researched_at IS NULL
async function getAssetsForResearch(): Promise<{ asset_id: string; asset_name: string }[]> {
  let query = `
    SELECT id as asset_id, name as asset_name
    FROM central.assets
    WHERE l3_ready = true
    AND (l3_researched_at IS NULL OR l3_collected_at > l3_researched_at)
    ORDER BY name
  `;

  let results = await runSql<{ asset_id: string; asset_name: string }>(query);
  
  if (BATCH_ASSETS) {
    results = results.filter(r => 
      BATCH_ASSETS.some(b => 
        r.asset_name.toLowerCase().includes(b.toLowerCase())
      )
    );
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
  }
  return results;
}

async function getAsset(assetId: string): Promise<Asset | null> {
  const query = `
    SELECT id, ticker, name, asset_class, current_price, vreal, alpha_gap
    FROM central.assets
    WHERE id = $1
  `;
  const results = await runSql<Record<string, unknown>>(query, [assetId]);
  return results[0] ? convertAsset(results[0]) : null;
}

async function getLatestAlpha(assetId: string): Promise<Alpha | null> {
  const query = `
    SELECT vreal, alpha_gap, confidence, timeframe
    FROM central.alpha
    WHERE asset_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const results = await runSql<Record<string, unknown>>(query, [assetId]);
  return results[0] ? convertAlpha(results[0]) : null;
}

async function getFutureEvents(assetId: string): Promise<FutureEvent[]> {
  const query = `
    SELECT event_type, headline, probability, impact_score, sentiment_score
    FROM central.future_events
    WHERE asset_id = $1
    AND created_at >= NOW() - INTERVAL '12 hours'
    ORDER BY probability DESC
    LIMIT 5
  `;
  const results = await runSql<Record<string, unknown>>(query, [assetId]);
  return results.map(convertFutureEvent);
}

async function getAllAssets(): Promise<Asset[]> {
  const query = `
    SELECT id, ticker, name, asset_class, current_price, vreal, alpha_gap
    FROM central.assets
    WHERE current_price IS NOT NULL
  `;
  const results = await runSql<Record<string, unknown>>(query);
  return results.map(convertAsset);
}

async function insertCorrelations(
  assetId: string,
  assetName: string,
  correlations: Array<{
    ticker: string;
    name: string;
    correlation: number;
    stability: string;
    hedge_suitability: number;
    reasoning: string;
  }>,
  allAssets: Asset[]
): Promise<number> {
  if (correlations.length === 0) return 0;

  for (const c of correlations) {
    const targetAsset = allAssets.find(a => a.ticker === c.ticker || a.name === c.name);
    if (!targetAsset) {
      console.log(`  Warning: Asset ${c.ticker} not found in universe, skipping`);
      continue;
    }

    const query = `
      INSERT INTO central.correlations
        (asset_id_1, asset_name_1, asset_id_2, asset_name_2, correlation, stability, hedge_suitability, reasoning)
      VALUES ('${assetId}', '${assetName}', '${targetAsset.id}', '${targetAsset.name}', ${c.correlation}, '${c.stability}', ${c.hedge_suitability}, '${c.reasoning.replace(/'/g, "''")}')
      ON CONFLICT (asset_id_1, asset_id_2) DO UPDATE SET
        correlation = EXCLUDED.correlation,
        stability = EXCLUDED.stability,
        hedge_suitability = EXCLUDED.hedge_suitability,
        reasoning = EXCLUDED.reasoning,
        last_update = NOW()
    `;
    await runSql(query);
  }

  return correlations.filter(c => allAssets.find(a => a.ticker === c.ticker)).length;
}

async function updateAssetTradeInfo(
  assetId: string,
  metrics: {
    volatility_30d: number | null;
    atr_14d: number | null;
    liquidity_score: number;
    trend_strength: number;
    momentum_14d: number;
    data_recency: string | null;
  }
): Promise<void> {
  const escapeSql = (str: string | null): string => {
    if (str === null) return 'null';
    return `'${str.replace(/'/g, "''")}'`;
  };

  const query = `
    UPDATE central.assets
    SET 
      act_trademarket_informations = jsonb_build_object(
        'volatility_30d', ${metrics.volatility_30d !== null ? metrics.volatility_30d : 'null'},
        'atr_14d', ${metrics.atr_14d !== null ? metrics.atr_14d : 'null'},
        'liquidity_score', ${metrics.liquidity_score},
        'trend_strength', ${metrics.trend_strength},
        'momentum_14d', ${metrics.momentum_14d},
        'data_recency', ${escapeSql(metrics.data_recency)}
      ),
      l3_researched_at = NOW()
    WHERE id = '${assetId}'
  `;
  await runSql(query);
}

async function callGemini(prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function buildResearchPrompt(
  asset: Asset,
  alpha: Alpha,
  futureEvents: FutureEvent[],
  allAssets: Asset[]
): string {
  const currentPrice = asset.current_price || 100;
  const alphaGapPct = currentPrice > 0 ? ((alpha.alpha_gap / currentPrice) * 100).toFixed(1) : '0';

  const commodityAssets = allAssets.filter(a => a.asset_class === 'commodity' && a.id !== asset.id);
  const forexAssets = allAssets.filter(a => a.asset_class === 'forex' && a.id !== asset.id);

  const commodityList = commodityAssets
    .map(a => `- ${a.ticker} (${a.name}): $${a.current_price?.toFixed(2) || 'N/A'}`)
    .join('\n');

  const forexList = forexAssets
    .map(a => `- ${a.ticker} (${a.name}): ${a.current_price?.toFixed(4) || 'N/A'}`)
    .join('\n');

  const futureList = futureEvents
    .map(f => `- [${(f.probability * 100).toFixed(0)}%] ${f.headline} (impact: ${f.impact_score}/10)`)
    .join('\n');

  return `You are a quantitative trading strategist specializing in ${asset.asset_class} markets.
Your output feeds directly into an automated trade engine. Precision is critical.

═══════════════════════════════════════
TARGET ASSET
═══════════════════════════════════════
Name: ${asset.name} (${asset.ticker})
Class: ${asset.asset_class}
Price: $${currentPrice.toFixed(2)} (from database)
Vreal: $${alpha.vreal.toFixed(2)}
Alpha-Gap: ${alpha.alpha_gap >= 0 ? '+' : ''}${alpha.alpha_gap.toFixed(2)} (${alphaGapPct}%)
Confidence: ${(alpha.confidence * 100).toFixed(0)}%
Timeframe: ${alpha.timeframe}

═══════════════════════════════════════
CONTEXT: PREDICTED EVENTS (next ${alpha.timeframe})
═══════════════════════════════════════
${futureList || 'None available'}

═══════════════════════════════════════
ASSET UNIVERSE (use ONLY these for correlations)
═══════════════════════════════════════
Commodities:
${commodityList || 'None available'}

Forex:
${forexList || 'None available'}

═══════════════════════════════════════
YOUR TASK
═══════════════════════════════════════

PART 1 — CORRELATION ANALYSIS
Identify EXACTLY 3 assets from the universe above with the strongest 
absolute correlation to ${asset.ticker}.

Methodology requirements:
- Base analysis on 90-day rolling price correlation (real data — search if needed)
- Include positive AND negative correlations (absolute strength matters)
- Prioritize assets that remain liquid enough to hedge
- Consider how PREDICTED EVENTS above may alter correlation in the coming ${alpha.timeframe}

For each correlation, provide:
- ticker & name (must match universe exactly)
- correlation coefficient (-1.0 to 1.0)
- stability ("stable" | "moderate" | "unstable") over the last 12 months
- hedge_suitability (1-10): combines correlation strength + liquidity + cost
- reasoning (max 2 sentences: WHY is this asset correlated?)

PART 2 — TRADING METRICS (live market data)
Research and report current market conditions for ${asset.ticker}.
Use real-time data. Do NOT guess — if data is unavailable, return null.

- volatility_30d: annualized realized volatility, % (null if unknown)
- atr_14d: Average True Range over 14 days, in price units (null if unknown)
- liquidity_score: 1-10 (10 = tight spreads, deep book, major venue)
- trend_strength: -10 to +10 (signed; magnitude = conviction)
- momentum_14d: -10 to +10 (recent 14-day price action)
- data_recency: timestamp of the most recent data point you used (ISO 8601)

═══════════════════════════════════════
OUTPUT FORMAT (strict JSON, no markdown)
═══════════════════════════════════════
{
  "correlations": [
    {
      "ticker": "BRENT",
      "name": "Crude Oil Brent",
      "correlation": 0.92,
      "stability": "stable",
      "hedge_suitability": 9,
      "reasoning": "Both are crude benchmarks responding to OPEC supply decisions and global demand. Spread has tightened post-2023."
    }
  ],
  "trading_metrics": {
    "volatility_30d": 28.4,
    "atr_14d": 1.82,
    "liquidity_score": 9,
    "trend_strength": 3,
    "momentum_14d": 2,
    "data_recency": "2026-04-19T14:00:00Z"
  }
}

HARD CONSTRAINTS:
- Return EXACTLY 3 correlations, sorted by hedge_suitability DESC
- Correlation values ∈ [-1.0, 1.0]; all scores ∈ [1, 10] or [-10, 10] as defined
- Tickers MUST exist in the Asset Universe above
- If live data cannot be retrieved, return null for that field — NEVER guess
- Respond with JSON only. No prose, no markdown, no comments.`;
}

function parseGeminiResponse(response: string): {
  correlations: Array<{
    ticker: string;
    name: string;
    correlation: number;
    stability: string;
    hedge_suitability: number;
    reasoning: string;
  }>;
  trading_metrics: {
    volatility_30d: number | null;
    atr_14d: number | null;
    liquidity_score: number;
    trend_strength: number;
    momentum_14d: number;
    data_recency: string | null;
  };
} {
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      const correlations = (parsed.correlations || []).slice(0, 3).map((c: any) => ({
        ticker: c.ticker || c.asset_ticker || '',
        name: c.name || c.asset_name || '',
        correlation: Math.max(-1, Math.min(1, parseFloat(c.correlation) || 0)),
        stability: ['stable', 'moderate', 'unstable'].includes(c.stability) ? c.stability : 'moderate',
        hedge_suitability: Math.max(1, Math.min(10, parseInt(c.hedge_suitability) || 5)),
        reasoning: c.reasoning || '',
      }));

      const metrics = parsed.trading_metrics || {};
      const trading_metrics = {
        volatility_30d: metrics.volatility_30d !== null ? parseFloat(metrics.volatility_30d) || null : null,
        atr_14d: metrics.atr_14d !== null ? parseFloat(metrics.atr_14d) || null : null,
        liquidity_score: Math.max(1, Math.min(10, parseInt(metrics.liquidity_score) || 5)),
        trend_strength: Math.max(-10, Math.min(10, parseInt(metrics.trend_strength) || 0)),
        momentum_14d: Math.max(-10, Math.min(10, parseInt(metrics.momentum_14d) || 0)),
        data_recency: metrics.data_recency || null,
      };

      return { correlations, trading_metrics };
    }

    return {
      correlations: [],
      trading_metrics: { volatility_30d: null, atr_14d: null, liquidity_score: 5, trend_strength: 0, momentum_14d: 0, data_recency: null },
    };
  } catch (e) {
    console.error('Failed to parse Gemini response:', e);
    return {
      correlations: [],
      trading_metrics: { volatility_30d: null, atr_14d: null, liquidity_score: 5, trend_strength: 0, momentum_14d: 0, data_recency: null },
    };
  }
}

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ correlations: number; success: boolean }> {
  console.log(`\n[${assetName}] Researching...`);

  const asset = await getAsset(assetId);
  if (!asset) {
    console.error(`  Asset not found`);
    return { correlations: 0, success: false };
  }

  const alpha = await getLatestAlpha(assetId);
  if (!alpha) {
    console.log(`  No alpha found, skipping`);
    return { correlations: 0, success: false };
  }

  const futureEvents = await getFutureEvents(assetId);
  const allAssets = await getAllAssets();

  console.log(`  Alpha gap: ${alpha.alpha_gap >= 0 ? '+' : ''}${alpha.alpha_gap.toFixed(2)}`);
  console.log(`  Future events: ${futureEvents.length}`);
  console.log(`  Available assets for correlation: ${allAssets.length - 1}`);

  const prompt = buildResearchPrompt(asset, alpha, futureEvents, allAssets);
  
  let response: string;
  try {
    response = await callGemini(prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  Gemini error: ${msg}`);
    return { correlations: 0, success: false };
  }

  console.log(`  Gemini response length: ${response.length}`);
  
  const analysis = parseGeminiResponse(response);
  console.log(`  Found ${analysis.correlations.length} correlations`);
  console.log(`  Volatility 30d: ${analysis.trading_metrics.volatility_30d?.toFixed(1) || 'N/A'}%`);
  console.log(`  ATR 14d: ${analysis.trading_metrics.atr_14d?.toFixed(2) || 'N/A'}`);
  console.log(`  Trend: ${analysis.trading_metrics.trend_strength}`);

  // Insert correlations
  if (analysis.correlations.length > 0) {
    const inserted = await insertCorrelations(assetId, assetName, analysis.correlations, allAssets);
    console.log(`  Inserted ${inserted} correlations`);
    analysis.correlations.forEach(c => {
      console.log(`    - ${c.ticker}: ${c.correlation.toFixed(2)} (${c.stability}, hedge: ${c.hedge_suitability}/10)`);
    });
  }

  // Update asset trade info
  await updateAssetTradeInfo(assetId, analysis.trading_metrics);
  console.log(`  Updated trading metrics`);

  return { correlations: analysis.correlations.length, success: true };
}

async function research() {
  console.log('=== VECTX V3 - Layer 3 Research ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const assets = await getAssetsForResearch();
  console.log(`Found ${assets.length} assets ready for Layer 3 research`);

  if (assets.length === 0) {
    console.log('No assets ready. Run Layer 3 Collect first.');
    return { correlations: 0, errors: 0 };
  }

  let totalCorrelations = 0;
  let totalErrors = 0;

  for (const { asset_id, asset_name } of assets) {
    const result = await processAsset(asset_id, asset_name);
    totalCorrelations += result.correlations;
    if (!result.success) totalErrors++;
  }

  console.log('\n=== Summary ===');
  console.log(`Correlations found: ${totalCorrelations}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { correlations: totalCorrelations, errors: totalErrors };
}

research().catch(console.error);
