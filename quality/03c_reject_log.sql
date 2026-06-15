-- ═════════════════════════════════════════════════════════════════════════════
-- L1 PRE-FILTER REJECT LOG - Schema
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Zweck: Loggt alle verworfenen Events (Shadow Mode und Production Mode)
-- Deploy: Einmalig ausführen
--
-- Erstellt: 2026-05-09
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Tabelle: l1_pre_filter_rejects ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS central.l1_pre_filter_rejects (
  id BIGSERIAL PRIMARY KEY,
  
  -- Welches Event wurde verworfen
  driver_event_id UUID REFERENCES central.drivers_events(id),
  asset_id UUID REFERENCES central.assets(id),
  asset_ticker VARCHAR(20),
  driver_name VARCHAR(255),
  headline TEXT,
  
  -- Warum verworfen
  reject_reason VARCHAR(50) NOT NULL,
  -- 'no_asset_match' = Kein Asset-Keyword gefunden
  -- 'excluded' = Ausschluss-Keyword gefunden
  -- 'headline_only_no_content' = Nur Headline, kein Content
  -- 'low_relevance' = LLM-Relevanz < 7 (nach Tag 8)
  
  -- Details
  reject_details JSONB,
  -- Enthält: matching_assets, exclude_match, primary_match, etc.
  
  -- Timestamp
  rejected_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Shadow Mode Flag
  shadow_mode BOOLEAN DEFAULT false
  -- true = Nur geloggt, nicht gefiltert (Shadow Mode)
  -- false = Event wurde wirklich verworfen (Production Mode)
);

CREATE INDEX IF NOT EXISTS idx_pre_filter_rejects_rejected_at 
ON central.l1_pre_filter_rejects(rejected_at DESC);

CREATE INDEX IF NOT EXISTS idx_pre_filter_rejects_asset 
ON central.l1_pre_filter_rejects(asset_ticker);

CREATE INDEX IF NOT EXISTS idx_pre_filter_rejects_reason 
ON central.l1_pre_filter_rejects(reject_reason);

-- ─── View: Reject Summary (Täglich) ─────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_reject_summary AS
SELECT
  reject_reason,
  COUNT(*) as total_rejects,
  COUNT(*) FILTER (WHERE shadow_mode = false) as production_rejects,
  COUNT(*) FILTER (WHERE shadow_mode = true) as shadow_rejects,
  COUNT(DISTINCT asset_ticker) as affected_assets,
  COUNT(DISTINCT driver_name) as affected_drivers
FROM central.l1_pre_filter_rejects
WHERE rejected_at > NOW() - INTERVAL '24 hours'
GROUP BY reject_reason
ORDER BY total_rejects DESC;

COMMENT ON VIEW central.v_reject_summary IS 'L1 Pre-Filter Reject Summary - Last 24 hours';

-- ─── View: Reject by Asset ─────────────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_reject_by_asset AS
SELECT
  asset_ticker,
  reject_reason,
  COUNT(*) as reject_count,
  ROUND(100.0 * COUNT(*) / NULLIF(
    (SELECT COUNT(*) FROM central.l1_pre_filter_rejects WHERE rejected_at > NOW() - INTERVAL '24 hours'),
    0
  ), 1) as pct_of_total
FROM central.l1_pre_filter_rejects
WHERE rejected_at > NOW() - INTERVAL '24 hours'
GROUP BY asset_ticker, reject_reason
ORDER BY asset_ticker, reject_count DESC;

COMMENT ON VIEW central.v_reject_by_asset IS 'L1 Pre-Filter Rejects by Asset - Last 24 hours';

-- ─── View: Recent Rejects (Beispiel-Events) ─────────────────────────────────────

CREATE OR REPLACE VIEW central.v_recent_rejects AS
SELECT
  r.id,
  r.asset_ticker,
  r.driver_name,
  LEFT(r.headline, 80) as headline_preview,
  r.reject_reason,
  r.shadow_mode,
  r.rejected_at
FROM central.l1_pre_filter_rejects r
ORDER BY r.rejected_at DESC
LIMIT 100;

COMMENT ON VIEW central.v_recent_rejects IS 'L1 Pre-Filter Recent Rejects - Last 100';

-- ═════════════════════════════════════════════════════════════════════════════
-- VERWENDUNG
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Reject-Reasons analysieren:
--   SELECT * FROM central.v_reject_summary;
--
-- Asset-spezifische Rejects:
--   SELECT * FROM central.v_reject_by_asset WHERE asset_ticker = 'WTI';
--
-- Letzte 100 Rejects:
--   SELECT * FROM central.v_recent_rejects;
--
-- Shadow Mode vs Production:
--   SELECT shadow_mode, COUNT(*) 
--   FROM central.l1_pre_filter_rejects 
--   WHERE rejected_at > NOW() - INTERVAL '7 days'
--   GROUP BY shadow_mode;
--
-- ═════════════════════════════════════════════════════════════════════════════