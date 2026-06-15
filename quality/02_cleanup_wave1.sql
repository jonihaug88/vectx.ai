-- ═════════════════════════════════════════════════════════════════════════════
-- FILE: 02_cleanup_wave1.sql
-- PURPOSE: Deactivate top 3 generic sources (MarketWatch, CNBC Markets, Bloomberg Markets)
-- CREATED: 2026-05-10
-- ═════════════════════════════════════════════════════════════════════════════
--
-- BEFORE RUNNING:
--   1. Run 01_quality_report.sql FIRST
--   2. Verify v_cleanup_wave1_targets shows exactly 60 rows
--   3. Review the targets - they should be MarketWatch, CNBC Markets, Bloomberg Markets
--
-- AFTER RUNNING:
--   SELECT COUNT(*) FROM central.drivers_sources WHERE active = false;
--   SELECT * FROM central.cleanup_log ORDER BY created_at DESC LIMIT 10;
--
-- ROLLBACK:
--   CALL central.rollback_cleanup_wave1();
--
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 0: Create Cleanup Log Table
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS central.cleanup_log (
  id BIGSERIAL PRIMARY KEY,
  cleanup_wave VARCHAR(50),
  source_name VARCHAR(255),
  ticker VARCHAR(20),
  action VARCHAR(50),
  previous_state JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_wave ON central.cleanup_log(cleanup_wave);
CREATE INDEX IF NOT EXISTS idx_cleanup_log_source ON central.cleanup_log(source_name);

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 1: DRY-RUN - Verify Targets (DO NOT SKIP!)
-- ═════════════════════════════════════════════════════════════════════════════

-- Run this FIRST to see what will be affected:
-- SELECT * FROM central.v_cleanup_wave1_targets;

-- Count targets:
-- SELECT COUNT(*) AS total_targets FROM central.v_cleanup_wave1_targets;

-- Expected: ~60 rows (3 sources × 20 assets)
-- If count differs significantly, STOP and investigate!

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 2: Snapshot Current State (Before Cleanup)
-- ═════════════════════════════════════════════════════════════════════════════

INSERT INTO central.cleanup_log (cleanup_wave, source_name, ticker, action, previous_state, notes)
SELECT 
  'wave1_generic_sources' AS cleanup_wave,
  ds.name AS source_name,
  a.ticker,
  'PRE_SNAPSHOT' AS action,
  jsonb_build_object(
    'source_id', ds.id,
    'asset_id', ds.asset_id::text,
    'driver_id', ds.driver_id::text,
    'active', ds.active,
    'trust_score', ds.trust_score,
    'impact_score', ds.impact_score,
    'url', ds.url
  ) AS previous_state,
  'State before Wave 1 cleanup' AS notes
FROM central.drivers_sources ds
JOIN central.assets a ON ds.asset_id = a.id
WHERE ds.name IN ('MarketWatch', 'CNBC Markets', 'Bloomberg Markets')
AND ds.active = true;

-- Verify snapshot:
-- SELECT COUNT(*) AS snapshotted FROM central.cleanup_log WHERE cleanup_wave = 'wave1_generic_sources' AND action = 'PRE_SNAPSHOT';

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 3: Execute Cleanup (Active → Inactive)
-- ═════════════════════════════════════════════════════════════════════════════

BEGIN;

-- Deactivate the targets
UPDATE central.drivers_sources
SET 
  active = false,
  last_result = 'Deactivated - Wave 1 generic source cleanup',
  last_error = NULL
WHERE name IN ('MarketWatch', 'CNBC Markets', 'Bloomberg Markets')
AND active = true;

-- Log the action
INSERT INTO central.cleanup_log (cleanup_wave, source_name, ticker, action, previous_state, notes)
SELECT 
  'wave1_generic_sources' AS cleanup_wave,
  ds.name AS source_name,
  a.ticker,
  'DEACTIVATED' AS action,
  jsonb_build_object('source_id', ds.id::text, 'active', true) AS previous_state,
  'Generic source deactivated - low match rate' AS notes
FROM central.drivers_sources ds
JOIN central.assets a ON ds.asset_id = a.id
WHERE ds.name IN ('MarketWatch', 'CNBC Markets', 'Bloomberg Markets')
AND ds.active = false;

-- Verify before commit
-- SELECT COUNT(*) AS deactivated FROM central.cleanup_log WHERE cleanup_wave = 'wave1_generic_sources' AND action = 'DEACTIVATED';

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 4: Post-Cleanup Verification
-- ═════════════════════════════════════════════════════════════════════════════

-- Check deactivated sources:
-- SELECT name, COUNT(*) FROM central.drivers_sources WHERE name IN ('MarketWatch', 'CNBC Markets', 'Bloomberg Markets') GROUP BY name;

-- Check total active sources remaining:
-- SELECT COUNT(DISTINCT name) AS active_sources FROM central.drivers_sources WHERE active = true;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 5: Rollback Procedure (If Needed)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE PROCEDURE central.rollback_cleanup_wave1()
LANGUAGE plpgsql
AS $$
DECLARE
  rec RECORD;
  rollback_count INT := 0;
BEGIN
  FOR rec IN 
    SELECT DISTINCT source_name 
    FROM central.cleanup_log 
    WHERE cleanup_wave = 'wave1_generic_sources' 
    AND action = 'DEACTIVATED'
  LOOP
    UPDATE central.drivers_sources
    SET 
      active = true,
      last_result = 'Reactivated - Rollback Wave 1'
    WHERE name = rec.source_name
    AND active = false;
    
    rollback_count := rollback_count + 1;
  END LOOP;
  
  INSERT INTO central.cleanup_log (cleanup_wave, source_name, action, notes)
  VALUES ('wave1_generic_sources', 'ROLLBACK', 'ROLLBACK_COMPLETE', 
          format('Rolled back %s sources', rollback_count));
  
  RAISE NOTICE 'Rollback complete. % sources reactivated.', rollback_count;
END;
$$;

-- To rollback:
-- CALL central.rollback_cleanup_wave1();

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 6: Metrics View (Track Improvement)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW central.v_cleanup_metrics AS
SELECT 
  'wave1_generic_sources' AS cleanup_wave,
  COUNT(*) FILTER (WHERE action = 'PRE_SNAPSHOT') AS targets_identified,
  COUNT(*) FILTER (WHERE action = 'DEACTIVATED') AS targets_deactivated,
  COUNT(*) FILTER (WHERE action = 'ROLLBACK_COMPLETE') AS rollbacks,
  MIN(created_at) AS started_at,
  MAX(created_at) FILTER (WHERE action = 'DEACTIVATED') AS completed_at
FROM central.cleanup_log
WHERE cleanup_wave = 'wave1_generic_sources';

-- ═════════════════════════════════════════════════════════════════════════════
-- EXECUTION SUMMARY
-- ═════════════════════════════════════════════════════════════════════════════
--
-- BEFORE:
--   1. Run 01_quality_report.sql
--   2. SELECT * FROM central.v_cleanup_wave1_targets;
--   3. Expect ~60 rows (3 sources × 20 assets)
--
-- EXECUTE:
--   1. Run this file (psql -f 02_cleanup_wave1.sql)
--   2. Check SELECT * FROM central.v_cleanup_metrics;
--
-- AFTER:
--   1. Monitor event volume for 7 days
--   2. Check match rate improvement
--   3. If issues: CALL central.rollback_cleanup_wave1();
--
-- WAVE 2 PLANNING:
--   1. After 7 days, review v_source_match_rate
--   2. Identify next batch of <15% match rate sources
--   3. Create 02_cleanup_wave2.sql
--
-- ═════════════════════════════════════════════════════════════════════════════
-- END OF FILE
-- ═════════════════════════════════════════════════════════════════════════════