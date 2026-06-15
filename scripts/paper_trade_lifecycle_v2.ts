// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Paper Trade Lifecycle Tracker (v2 with Hedge Support)
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createPriceFeed, type PriceFeed, type PriceTick } from './priceFeed';

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
  ticker: string;
  signal_direction: 'long' | 'short';
  entry_type: 'market' | 'limit';
  entry_price: number | string;
  take_profit_price: number | string;
  stop_loss_price: number | string;
  position_size_pct: number | string;
  leverage: number | string;
  timeframe: string;
  status: 'pending' | 'open' | 'closed' | 'expired';
  would_have_executed: boolean | null;
  hypothetical_fill_price: number | string | null;
  max_favorable_price: number | string | null;
  max_adverse_price: number | string | null;
  adjustment_count: number | null;
  hedge_ticker: string | null;
  hedge_direction: 'long' | 'short' | null;
  hedge_ratio: number | string | null;
  hedge_entry_price: number | string | null;
  hedge_current_price: number | string | null;
  hedge_max_favorable_price: number | string | null;
  hedge_max_adverse_price: number | string | null;
  hedge_error: string | null;
  created_at: Date;
  last_checked_at: Date | null;
}

// Helper to convert string decimals to numbers
function toNum(val: number | string | null): number {
  if (val === null) return 0;
  return typeof val === 'string' ? parseFloat(val) : val;
}

const TIMEFRAME_TO_DAYS: Record<string, number> = {
  '7d': 7, '14d': 14, '30d': 30, '60d': 60, '90d': 90,
  // Legacy formats (written by L3 Analyze before fix)
  '7 days': 7, '14 days': 14, '30 days': 30, '60 days': 60, '90 days': 90,
};
const PENDING_ORDER_TIMEOUT_DAYS = 2;
const DEFAULT_SLIPPAGE_PCT = 0.0002; // 2 bps
const DEFAULT_HEDGE_SLIPPAGE_PCT = 0.0003; // 3 bps

async function runSql<T>(query: string): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': ADMIN_TOKEN,
    },
    body: JSON.stringify({ sql: query }),
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
      pt.timeframe, pt.status, pt.would_have_executed, pt.hypothetical_fill_price,
      pt.max_favorable_price, pt.max_adverse_price,
      pt.adjustment_count,
      pt.hedge_ticker, pt.hedge_direction, pt.hedge_ratio,
      pt.hedge_entry_price, pt.hedge_current_price,
      pt.hedge_max_favorable_price, pt.hedge_max_adverse_price, pt.hedge_error,
      pt.created_at, pt.last_checked_at,
      a.ticker
    FROM central.paper_trades pt
    JOIN central.assets a ON a.id = pt.asset_id
    WHERE pt.status IN ('pending', 'open')
    ORDER BY pt.created_at ASC
  `;
  return runSql<PaperTrade>(query);
}

async function updatePaperTrade(id: string, patch: Record<string, unknown>): Promise<void> {
  const setClauses = Object.entries(patch)
    .filter(([_, v]) => v !== undefined)
    .map(([k, v]) => {
      if (v === null) return `${k} = null`;
      if (typeof v === 'string') return `${k} = '${v.replace(/'/g, "''")}'`;
      if (typeof v === 'boolean') return `${k} = ${v}`;
      if (v instanceof Date) return `${k} = '${v.toISOString()}'`;
      return `${k} = ${v}`;
    });
  
  if (setClauses.length === 0) return;
  
  await runSql(`UPDATE central.paper_trades SET ${setClauses.join(', ')} WHERE id = '${id}'`);
}

async function insertPriceSnapshot(ticker: string, price: number, source: string): Promise<void> {
  await runSql(`
    INSERT INTO central.price_snapshots (ticker, price, source, snapshot_at)
    VALUES ('${ticker}', ${price}, '${source}', NOW())
  `);
}

// ─── Core Logic ──────────────────────────────────────────────────────

function updateExtremes(
  direction: 'long' | 'short',
  entryPrice: number,
  currentPrice: number,
  currentMFE: number | null,
  currentMAE: number | null
): { mfePrice: number; maePrice: number; mfePct: number; maePct: number } {
  const mfe = currentMFE ?? currentPrice;
  const mae = currentMAE ?? currentPrice;

  let mfePrice = mfe;
  let maePrice = mae;

  if (direction === 'long') {
    if (currentPrice > mfe) mfePrice = currentPrice;
    if (currentPrice < mae) maePrice = currentPrice;
  } else {
    if (currentPrice < mfe) mfePrice = currentPrice;
    if (currentPrice > mae) maePrice = currentPrice;
  }

  const mfePct = direction === 'long'
    ? ((mfePrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - mfePrice) / entryPrice) * 100;

  const maePct = direction === 'long'
    ? ((maePrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - maePrice) / entryPrice) * 100;

  return { mfePrice, maePrice, mfePct: round3(mfePct), maePct: round3(maePct) };
}

