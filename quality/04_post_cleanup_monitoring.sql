-- ═══════════════════════════════════════════════════════════════════
-- vectX.ai — Post-Cleanup Daily Monitoring (7 Tage)
-- ═══════════════════════════════════════════════════════════════════
--
-- Cleanup Welle 1 wurde am 2026-05-10 ausgeführt.
-- Folgende Metriken sollten täglich beobachtet werden, um zu prüfen
-- ob der Cleanup die erwartete Wirkung hat.
--
-- BAUEN AUF: bestehende Views aus 01_dashboard_views.sql
-- ═══════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════
-- Query 1: Event-Volume Trend
-- ═══════════════════════════════════════════════════════════════════
-- ZIEL: ~40% Rückgang nach Cleanup, dann stabilisierend
-- ALARM: Volume sinkt um >70% → Cleanup zu aggressiv
-- ALARM: Volume bleibt bei alten Werten → Cleanup hat nicht gegriffen

SELECT 
  DATE(created_at) AS day,
  COUNT(*) AS driver_events,
  COUNT(*) FILTER (WHERE quality_tag = 'high') AS high_quality_events,
  COUNT(*) FILTER (WHERE quality_tag IN ('url_only', 'headline_dup', 'empty')) AS broken_events
FROM central.driver_events
WHERE created_at > NOW() - INTERVAL '14 days'
GROUP BY DATE(created_at)
ORDER BY day DESC;


-- ═══════════════════════════════════════════════════════════════════
-- Query 2: Asset-Coverage (kritisch!)
-- ═══════════════════════════════════════════════════════════════════
-- ZIEL: Jedes Asset hat ≥ 30 Events pro Tag
-- ALARM: Ein Asset hat < 10 Events pro Tag → Coverage-Problem

SELECT 
  asset_name,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS events_24h,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS events_7d,
  ROUND(
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::numeric / 7, 1
  ) AS avg_events_per_day
FROM central.events
GROUP BY asset_name
ORDER BY events_24h ASC;


-- ═══════════════════════════════════════════════════════════════════
-- Query 3: Match-Rate-Verbesserung
-- ═══════════════════════════════════════════════════════════════════
-- ZIEL: Match-Rate steigt deutlich (idealerweise von 25% auf 50%+)

WITH matched AS (
  SELECT 
    de.id,
    de.created_at,
    EXISTS (
      SELECT 1 
      FROM central.drivers_sources ds
      JOIN central.assets a ON a.id = ds.asset_id
      JOIN central.asset_match_keywords amk ON amk.asset_symbol = a.symbol
      WHERE ds.source_name = de.source_name
        AND ds.active = true
        AND POSITION(LOWER(amk.keyword) IN LOWER(de.headline)) > 0
    ) AS has_match
  FROM central.driver_events de
  WHERE de.created_at > NOW() - INTERVAL '7 days'
)
SELECT 
  DATE(created_at) AS day,
  COUNT(*) AS events,
  COUNT(*) FILTER (WHERE has_match) AS matched,
  ROUND(100.0 * COUNT(*) FILTER (WHERE has_match) / NULLIF(COUNT(*), 0), 1) AS match_pct
FROM matched
GROUP BY DATE(created_at)
ORDER BY day DESC;


-- ═══════════════════════════════════════════════════════════════════
-- Query 4: Verbleibende Source-Quality (welche sind als nächstes dran?)
-- ═══════════════════════════════════════════════════════════════════
-- Nur AKTIVE Sources nach Cleanup. Top-10 schlechteste anzeigen.

SELECT 
  source_name,
  asset_symbol,
  total_events_7d,
  match_rate_pct,
  classification,
  suggested_action
FROM central.v_source_quality_report
WHERE source_name NOT IN (
  -- Bereits in Welle 1 deaktivierte Sources ausblenden
  SELECT DISTINCT source_name 
  FROM central.source_cleanup_log 
  WHERE cleanup_wave = 1 AND action = 'deactivated'
)
AND classification = 'REMOVE'
ORDER BY match_rate_pct ASC, total_events_7d DESC
LIMIT 20;


-- ═══════════════════════════════════════════════════════════════════
-- Query 5: Wöchentliche Zusammenfassung (am Ende von Tag 7)
-- ═══════════════════════════════════════════════════════════════════

WITH before_cleanup AS (
  SELECT 
    'before' AS period,
    COUNT(*) AS events,
    COUNT(*) FILTER (WHERE quality_tag = 'high') AS high_quality
  FROM central.driver_events
  WHERE created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
),
after_cleanup AS (
  SELECT 
    'after' AS period,
    COUNT(*) AS events,
    COUNT(*) FILTER (WHERE quality_tag = 'high') AS high_quality
  FROM central.driver_events
  WHERE created_at > NOW() - INTERVAL '7 days'
)
SELECT * FROM before_cleanup
UNION ALL
SELECT * FROM after_cleanup;


-- ═══════════════════════════════════════════════════════════════════
-- Eine ENTSPANNTE Routine für die nächsten 7 Tage
-- ═══════════════════════════════════════════════════════════════════
--
-- Tag 1-2: Query 1 + Query 2 — sind Volume und Asset-Coverage okay?
-- Tag 3-5: Query 1 + Query 3 — verbessert sich Match-Rate?
-- Tag 7:   Query 5 — gesamthafte Vorher-Nachher-Analyse
-- Tag 7:   Query 4 — ist Welle 2 nötig?
--
-- Was du NICHT machen solltest:
-- - Jeden Tag Welle 2 planen, weil "Match-Rate noch nicht ideal"
-- - Bei Tag 3 schon "korrigierende" Cleanups starten
-- - Asset-Keywords während dieser 7 Tage nochmal anpassen
--   (verfälscht die Match-Rate-Messung)
--
-- Beobachten ist eine aktive Tätigkeit. Sie sieht nur passiv aus.