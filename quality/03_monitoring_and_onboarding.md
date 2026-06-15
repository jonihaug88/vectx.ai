# Monitoring Plan & Source Onboarding Checklist

**Created:** 2026-05-10
**Purpose:** 7-day monitoring after Wave 1 cleanup + onboarding checklist for future sources

---

## Part 1: 7-Day Monitoring Plan

### Daily Metrics to Track

**Morning (08:00 CET):**
```sql
-- Event volume comparison
SELECT 
  DATE(created_at) AS date,
  COUNT(*) AS events
FROM central.drivers_events
WHERE created_at > NOW() - INTERVAL '8 days'
GROUP BY DATE(created_at)
ORDER BY date;

-- Match rate by asset
SELECT * FROM central.v_asset_mismatch_summary
ORDER BY avg_match_rate ASC;

-- Source quality check
SELECT * FROM central.v_source_quality_summary
WHERE total_mappings > 5
ORDER BY avg_match_rate ASC;
```

**Evening (20:00 CET):**
```sql
-- New events by source (check for deactivated sources)
SELECT 
  ds.name AS source_name,
  COUNT(*) AS new_events
FROM central.drivers_events de
JOIN central.drivers_sources ds ON de.source_id = ds.id
WHERE de.created_at > NOW() - INTERVAL '12 hours'
GROUP BY ds.name
ORDER BY new_events DESC
LIMIT 20;

-- Verify deactivated sources are NOT producing events
SELECT 
  ds.name AS source_name,
  ds.active,
  COUNT(*) AS events_24h
FROM central.drivers_sources ds
LEFT JOIN central.drivers_events de ON de.source_id = ds.id 
  AND de.created_at > NOW() - INTERVAL '24 hours'
WHERE ds.name IN ('MarketWatch', 'CNBC Markets', 'Bloomberg Markets')
GROUP BY ds.name, ds.active;
```

### Day-by-Day Monitoring

#### Day 1 (Cleanup Day)
- [ ] Run `02_cleanup_wave1.sql`
- [ ] Verify 60 mappings deactivated
- [ ] Check `v_cleanup_metrics` shows correct counts
- [ ] Confirm no events from deactivated sources in next 12h

#### Day 2-3 (Early Observation)
- [ ] Check event volume - expect ~10-15% drop (generic sources removed)
- [ ] Verify match rate improvement in `v_source_match_rate`
- [ ] Check for any unexpected gaps in asset coverage
- [ ] Review `v_asset_mismatch_summary` - which assets improved most?

#### Day 4-5 (Mid-Week Check)
- [ ] Calculate actual match rate improvement:
  ```sql
  SELECT 
    ticker,
    AVG(match_rate_pct) AS current_match_rate
  FROM central.v_source_match_rate
  GROUP BY ticker
  ORDER BY current_match_rate ASC;
  ```
- [ ] Identify any assets with <10 events/day (coverage gap)
- [ ] Review keywords for assets with <20% match rate

#### Day 6-7 (Pre-Wave-2 Assessment)
- [ ] Final match rate calculation
- [ ] Identify next cleanup candidates (<15% match rate)
- [ ] Check for false positives (relevant sources that were deactivated)
- [ ] Prepare Wave 2 target list

### Key Metrics Thresholds

| Metric | Before Cleanup | Target After | Action if Below |
|--------|---------------|---------------|------------------|
| Event Volume | ~2,000/day | 1,700-1,800/day | Acceptable (10-15% drop expected) |
| Avg Match Rate | ~6% | >15% | If <15%, review keywords first |
| Assets with <50 events/day | 0 | 0 | Investigate immediately |
| Active Sources | 150 | 147 | 3 sources deactivated |

### Decision Logic for Wave 2

**After Day 7, check:**

```sql
-- Wave 2 candidates (<15% match rate, still active)
SELECT * FROM central.v_source_match_rate
WHERE match_rate_pct < 15
AND active = true
ORDER BY events DESC;
```

**Criteria for Wave 2:**
1. Match rate improvement confirmed (avg >15%)
2. No coverage gaps (all assets have events)
3. No false positives found in manual review
4. At least 5 sources with <15% match rate identified

**If NOT ready for Wave 2:**
1. Review keywords in `03a_keywords.ts`
2. Add missing keywords for low-match assets
3. Wait additional 3-5 days
4. Re-assess

---

## Part 2: Onboarding Checklist for New Sources

### Before Adding a New Source

**Step 1: Source Classification**
- [ ] Is this an asset-specific source (e.g., OilPrice.com)?
- [ ] Or a generic source (e.g., Reuters, Bloomberg)?
- [ ] If generic → DO NOT add without LLM filter

