/**
 * VECTX V3 - Layer 2 Research Script
 * 
 * Takes processed events and drivers, creates future_events
 * Updates driver weightings based on current events
 * Uses Gemini 3.0 Pro for analysis
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
}

interface Driver {
  id: string;
  asset_id: string;
  driver_name: string;
  description: string;
  supply_or_demand: string;
  quantitative_or_qualitative: string;
  impact_score: number | null;
  act_weighting: number | null;
}

interface Event {
  id: string;
  asset_id: string;
  asset_name: string;
  event_type: string;
  headline: string;
  summary: string;
  impact_score: number;
  sentiment_score: number;
  quantitative_or_qualitative: string;
  supply_or_demand: string;
  timeline_score: number;
  driver_name: string;
  created_at: string;
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

async function getAssetsForResearch(): Promise<{ asset_id: string; asset_name: string }[]> {
  let query = `
    SELECT DISTINCT 
      e.asset_id,
      e.asset_name
    FROM central.events e
    WHERE e.l2_processed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM central.future_events fe 
      WHERE fe.asset_id = e.asset_id 
      AND fe.created_at >= NOW() - INTERVAL '2 hours'
    )
    ORDER BY e.asset_name
  `;

  let results = await runSql<{ asset_id: string; asset_name: string }>(query);
  
  if (BATCH_ASSETS) {
    results = results.filter(r => BATCH_ASSETS.includes(r.asset_name));
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
  }
  
  return results;
}

async function getAsset(assetId: string): Promise<Asset | null> {
  const query = `SELECT id, ticker, name, asset_class, current_price FROM central.assets WHERE id = $1`;
  const results = await runSql<Asset>(query, [assetId]);
  return results[0] || null;
}

async function getDrivers(assetId: string): Promise<Driver[]> {
  const query = `
    SELECT id, asset_id, driver_name, description, supply_or_demand, 
           quantitative_or_qualitative, impact_score, act_weighting
    FROM central.drivers
    WHERE asset_id = $1
    ORDER BY driver_name
  `;
  return runSql<Driver>(query, [assetId]);
}

async function getProcessedEvents(assetId: string): Promise<Event[]> {
  const query = `
    SELECT 
      id, asset_id, asset_name, event_type, headline, summary,
      impact_score, sentiment_score, quantitative_or_qualitative,
      supply_or_demand, timeline_score, driver_name, created_at
    FROM central.events
    WHERE asset_id = $1
    AND l2_processed_at IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 30
  `;
  return runSql<Event>(query, [assetId]);
}

async function insertFutureEvents(
  assetId: string,
  events: Array<{
    event_type: string;
    headline: string;
    summary: string;
    impact_score: number;
    sentiment_score: number;
    probability: number;
    timeline_score: number;
    driver_name: string;
  }>
): Promise<number> {
  if (events.length === 0) return 0;

  const escapeSql = (str: string | null): string => {
    if (!str) return 'null';
    return `'${str.replace(/'/g, "''")}'`;
  };

  for (const event of events) {
    const query = `
      INSERT INTO central.future_events 
        (asset_id, event_type, headline, summary, impact_score, sentiment_score,
         probability, timeline_score, driver_name)
      VALUES (
        '${assetId}',
        ${escapeSql(event.event_type)},
        ${escapeSql(event.headline)},
        ${escapeSql(event.summary)},
        ${event.impact_score},
        ${event.sentiment_score},
        ${event.probability},
        ${event.timeline_score},
        ${escapeSql(event.driver_name)}
      )
    `;
    await runSql(query);
  }

  return events.length;
}

async function updateDriverWeightings(
  assetId: string,
  weightings: Array<{ driver_name: string; weighting: number }>
): Promise<void> {
  for (const w of weightings) {
    const escapeSql = (str: string): string => {
      return `'${str.replace(/'/g, "''")}'`;
    };
    const query = `
      UPDATE central.drivers
      SET act_weighting = ${w.weighting}
      WHERE asset_id = '${assetId}'
      AND driver_name = ${escapeSql(w.driver_name)}
    `;
    await runSql(query);
  }
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
  drivers: Driver[],
  events: Event[]
): string {
  const driverList = drivers
    .map(d => `- ${d.driver_name} (${d.supply_or_demand}, ${d.quantitative_or_qualitative}): ${d.description || 'No description'}`)
    .join('\n');

  const eventList = events
    .slice(0, 25)
    .map(e => {
      const sentiment = e.sentiment_score >= 0 ? `+${e.sentiment_score.toFixed(1)}` : e.sentiment_score.toFixed(1);
      return `- [${e.driver_name}] (${e.impact_score}/10, ${sentiment}) ${e.headline}\n  ${e.summary}`;
    })
    .join('\n');

  return `You are a quantitative financial analyst specializing in ${asset.asset_class} markets.

ASSET: ${asset.name} (${asset.ticker})
CURRENT PRICE: ${asset.current_price || 'Unknown'}
CLASS: ${asset.asset_class}

REGISTERED DRIVERS:
${driverList}

CURRENT EVENTS (from Layer 1):
${eventList}

TASK: Create a forward-looking analysis for ${asset.ticker}.

PART 1 - DRIVER WEIGHTINGS:
Analyze which drivers are most active right now based on current events.
Assign weightings to each driver (0.0 to 1.0, sum should equal 1.0).
More events + higher impact = higher weighting.

PART 2 - FUTURE EVENTS:
Based on current events, predict 3-5 FUTURE developments that could occur.
These are NOT current events, but likely developments based on current trajectory.
Each must have a probability (0.0 to 1.0).

Respond in JSON format:
{
  "driver_weightings": [
    { "driver_name": "Geopolitical Tensions", "weighting": 0.35 },
    { "driver_name": "OPEC Production Decisions", "weighting": 0.25 }
  ],
  "future_events": [
    {
      "event_type": "supply_shock",
      "headline": "OPEC announces voluntary production cuts",
      "summary": "Saudi Arabia and allies agree to extend production cuts into Q2",
      "impact_score": 8,
      "sentiment_score": 0.7,
      "probability": 0.65,
      "timeline_score": 3,
      "driver_name": "OPEC Production Decisions"
    }
  ]
}

IMPORTANT:
- Driver names MUST match exactly from the registered drivers list
- Weightings must sum to ~1.0
- Future events are predictions, not current events
- Probability represents likelihood of this scenario occurring

Respond ONLY with valid JSON. No markdown, no explanation.`;
}

function parseGeminiResponse(response: string): {
  driver_weightings: Array<{ driver_name: string; weighting: number }>;
  future_events: Array<{
    event_type: string;
    headline: string;
    summary: string;
    impact_score: number;
    sentiment_score: number;
    probability: number;
    timeline_score: number;
    driver_name: string;
  }>;
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
      return {
        driver_weightings: parsed.driver_weightings || [],
        future_events: parsed.future_events || [],
      };
    }

    return { driver_weightings: [], future_events: [] };
  } catch (e) {
    console.error('Failed to parse Gemini response:', e);
    return { driver_weightings: [], future_events: [] };
  }
}

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ weightings: number; futureEvents: number; errors: number }> {
  console.log(`\n[${assetName}] Researching...`);

  const asset = await getAsset(assetId);
  if (!asset) {
    console.error(`  Asset not found`);
    return { weightings: 0, futureEvents: 0, errors: 1 };
  }

  const drivers = await getDrivers(assetId);
  console.log(`  Drivers: ${drivers.length}`);

  const events = await getProcessedEvents(assetId);
  console.log(`  Processed events: ${events.length}`);

  if (events.length < 3) {
    console.log(`  Skipping: Not enough processed events`);
    return { weightings: 0, futureEvents: 0, errors: 0 };
  }

  const prompt = buildResearchPrompt(asset, drivers, events);
  
  let response: string;
  try {
    response = await callGemini(prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  Gemini error: ${msg}`);
    return { weightings: 0, futureEvents: 0, errors: 1 };
  }

  console.log(`  Gemini response length: ${response.length}`);
  
  const analysis = parseGeminiResponse(response);
  console.log(`  Parsed ${analysis.driver_weightings.length} weightings, ${analysis.future_events.length} future events`);

  // Update driver weightings
  if (analysis.driver_weightings.length > 0) {
    await updateDriverWeightings(assetId, analysis.driver_weightings);
    console.log(`  Updated ${analysis.driver_weightings.length} driver weightings`);
  }

  // Insert future events
  if (analysis.future_events.length > 0) {
    const inserted = await insertFutureEvents(assetId, analysis.future_events);
    console.log(`  Inserted ${inserted} future events`);
  }

  return {
    weightings: analysis.driver_weightings.length,
    futureEvents: analysis.future_events.length,
    errors: 0,
  };
}

async function research() {
  console.log('=== VECTX V3 - Layer 2 Research ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const assets = await getAssetsForResearch();
  console.log(`Found ${assets.length} assets ready for Layer 2 research`);

  if (assets.length === 0) {
    console.log('No assets ready. Run Layer 2 Collect first.');
    return { weightings: 0, futureEvents: 0, errors: 0 };
  }

  let totalWeightings = 0;
  let totalFutureEvents = 0;
  let totalErrors = 0;

  for (const { asset_id, asset_name } of assets) {
    const result = await processAsset(asset_id, asset_name);
    totalWeightings += result.weightings;
    totalFutureEvents += result.futureEvents;
    totalErrors += result.errors;
  }

  console.log('\n=== Summary ===');
  console.log(`Driver weightings updated: ${totalWeightings}`);
  console.log(`Future events created: ${totalFutureEvents}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { weightings: totalWeightings, futureEvents: totalFutureEvents, errors: totalErrors };
}

research().catch(console.error);