-- ═══════════════════════════════════════════════════════════════════
-- vectX.ai — Trade Adjustment System (Strategie A2)
-- ═══════════════════════════════════════════════════════════════════

-- ─── Erweiterung paper_trades ─────────────────────────────────────

ALTER TABLE central.paper_trades
  ADD COLUMN IF NOT EXISTS original_stop_loss_price   NUMERIC,
  ADD COLUMN IF NOT EXISTS original_take_profit_price NUMERIC,
  ADD COLUMN IF NOT EXISTS original_position_size_pct NUMERIC,
  ADD COLUMN IF NOT EXISTS original_leverage          NUMERIC,
  ADD COLUMN IF NOT EXISTS original_risk_reward_ratio NUMERIC,
  ADD COLUMN IF NOT EXISTS adjustment_count           INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_adjusted_at           TIMESTAMPTZ;

-- ─── Neue Tabelle: trade_adjustments (Audit-Log) ──────────────────

CREATE TABLE IF NOT EXISTS central.trade_adjustments (
  id                       BIGSERIAL PRIMARY KEY,
  paper_trade_id           UUID NOT NULL REFERENCES central.paper_trades(id) ON DELETE CASCADE,
  alpha_id                 UUID REFERENCES central.alpha(id),
  
  old_stop_loss_price      NUMERIC,
  new_stop_loss_price      NUMERIC,
  old_take_profit_price    NUMERIC,
  new_take_profit_price    NUMERIC,
  old_position_size_pct    NUMERIC,
  new_position_size_pct    NUMERIC,
  old_leverage             NUMERIC,
  new_leverage             NUMERIC,
  old_risk_reward_ratio    NUMERIC,
  new_risk_reward_ratio    NUMERIC,
  
  adjustment_reason        TEXT NOT NULL,
  old_vreal                NUMERIC,
  new_vreal                NUMERIC,
  alpha_gap_pct_at_update  NUMERIC,
  stop_loss_change_pct     NUMERIC,
  take_profit_change_pct   NUMERIC,
  
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_adjustments_trade 
  ON central.trade_adjustments(paper_trade_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_adjustments_alpha 
  ON central.trade_adjustments(alpha_id);

CREATE INDEX IF NOT EXISTS idx_adjustments_created
  ON central.trade_adjustments(created_at DESC);

-- ─── close_reason Spalte ─────────────────────────────────────────

ALTER TABLE central.paper_trades
  ADD COLUMN IF NOT EXISTS close_reason TEXT;

-- ─── Neue Tabelle: trade_skips ────────────────────────────────────

CREATE TABLE IF NOT EXISTS central.trade_skips (
  id              BIGSERIAL PRIMARY KEY,
  asset_id        UUID REFERENCES central.assets(id),
  alpha_id        UUID REFERENCES central.alpha(id),
  signal_direction VARCHAR(10),
  skip_reason     TEXT NOT NULL,
  skip_details    JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skips_created
  ON central.trade_skips(created_at DESC);
