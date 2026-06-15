// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Trade Adjustment Actions (Update, Reverse, Skip)
// ═══════════════════════════════════════════════════════════════════
//
// Implementiert die drei Aktionen, die nach checkExistingTrade
// ausgeführt werden können.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { TradeProposal, ExistingTrade } from "./trade_adjustment_pre_check.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = JSON.parse(readFileSync(resolve(__dirname, "../config.json"), "utf-8"));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;

// ─── DB Helper ─────────────────────────────────────────────────────

async function runSql<T>(query: string): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ sql: query }),
  });
  const result = await response.json();
  if (result.ok === false) {
    throw new Error(`SQL error: ${result.error}`);
  }
  return result.data || [];
}

// ─── 1. Update Existing Trade ─────────────────────────────────────

export async function updateExistingTrade(
  existingTradeId: string,
  proposal: TradeProposal,
  reason: string
): Promise<void> {
  // Erst den alten Stand laden (für Audit)
  const oldRow = await runSql<ExistingTrade>(`
    SELECT 
      id, asset_id, signal_direction,
      entry_price, stop_loss_price, take_profit_price,
      position_size_pct, leverage, risk_reward_ratio,
      opened_at, status,
      original_stop_loss_price, original_take_profit_price,
      original_position_size_pct, original_leverage,
      COALESCE(adjustment_count, 0) AS adjustment_count
    FROM central.paper_trades
    WHERE id = '${existingTradeId}'
  `);

  if (oldRow.length === 0) {
    throw new Error(`Trade ${existingTradeId} not found for update`);
  }

  const old = oldRow[0];

  // Bei erstem Adjustment: Original-Werte snapshotten
  const isFirstAdjustment = old.adjustment_count === 0;
  const originalStop = old.original_stop_loss_price ?? (isFirstAdjustment ? old.stop_loss_price : null);
  const originalTarget = old.original_take_profit_price ?? (isFirstAdjustment ? old.take_profit_price : null);
  const originalPosSize = old.original_position_size_pct ?? (isFirstAdjustment ? old.position_size_pct : null);
  const originalLev = old.original_leverage ?? (isFirstAdjustment ? old.leverage : null);

  // Stop-Loss-Sicherheit: niemals verschlechtern
  const safeStop = computeSafeStop(old.signal_direction, old.stop_loss_price, proposal.stop_loss_price);

  // Calculate change percentages
  const stopLossChangePct = pctDiff(old.stop_loss_price, safeStop);
  const takeProfitChangePct = pctDiff(old.take_profit_price, proposal.take_profit_price);

  // Update paper_trades
  await runSql(`
    UPDATE central.paper_trades
    SET 
      stop_loss_price       = ${safeStop},
      take_profit_price     = ${proposal.take_profit_price},
      position_size_pct     = ${proposal.position_size_pct},
      leverage              = ${proposal.leverage},
      risk_reward_ratio     = ${proposal.risk_reward_ratio},
      original_stop_loss_price   = COALESCE(original_stop_loss_price, ${originalStop ?? 'NULL'}),
      original_take_profit_price = COALESCE(original_take_profit_price, ${originalTarget ?? 'NULL'}),
      original_position_size_pct = COALESCE(original_position_size_pct, ${originalPosSize ?? 'NULL'}),
      original_leverage          = COALESCE(original_leverage, ${originalLev ?? 'NULL'}),
      adjustment_count      = COALESCE(adjustment_count, 0) + 1,
      last_adjusted_at      = NOW()
    WHERE id = '${existingTradeId}'
  `);

  // Insert trade_adjustments (Audit-Log)
  await runSql(`
    INSERT INTO central.trade_adjustments (
      paper_trade_id, alpha_id,
      old_stop_loss_price, new_stop_loss_price,
      old_take_profit_price, new_take_profit_price,
      old_position_size_pct, new_position_size_pct,
      old_leverage, new_leverage,
      old_risk_reward_ratio, new_risk_reward_ratio,
      adjustment_reason,
      old_vreal, new_vreal, alpha_gap_pct_at_update,
      stop_loss_change_pct, take_profit_change_pct
    )
    VALUES (
      '${existingTradeId}',
      '${proposal.alpha_id}',
      ${old.stop_loss_price},
      ${safeStop},
      ${old.take_profit_price},
      ${proposal.take_profit_price},
      ${old.position_size_pct},
      ${proposal.position_size_pct},
      ${old.leverage},
      ${proposal.leverage},
      ${old.risk_reward_ratio},
      ${proposal.risk_reward_ratio},
      '${reason}',
      ${old.vreal_at_open ?? 'NULL'},
      ${proposal.vreal},
      ${proposal.alpha_gap_pct},
      ${stopLossChangePct},
      ${takeProfitChangePct}
    )
  `);

  console.log(`✅ Trade ${existingTradeId.substring(0, 8)} adjusted (reason: ${reason})`);
}