async function fillOrder(
  trade: PaperTrade,
  mainTick: PriceTick,
  hedgeTick: PriceTick | null
): Promise<boolean> {
  const now = new Date();
  const slip = DEFAULT_SLIPPAGE_PCT;
  const mainFillPrice = trade.signal_direction === 'long'
    ? mainTick.price * (1 + slip)
    : mainTick.price * (1 - slip);

  const patch: Record<string, unknown> = {
    status: 'open',
    would_have_executed: true,
    hypothetical_fill_price: mainFillPrice,
    hypothetical_fill_at: now,
    current_price: mainTick.price,
    max_favorable_price: mainTick.price,
    max_adverse_price: mainTick.price,
    max_favorable_pct: 0,
    max_adverse_pct: 0,
    last_checked_at: now,
  };

  let hedgeError = false;

  // Open hedge leg if planned
  if (trade.hedge_ticker && trade.hedge_direction && trade.hedge_ratio) {
    if (!hedgeTick) {
      patch.hedge_error = `No price for hedge asset ${trade.hedge_ticker} at fill time`;
      hedgeError = true;
    } else {
      const hedgeSlip = DEFAULT_HEDGE_SLIPPAGE_PCT;
      const hedgeFillPrice = trade.hedge_direction === 'long'
        ? hedgeTick.price * (1 + hedgeSlip)
        : hedgeTick.price * (1 - hedgeSlip);

      patch.hedge_entry_price = hedgeFillPrice;
      patch.hedge_entry_at = now;
      patch.hedge_market_at_entry = hedgeTick.price;
      patch.hedge_current_price = hedgeTick.price;
      patch.hedge_max_favorable_price = hedgeTick.price;
      patch.hedge_max_adverse_price = hedgeTick.price;
      patch.hedge_max_favorable_pct = 0;
      patch.hedge_max_adverse_pct = 0;
    }
  }

  await updatePaperTrade(trade.id, patch);
  return hedgeError;
}

async function closeTrade(
  trade: PaperTrade,
  mainExitPrice: number,
  hedgeTick: PriceTick | null,
  trigger: string
): Promise<void> {
  const now = new Date();
  const mainFillPrice = toNum(trade.hypothetical_fill_price ?? trade.entry_price);

  // Detect data anomaly: exit price way out of range from fill price
  const priceRatio = mainExitPrice / mainFillPrice;
  const anomalyDetected = priceRatio > 10 || priceRatio < 0.1;
  if (anomalyDetected) {
    console.log(`  ⚠️ DATA ANOMALY: exit price $${mainExitPrice.toFixed(2)} vs fill $${mainFillPrice.toFixed(2)} (${(priceRatio * 100).toFixed(0)}%)`);
  }

  // Main-leg PnL
  let mainRawPct = trade.signal_direction === 'long'
    ? ((mainExitPrice - mainFillPrice) / mainFillPrice) * 100
    : ((mainFillPrice - mainExitPrice) / mainFillPrice) * 100;

  // Clamp to database field limits (pnl_pct is numeric(7,4) → max ±999.9999)
  const PNL_PCT_MAX = 999;
  if (Math.abs(mainRawPct) > PNL_PCT_MAX) {
    console.log(`  ⚠️ PnL clamped: ${mainRawPct.toFixed(2)}% → ${PNL_PCT_MAX * Math.sign(mainRawPct)}%`);
    mainRawPct = PNL_PCT_MAX * Math.sign(mainRawPct);
  }

  const mainLeveragedPct = mainRawPct * trade.leverage;

  const risk = Math.abs(mainFillPrice - trade.stop_loss_price);
  const directionalReward = trade.signal_direction === 'long'
    ? mainExitPrice - mainFillPrice
    : mainFillPrice - mainExitPrice;
  let rMultiple = risk > 0 ? directionalReward / risk : 0;

  // Clamp R-multiple (pnl_r_multiple is numeric(5,2) → max ±999.99)
  const R_MULTIPLE_MAX = 999;
  if (Math.abs(rMultiple) > R_MULTIPLE_MAX) {
    console.log(`  ⚠️ R-multiple clamped: ${rMultiple.toFixed(2)} → ${R_MULTIPLE_MAX * Math.sign(rMultiple)}`);
    rMultiple = R_MULTIPLE_MAX * Math.sign(rMultiple);
  }

  const patch: Record<string, unknown> = {
    status: 'closed',
    closed_at: now,  // Fix: Set closed_at
    exit_price: mainExitPrice,
    exit_at: now,
    exit_trigger: trigger,
    pnl_pct: round3(mainRawPct),
    pnl_leveraged_pct: round3(mainLeveragedPct),
    pnl_r_multiple: round2(rMultiple),
    current_price: mainExitPrice,
    last_checked_at: now,
    evaluation_complete: true,
  };

  // Hedge-leg PnL
  if (trade.hedge_ticker && trade.hedge_entry_price && trade.hedge_direction) {
    const hedgeExitPrice = hedgeTick?.price ?? trade.hedge_current_price ?? trade.hedge_entry_price;
    const hedgeEntry = trade.hedge_entry_price;
    const hedgeDir = trade.hedge_direction;
    const ratio = trade.hedge_ratio!;

    const hedgeRawPct = hedgeDir === 'long'
      ? ((hedgeExitPrice - hedgeEntry) / hedgeEntry) * 100
      : ((hedgeEntry - hedgeExitPrice) / hedgeEntry) * 100;

    const hedgeContribution = hedgeRawPct * ratio * trade.leverage;

    const mainWasProfitable = mainRawPct > 0;
    const hedgeWasProfitable = hedgeRawPct > 0;
    const correlationHeld = mainWasProfitable !== hedgeWasProfitable;

    patch.hedge_exit_price = hedgeExitPrice;
    patch.hedge_exit_at = now;
    patch.hedge_pnl_pct = round3(hedgeRawPct);
    patch.hedge_contribution_pct = round3(hedgeContribution);
    patch.combined_pnl_pct = round3(mainLeveragedPct + hedgeContribution);
    patch.correlation_held = correlationHeld;

    if (!hedgeTick) {
      patch.hedge_error = (trade.hedge_error ? trade.hedge_error + '; ' : '') + 
        'No price for hedge asset at close time';
    }
  }

  await updatePaperTrade(trade.id, patch);
}