**Step 2: Asset Mapping Decision**
- [ ] How many assets should this source map to?
- [ ] Rule: Asset-specific → 1-3 assets max
- [ ] Rule: Multi-asset → 4-10 assets max
- [ ] Rule: Generic → NOT ALLOWED without filter

**Step 3: Manual Match Rate Test**
Before adding to production:
```sql
-- Test: Check recent headlines from source
SELECT headline 
FROM central.drivers_events 
WHERE source_name = '[NEW_SOURCE_NAME]' 
ORDER BY created_at DESC 
LIMIT 20;
```
- [ ] Manually count how many match the target asset(s)
- [ ] If <30% match → REJECT or add LLM filter
- [ ] If 30-50% → REVIEW with keyword improvement
- [ ] If >50% → APPROVE

### Adding a New Source

**Template:**
```sql
INSERT INTO central.drivers_sources (
  asset_id, asset_name, driver_id, driver_name,
  name, url, source_type, trust_score, impact_score,
  auto_analyze, active, tier
) VALUES (
  '[ASSET_ID]',
  '[ASSET_NAME]',
  '[DRIVER_ID]',
  '[DRIVER_NAME]',
  '[SOURCE_NAME]',
  '[RSS_URL]',
  'rss',
  5.0,  -- trust_score (1-10)
  5.0,  -- impact_score (1-10)
  true, -- auto_analyze
  true, -- active
  'specific' -- tier: 'specific', 'multi_asset', 'generic'
);
```

**Required Fields:**
- [ ] `name` - Human-readable source name
- [ ] `url` - RSS feed URL
- [ ] `asset_id` - Target asset (from central.assets)
- [ ] `driver_id` - Associated driver (from central.drivers)
- [ ] `tier` - Must be one of: 'specific', 'multi_asset', 'generic'

### Post-Addition Verification

**After 24 hours:**
```sql
-- Check if source is producing events
SELECT COUNT(*) AS events_24h
FROM central.drivers_events
WHERE source_id = '[NEW_SOURCE_ID]'
AND created_at > NOW() - INTERVAL '24 hours';

-- Check match rate
SELECT * FROM central.v_source_match_rate
WHERE source_name = '[NEW_SOURCE_NAME]';
```

- [ ] Source has >0 events
- [ ] Match rate >30% (or flagged for review)
- [ ] No errors in `last_error` column

### Permanent Rules

1. **Never add generic sources without LLM filter**
   - Generic sources (Bloomberg, Reuters, etc.) MUST go through relevance filtering
   - Use `03b_pre_filter.ts` with LLM validation

2. **Maximum 3 mappings per asset-specific source**
   - OilPrice.com → WTI + BRENT only (2 mappings)
   - NOT OilPrice.com → ALL assets

3. **Maximum 10 mappings per multi-asset source**
   - Reuters Commodities → WTI + BRENT + HG + GC + NG (5 mappings max)
   - NOT Reuters Commodities → ALL assets

4. **Zero mappings for generic sources**
   - MarketWatch, CNBC, Bloomberg Markets → DEACTIVATED
   - If needed, create filtered pipeline

5. **Match rate monitoring**
   - Every source MUST be reviewed after 7 days
   - <15% match rate → immediate review
   - <30% match rate → keyword review
   - >50% match rate → approved

---

## Part 3: Maintenance Schedule

### Weekly (Every Monday)
- [ ] Run `v_source_quality_summary`
- [ ] Check for new <15% match rate sources
- [ ] Review event volume trends

### Monthly (First of each month)
- [ ] Full match rate audit
- [ ] Keyword review for all assets
- [ ] Source health check (error rates, activity)

### Quarterly
- [ ] Comprehensive source audit
- [ ] Retire inactive sources
- [ ] Add new high-quality sources
- [ ] Update asset keywords based on market changes

---

## Quick Reference: Commands

```bash
# Run quality report
psql -f intel/quality/01_quality_report.sql

# View cleanup targets
SELECT * FROM central.v_cleanup_wave1_targets;

# Execute cleanup
psql -f intel/quality/02_cleanup_wave1.sql

# Rollback if needed
CALL central.rollback_cleanup_wave1();

# Check metrics
SELECT * FROM central.v_cleanup_metrics;
SELECT * FROM central.v_source_match_rate;
SELECT * FROM central.v_asset_mismatch_summary;
```

---

**Remember:** The goal is NOT to have more events - it's to have BETTER events. Quality over quantity.

**End of File**