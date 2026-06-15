-- ═════════════════════════════════════════════════════════════════════════════
-- L1 LOW-RELEVANCE EVENTS - Schema
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Zweck: Loggt Events die vom LLM wegen niedriger Relevanz verworfen wurden
-- Deploy: Einmalig ausführen (Tag 8-10)
--
-- Erstellt: 2026-05-09
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Tabelle: l1_low_relevance_events ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS central.l1_low_relevance_events (
  id BIGSERIAL PRIMARY KEY,
  
  -- Welches Event wurde verworfen
  driver_event_id UUID REFERENCES central.drivers_events(id),
  asset_id UUID REFERENCES central.assets(id),
  asset_ticker VARCHAR(20),
  driver_name VARCHAR(255),
  headline TEXT,
  
  -- LLM Output
  relevance_score INTEGER,
  -- 0-10, Events < 7 werden verworfen
  
  llm_impact_score INTEGER,
  llm_sentiment_score NUMERIC,
  llm_driver_name VARCHAR(255),
  
  -- Skip-Reason
  skip_reason TEXT,
  -- Human-readable explanation why this event was skipped
  
  -- Timestamp
  rejected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_low_relevance_rejected_at 
ON central.l1_low_relevance_events(rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_low_relevance_asset 
ON central.l1_low_relevance_events(asset_ticker);

CREATE INDEX IF NOT EXISTS idx_low_relevance_score 
ON central.l1_low_relevance_events(relevance_score);

-- ─── View: Low-Relevance Summary ──────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_low_relevance_summary AS
SELECT
  asset_ticker,
  COUNT(*) as total_rejected,
  AVG(relevance_score)::numeric(3,1) as avg_relevance_score,
  MIN(relevance_score) as min_score,
  MAX(relevance_score) as max_score,
  COUNT(DISTINCT driver_name) as affected_drivers
FROM central.l1_low_relevance_events
WHERE rejected_at > NOW() - INTERVAL '24 hours'
GROUP BY asset_ticker
ORDER BY total_rejected DESC;

COMMENT ON VIEW central.v_low_relevance_summary IS 'L1 Low-Relevance Events by Asset - Last 24 hours';

-- ─── View: Low-Relevance by Reason ────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_low_relevance_by_reason AS
SELECT
  SUBSTRING(skip_reason FROM 1 FOR 50) as reason_preview,
  COUNT(*) as total,
  AVG(relevance_score)::numeric(3,1) as avg_score
FROM central.l1_low_relevance_events
WHERE rejected_at > NOW() - INTERVAL '24 hours'
GROUP BY SUBSTRING(skip_reason FROM 1 FOR 50)
ORDER BY total DESC;

COMMENT ON VIEW central.v_low_relevance_by_reason IS 'L1 Low-Relevance Events by Skip Reason - Last 24 hours';

-- ─── View: Low-Relevance Examples ─────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_low_relevance_examples AS
SELECT
  asset_ticker,
  driver_name,
  LEFT(headline, 60) as headline_preview,
  relevance_score,
  LEFT(skip_reason, 80) as skip_reason_preview,
  rejected_at
FROM central.l1_low_relevance_events
ORDER BY rejected_at DESC
LIMIT 50;

COMMENT ON VIEW central.v_low_relevance_examples IS 'L1 Low-Relevance Event Examples - Last 50';

-- ═════════════════════════════════════════════════════════════════════════════
-- STATISTIKEN
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Wie viele Events werden verworfen?
--   SELECT COUNT(*) FROM central.l1_low_relevance_events 
--   WHERE rejected_at > NOW() - INTERVAL '24 hours';
--
-- Durchschnittlicher Relevanz-Score:
--   SELECT AVG(relevance_score) FROM central.l1_low_relevance_events
--   WHERE rejected_at > NOW() - INTERVAL '24 hours';
--
-- Assets mit meisten Rejects:
--   SELECT * FROM central.v_low_relevance_summary;
--
-- ═════════════════════════════════════════════════════════════════════════════