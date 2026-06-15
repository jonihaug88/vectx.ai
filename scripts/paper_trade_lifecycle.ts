/**
 * VECTX V3 - Paper Trade Lifecycle Tracker
 * 
 * Runs every 15 minutes to:
 * - Check current market prices for open paper trades
 * - Update max_favorable / max_adverse
 * - Detect take-profit / stop-loss hits
 * - Calculate PnL on close
 * 
 * Cron: every 15 minutes (0,15,30,45 * * * *)
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createPriceFeed, type PriceTick } from './priceFeed';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;

interface PaperTrade {
  id: string;
  asset_id: string;
  signal_direction: 'long' | 'short';
  entry_type: 'market' | 'limit';
  entry_price: number;
  take_profit_price: number;
  stop_loss_price: number;
  position_size_pct: number;
  leverage: number;
  hedge_ticker: string | null;
  hedge_direction: 'long' | 'short' | null;
  hedge_ratio: number | null;
  opened_at: string | null;
  status: string;
  actual_market_price_at_entry: number | null;
  actual_max_favorable: number | null;
  actual_max_adverse: number | null;
  would_have_executed: boolean;
}

interface Asset {
  id: string;
  ticker: string;
  name: string;
  asset_class: string;
  current_price: number | null;
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

async function getOpenPaperTrades(): Promise<PaperTrade[]> {
  const query = `
    SELECT 
      pt.id, pt.asset_id, pt.signal_direction, pt.entry_type, pt.entry_price,
      pt.take_profit_price, pt.stop_loss_price, pt.position_size_pct, pt.leverage,
      pt.hedge_ticker, pt.hedge_direction, pt.hedge_ratio,
      pt.opened_at, pt.status, pt.actual_market_price_at_entry,
      pt.actual_max_favorable, pt.actual_max_adverse, pt.would_have_executed
    FROM central.paper_trades pt
    WHERE pt.status = 'open'
    ORDER BY pt.created_at ASC
  `;
  return runSql<PaperTrade>(query);
}

async function getAssets(): Promise<Map<string, Asset>> {
  const query = `SELECT id, ticker, name, asset_class, current_price FROM central.assets`;
  const results = await runSql<Asset>(query);
  const map = new Map<string, Asset>();
  for (const asset of results) {
    map.set(asset.id, asset);
  }
  return map;
}

/**
 * Store price in central.prices and update assets.current_price
 * Includes outlier detection to prevent bad data from poisoning the dataset
 */
async function storePrice(
  assetId: string,
  ticker: string,
  price: number,
  source: string
): Promise<{ stored: boolean; reason?: string }> {
  // Get last price snapshot for validation
  const lastSnapshot = await getLastPriceSnapshot(ticker);
  
  // Outlier detection
  if (lastSnapshot) {
    const ageMinutes = (Date.now() - lastSnapshot.timestamp.getTime()) / 60_000;
    const pctChange = Math.abs((price - lastSnapshot.price) / lastSnapshot.price);
    
    // Thresholds scale with time gap
    const maxReasonablePct = ageMinutes < 30 ? 0.03 : 0.08; // 3% intraday, 8% across gaps
    
    if (pctChange > maxReasonablePct) {
      // Log anomaly but don't store
      console.log(`  ⚠️ OUTLIER: ${ticker} ${lastSnapshot.price.toFixed(2)} → ${price.toFixed(2)} (${(pctChange * 100).toFixed(1)}% change in ${ageMinutes.toFixed(0)}min)`);
      await logPriceAnomaly(ticker, price, lastSnapshot.price, source);
      return { stored: false, reason: 'outlier_rejected' };
    }
    
    if (pctChange > maxReasonablePct * 0.7) {
      console.log(`  ⚠️ FLAG: ${ticker} price change suspicious but within threshold`);
      // Store but could flag if needed
    }
  }
  
  // Calculate change_pct vs previous close
  const prevClose = await getPreviousClose(ticker);
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;

  // Insert into central.prices (history)
  await runSql(`
    INSERT INTO central.prices (asset_id, price, change_pct, observation_date, source)
    VALUES ('${assetId}', ${price}, ${changePct}, NOW(), '${source}')
  `);

  // Insert into price_snapshots for gap detection
  await runSql(`
    INSERT INTO central.price_snapshots (ticker, price, source, snapshot_at)
    VALUES ('${ticker}', ${price}, '${source}', NOW())
  `);

  // Update assets.current_price
  await runSql(`
    UPDATE central.assets
    SET current_price = ${price}, last_price_update = NOW()
    WHERE id = '${assetId}'
  `);

  return { stored: true };
}

async function getLastPriceSnapshot(ticker: string): Promise<{ price: number; timestamp: Date } | null> {
  const query = `
    SELECT price, snapshot_at as timestamp
    FROM central.price_snapshots
    WHERE ticker = '${ticker}'
    ORDER BY snapshot_at DESC
    LIMIT 1
  `;
  const results = await runSql<{ price: number; timestamp: string }>(query);
  if (results.length === 0) return null;
  return {
    price: results[0].price,
    timestamp: new Date(results[0].timestamp),
  };
}

