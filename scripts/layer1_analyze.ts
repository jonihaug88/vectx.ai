/**
 * VECTX V3 - Layer 1 Analyze Script
 * 
 * Takes research_events and drivers_events, analyzes with GLM-5
 * Creates final events in central.events table
 * 
 * Trigger: When ≥5 drivers_events AND ≥1 research_events per Asset
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

interface DriverEvent {
  id: string;
  asset_id: string;
  asset_name: string;
  driver_id: string;
  driver_name: string;
  headline: string;
  output: string;
}

interface ResearchEvent {
  id: string;
  asset_id: string;
  asset_name: string;
  headline: string;
  summary: string;
  existing_driver: string | null;
  new_driver: string | null;
  new_source: string | null;
}

interface Driver {
  id: string;
  asset_id: string;
  driver_name: string;
  description: string;
  supply_or_demand: string;
  quantitative_or_qualitative: string;
}

interface Asset {
  id: string;
  ticker: string;
  name: string;
  asset_class: string;
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

async function getAssetsReadyForAnalyze(): Promise<{ asset_id: string; asset_name: string; driver_events: string; research_events: string }[]> {
  let query = `
    SELECT 
      de.asset_id,
      de.asset_name,
      COUNT(DISTINCT de.id)::text as driver_events,
      COUNT(DISTINCT re.id)::text as research_events
    FROM central.drivers_events de
    LEFT JOIN central.research_events re ON re.asset_id = de.asset_id
    LEFT JOIN central.events e ON e.asset_id = de.asset_id AND e.headline = de.headline
    WHERE e.id IS NULL
    GROUP BY de.asset_id, de.asset_name
    HAVING COUNT(DISTINCT de.id) >= 5
    ORDER BY COUNT(DISTINCT re.id) DESC
  `;
  
  let results = await runSql<{ asset_id: string; asset_name: string; driver_events: string; research_events: string }>(query);
  
  if (BATCH_ASSETS) {
    results = results.filter(r => BATCH_ASSETS.includes(r.asset_name));
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
  }
  
  return results;
}

async function getDriverEvents(assetId: string, limit: number = 20): Promise<DriverEvent[]> {
  const query = `
    SELECT id, asset_id, asset_name, driver_id, driver_name, headline, output
    FROM central.drivers_events
    WHERE asset_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `;
  return runSql<DriverEvent>(query, [assetId, limit]);
}

async function getResearchEvents(assetId: string, limit: number = 20): Promise<ResearchEvent[]> {
  const query = `
    SELECT id, asset_id, asset_name, headline, summary, existing_driver, new_driver, new_source
    FROM central.research_events
    WHERE asset_id = $1
    ORDER BY created_at DESC
    LIMIT $2
  `;
  return runSql<ResearchEvent>(query, [assetId, limit]);
}

async function getAssetDrivers(assetId: string): Promise<Driver[]> {
  const query = `
    SELECT id, asset_id, driver_name, description, supply_or_demand, quantitative_or_qualitative
    FROM central.drivers
    WHERE asset_id = $1
  `;
  return runSql<Driver>(query, [assetId]);
}

async function getAssetInfo(assetId: string): Promise<Asset | null> {
  const query = `SELECT id, ticker, name, asset_class FROM central.assets WHERE id = $1`;
  const results = await runSql<Asset>(query, [assetId]);
  return results[0] || null;
}

async function insertEvent(event: {
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
}): Promise<void> {
  const escapeSql = (str: string | null): string => {
    if (!str) return 'null';
    return `'${str.replace(/'/g, "''").replace(/"/g, '\\"')}'`;
  };

  const query = `
    INSERT INTO central.events 
      (asset_id, asset_name, event_type, headline, summary, impact_score, sentiment_score,
       quantitative_or_qualitative, supply_or_demand, timeline_score, driver_name)
    VALUES (
      '${event.asset_id}',
      '${event.asset_name}',
      ${escapeSql(event.event_type)},
      ${escapeSql(event.headline)},
      ${escapeSql(event.summary)},
      ${event.impact_score},
      ${event.sentiment_score},
      ${escapeSql(event.quantitative_or_qualitative)},
      ${escapeSql(event.supply_or_demand)},
      ${event.timeline_score},
      ${escapeSql(event.driver_name)}
    )
  `;
  await runSql(query);
}

async function callGLM5(prompt: string, retries: number = 3): Promise<string> {
  const TIMEOUT_MS = 90000; // 90 second timeout
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
      
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
            temperature: 0.3,
            num_predict: 4096,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GLM-5 error: ${response.status} - ${text}`);
      }

      const data = await response.json();
      const content = data.message?.content || '';
      
      // Retry if empty response
      if (content.length < 100 && attempt < retries) {
        console.log(`  Empty response (attempt ${attempt}/${retries}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        continue;
      }
      
      return content;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < retries) {
        console.log(`  GLM-5 call failed: ${msg.substring(0, 50)} (attempt ${attempt}/${retries}), retrying...`);
        await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
      } else {
        throw error;
      }
    }
  }
  return '';
}

function buildAnalyzePrompt(
  asset: Asset,
  drivers: Driver[],
  driverEvents: DriverEvent[],
  researchEvents: ResearchEvent[]
): string {
  const driverList = drivers
    .map(d => `- ${d.driver_name}: ${d.description || 'No description'} (${d.supply_or_demand}, ${d.quantitative_or_qualitative})`)
    .join('\n');

  const driverEventsList = driverEvents
    .slice(0, 10)
    .map(e => `- [${e.driver_name}] ${e.headline}`)
    .join('\n');

  const researchEventsList = researchEvents
    .slice(0, 8)
    .map(e => {
      const driverInfo = e.existing_driver ? ` (${e.existing_driver})` : e.new_driver ? ' (NEW)' : '';
      return `- ${e.headline}${driverInfo}`;
    })
    .join('\n');

  return `You are a quantitative financial analyst specializing in ${asset.asset_class} markets.

ASSET: ${asset.name} (${asset.ticker})
CLASS: ${asset.asset_class}

REGISTERED DRIVERS:
${driverList}

RSS EVENTS (from configured feeds):
${driverEventsList}

WEB RESEARCH EVENTS (news not covered by RSS):
${researchEventsList}

TASK: Analyze ALL events and create FINAL scored events for the central.events table.

For the TOP 3-5 most significant events (from both sources), provide:
1. event_type: "price_signal" | "supply_shock" | "demand_shift" | "geopolitical" | "macro" | "sentiment"
2. headline: The original headline (keep exact)
3. summary: Why this matters for ${asset.ticker} price (1-2 sentences)
4. impact_score: 1-10 (10 = critical, market-moving event)
5. sentiment_score: -1.0 to 1.0 (-1 = very bearish, 0 = neutral, 1 = very bullish for ${asset.ticker})
6. quantitative_or_qualitative: "quantitative" | "qualitative" | "both"
7. supply_or_demand: "supply" | "demand" | "both"
8. timeline_score: 1-5 (1 = immediate impact within days, 5 = long-term over months)
9. driver_name: Which registered driver this relates to (must match a driver from the list)

PRIORITIZE: 
- Events from web research (these are gaps in RSS coverage)
- High-impact events (geopolitical, supply disruptions)
- Events that would move ${asset.ticker} price

Respond in JSON format:
{
  "events": [
    {
      "event_type": "geopolitical",
      "headline": "Iran closes Strait of Hormuz",
      "summary": "Critical supply disruption affecting 20% of global oil flows. Immediate bullish for oil prices.",
      "impact_score": 10,
      "sentiment_score": 0.8,
      "quantitative_or_qualitative": "both",
      "supply_or_demand": "supply",
      "timeline_score": 1,
      "driver_name": "Geopolitical Tensions and Conflict Risk"
    }
  ]
}

Respond ONLY with valid JSON. No markdown, no explanation.`;
}

function parseGLMResponse(response: string): {
  events: Array<{
    event_type: string;
    headline: string;
    summary: string;
    impact_score: number;
    sentiment_score: number;
    quantitative_or_qualitative: string;
    supply_or_demand: string;
    timeline_score: number;
    driver_name: string;
  }>;
} {
  try {
    let cleaned = response.trim();
    // Remove markdown code blocks
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();
    
    // Try to find JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.events && Array.isArray(parsed.events)) {
          return parsed;
        }
      } catch (parseError) {
        // JSON is malformed, try to extract events individually
        console.log('  Malformed JSON, attempting event extraction...');
      }
    }
    
    // Extract individual event objects using regex
    const eventRegex = /\{\s*"event_type"\s*:\s*"[^"]*"\s*,\s*"headline"\s*:\s*"[^"]*"\s*,\s*"summary"\s*:\s*"[^"]*"\s*,\s*"impact_score"\s*:\s*\d+\s*,\s*"sentiment_score"\s*:\s*-?[\d.]+\s*,\s*"quantitative_or_qualitative"\s*:\s*"[^"]*"\s*,\s*"supply_or_demand"\s*:\s*"[^"]*"\s*,\s*"timeline_score"\s*:\s*\d+\s*,\s*"driver_name"\s*:\s*"[^"]*"\s*\}/g;
    
    const eventMatches = cleaned.match(eventRegex) || [];
    if (eventMatches.length > 0) {
      const events = eventMatches.map(match => {
        try {
          return JSON.parse(match);
        } catch {
          return null;
        }
      }).filter((e): e is NonNullable<typeof e> => e !== null);
      
      if (events.length > 0) {
        console.log(`  Recovered ${events.length} events from malformed JSON`);
        return { events };
      }
    }
    
    // Try to extract events array directly
    const eventsMatch = cleaned.match(/"events"\s*:\s*\[[\s\S]*\]/);
    if (eventsMatch) {
      const eventsJson = '{' + eventsMatch[0] + '}';
      const parsed = JSON.parse(eventsJson);
      return { events: parsed.events || [] };
    }
    
    console.error('No valid JSON found in response');
    return { events: [] };
  } catch (e) {
    console.error('Failed to parse GLM response:', e);
    return { events: [] };
  }
}

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ processed: number; errors: number }> {
  console.log(`\n[${assetName}] Analyzing...`);

  const asset = await getAssetInfo(assetId);
  if (!asset) {
    console.error(`  Asset not found`);
    return { processed: 0, errors: 1 };
  }

  const drivers = await getAssetDrivers(assetId);
  console.log(`  Drivers: ${drivers.length}`);

  const driverEvents = await getDriverEvents(assetId, 20);
  console.log(`  Driver events: ${driverEvents.length}`);

  const researchEvents = await getResearchEvents(assetId, 20);
  console.log(`  Research events: ${researchEvents.length}`);

  if (driverEvents.length < 5) {
    console.log(`  Skipping: Not enough driver events`);
    return { processed: 0, errors: 0 };
  }

  const prompt = buildAnalyzePrompt(asset, drivers, driverEvents, researchEvents);
  
  let response: string;
  try {
    response = await callGLM5(prompt);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`  GLM-5 error: ${msg}`);
    return { processed: 0, errors: 1 };
  }

  console.log(`  GLM response length: ${response.length}`);
  if (response.length < 500) {
    console.log(`  GLM response (truncated): ${response.substring(0, 200)}`);
  }
  
  const analysis = parseGLMResponse(response);
  console.log(`  Parsed ${analysis.events.length} events`);

  for (const event of analysis.events) {
    try {
      const impactScore = Math.min(Math.max(event.impact_score, 1), 10);
      const sentimentScore = Math.min(Math.max(event.sentiment_score, -1), 1);
      const timelineScore = Math.min(Math.max(event.timeline_score, 1), 5);

      await insertEvent({
        asset_id: assetId,
        asset_name: assetName,
        event_type: event.event_type,
        headline: event.headline,
        summary: event.summary,
        impact_score: impactScore,
        sentiment_score: sentimentScore,
        quantitative_or_qualitative: event.quantitative_or_qualitative,
        supply_or_demand: event.supply_or_demand,
        timeline_score: timelineScore,
        driver_name: event.driver_name,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to insert: ${event.headline?.substring(0, 40)}...`);
    }
  }

  return { processed: analysis.events.length, errors: 0 };
}

async function analyze() {
  console.log('=== VECTX V3 - Layer 1 Analyze ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Model: ${OLLAMA_MODEL}`);
  console.log('');

  const assets = await getAssetsReadyForAnalyze();
  console.log(`Found ${assets.length} assets ready for analysis`);

  if (assets.length === 0) {
    console.log('No assets ready. Run collect and research first.');
    return { processed: 0, errors: 0 };
  }

  let totalProcessed = 0;
  let totalErrors = 0;

  for (let i = 0; i < assets.length; i++) {
    const { asset_id, asset_name, driver_events, research_events } = assets[i];
    console.log(`\n[${asset_name}] ${driver_events} driver events, ${research_events} research events`);
    
    const result = await processAsset(asset_id, asset_name);
    totalProcessed += result.processed;
    totalErrors += result.errors;
    
    // Delay between assets to avoid rate limiting (skip after last asset)
    if (i < assets.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Processed: ${totalProcessed} events`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { processed: totalProcessed, errors: totalErrors };
}

analyze().catch(console.error);