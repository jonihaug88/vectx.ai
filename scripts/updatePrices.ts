// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Update All Asset Prices
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";
import { createPriceFeed } from "./priceFeed";

const config = JSON.parse(readFileSync("../config.json", "utf-8"));
const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;

async function runSql<T>(query: string): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify({ sql: query }),
  });
  return (await response.json()).data || [];
}

async function main() {
  console.log("=== Updating Asset Prices ===\n");
  const startTime = Date.now();

  // Get all assets
  const assets = await runSql<{ id: string; ticker: string; name: string }>(`
    SELECT id, ticker, name FROM central.assets ORDER BY ticker;
  `);

  console.log(`Found ${assets.length} assets\n`);

  // Create price feed
  const priceFeed = createPriceFeed();

  let updated = 0;
  let failed = 0;

  for (const asset of assets) {
    try {
      const tick = await priceFeed.getLatest(asset.ticker);
      
      if (tick && tick.price > 0) {
        // Update current price in assets table
        await runSql(`
          UPDATE central.assets
          SET current_price = ${tick.price},
              last_calculation = NOW()
          WHERE id = '${asset.id}';
        `);
        
        // Insert price snapshot for historical tracking
        await runSql(`
          INSERT INTO central.price_snapshots (ticker, price, source, snapshot_at)
          VALUES ('${asset.ticker}', ${tick.price}, '${tick.source}', NOW());
        `);
        
        console.log(`✅ ${asset.ticker}: $${tick.price.toFixed(2)}`);
        updated++;
      } else {
        console.log(`⚠️ ${asset.ticker}: No price`);
        failed++;
      }
    } catch (err) {
      console.log(`❌ ${asset.ticker}: ${(err as Error).message}`);
      failed++;
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Failed: ${failed}`);
  console.log(`Duration: ${duration}s`);
}

main().catch(console.error);