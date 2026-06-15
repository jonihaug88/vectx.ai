/**
 * VECTX V3 - Layer 3 Collect Script
 * 
 * Gathers asset data and alpha calculations for trade generation
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

interface Asset {
  id: string;
  ticker: string;
  name: string;
  asset_class: string;
  current_price: number | null;
  vreal: number | null;
  alpha_gap: number | null;
  last_calculation: string | null;
}

interface Alpha {
  id: string;
  asset_id: string;
  vreal: number;
  alpha_gap: number;
  confidence: number;
  reasoning: string;
  timeframe_days: number;
  created_at: string;
}

interface FutureEvent {
  id: string;
  event_type: string;
  headline: string;
  impact_score: number;
  sentiment_score: number;
  probability: number;
  timeline_score: number;
  driver_name: string;
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

async function getAssetsWithAlpha(): Promise<{ asset_id: string; asset_name: string }[]> {
  let query = `
    SELECT DISTINCT 
      a.id as asset_id,
      a.name as asset_name
    FROM central.assets a
    WHERE a.vreal IS NOT NULL
    AND a.alpha_gap IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM central.alpha al 
      WHERE al.asset_id = a.id 
      AND al.created_at >= NOW() - INTERVAL '12 hours'
    )
    ORDER BY a.name
  `;

  let results = await runSql<{ asset_id: string; asset_name: string }>(query);
  
  if (BATCH_ASSETS) {
    // Match by ticker or name (case insensitive, partial match)
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
    SELECT id, ticker, name, asset_class, current_price, vreal, alpha_gap, last_calculation
    FROM central.assets
    WHERE id = $1
  `;
  const results = await runSql<Asset>(query, [assetId]);
  return results[0] || null;
}

async function getLatestAlpha(assetId: string): Promise<Alpha | null> {
  const query = `
    SELECT id, asset_id, vreal, alpha_gap, confidence, reasoning, timeframe_days, created_at
    FROM central.alpha
    WHERE asset_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const results = await runSql<Alpha>(query, [assetId]);
  return results[0] || null;
}

async function getTopFutureEvents(assetId: string): Promise<FutureEvent[]> {
  const query = `
    SELECT id, event_type, headline, impact_score, sentiment_score, probability, timeline_score, driver_name
    FROM central.future_events
    WHERE asset_id = $1
    AND created_at >= NOW() - INTERVAL '12 hours'
    ORDER BY probability DESC, impact_score DESC
    LIMIT 5
  `;
  return runSql<FutureEvent>(query, [assetId]);
}

async function markForL3(assetId: string): Promise<void> {
  await runSql(`
    UPDATE central.assets 
    SET l3_ready = true, l3_collected_at = NOW(), l3_researched_at = NULL
    WHERE id = '${assetId}'
  `);
}

async function collect() {
  console.log('=== VECTX V3 - Layer 3 Collect ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const assets = await getAssetsWithAlpha();
  console.log(`Found ${assets.length} assets with valid alpha`);

  if (assets.length === 0) {
    console.log('No assets ready. Run Layer 2 Analyze first.');
    return { assetsPrepared: 0 };
  }

  let assetsPrepared = 0;

  for (const { asset_id, asset_name } of assets) {
    console.log(`\n[${asset_name}] Collecting...`);

    const asset = await getAsset(asset_id);
    if (!asset) {
      console.log(`  Asset not found, skipping`);
      continue;
    }

    const alpha = await getLatestAlpha(asset_id);
    if (!alpha) {
      console.log(`  No alpha found, skipping`);
      continue;
    }

    const futureEvents = await getTopFutureEvents(asset_id);
    const currentPrice = asset.current_price ? Number(asset.current_price) : null;
    console.log(`  Current price: $${currentPrice?.toFixed(2) || 'N/A'}`);
    console.log(`  Vreal: $${Number(alpha.vreal).toFixed(2)}`);
    console.log(`  Alpha gap: ${Number(alpha.alpha_gap) >= 0 ? '+' : ''}${Number(alpha.alpha_gap).toFixed(2)}`);
    console.log(`  Confidence: ${(Number(alpha.confidence) * 100).toFixed(0)}%`);
    console.log(`  Future events: ${futureEvents.length}`);
    console.log(`  Timeframe: ${alpha.timeframe_days} days`);

    // Mark as ready for L3
    await markForL3(asset_id);
    assetsPrepared++;
    console.log(`  ✅ Ready for Layer 3`);
  }

  console.log('\n=== Summary ===');
  console.log(`Assets prepared for L3: ${assetsPrepared}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { assetsPrepared };
}

collect().catch(console.error);