// ─── Main Tracker Loop ──────────────────────────────────────────────

export async function trackLifecycle(): Promise<{
  checked: number;
  filled: number;
  closed: number;
  expired: number;
  hedge_errors: number;
}> {
  console.log('=== VECTX V3 - Paper Trade Lifecycle Tracker V2 ===');
  console.log(`Started at: ${new Date().toISOString()}`);

  const trades = await getOpenPaperTrades();
  console.log(`Found ${trades.length} open paper trades`);

  if (trades.length === 0) {
    console.log('No open trades to track.');
    return { checked: 0, filled: 0, closed: 0, expired: 0, hedge_errors: 0 };
  }

  const priceFeed = createPriceFeed();

  // Batch fetch prices for all tickers
  const tickerSet = new Set<string>();
  for (const t of trades) {
    tickerSet.add(t.ticker);
    if (t.hedge_ticker) tickerSet.add(t.hedge_ticker);
  }

  const tickerPrices = new Map<string, PriceTick>();
  for (const ticker of tickerSet) {
    try {
      const tick = await priceFeed.getLatest(ticker);
      tickerPrices.set(ticker, tick);
      await insertPriceSnapshot(ticker, tick.price, tick.source);
      console.log(`  ${ticker}: $${tick.price.toFixed(4)} (${tick.source})`);
    } catch (err) {
      console.error(`  Failed to fetch ${ticker}: ${(err as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 200)); // Rate limit
  }

  let filled = 0, closed = 0, expired = 0, hedge_errors = 0;

  for (const trade of trades) {
    const mainTick = tickerPrices.get(trade.ticker);
    if (!mainTick) continue;

    const hedgeTick = trade.hedge_ticker ? tickerPrices.get(trade.hedge_ticker) ?? null : null;

    const now = new Date();
    const ageDays = (now.getTime() - new Date(trade.created_at).getTime()) / (1000 * 60 * 60 * 24);

    console.log(`\n[${trade.ticker}] Trade ${trade.id.substring(0, 8)}... (${trade.status})`);

    // PENDING
    if (trade.status === 'pending') {
      if (ageDays > PENDING_ORDER_TIMEOUT_DAYS) {
        console.log(`  ⏰ EXPIRED: pending for ${ageDays.toFixed(1)} days`);
        await updatePaperTrade(trade.id, { status: 'expired', would_have_executed: false, last_checked_at: now });
        expired++;
        continue;
      }

      const shouldFill = trade.entry_type === 'market' ||
        (trade.signal_direction === 'long' ? mainTick.price <= trade.entry_price : mainTick.price >= trade.entry_price);

      if (shouldFill) {
        console.log(`  ✅ FILLED at $${mainTick.price.toFixed(4)}`);
        const hedgeErr = await fillOrder(trade, mainTick, hedgeTick);
        if (hedgeErr) hedge_errors++;
        filled++;
      } else {
        await updatePaperTrade(trade.id, { last_checked_at: now });
      }
      continue;
    }

    // OPEN
    if (trade.status === 'open') {
      const maxDays = TIMEFRAME_TO_DAYS[trade.timeframe] ?? 30;
      
      // Timeout
      if (ageDays > maxDays) {
        console.log(`  ⏰ TIMEOUT: age ${ageDays.toFixed(1)}d > ${maxDays}d`);
        await closeTrade(trade, mainTick.price, hedgeTick, 'timeout');
        closed++;
        continue;
      }

      // Stop / Target
      const hitStop = trade.signal_direction === 'long'
        ? mainTick.price <= toNum(trade.stop_loss_price)
        : mainTick.price >= toNum(trade.stop_loss_price);

      const hitTarget = trade.signal_direction === 'long'
        ? mainTick.price >= toNum(trade.take_profit_price)
        : mainTick.price <= toNum(trade.take_profit_price);

      if (hitStop) {
        // Classify as trailing_stop if the stop was adjusted into profit/breakeven territory
        const fillPrice = toNum(trade.hypothetical_fill_price ?? trade.entry_price);
        const adjustedStop = (trade.adjustment_count ?? 0) > 0;
        const stopInProfit = (trade.signal_direction === 'long' && toNum(trade.stop_loss_price) >= fillPrice)
          || (trade.signal_direction === 'short' && toNum(trade.stop_loss_price) <= fillPrice);
        const trigger = (adjustedStop && stopInProfit) ? 'trailing_stop' : 'stop_loss';
        console.log(`  ${trigger === 'trailing_stop' ? '📈 TRAILING STOP' : '🛑 STOP LOSS'} at $${toNum(trade.stop_loss_price).toFixed(4)}`);
        await closeTrade(trade, toNum(trade.stop_loss_price), hedgeTick, trigger);
        closed++;
        continue;
      }

      if (hitTarget) {
        console.log(`  🎯 TAKE PROFIT at $${toNum(trade.take_profit_price).toFixed(4)}`);
        await closeTrade(trade, toNum(trade.take_profit_price), hedgeTick, 'take_profit');
        closed++;
        continue;
      }

      // Update tracking
      const mainExtremes = updateExtremes(
        trade.signal_direction,
        trade.hypothetical_fill_price ?? trade.entry_price,
        mainTick.price,
        trade.max_favorable_price,
        trade.max_adverse_price
      );

      const patch: Record<string, unknown> = {
        current_price: mainTick.price,
        max_favorable_price: mainExtremes.mfePrice,
        max_adverse_price: mainExtremes.maePrice,
        max_favorable_pct: mainExtremes.mfePct,
        max_adverse_pct: mainExtremes.maePct,
        last_checked_at: now,
      };

      if (trade.hedge_ticker && hedgeTick && trade.hedge_entry_price) {
        const hedgeExtremes = updateExtremes(
          trade.hedge_direction!,
          trade.hedge_entry_price,
          hedgeTick.price,
          trade.hedge_max_favorable_price,
          trade.hedge_max_adverse_price
        );
        patch.hedge_current_price = hedgeTick.price;
        patch.hedge_max_favorable_price = hedgeExtremes.mfePrice;
        patch.hedge_max_adverse_price = hedgeExtremes.maePrice;
        patch.hedge_max_favorable_pct = hedgeExtremes.mfePct;
        patch.hedge_max_adverse_pct = hedgeExtremes.maePct;
      }

      await updatePaperTrade(trade.id, patch);
      console.log(`  MFE: ${mainExtremes.mfePct.toFixed(2)}% | MAE: ${mainExtremes.maePct.toFixed(2)}%`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Checked: ${trades.length}`);
  console.log(`Filled: ${filled}`);
  console.log(`Closed: ${closed}`);
  console.log(`Expired: ${expired}`);
  console.log(`Hedge errors: ${hedge_errors}`);
  console.log(`Finished at: ${new Date().toISOString()}`);

  return { checked: trades.length, filled, closed, expired, hedge_errors };
}

// ─── Helpers ───────────────────────────────────────────────────────
const round2 = (n: number) => Number(n.toFixed(2));
const round3 = (n: number) => Number(n.toFixed(3));

// Run if executed directly
trackLifecycle().catch(console.error);