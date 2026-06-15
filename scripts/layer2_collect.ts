/**
 * VECTX V3 - Layer 2 Collect Script
 * 
 * Marks events from Layer 1 for Layer 2 processing
 * Updates timestamp and prepares data for research
 * No LLM required - pure data preparation
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

// Batch processing
const BATCH_ASSETS = process.env.ASSETS?.split(',') || null;

interface Event {
  id: string;
  asset_id: string;
  asset_name: string;
  event_type: string;
  headline: string;
  summary: string;
  impact_score: number;
  sentiment_score: number;
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

async function getUnprocessedEvents(): Promise<{ asset_id: string; asset_name: string; count: string }[]> {
  let query = `
    SELECT 
      e.asset_id,
      e.asset_name,
      COUNT(*)::text as count
    FROM central.events e
    WHERE e.l2_processed_at IS NULL
    GROUP BY e.asset_id, e.asset_name
    ORDER BY COUNT(*) DESC
  `;

  let results = await runSql<{ asset_id: string; asset_name: string; count: string }>(query);
  
  if (BATCH_ASSETS) {
    results = results.filter(r => BATCH_ASSETS.includes(r.asset_name));
    console.log(`BATCH MODE: Processing only ${BATCH_ASSETS.join(', ')}`);
  }
  
  return results;
}

async function getAssetEvents(assetId: string): Promise<Event[]> {
  const query = `
    SELECT 
      id, asset_id, asset_name, event_type, headline, summary,
      impact_score, sentiment_score, driver_name, created_at
    FROM central.events
    WHERE asset_id = $1
    AND l2_processed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return runSql<Event>(query, [assetId]);
}

async function markEventsForL2(eventIds: string[]): Promise<number> {
  if (eventIds.length === 0) return 0;
  
  const idsList = eventIds.map(id => `'${id}'`).join(',');
  const query = `
    UPDATE central.events
    SET l2_processed_at = NOW()
    WHERE id IN (${idsList})
  `;
  await runSql(query);
  return eventIds.length;
}

async function getAssetInfo(assetId: string): Promise<{ id: string; ticker: string; name: string; asset_class: string; current_price: number | null } | null> {
  const query = `
    SELECT id, ticker, name, asset_class, current_price 
    FROM central.assets 
    WHERE id = $1
  `;
  const results = await runSql<{ id: string; ticker: string; name: string; asset_class: string; current_price: number | null }>(query, [assetId]);
  return results[0] || null;
}

async function getDrivers(assetId: string): Promise<{ id: string; driver_name: string; description: string; supply_or_demand: string }[]> {
  const query = `
    SELECT id, driver_name, description, supply_or_demand
    FROM central.drivers
    WHERE asset_id = $1
    ORDER BY driver_name
  `;
  return runSql<{ id: string; driver_name: string; description: string; supply_or_demand: string }>(query, [assetId]);
}

async function collect() {
  console.log('=== VECTX V3 - Layer 2 Collect ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  // Get assets with unprocessed events
  const assetCounts = await getUnprocessedEvents();
  console.log(`Found ${assetCounts.length} assets with unprocessed events`);

  if (assetCounts.length === 0) {
    console.log('No unprocessed events. Layer 1 Analyze may not have run yet.');
    return { assetsProcessed: 0, eventsMarked: 0 };
  }

  let totalEventsMarked = 0;
  let assetsProcessed = 0;

  for (const { asset_id, asset_name, count } of assetCounts) {
    console.log(`\n[${asset_name}] ${count} unprocessed events`);

    // Get events
    const events = await getAssetEvents(asset_id);
    console.log(`  Loaded ${events.length} events for processing`);

    // Get asset info for context
    const asset = await getAssetInfo(asset_id);
    if (!asset) {
      console.log(`  WARNING: Asset not found, skipping`);
      continue;
    }

    // Get drivers for context
    const drivers = await getDrivers(asset_id);
    console.log(`  Drivers: ${drivers.length}`);

    // Mark events for L2 processing
    const eventIds = events.map(e => e.id);
    const marked = await markEventsForL2(eventIds);
    totalEventsMarked += marked;
    assetsProcessed++;

    console.log(`  Marked ${marked} events for Layer 2`);
  }

  console.log('\n=== Summary ===');
  console.log(`Assets processed: ${assetsProcessed}`);
  console.log(`Events marked for L2: ${totalEventsMarked}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return {
    assetsProcessed,
    eventsMarked: totalEventsMarked,
  };
}

collect().catch(console.error);