// ─── 2. Reverse Direction (alten closen, neuen erstellen) ─────────

export async function reverseDirection(
  existingTradeId: string,
  proposal: TradeProposal,
  insertNewTrade: (proposal: TradeProposal) => Promise<string>,
  currentMarketPrice?: number
): Promise<{ closedTradeId: string; newTradeId: string }> {
  // 1. Alten Trade closen mit close_reason='signal_reversed'
  // Use current market price for PnL calculation instead of new trade's entry price
  const exitPrice = currentMarketPrice ?? proposal.entry_price;

  // Calculate PnL using the same logic as closeTrade in lifecycle
  const fillPrice = proposal.vreal; // vreal ≈ market price at entry, use as fill price fallback
  const effectiveFill = fillPrice > 0 ? fillPrice : proposal.entry_price;

  let pnlPct = proposal.signal_direction === 'long'
    ? ((exitPrice - effectiveFill) / effectiveFill) * 100
    : ((effectiveFill - exitPrice) / effectiveFill) * 100;

  // Clamp to database limits
  if (Math.abs(pnlPct) > 999) pnlPct = 999 * Math.sign(pnlPct);
  const pnlPctRounded = Math.round(pnlPct * 1000) / 1000;
  const leveragedPct = pnlPctRounded * (proposal.leverage ?? 1);

  await runSql(`
    UPDATE central.paper_trades
    SET 
      status         = 'closed',
      close_reason   = 'signal_reversed',
      exit_price     = ${exitPrice},
      exit_trigger   = 'signal_reversed',
      pnl_pct        = ${pnlPctRounded},
      pnl_leveraged_pct = ${leveragedPct},
      closed_at      = NOW(),
      last_adjusted_at = NOW()
    WHERE id = '${existingTradeId}'
      AND status IN ('pending', 'open')
  `);

  // 2. Audit-Eintrag in trade_adjustments
  await runSql(`
    INSERT INTO central.trade_adjustments (
      paper_trade_id, alpha_id,
      adjustment_reason,
      new_vreal, alpha_gap_pct_at_update
    )
    VALUES (
      '${existingTradeId}',
      '${proposal.alpha_id}',
      'signal_reversed',
      ${proposal.vreal},
      ${proposal.alpha_gap_pct}
    )
  `);

  // 3. Neuen Trade in Gegenrichtung erstellen
  const newTradeId = await insertNewTrade(proposal);

  console.log(
    `🔄 Direction reversed: closed ${existingTradeId.substring(0, 8)}, opened ${newTradeId.substring(0, 8)}`
  );

  return { closedTradeId: existingTradeId, newTradeId };
}

// ─── 3. Log Skip ──────────────────────────────────────────────────

export async function logTradeSkip(
  proposal: TradeProposal,
  existingTradeId: string,
  reason: string,
  confidence?: number
): Promise<void> {
  await runSql(`
    INSERT INTO central.trade_skips (
      asset_id, skip_reason, alpha_confidence, created_at
    )
    VALUES (
      '${proposal.asset_id}',
      '${reason}',
      ${confidence ?? 'NULL'},
      NOW()
    )
  `);

  console.log(`⏭️ Trade skipped: ${reason}`);
}

// ─── Helpers ──────────────────────────────────────────────────────

function pctDiff(oldVal: number, newVal: number): number {
  if (oldVal === 0) return 0;
  return ((newVal - oldVal) / oldVal) * 100;
}

function computeSafeStop(
  direction: 'long' | 'short',
  oldStop: number,
  proposedStop: number
): number {
  // Defensive: niemals Stop verschlechtern
  if (direction === 'long') {
    return Math.max(oldStop, proposedStop);
  } else {
    return Math.min(oldStop, proposedStop);
  }
}