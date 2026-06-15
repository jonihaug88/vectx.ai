-- ═════════════════════════════════════════════════════════════════════════════
-- L1 DATA QUALITY DASHBOARD - SQL Views
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Zweck: Tägliche Überwachung der L1-Datenqualität
-- Deploy: Einmalig ausführen, Views bleiben erhalten
-- Nutzung: SELECT * FROM central.v_l1_quality_summary;
--
-- Erstellt: 2026-05-09
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── View 1: Quality Summary (Gesamtübersicht) ─────────────────────────────────

CREATE OR REPLACE VIEW central.v_l1_quality_summary AS
SELECT
  'driver_events' as table_name,
  COUNT(*)::text as total_events,
  COUNT(*) FILTER (WHERE LENGTH(output) >= 200)::text as good_content,
  COUNT(*) FILTER (WHERE LENGTH(output) BETWEEN 50 AND 199)::text as medium_content,
  COUNT(*) FILTER (WHERE LENGTH(output) < 50)::text as short_content,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(output) >= 200) / NULLIF(COUNT(*), 0), 1)::text as good_pct,
  COUNT(*) FILTER (WHERE output LIKE 'http%')::text as url_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE output LIKE 'http%') / NULLIF(COUNT(*), 0), 1)::text as url_pct
FROM central.drivers_events
WHERE created_at > NOW() - INTERVAL '24 hours'

UNION ALL

SELECT
  'events' as table_name,
  COUNT(*)::text as total_events,
  COUNT(*) FILTER (WHERE LENGTH(summary) >= 200)::text as good_content,
  COUNT(*) FILTER (WHERE LENGTH(summary) BETWEEN 50 AND 199)::text as medium_content,
  COUNT(*) FILTER (WHERE LENGTH(summary) < 50)::text as short_content,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(summary) >= 200) / NULLIF(COUNT(*), 0), 1)::text as good_pct,
  COUNT(*) FILTER (WHERE summary LIKE 'http%')::text as url_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE summary LIKE 'http%') / NULLIF(COUNT(*), 0), 1)::text as url_pct
FROM central.events
WHERE created_at > NOW() - INTERVAL '24 hours';

COMMENT ON VIEW central.v_l1_quality_summary IS 'L1 Data Quality Summary - Last 24 hours';

-- ─── View 2: Quality by Asset ──────────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_l1_quality_by_asset AS
SELECT
  a.ticker,
  a.name as asset_name,
  COUNT(e.id) as total_events,
  COUNT(*) FILTER (WHERE LENGTH(e.summary) >= 200) as good_content,
  COUNT(*) FILTER (WHERE LENGTH(e.summary) BETWEEN 50 AND 199) as medium_content,
  COUNT(*) FILTER (WHERE LENGTH(e.summary) < 50) as short_content,
  COUNT(*) FILTER (WHERE e.summary LIKE 'http%') as url_in_summary,
  COUNT(*) FILTER (WHERE e.summary = e.headline) as same_as_headline,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(e.summary) >= 200) / NULLIF(COUNT(*), 0), 1) as good_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE e.summary = e.headline) / NULLIF(COUNT(*), 0), 1) as headline_pct
FROM central.events e
JOIN central.assets a ON e.asset_id = a.id
WHERE e.created_at > NOW() - INTERVAL '24 hours'
GROUP BY a.ticker, a.name
ORDER BY good_pct ASC NULLS LAST;

COMMENT ON VIEW central.v_l1_quality_by_asset IS 'L1 Quality Metrics by Asset - Last 24 hours';

-- ─── View 3: Quality by Source ────────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_l1_quality_by_source AS
SELECT
  de.source_name,
  COUNT(*) as total_events,
  AVG(LENGTH(de.output))::int as avg_content_length,
  MIN(LENGTH(de.output)) as min_content_length,
  MAX(LENGTH(de.output)) as max_content_length,
  COUNT(*) FILTER (WHERE LENGTH(de.output) >= 200) as good_count,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(de.output) >= 200) / NULLIF(COUNT(*), 0), 1) as good_pct,
  CASE 
    WHEN AVG(LENGTH(de.output)) >= 200 THEN 'premium'
    WHEN AVG(LENGTH(de.output)) >= 100 THEN 'mixed'
    ELSE 'headline_only'
  END as tier
FROM central.drivers_events de
WHERE de.created_at > NOW() - INTERVAL '24 hours'
GROUP BY de.source_name
ORDER BY total_events DESC;

COMMENT ON VIEW central.v_l1_quality_by_source IS 'L1 Quality Metrics by RSS Source - Last 24 hours';

-- ─── View 4: Asset Coverage (Events per Asset per Day) ───────────────────────

CREATE OR REPLACE VIEW central.v_l1_asset_coverage AS
SELECT
  a.ticker,
  COUNT(e.id) as events_24h,
  COUNT(DISTINCT e.driver_name) as unique_drivers,
  MIN(e.created_at) as first_event,
  MAX(e.created_at) as last_event