async function getPreviousClose(ticker: string): Promise<number | null> {
  const query = `
    SELECT price
    FROM central.prices p
    JOIN central.assets a ON a.id = p.asset_id
    WHERE a.ticker = '${ticker}'
    AND p.observation_date < CURRENT_DATE
    ORDER BY p.observation_date DESC
    LIMIT 1
  `;
  const results = await runSql<{ price: number }>(query);
  return results[0]?.price || null;
}

async function logPriceAnomaly(ticker: string, newPrice: number, oldPrice: number, source: string): Promise<void> {
  const query = `
    INSERT INTO central.price_anomalies (ticker, new_price, old_price, source, detected_at)
    VALUES ('${ticker}', ${newPrice}, ${oldPrice}, '${source}', NOW())
  `;
  try {
    await runSql(query);
  } catch {
    // Table might not exist yet - ignore
  }
}

/**
 * Check if trade should have executed (for limit orders)
 */
function checkExecution(
  trade: PaperTrade,
  currentPrice: number,
  entryTime: Date
): { executed: boolean; fillPrice: number | null } {
  if (trade.entry_type === 'market') {
    return { executed: true, fillPrice: trade.entry_price };
  }

  // Limit order: check if price reached limit
  const limitPrice = trade.entry_price;
  if (trade.signal_direction === 'long') {
    // Buy limit: executed when price <= limit
    if (currentPrice <= limitPrice) {
      return { executed: true, fillPrice: limitPrice };
    }
  } else {
    // Sell limit: executed when price >= limit
    if (currentPrice >= limitPrice) {
      return { executed: true, fillPrice: limitPrice };
    }
  }

  return { executed: false, fillPrice: null };
}

/**
 * Check if take-profit or stop-loss was hit
 */
function checkExitTrigger(
  trade: PaperTrade,
  currentPrice: number,
  highSinceEntry: number,
  lowSinceEntry: number
): { trigger: string | null; exitPrice: number | null } {
  if (trade.signal_direction === 'long') {
    // Long: TP hit if high >= take_profit, SL hit if low <= stop_loss
    if (highSinceEntry >= trade.take_profit_price) {
      return { trigger: 'take_profit', exitPrice: trade.take_profit_price };
    }
    if (lowSinceEntry <= trade.stop_loss_price) {
      return { trigger: 'stop_loss', exitPrice: trade.stop_loss_price };
    }
  } else {
    // Short: TP hit if low <= take_profit, SL hit if high >= stop_loss
    if (lowSinceEntry <= trade.take_profit_price) {
      return { trigger: 'take_profit', exitPrice: trade.take_profit_price };
    }
    if (highSinceEntry >= trade.stop_loss_price) {
      return { trigger: 'stop_loss', exitPrice: trade.stop_loss_price };
    }
  }

  return { trigger: null, exitPrice: null };
}

/**
 * Calculate PnL
 */
function calculatePnL(
  trade: PaperTrade,
  entryPrice: number,
  exitPrice: number
): { pnl_pct: number; pnl_absolute: number } {
  let pnl_pct: number;
  if (trade.signal_direction === 'long') {
    pnl_pct = ((exitPrice - entryPrice) / entryPrice) * 100;
  } else {
    pnl_pct = ((entryPrice - exitPrice) / entryPrice) * 100;
  }
  
  // Apply leverage
  pnl_pct = pnl_pct * trade.leverage;
  
  // Absolute PnL (assuming $10,000 position)
  const positionValue = 10000 * (trade.position_size_pct / 100);
  const pnl_absolute = positionValue * (pnl_pct / 100);

  return { pnl_pct, pnl_absolute };
}

async function updatePaperTrade(
  tradeId: string,
  updates: Partial<PaperTrade>
): Promise<void> {
  const setClauses: string[] = [];
  
  if (updates.actual_market_price_at_entry !== undefined) {
    setClauses.push(`actual_market_price_at_entry = ${updates.actual_market_price_at_entry}`);
  }
  if (updates.actual_max_favorable !== undefined) {
    setClauses.push(`actual_max_favorable = ${updates.actual_max_favorable}`);
  }
  if (updates.actual_max_adverse !== undefined) {
    setClauses.push(`actual_max_adverse = ${updates.actual_max_adverse}`);
  }
  if (updates.would_have_executed !== undefined) {
    setClauses.push(`would_have_executed = ${updates.would_have_executed}`);
  }
  if (updates.hypothetical_fill_price !== undefined) {
    setClauses.push(`hypothetical_fill_price = ${updates.hypothetical_fill_price}`);
  }
  if (updates.status !== undefined) {
    setClauses.push(`status = '${updates.status}'`);
  }
  if (updates.exit_trigger !== undefined) {
    setClauses.push(`exit_trigger = '${updates.exit_trigger}'`);
  }
  if (updates.pnl_pct !== undefined) {
    setClauses.push(`pnl_pct = ${updates.pnl_pct}`);
  }
  if (updates.pnl_absolute !== undefined) {
    setClauses.push(`pnl_absolute = ${updates.pnl_absolute}`);
  }
  if (updates.evaluation_complete !== undefined) {
    setClauses.push(`evaluation_complete = ${updates.evaluation_complete}`);
  }
  if (updates.status === 'closed') {
    setClauses.push(`closed_at = NOW()`);
  }

  if (setClauses.length === 0) return;

  const query = `UPDATE central.paper_trades SET ${setClauses.join(', ')} WHERE id = '${tradeId}'`;
  await runSql(query);
}

