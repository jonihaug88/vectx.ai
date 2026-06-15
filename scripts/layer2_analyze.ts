/**
 * VECTX V3 - Layer 2 Analyze Script
 * 
 * Takes events, future_events, and asset data
 * Calculates vreal (intrinsic value) and alpha_gap
 * Uses GLM-5 for analysis
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
const OLLAMA_BASE_URL = config.ollama_cloud.base_url;
const OLLAMA_API_KEY = config.ollama_cloud.api_key;
const OLLAMA_MODEL = config.ollama_cloud.model;

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

interface Driver {
  id: string;
  driver_name: string;
  description: string;
  supply_or_demand: string;
  act_weighting: number | null;
}

interface Event {
  id: string;
  event_type: string;
  headline: string;
  summary: string;
  impact_score: number;
  sentiment_score: number;
  timeline_score: number;
  driver_name: string;
}

interface FutureEvent {
  id: string;
  event_type: string;
  headline: string;
  summary: string;
  impact_score: number;
  sentiment_score: number;
  probability: number;
  timeline_score: number;
  driver_name: string;
}

interface AlphaResult {
  vreal: number;
  alpha_gap: number;
  confidence: number;
  reasoning: string;
  timeframe: string;
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

async function getAssetsForAnalyze(): Promise<{ asset_id: string; asset_name: string }[]> {
  let query = `
    SELECT DISTINCT 
      a.id as asset_id,
      a.name as asset_name
    FROM central.assets a
    WHERE EXISTS (
      SELECT 1 FROM central.future_events fe WHERE fe.asset_id = a.id
      AND fe.created_at >= NOW() - INTERVAL '48 hours'
    )
    ORDER BY a.name
  `;

  let results = await runSql<{ asset_id: string; asset_name: string }>(query);
  
  if (BATCH_ASSETS) {
    results = results.filter(r => BATCH_ASSETS.includes(r.asset_name));
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
  const results = await runSql<Asset>(query, [assetId]);
  return results[0] || null;
}

async function getDrivers(assetId: string): Promise<Driver[]> {
  const query = `
    SELECT id, driver_name, description, supply_or_demand, act_weighting
    FROM central.drivers
    WHERE asset_id = $1
    ORDER BY act_weighting DESC NULLS LAST
  `;
  return runSql<Driver>(query, [assetId]);
}

async function getRecentEvents(assetId: string): Promise<Event[]> {
  const query = `
    SELECT id, event_type, headline, summary, impact_score, sentiment_score, timeline_score, driver_name
    FROM central.events
    WHERE asset_id = $1
    ORDER BY created_at DESC
    LIMIT 20
  `;
  return runSql<Event>(query, [assetId]);
}

async function getFutureEvents(assetId: string): Promise<FutureEvent[]> {
  const query = `
    SELECT id, event_type, headline, summary, impact_score, sentiment_score, probability, timeline_score, driver_name
    FROM central.future_events
    WHERE asset_id = $1
    AND created_at >= NOW() - INTERVAL '48 hours'
    ORDER BY probability DESC, impact_score DESC
    LIMIT 10
  `;
  return runSql<FutureEvent>(query, [assetId]);
}

async function insertAlpha(
  assetId: string,
  result: AlphaResult,
  eventId: string | null = null
): Promise<void> {
  const escapeSql = (str: string): string => {
    return `'${str.replace(/'/g, "''")}'`;
  };

  const query = `
    INSERT INTO central.alpha
      (asset_id, vreal, alpha_gap, confidence, reasoning, timeframe)
    VALUES (
      '${assetId}',
      ${result.vreal},
      ${result.alpha_gap},
      ${result.confidence},
      ${escapeSql(result.reasoning)},
      ${escapeSql(result.timeframe)}
    )
  `;
  await runSql(query);
}

async function updateAssetAlpha(
  assetId: string,
  vreal: number,
  alphaGap: number
): Promise<void> {
  const query = `
    UPDATE central.assets
    SET vreal = ${vreal}, alpha_gap = ${alphaGap}, last_calculation = NOW()
    WHERE id = '${assetId}'
  `;
  await runSql(query);
}

async function callGLM5(prompt: string): Promise<string> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OLLAMA_API_KEY}`,
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: {
        temperature: 0.2,
        num_predict: 4096,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GLM-5 error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  return data.message?.content || '';
}

function buildAnalyzePrompt(
  asset: Asset,
  drivers: Driver[],
  events: Event[],
  futureEvents: FutureEvent[]
): string {
  const currentPrice = Number(asset.current_price) || 100; // Default if unknown

  const driverList = drivers
    .map(d => {
      const weightVal = Number(d.act_weighting);
      const weight = d.act_weighting ? ` (weight: ${(weightVal * 100).toFixed(0)}%)` : '';
      return `- ${d.driver_name}${weight}: ${d.description || 'No description'} [${d.supply_or_demand}]`;
    })
    .join('\n');

  const eventList = events
    .slice(0, 15)
    .map(e => {
      const sentVal = Number(e.sentiment_score) || 0;
      const sentiment = sentVal >= 0 ? `+${sentVal.toFixed(1)}` : sentVal.toFixed(1);
      const impact = `(${e.impact_score}/10, ${sentiment})`;
      return `- ${impact} ${e.headline}\n  ${e.summary}`;
    })
    .join('\n');

  const futureList = futureEvents
    .map(f => {
      const prob = `(prob: ${(Number(f.probability) * 100 || 0).toFixed(0)}%)`;
      const sentVal = Number(f.sentiment_score) || 0;
      const sentiment = sentVal >= 0 ? `+${sentVal.toFixed(1)}` : sentVal.toFixed(1);
      return `- ${prob} [${f.event_type}] (${f.impact_score}/10, ${sentiment}) ${f.headline}`;
    })
    .join('\n');

  return `You are a quantitative financial analyst specializing in ${asset.asset_class} markets.

ASSET: ${asset.name} (${asset.ticker})
CURRENT PRICE: $${currentPrice.toFixed(2)}
CLASS: ${asset.asset_class}

ACTIVE DRIVERS (weighted by current relevance):
${driverList}

CURRENT EVENTS:
${eventList}

PREDICTED FUTURE EVENTS:
${futureList}

TASK: Calculate the INTRINSIC VALUE (vreal) and ALPHA GAP for ${asset.ticker}.

vreal = The "true" value of ${asset.ticker} based on all fundamentals, events, and future expectations.
alpha_gap = vreal - current_price (positive = undervalued, negative = overvalued)

Consider:
1. Driver weightings - which factors matter most right now
2. Current events - immediate price pressures
3. Future events - expected developments and their probabilities
4. Supply/demand balance across all drivers
5. Timeline of impacts (immediate vs long-term)

Respond in JSON format:
{
  "vreal": 85.50,
  "alpha_gap": 5.50,
  "confidence": 0.75,
  "reasoning": "Geopolitical tensions in Middle East creating supply concerns (weight: 35%). OPEC+ production cuts supporting prices. Strong demand from Asia. Future events suggest 65% probability of continued supply constraints.",
  "timeframe": "2-4 weeks"
}

IMPORTANT:
- vreal should be a realistic price, not extreme
- alpha_gap = vreal - current_price (${currentPrice.toFixed(2)})
- confidence: 0.0 (very uncertain) to 1.0 (highly confident)
- timeframe: When this valuation becomes relevant (e.g., "1-2 weeks", "1-3 months")

Respond ONLY with valid JSON. No markdown, no explanation.`;
}

function parseGLMResponse(response: string): AlphaResult | null {
  try {
    let cleaned = response.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        vreal: parseFloat(parsed.vreal) || 0,
        alpha_gap: parseFloat(parsed.alpha_gap) || 0,
        confidence: parseFloat(parsed.confidence) || 0.5,
        reasoning: parsed.reasoning || 'No reasoning provided',
        timeframe: parsed.timeframe || 'Unknown',
      };
    }

    return null;
  } catch (e) {
    console.error('Failed to parse GLM response:', e);
    return null;
  }
}

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ success: boolean; vreal: number; alphaGap: number }> {
  console.log(`\n[${assetName}] Analyzing...`);

  const asset = await getAsset(assetId);
  if (!asset) {
    console.error(`  Asset not found`);
    return { success: false, vreal: 0, alphaGap: 0 };
  }

  const drivers = await getDrivers(assetId);
  console.log(`  Drivers: ${drivers.length}`);

  const events = await getRecentEvents(assetId);
  console.log(`  Recent events: ${events.length}`);

  const futureEvents = await getFutureEvents(assetId);
  console.log(`  Future events: ${futureEvents.length}`);

  if (futureEvents.length === 0) {
    console.log(`  Skipping: No future events (run Layer 2 Research first)`);
    return { success: false, vreal: 0, alphaGap: 0 };
  }

  const prompt = buildAnalyzePrompt(asset, drivers, events, futureEvents);
  
  let response: string;
  try {
    response = await callGLM5(prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  GLM-5 error: ${msg}`);
    return { success: false, vreal: 0, alphaGap: 0 };
  }

  console.log(`  GLM response length: ${response.length}`);
  
  const result = parseGLMResponse(response);
  if (!result) {
    console.error(`  Failed to parse alpha result`);
    return { success: false, vreal: 0, alphaGap: 0 };
  }

  console.log(`  vreal: $${result.vreal.toFixed(2)}`);
  console.log(`  alpha_gap: ${result.alpha_gap >= 0 ? '+' : ''}${result.alpha_gap.toFixed(2)}`);
  console.log(`  confidence: ${(result.confidence * 100).toFixed(0)}%`);
  console.log(`  timeframe: ${result.timeframe}`);

  // Insert alpha record
  await insertAlpha(assetId, result);
  console.log(`  Inserted alpha record`);

  // Update asset
  await updateAssetAlpha(assetId, result.vreal, result.alpha_gap);
  console.log(`  Updated asset vreal/alpha_gap`);

  return { success: true, vreal: result.vreal, alphaGap: result.alpha_gap };
}

async function analyze() {
  console.log('=== VECTX V3 - Layer 2 Analyze ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log('');

  const assets = await getAssetsForAnalyze();
  console.log(`Found ${assets.length} assets ready for Layer 2 analysis`);

  if (assets.length === 0) {
    console.log('No assets ready. Run Layer 2 Research first.');
    return { processed: 0, errors: 0 };
  }

  let totalProcessed = 0;
  let totalErrors = 0;

  for (const { asset_id, asset_name } of assets) {
    const result = await processAsset(asset_id, asset_name);
    if (result.success) {
      totalProcessed++;
    } else {
      totalErrors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Assets analyzed: ${totalProcessed}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { processed: totalProcessed, errors: totalErrors };
}

analyze().catch(console.error);