FROM central.assets a
LEFT JOIN central.events e ON e.asset_id = a.id AND e.created_at > NOW() - INTERVAL '24 hours'
GROUP BY a.ticker
ORDER BY events_24h DESC;

COMMENT ON VIEW central.v_l1_asset_coverage IS 'L1 Asset Coverage - Events per Asset in Last 24 hours';

-- ─── View 5: Quality Timeline (Hourly) ────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_l1_quality_timeline AS
SELECT
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE LENGTH(summary) >= 200) as good_events,
  COUNT(*) FILTER (WHERE summary LIKE 'http%') as url_events,
  COUNT(*) FILTER (WHERE summary = headline) as headline_events,
  AVG(LENGTH(summary))::int as avg_length
FROM central.events
WHERE created_at > NOW() - INTERVAL '48 hours'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW central.v_l1_quality_timeline IS 'L1 Quality Timeline - Last 48 hours by hour';

-- ─── View 6: Driver-Asset Mismatch Detection (Heuristic) ─────────────────────

CREATE OR REPLACE VIEW central.v_l1_mismatch_detection AS
SELECT
  a.ticker,
  e.driver_name,
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE 
    -- Heuristic: Asset name or ticker should appear in headline
    LOWER(e.headline) NOT LIKE '%' || LOWER(SPLIT_PART(a.name, ' ', 1)) || '%'
    AND LOWER(e.headline) NOT LIKE '%' || LOWER(a.ticker) || '%'
    AND LOWER(e.headline) NOT LIKE '%oil%'  -- Common commodity terms
    AND LOWER(e.headline) NOT LIKE '%gas%'
    AND LOWER(e.headline) NOT LIKE '%crude%'
    AND LOWER(e.headline) NOT LIKE '%forex%'
    AND LOWER(e.headline) NOT LIKE '%currency%'
    AND LOWER(e.headline) NOT LIKE '%dollar%'
    AND LOWER(e.headline) NOT LIKE '%fed%'
    AND LOWER(e.headline) NOT LIKE '%central bank%'
  ) as potential_mismatch,
  ROUND(100.0 * COUNT(*) FILTER (WHERE 
    LOWER(e.headline) NOT LIKE '%' || LOWER(SPLIT_PART(a.name, ' ', 1)) || '%'
    AND LOWER(e.headline) NOT LIKE '%' || LOWER(a.ticker) || '%'
    AND LOWER(e.headline) NOT LIKE '%oil%'
    AND LOWER(e.headline) NOT LIKE '%gas%'
    AND LOWER(e.headline) NOT LIKE '%crude%'
    AND LOWER(e.headline) NOT LIKE '%forex%'
    AND LOWER(e.headline) NOT LIKE '%currency%'
    AND LOWER(e.headline) NOT LIKE '%dollar%'
    AND LOWER(e.headline) NOT LIKE '%fed%'
    AND LOWER(e.headline) NOT LIKE '%central bank%'
  ) / NULLIF(COUNT(*), 0), 1) as mismatch_pct
FROM central.events e
JOIN central.assets a ON e.asset_id = a.id
WHERE e.created_at > NOW() - INTERVAL '24 hours'
GROUP BY a.ticker, e.driver_name
HAVING COUNT(*) > 5
ORDER BY mismatch_pct DESC NULLS LAST
LIMIT 20;

COMMENT ON VIEW central.v_l1_mismatch_detection IS 'L1 Driver-Asset Mismatch Detection - Potential misclassifications';

-- ─── View 7: Daily Quality Baseline (for tracking) ─────────────────────────────

CREATE OR REPLACE VIEW central.v_l1_daily_baseline AS
SELECT
  DATE(created_at) as date,
  COUNT(*) as total_events,
  COUNT(*) FILTER (WHERE LENGTH(summary) >= 200) as good_events,
  COUNT(*) FILTER (WHERE summary LIKE 'http%') as url_events,
  COUNT(*) FILTER (WHERE summary = headline) as headline_events,
  COUNT(DISTINCT asset_id) as assets_covered,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(summary) >= 200) / NULLIF(COUNT(*), 0), 1) as good_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE summary LIKE 'http%') / NULLIF(COUNT(*), 0), 1) as url_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE summary = headline) / NULLIF(COUNT(*), 0), 1) as headline_pct
FROM central.events
GROUP BY 1
ORDER BY 1 DESC
LIMIT 30;

COMMENT ON VIEW central.v_l1_daily_baseline IS 'L1 Daily Quality Baseline - Last 30 days';

-- ═════════════════════════════════════════════════════════════════════════════
-- VERWENDUNG
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Täglicher Check:
--   SELECT * FROM central.v_l1_quality_summary;
--   SELECT * FROM central.v_l1_quality_by_asset;
--   SELECT * FROM central.v_l1_quality_by_source WHERE good_pct < 20;
--
-- Alarm-Schwellen:
--   url_pct > 5%          → L1 Collect prüfen
--   headline_pct > 30%    → RSS-Qualität prüfen
--   assets_covered < 15   → Source Coverage prüfen
--   good_pct < 10%        → Overall Quality zu niedrig
--
-- ═════════════════════════════════════════════════════════════════════════════