# Data Quality Improvement - Deployment Plan

## Übersicht

Dies ist der Deploy-Plan für die Daten-Qualitäts-Verbesserungen nach der Analyse vom 2026-05-09.

**Problem:** 95% der RSS-Feeds liefern nur Headlines/Short Snippets, keine echten Artikel-Inhalte.

**Lösung:** 4-Phasen-Plan über 14 Tage.

---

## Tag 1-3: Dashboard (Sofort)

### Deployment

```sql
-- Führe diese Views aus:
-- 01_dashboard_views.sql
```

### Baseline messen

Nach dem Deployment:
```sql
SELECT * FROM central.v_l1_quality_summary;
SELECT * FROM central.v_l1_quality_by_asset;
SELECT * FROM central.v_l1_quality_by_source;
```

### Erfolgskriterien

- Dashboard zeigt täglich Metriken
- Erkennen von Problemen innerhalb 24h (statt Wochen)

---

## Tag 4-7: Source Tiers + Pre-Filter (Shadow Mode)

### Deployment

1. **Source Tiers:**
```sql
-- 02_source_tiers.sql
```

2. **Pre-Filter Framework:**
```typescript
// 03a_keywords.ts
// 03b_pre_filter.ts
```

3. **Reject Log Tabelle:**
```sql
-- 03c_reject_log.sql
```

### Shadow Mode (WICHTIG!)

- **Tag 4-5:** Pre-Filter läuft im Shadow Mode
- **Was das bedeutet:**
  - Jedes Event wird geprüft
  - Rejects werden geloggt in `l1_pre_filter_rejects`
  - Events werden NICHT gefiltert (gehen trotzdem durch)
- **Warum:** Keywords validieren ohne Daten zu verlieren

### Shadow Mode aktivieren

```typescript
// In 03b_pre_filter.ts:
const SHADOW_MODE = true; // Log only, don't filter
```

### Shadow Mode deaktivieren (Tag 6-7)

Nach Validierung:
```typescript
const SHADOW_MODE = false; // Actually filter
```

---

## Tag 8-10: Relevance Score

### Deployment

1. **L1 Analyze Prompt anpassen:**
```typescript
// 04a_relevance_score.ts
```

2. **Low-Relevance Events loggen:**
```sql
-- 04b_low_relevance_schema.sql
```

### Prompt-Erweiterung

Der LLM muss jetzt einen Relevanz-Score 0-10 geben:
- `< 7`: Event verwerfen
- `>= 7`: Event akzeptieren

---

## Datei-Übersicht

| Datei | Was | Wann |
|-------|-----|------|
| `00_deployment_plan.md` | Diese Datei | Jetzt lesen |
| `01_dashboard_views.sql` | 7 SQL Views | Tag 1 |
| `02_source_tiers.sql` | Source-Klassifikation | Tag 2 |
| `03a_keywords.ts` | Asset/Driver Keywords | Tag 4 |
| `03b_pre_filter.ts` | Pre-Filter Framework | Tag 4 |
| `03c_reject_log.sql` | Reject Log Tabelle | Tag 4 |
| `04a_relevance_score.ts` | LLM Relevanz-Score | Tag 8 |
| `04b_low_relevance_schema.sql` | Low-Relevance Tabelle | Tag 8 |

---

## Monitoring

### Tägliche Checks

```sql
-- Dashboard Summary
SELECT * FROM central.v_l1_quality_summary;

-- Events pro Tier
SELECT tier, COUNT(*) FROM central.v_l1_quality_by_source GROUP BY tier;

-- Reject-Reasons (nach Tag 4)
SELECT reject_reason, COUNT(*) 
FROM central.l1_pre_filter_rejects 
WHERE rejected_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```

### Alarm-Schwellen

| Metrik | Schwellenwert | Aktion |
|--------|--------------|--------|
| URL in Summary | > 5% | L1 Collect prüfen |
| Summary = Headline | > 30% | RSS-Feed-Qualität prüfen |
| Events/Asset/Tag | < 20 | Source Coverage prüfen |
| Reject Rate (nach Tag 7) | > 80% | Keywords zu eng |

---

## Keywords validieren

Nach 1-2 Wochen:

```sql
-- Welche Reject-Reasons dominieren?
SELECT reject_reason, COUNT(*) 
FROM central.l1_pre_filter_rejects
WHERE rejected_at > NOW() - INTERVAL '7 days'
GROUP BY 1 ORDER BY 2 DESC;
```

- **`no_asset_match`** → Keywords zu eng
- **`headline_only_no_content`** → Richtige Filter, gewünschtes Verhalten

---

## Erfolgsmessung

Nach 14 Tagen:

1. **Dashboard läuft** → Täglich sichtbar
2. **Shadow Mode beendet** → Pre-Filter aktiv
3. **Relevanz-Score aktiv** → LLM filtert Low-Relevance
4. **Baseline dokumentiert** → Verbesserung messbar

---

## Nächste Schritte

1. Driver-Liste pro Asset bereitstellen (für präzisere Keywords)
2. Keywords in `03a_keywords.ts` verfeinern
3. L1-Analyze-Prompt mit Driver-Beschreibungen erweitern

---

**Status:** Bereit für Deployment
**Empfehlung:** Starte mit Dashboard (Tag 1-3), dann Shadow Mode (Tag 4-7)