async function trackLifecycle() {
  console.log('=== VECTX V3 - Paper Trade Lifecycle Tracker ===');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('');

  const trades = await getOpenPaperTrades();
  console.log(`Found ${trades.length} open paper trades`);

  if (trades.length === 0) {
    console.log('No open trades to track.');
    return { tracked: 0, closed: 0 };
  }

  const assets = await getAssets();
  const priceFeed = createPriceFeed();
  let tracked = 0;
  let closed = 0;

  for (const trade of trades) {
    const asset = assets.get(trade.asset_id);
    if (!asset) {
      console.log(`  Trade ${trade.id}: Asset not found, skipping`);
      continue;
    }

    // Use priceFeed abstraction
    let priceResult: PriceTick;
    try {
      priceResult = await priceFeed.getLatest(asset.ticker);
    } catch (err) {
      console.log(`  Trade ${trade.id}: No price available for ${asset.ticker} - ${(err as Error).message}`);
      continue;
    }

    const currentPrice = priceResult.price;
    console.log(`\n[${asset.ticker}] Trade ${trade.id.substring(0, 8)}... (${priceResult.source})`);
    console.log(`  Direction: ${trade.signal_direction}, Entry: $${trade.entry_price.toFixed(2)}`);
    console.log(`  Current: $${currentPrice.toFixed(4)}`);

    // Store price in central.prices and update assets.current_price
    const storeResult = await storePrice(asset.id, asset.ticker, currentPrice, priceResult.source);
    if (!storeResult.stored) {
      console.log(`  ⚠️ Price rejected: ${storeResult.reason}`);
    }

    // Check execution for limit orders
    if (trade.entry_type === 'limit' && !trade.would_have_executed) {
      const { executed, fillPrice } = checkExecution(trade, currentPrice, new Date());
      if (executed) {
        console.log(`  ✅ Limit would have filled at $${fillPrice?.toFixed(2)}`);
        await updatePaperTrade(trade.id, {
          would_have_executed: true,
          hypothetical_fill_price: fillPrice ?? undefined,
          status: 'filled',
          opened_at: new Date().toISOString(),
        });
      } else {
        console.log(`  ⏳ Limit not yet reached`);
        await updatePaperTrade(trade.id, {
          would_have_executed: false,
        });
      }
      tracked++;
      continue;
    }

    // Update max favorable / adverse
    const currentFavorable = trade.signal_direction === 'long'
      ? currentPrice - trade.entry_price
      : trade.entry_price - currentPrice;
    const currentAdverse = trade.signal_direction === 'long'
      ? trade.entry_price - currentPrice
      : currentPrice - trade.entry_price;

    const maxFavorable = Math.max(trade.actual_max_favorable || 0, currentFavorable);
    const maxAdverse = Math.max(trade.actual_max_adverse || 0, currentAdverse);

    console.log(`  Max favorable: $${maxFavorable.toFixed(2)}, Max adverse: $${maxAdverse.toFixed(2)}`);

    // Check exit triggers
    const highSinceEntry = trade.entry_price + maxFavorable;
    const lowSinceEntry = trade.entry_price - maxAdverse;
    
    const { trigger, exitPrice } = checkExitTrigger(trade, currentPrice, highSinceEntry, lowSinceEntry);

    if (trigger) {
      console.log(`  🎯 EXIT: ${trigger} at $${exitPrice?.toFixed(2)}`);
      
      const { pnl_pct, pnl_absolute } = calculatePnL(trade, trade.entry_price, exitPrice!);
      console.log(`  PnL: ${pnl_pct >= 0 ? '+' : ''}${pnl_pct.toFixed(2)}% ($${pnl_absolute.toFixed(2)})`);

      await updatePaperTrade(trade.id, {
        status: 'closed',
        exit_trigger: trigger,
        pnl_pct,
        pnl_absolute,
        evaluation_complete: true,
        actual_max_favorable: maxFavorable,
        actual_max_adverse: maxAdverse,
      });
      closed++;
    } else {
      // Just update tracking data
      await updatePaperTrade(trade.id, {
        actual_max_favorable: maxFavorable,
        actual_max_adverse: maxAdverse,
        actual_market_price_at_entry: currentPrice,
      });
    }

    tracked++;
  }

  console.log('\n=== Summary ===');
  console.log(`Trades tracked: ${tracked}`);
  console.log(`Trades closed: ${closed}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { tracked, closed };
}

trackLifecycle().catch(console.error);