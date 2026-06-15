// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Trade Adjustment Pre-Check
// ═══════════════════════════════════════════════════════════════════
//
// Wird in L3 Analyze aufgerufen, BEVOR ein neuer Trade erstellt wird.
// Drei mögliche Pfade:
//   1. Kein offener Trade → normal new trade erstellen
//   2. Offener Trade, gleiche Direction → Update oder Skip
//   3. Offener Trade, andere Direction → alten closen, neuen erstellen
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = JSON.parse(readFileSync(resolve(__dirname, "../config.json"), "utf-8"));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;

// ─── Configuration ────────────────────────────────────────────────

const ADJUSTMENT_THRESHOLD_PCT = 0.5;  // 0.5% Schwelle für meaningful change
const MAX_TRADE_AGE_DAYS = 14;          // Trades älter als 14d werden ignoriert

// ─── Types ─────────────────────────────────────────────────────────

export type SignalDirection = 'long' | 'short';

export interface TradeProposal {
  asset_id: string;
  alpha_id: string;
  signal_direction: SignalDirection;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  position_size_pct: number;
  leverage: number;
  risk_reward_ratio: number;
  vreal: number;
  alpha_gap_pct: number;
}

export interface ExistingTrade {
  id: string;
  asset_id: string;
  signal_direction: SignalDirection;
  entry_price: number;
  stop_loss_price: number;
  take_profit_price: number;
  position_size_pct: number;
  leverage: number;
  risk_reward_ratio: number;
  opened_at: string;
  status: string;
  original_stop_loss_price: number | null;
  original_take_profit_price: number | null;
  original_position_size_pct: number | null;
  original_leverage: number | null;
  adjustment_count: number;
}

export type PreCheckResult =
  | { action: 'create_new'; reason: string }
  | { action: 'update_existing'; existingTradeId: string; reason: string }
  | { action: 'reverse_direction'; existingTradeId: string; reason: string }
  | { action: 'skip'; existingTradeId: string; reason: string };

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

// ─── Hauptfunktion: Pre-Check ─────────────────────────────────────

export async function checkExistingTrade(
  proposal: TradeProposal
): Promise<PreCheckResult> {
  // Suche offenen Trade auf demselben Asset, der jünger als MAX_TRADE_AGE_DAYS ist
  const result = await runSql<ExistingTrade>(`
    SELECT 
      id, asset_id, signal_direction,
      entry_price, stop_loss_price, take_profit_price,
      position_size_pct, leverage, risk_reward_ratio,
      opened_at, status,
      original_stop_loss_price, original_take_profit_price,
      original_position_size_pct, original_leverage,
      COALESCE(adjustment_count, 0) AS adjustment_count
    FROM central.paper_trades
    WHERE asset_id = '${proposal.asset_id}'
      AND status IN ('pending', 'open')
      AND opened_at > NOW() - INTERVAL '${MAX_TRADE_AGE_DAYS} days'
    ORDER BY opened_at DESC
    LIMIT 1
  `);

  // Pfad 1: Kein offener Trade → normal weiter
  if (result.length === 0) {
    return { action: 'create_new', reason: 'no_existing_open_trade' };
  }

  const existing = result[0];

  // Pfad 3: Direction-Umkehr → alten closen, neuen erstellen
  if (existing.signal_direction !== proposal.signal_direction) {
    return {
      action: 'reverse_direction',
      existingTradeId: existing.id,
      reason: `signal_reversed_from_${existing.signal_direction}_to_${proposal.signal_direction}`,
    };
  }

  // Pfad 2: Gleiche Direction → prüfen ob Update sinnvoll
  const stopChangePct = pctDiff(existing.stop_loss_price, proposal.stop_loss_price);
  const targetChangePct = pctDiff(existing.take_profit_price, proposal.take_profit_price);

  const meaningfulStopChange = Math.abs(stopChangePct) >= ADJUSTMENT_THRESHOLD_PCT;
  const meaningfulTargetChange = Math.abs(targetChangePct) >= ADJUSTMENT_THRESHOLD_PCT;

  if (!meaningfulStopChange && !meaningfulTargetChange) {
    return {
      action: 'skip',
      existingTradeId: existing.id,
      reason: 'no_meaningful_change',
    };
  }

  // Sicherheits-Check: Stop nie verschlechtern
  if (!isStopImprovement(existing, proposal)) {
    return {
      action: 'skip',
      existingTradeId: existing.id,
      reason: 'stop_would_worsen',
    };
  }

  return {
    action: 'update_existing',
    existingTradeId: existing.id,
    reason: meaningfulStopChange && meaningfulTargetChange
      ? 'stop_and_target_drift'
      : meaningfulStopChange
      ? 'stop_drift'
      : 'target_drift',
  };
}

// ─── Helper: prozentuale Differenz ────────────────────────────────

function pctDiff(oldVal: number, newVal: number): number {
  if (oldVal === 0) return 0;
  return ((newVal - oldVal) / oldVal) * 100;
}

// ─── Helper: prüft ob neuer Stop besser oder gleich ist ──────────

function isStopImprovement(
  existing: ExistingTrade,
  proposal: TradeProposal
): boolean {
  if (existing.signal_direction === 'long') {
    // Bei LONG darf neuer Stop nicht UNTER altem Stop sein
    return proposal.stop_loss_price >= existing.stop_loss_price;
  } else {
    // Bei SHORT darf neuer Stop nicht ÜBER altem Stop sein
    return proposal.stop_loss_price <= existing.stop_loss_price;
  }
}

// ─── Export for testing ───────────────────────────────────────────

export { ADJUSTMENT_THRESHOLD_PCT, MAX_TRADE_AGE_DAYS };