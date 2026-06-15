-- ═════════════════════════════════════════════════════════════════════════════
-- L1 SOURCE TIERS - Automatische Klassifikation
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Zweck: RSS-Quellen nach Content-Qualität klassifizieren
-- Deploy: Einmalig ausführen (fügt 'tier' Spalte hinzu)
--
-- Tier-Definitionen:
--   premium      = Durchschnitt >= 200 Zeichen (echter Content)
--   mixed        = Durchschnitt 100-199 Zeichen (mittelmäßig)
--   headline_only = Durchschnitt < 100 Zeichen (nur Headlines)
--
-- Erstellt: 2026-05-09
-- ═════════════════════════════════════════════════════════════════════════════

-- ─── Schema-Erweiterung: tier Spalte ───────────────────────────────────────────

ALTER TABLE central.drivers_sources 
ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'headline_only';

ALTER TABLE central.drivers_sources 
ADD COLUMN IF NOT EXISTS avg_content_length INTEGER DEFAULT 0;

ALTER TABLE central.drivers_sources 
ADD COLUMN IF NOT EXISTS last_quality_check TIMESTAMPTZ;

-- ─── Automatische Tier-Zuweisung basierend auf historischen Daten ─────────────

CREATE OR REPLACE FUNCTION central.update_source_tiers()
RETURNS void AS $$
BEGIN
  -- Berechne avg_content_length und tier für alle Sources
  WITH source_stats AS (
    SELECT 
      de.source_name,
      AVG(LENGTH(de.output))::int as avg_len,
      COUNT(*) as event_count
    FROM central.drivers_events de
    WHERE de.created_at > NOW() - INTERVAL '7 days'
    GROUP BY de.source_name
  )
  UPDATE central.drivers_sources ds
  SET 
    avg_content_length = ss.avg_len,
    tier = CASE 
      WHEN ss.avg_len >= 200 THEN 'premium'
      WHEN ss.avg_len >= 100 THEN 'mixed'
      ELSE 'headline_only'
    END,
    last_quality_check = NOW()
  FROM source_stats ss
  WHERE ds.name = ss.source_name;
  
  -- Sources ohne Events in letzten 7 Tagen bekommen 'unknown'
  UPDATE central.drivers_sources
  SET tier = 'unknown'
  WHERE last_quality_check IS NULL;
END;
$$ LANGUAGE plpgsql;

-- ─── Ausführen ──────────────────────────────────────────────────────────────────

SELECT central.update_source_tiers();

-- ─── View: Source Tier Summary ─────────────────────────────────────────────────

CREATE OR REPLACE VIEW central.v_source_tiers AS
SELECT
  tier,
  COUNT(*) as source_count,
  SUM(event_count) as total_events,
  AVG(avg_content_length)::int as avg_len_in_tier,
  MIN(avg_content_length) as min_len_in_tier,
  MAX(avg_content_length) as max_len_in_tier
FROM (
  SELECT 
    ds.tier,
    ds.avg_content_length,
    COUNT(de.id) as event_count
  FROM central.drivers_sources ds
  LEFT JOIN central.drivers_events de ON de.source_name = ds.name
  WHERE de.created_at > NOW() - INTERVAL '7 days'
  GROUP BY ds.tier, ds.avg_content_length
) sub
GROUP BY tier
ORDER BY 
  CASE tier
    WHEN 'premium' THEN 1
    WHEN 'mixed' THEN 2
    WHEN 'headline_only' THEN 3
    ELSE 4
  END;

COMMENT ON VIEW central.v_source_tiers IS 'L1 Source Tier Summary - Grouped by tier';

-- ─── View: Premium Sources (für Qualitäts-Analyse) ─────────────────────────────

CREATE OR REPLACE VIEW central.v_premium_sources AS
SELECT
  ds.name as source_name,
  ds.tier,
  ds.avg_content_length,
  COUNT(de.id) as events_last_7d,
  COUNT(*) FILTER (WHERE LENGTH(de.output) >= 200) as good_events,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(de.output) >= 200) / NULLIF(COUNT(*), 0), 1) as good_pct
FROM central.drivers_sources ds
JOIN central.drivers_events de ON de.source_name = ds.name
WHERE ds.tier = 'premium'
AND de.created_at > NOW() - INTERVAL '7 days'
GROUP BY ds.name, ds.tier, ds.avg_content_length
ORDER BY events_last_7d DESC;

COMMENT ON VIEW central.v_premium_sources IS 'Premium Sources (>= 200 char avg content)';

-- ─── View: Headline-Only Sources (für Ausschluss-Überlegungen) ────────────────

CREATE OR REPLACE VIEW central.v_headline_only_sources AS
SELECT
  ds.name as source_name,
  ds.tier,
  ds.avg_content_length,
  COUNT(de.id) as events_last_7d,
  COUNT(*) FILTER (WHERE LENGTH(de.output) < 50) as very_short_events,
  ROUND(100.0 * COUNT(*) FILTER (WHERE LENGTH(de.output) < 50) / NULLIF(COUNT(*), 0), 1) as very_short_pct
FROM central.drivers_sources ds
JOIN central.drivers_events de ON de.source_name = ds.name
WHERE ds.tier = 'headline_only'
AND de.created_at > NOW() - INTERVAL '7 days'
GROUP BY ds.name, ds.tier, ds.avg_content_length
ORDER BY events_last_7d DESC;

COMMENT ON VIEW central.v_headline_only_sources IS 'Headline-Only Sources (< 100 char avg)';

-- ─── Index für Performance ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_drivers_sources_tier 
ON central.drivers_sources(tier);

CREATE INDEX IF NOT EXISTS idx_drivers_events_source_name 
ON central.drivers_events(source_name);

-- ═════════════════════════════════════════════════════════════════════════════
-- VERWENDUNG
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Tier-Übersicht:
--   SELECT * FROM central.v_source_tiers;
--
-- Premium Sources:
--   SELECT * FROM central.v_premium_sources;
--
-- Headline-Only Sources:
--   SELECT * FROM central.v_headline_only_sources;
--
-- Tier eines bestimmten Source:
--   SELECT name, tier, avg_content_length 
--   FROM central.drivers_sources 
--   WHERE name LIKE '%OilPrice%';
--
-- ─── CANDIDATES FÜR MANUELLE ANPASSUNG ────────────────────────────────────────
--
-- Nach dem Deployment:
-- 1. Prüfe v_premium_sources - sind diese Sources wirklich gut?
-- 2. Prüfe v_headline_only_sources - sollen diese behalten werden?
-- 3. Manuelles Tier-Update falls nötig:
--
--    UPDATE central.drivers_sources 
--    SET tier = 'premium' 
--    WHERE name LIKE '%SCMP%' OR name LIKE '%OilPrice%';
--
-- ═════════════════════════════════════════════════════════════════════════════