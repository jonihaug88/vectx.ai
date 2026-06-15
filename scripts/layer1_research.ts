/**
 * VECTX V3 - Layer 1 Research Script (v2 with Novelty Tracking)
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { trackNoveltyForEvent } from './l1_research_novelty_integration.js';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;
const BRAVE_API_KEY = config.brave_api_key;
const GEMINI_API_KEY = config.gemini_api_key;

const GEMINI_MODEL = 'gemini-2.5-flash';

// Batch processing
const BATCH_ASSETS = process.env.ASSETS?.split(',') || null;

interface Driver {
  id: string;
  asset_id: string;
  driver_name: string;
  description: string;
  supply_or_demand: string;
}

interface DriverEvent {
  id: string;
  headline: string;
  driver_name: string;
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

async function getAssetsWithNewEvents(): Promise<{ asset_id: string; asset_name: string; event_count: string }[]> {
  // Get assets with driver events, regardless of research_events
  let query = `
    SELECT 
      de.asset_id,
      de.asset_name,
      COUNT(*)::text as event_count
    FROM central.drivers_events de
    WHERE de.created_at > NOW() - INTERVAL '24 hours'
    GROUP BY de.asset_id, de.asset_name
    HAVING COUNT(*) >= 5
    ORDER BY COUNT(*) DESC
  `;
  
  let results = await runSql<{ asset_id: string; asset_name: string; event_count: string }>(query);
  
  if (BATCH_ASSETS) {
    results = results.filter(r => BATCH_ASSETS.includes(r.asset_name));
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
  }
  
  return results;
}

async function getAssetDrivers(assetId: string): Promise<Driver[]> {
  const query = `
    SELECT id, asset_id, driver_name, description, supply_or_demand
    FROM central.drivers
    WHERE asset_id = $1
  `;
  return runSql<Driver>(query, [assetId]);
}

async function getRecentDriverEvents(assetId: string, hoursBack: number = 24): Promise<DriverEvent[]> {
  const query = `
    SELECT id, headline, driver_name
    FROM central.drivers_events
    WHERE asset_id = $1
    AND created_at > NOW() - INTERVAL '${hoursBack} hours'
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return runSql<DriverEvent>(query, [assetId]);
}

async function getAssetInfo(assetId: string): Promise<Asset | null> {
  const query = `SELECT id, ticker, name, asset_class FROM central.assets WHERE id = $1`;
  const results = await runSql<Asset>(query, [assetId]);
  return results[0] || null;
}

async function searchBrave(query: string, count: number = 10): Promise<{ title: string; url: string; description: string }[]> {
  const response = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&freshness=24h`,
    {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Brave API error: ${response.status}`);
  }

  const data = await response.json();
  return (data.web?.results || []).map((r: any) => ({
    title: r.title,
    url: r.url,
    description: r.description,
  }));
}

async function callGemini(prompt: string): Promise<string> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini error: ${response.status} - ${text}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  let text = '';
  for (const part of parts) {
    if (part.text && !part.thought) text += part.text;
  }
  return text;
}

function buildResearchPrompt(
  asset: Asset,
  drivers: Driver[],
  existingEvents: DriverEvent[],
  searchResults: { title: string; url: string; description: string }[]
): string {
  const driverList = drivers
    .map(d => `- ${d.driver_name}: ${d.description || 'No description'}`)
    .join('\n');

  const existingHeadlines = existingEvents
    .slice(0, 20)
    .map(e => `- ${e.headline}`)
    .join('\n');

  const searchHeadlines = searchResults
    .map(s => `- ${s.title}\n  Source: ${s.url}\n  Snippet: ${s.description || 'N/A'}`)
    .join('\n');

  return `You are a financial research analyst for ${asset.asset_class} markets.

ASSET: ${asset.name} (${asset.ticker})

EXISTING DRIVERS (already tracked):
${driverList}

RECENT RSS HEADLINES (already collected):
${existingHeadlines}

WEB SEARCH RESULTS (potentially new):
${searchHeadlines}

TASK: Identify news/events from the web search that are:
1. NOT covered by our RSS feeds
2. RELEVANT to ${asset.ticker} price
3. Potentially significant (could move price)

For each NEW finding:
- Determine if it fits an existing driver
- If NOT covered by any driver, suggest a NEW driver

Respond in JSON format:
{
  "new_findings": [
    {
      "headline": "exact headline from search",
      "summary": "Why this matters for ${asset.ticker}",
      "existing_driver": "driver name or null",
      "new_driver_needed": false,
      "source_url": "url from search"
    }
  ],
  "suggested_drivers": [
    {
      "name": "New Driver Name",
      "description": "Why this driver matters for ${asset.ticker}",
      "supply_or_demand": "supply|demand|both",
      "suggested_sources": [
        {
          "name": "Source Name",
          "url": "https://rss-url-if-known.com/feed",
          "description": "Why this source is valuable"
        }
      ]
    }
  ]
}

IMPORTANT: Only include findings that are genuinely NEW (not in RSS headlines).
Respond ONLY with valid JSON. No markdown.`;
}

function parseGeminiResponse(response: string): {
  new_findings: Array<{
    headline: string;
    summary: string;
    existing_driver: string | null;
    new_driver_needed: boolean;
    source_url: string;
  }>;
  suggested_drivers: Array<{
    name: string;
    description: string;
    supply_or_demand: string;
    suggested_sources: Array<{
      name: string;
      url: string;
      description: string;
    }>;
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
      return JSON.parse(jsonMatch[0]);
    }
    return { new_findings: [], suggested_drivers: [] };
  } catch (e) {
    console.error('Failed to parse response:', e);
    return { new_findings: [], suggested_drivers: [] };
  }
}

async function insertResearchEvent(event: {
  asset_id: string;
  asset_name: string;
  headline: string;
  summary: string;
  existing_driver: string | null;
  new_driver: string | null;
  new_source: string | null;
}): Promise<string> {
  const escapeSql = (str: string | null): string => {
    if (!str) return 'null';
    return `'${str.replace(/'/g, "''")}'`;
  };

  const query = `
    INSERT INTO central.research_events 
      (asset_id, asset_name, headline, summary, existing_driver, new_driver, new_source)
    VALUES (
      '${event.asset_id}',
      '${event.asset_name}',
      ${escapeSql(event.headline)},
      ${escapeSql(event.summary)},
      ${escapeSql(event.existing_driver)},
      ${escapeSql(event.new_driver)},
      ${escapeSql(event.new_source)}
    )
    RETURNING id::text
  `;
  const results = await runSql<{ id: string }>(query);
  return results[0]?.id || '';
}

async function processAsset(
  assetId: string,
  assetName: string
): Promise<{ findings: number; newDrivers: number }> {
  console.log(`\n[${assetName}] Researching...`);

  const asset = await getAssetInfo(assetId);
  if (!asset) return { findings: 0, newDrivers: 0 };

  const drivers = await getAssetDrivers(assetId);
  console.log(`  Existing drivers: ${drivers.length}`);

  const existingEvents = await getRecentDriverEvents(assetId);
  console.log(`  RSS events (24h): ${existingEvents.length}`);

  // Build search queries for gaps
  const searchQueries = [
    `${asset.name} latest news today`,
    `${asset.ticker} market news analysis`,
    `${asset.ticker} price drivers outlook`,
  ];

  let allSearchResults: { title: string; url: string; description: string }[] = [];
  
  for (const query of searchQueries) {
    try {
      const results = await searchBrave(query, 10);
      allSearchResults = allSearchResults.concat(results);
    } catch (error) {
      console.error(`  Search error for "${query}": ${error}`);
    }
  }

  // Dedupe by URL
  const uniqueResults = Array.from(
    new Map(allSearchResults.map(r => [r.url, r])).values()
  ).slice(0, 20);

  console.log(`  Search results: ${uniqueResults.length}`);

  if (uniqueResults.length === 0) {
    console.log(`  No search results`);
    return { findings: 0, newDrivers: 0 };
  }

  // Analyze with Gemini
  const prompt = buildResearchPrompt(asset, drivers, existingEvents, uniqueResults);
  
  let response: string;
  try {
    response = await callGemini(prompt);
  } catch (error) {
    console.error(`  Gemini error: ${error}`);
    return { findings: 0, newDrivers: 0 };
  }

  console.log(`  Gemini response: ${response.length} chars`);

  const analysis = parseGeminiResponse(response);
  console.log(`  New findings: ${analysis.new_findings.length}`);
  console.log(`  Suggested drivers: ${analysis.suggested_drivers.length}`);

  // Insert findings into research_events + track novelty
  for (const finding of analysis.new_findings) {
    try {
      const eventId = await insertResearchEvent({
        asset_id: assetId,
        asset_name: assetName,
        headline: finding.headline,
        summary: finding.summary,
        existing_driver: finding.existing_driver,
        new_driver: finding.new_driver_needed ? 'Yes - needs creation' : null,
        new_source: finding.source_url,
      });
      
      // Track novelty score
      await trackNoveltyForEvent(
        { id: assetId, ticker: asset?.ticker || assetName, schema: assetName.toLowerCase().replace(/\s+/g, '_') },
        { id: eventId, headline: finding.headline, summary: finding.summary },
        { lookbackDays: 7 }
      );
    } catch (error) {
      console.error(`  Failed to insert: ${finding.headline?.substring(0, 40)}...`);
    }
  }

  // TODO: Create new drivers if suggested
  // This would require additional logic to insert into drivers table

  return { findings: analysis.new_findings.length, newDrivers: analysis.suggested_drivers.length };
}

async function research() {
  console.log('=== VECTX V3 - Layer 1 Research ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const assets = await getAssetsWithNewEvents();
  console.log(`Found ${assets.length} assets with new RSS events`);

  if (assets.length === 0) {
    console.log('No assets need research.');
    return { findings: 0, newDrivers: 0 };
  }

  let totalFindings = 0;
  let totalNewDrivers = 0;

  for (const { asset_id, asset_name, event_count } of assets) {
    console.log(`\n[${asset_name}] ${event_count} RSS events`);
    
    const result = await processAsset(asset_id, asset_name);
    totalFindings += result.findings;
    totalNewDrivers += result.newDrivers;
  }

  console.log('\n=== Summary ===');
  console.log(`New findings: ${totalFindings}`);
  console.log(`Suggested new drivers: ${totalNewDrivers}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { findings: totalFindings, newDrivers: totalNewDrivers };
}

research().catch(console.error);