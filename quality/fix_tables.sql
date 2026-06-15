-- ═════════════════════════════════════════════════════════════════════════════
-- FIX: Reject Log und Low-Relevance Tables
-- ═════════════════════════════════════════════════════════════════════════════

-- Reject Log Table
CREATE TABLE IF NOT EXISTS central.l1_pre_filter_rejects (
  id BIGSERIAL PRIMARY KEY,
  driver_event_id UUID,
  asset_id UUID,
  asset_ticker VARCHAR(20),
  driver_name VARCHAR(255),
  headline TEXT,
  reject_reason VARCHAR(50) NOT NULL,
  reject_details JSONB,
  rejected_at TIMESTAMPTZ DEFAULT NOW(),
  shadow_mode BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_pre_filter_rejects_rejected_at ON central.l1_pre_filter_rejects(rejected_at DESC);
CREATE INDEX IF NOT EXISTS idx_pre_filter_rejects_asset ON central.l1_pre_filter_rejects(asset_ticker);
CREATE INDEX IF NOT EXISTS idx_pre_filter_rejects_reason ON central.l1_pre_filter_rejects(reject_reason);

-- Low Relevance Table
CREATE TABLE IF NOT EXISTS central.l1_low_relevance_events (
  id BIGSERIAL PRIMARY KEY,
  driver_event_id UUID,
  asset_id UUID,
  asset_ticker VARCHAR(20),
  driver_name VARCHAR(255),
  headline TEXT,
  relevance_score INTEGER,
  llm_impact_score INTEGER,
  llm_sentiment_score NUMERIC,
  llm_driver_name VARCHAR(255),
  skip_reason TEXT,
  rejected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_low_relevance_rejected_at ON central.l1_low_relevance_events(rejected_at DESC);
CREATE INDEX IF NOT EXISTS idx_low_relevance_asset ON central.l1_low_relevance_events(asset_ticker);
CREATE INDEX IF NOT EXISTS idx_low_relevance_score ON central.l1_low_relevance_events(relevance_score);

-- Source Tier Column
ALTER TABLE central.drivers_sources ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'headline_only';
ALTER TABLE central.drivers_sources ADD COLUMN IF NOT EXISTS avg_content_length INTEGER DEFAULT 0;
ALTER TABLE central.drivers_sources ADD COLUMN IF NOT EXISTS last_quality_check TIMESTAMPTZ;

-- Views
CREATE OR REPLACE VIEW central.v_reject_summary AS
SELECT
  reject_reason,
  COUNT(*) as total_rejects,
  COUNT(*) FILTER (WHERE shadow_mode = false) as production_rejects,
  COUNT(*) FILTER (WHERE shadow_mode = true) as shadow_rejects,
  COUNT(DISTINCT asset_ticker) as affected_assets
FROM central.l1_pre_filter_rejects
WHERE rejected_at > NOW() - INTERVAL '24 hours'
GROUP BY reject_reason
ORDER BY total_rejects DESC;

CREATE OR REPLACE VIEW central.v_low_relevance_summary AS
SELECT
  asset_ticker,
  COUNT(*) as total_rejected,
  AVG(relevance_score)::numeric(3,1) as avg_relevance_score,
  MIN(relevance_score) as min_score,
  MAX(relevance_score) as max_score
FROM central.l1_low_relevance_events
WHERE rejected_at > NOW() - INTERVAL '24 hours'
GROUP BY asset_ticker
ORDER BY total_rejected DESC;
