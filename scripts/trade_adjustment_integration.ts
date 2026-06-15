// ═══════════════════════════════════════════════════════════════════
// vectX.ai — L3 Analyze Integration for Trade Adjustment System
// ═══════════════════════════════════════════════════════════════════
//
// Dieser Wrapper ersetzt den direkten insertTradeRow-Aufruf in L3 Analyze.
// Er prüft zuerst auf existierende Trades und entscheidet:
//   - create_new: Trade normal erstellen
//   - update_existing: Bestehenden Trade anpassen
//   - skip: Keine Aktion (keine meaningful change)
//   - reverse_direction: Alten closen, neuen erstellen
// ═══════════════════════════════════════════════════════════════════

import { checkExistingTrade, type TradeProposal, type PreCheckResult } from './trade_adjustment_pre_check.js';
import { updateExistingTrade, reverseDirection, logTradeSkip } from './trade_adjustment_actions.js';

// ─── Type for L3 Analyze Trade Output ─────────────────────────────

export interface L3TradeProposal {
  asset_id: string;
  asset_name: string;
  alpha_id: string;
  signal_direction: 'long' | 'short';
  entry_price: number;
  take_profit_price: number;
  stop_loss_price: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  position_size_pct: number;
  leverage: number;
  risk_reward_ratio: number;
  trade_confidence: number;
  reasoning: Record<string, any>;
  hedge_ticker?: string;
  hedge_direction?: 'long' | 'short';
  hedge_ratio?: number;
  hedge_type?: string;
  // Additional context
  vreal: number;
  alpha_gap_pct: number;
}

export interface ProcessResult {
  action: 'created' | 'updated' | 'skipped' | 'reversed';
  tradeId: string | null;
  details: string;
}

// ─── Main Function: Process Trade Proposal ─────────────────────────

export async function processTradeProposal(
  proposal: L3TradeProposal,
  insertNewTrade: (proposal: L3TradeProposal) => Promise<string>
): Promise<ProcessResult> {
  
  // Convert to TradeProposal format for pre-check
  const tradeProposal: TradeProposal = {
    asset_id: proposal.asset_id,
    alpha_id: proposal.alpha_id,
    signal_direction: proposal.signal_direction,
    entry_price: proposal.entry_price,
    stop_loss_price: proposal.stop_loss_price,
    take_profit_price: proposal.take_profit_price,
    position_size_pct: proposal.position_size_pct,
    leverage: proposal.leverage,
    risk_reward_ratio: proposal.risk_reward_ratio,
    vreal: proposal.vreal,
    alpha_gap_pct: proposal.alpha_gap_pct,
  };

  // SCHRITT 1: Pre-Check
  const checkResult = await checkExistingTrade(tradeProposal);

  console.log(
    `  Pre-check for ${proposal.asset_name} (${proposal.signal_direction}): ${checkResult.action} (${checkResult.reason})`
  );

  // SCHRITT 2: Action nach Pre-Check-Ergebnis
  switch (checkResult.action) {
    
    // ─── Pfad 1: Kein offener Trade → normaler Insert
    case 'create_new': {
      const newTradeId = await insertNewTrade(proposal);
      return {
        action: 'created',
        tradeId: newTradeId,
        details: 'New trade created (no existing open position)',
      };
    }

    // ─── Pfad 2a: Update existing
    case 'update_existing': {
      await updateExistingTrade(
        checkResult.existingTradeId,
        tradeProposal,
        checkResult.reason
      );
      return {
        action: 'updated',
        tradeId: checkResult.existingTradeId,
        details: `Existing trade updated (${checkResult.reason})`,
      };
    }

    // ─── Pfad 2b: Skip (keine meaningful change)
    case 'skip': {
      await logTradeSkip(
        tradeProposal,
        checkResult.existingTradeId,
        checkResult.reason,
        proposal.trade_confidence
      );
      return {
        action: 'skipped',
        tradeId: null,
        details: `Skip: ${checkResult.reason}`,
      };
    }

    // ─── Pfad 3: Direction reversal
    case 'reverse_direction': {
      // Pass current market price for accurate PnL calculation on close
      const currentPrice = tradeProposal.current_price ?? undefined;
      const result = await reverseDirection(
        checkResult.existingTradeId,
        tradeProposal,
        async (p) => {
          // Call the original insert function for new trades
          return await insertNewTrade(proposal);
        },
        currentPrice
      );
      return {
        action: 'reversed',
        tradeId: result.newTradeId,
        details: `Closed ${result.closedTradeId.substring(0, 8)}, opened ${result.newTradeId.substring(0, 8)}`,
      };
    }
  }
}

// ─── Export for use in L3 Analyze ────────────────────────────────

export { checkExistingTrade };
export type { TradeProposal, PreCheckResult };