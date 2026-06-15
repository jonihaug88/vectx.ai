-- ═════════════════════════════════════════════════════════════════════════════
-- FILE: 01_quality_report.sql
-- PURPOSE: Source-Quality-Diagnose - Match-Rate pro Source-Asset-Mapping
-- CREATED: 2026-05-10
-- ═════════════════════════════════════════════════════════════════════════════
--
-- BEFORE RUNNING:
--   1. This is READ-ONLY - no data changes
--   2. Creates asset_keywords table + 3 diagnostic views
--   3. Run once, then use views for analysis
--
-- AFTER RUNNING:
--   SELECT * FROM central.v_source_match_rate;
--   SELECT * FROM central.v_source_quality_summary;
--   SELECT * FROM central.v_asset_mismatch_summary;
--
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 1: Create Asset Keywords Table
-- ═════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS central.asset_keywords CASCADE;

CREATE TABLE central.asset_keywords (
  ticker VARCHAR(20) PRIMARY KEY,
  name VARCHAR(100),
  asset_class VARCHAR(20),
  primary_keywords TEXT[],
  secondary_keywords TEXT[],
  exclude_keywords TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert keywords (from 03a_keywords.ts)
INSERT INTO central.asset_keywords (ticker, name, asset_class, primary_keywords, secondary_keywords, exclude_keywords) VALUES
-- Commodities - Energy
('WTI', 'Crude Oil WTI', 'commodity',
  ARRAY['wti', 'west texas', 'crude oil', 'oil price', 'oil prices', 'brent spread', 'wti price', 'us oil', 'american crude', 'nymex crude', 'light sweet crude'],
  ARRAY['opec', 'oil production', 'oil demand', 'oil supply', 'rig count', 'shale oil', 'us inventories', 'api crude', 'eia crude', 'strategic petroleum reserve', 'spr'],
  ARRAY['palm oil', 'olive oil', 'coconut oil', 'fish oil', 'motor oil', 'engine oil', 'essential oil']),
  
('BRENT', 'Crude Oil Brent', 'commodity',
  ARRAY['brent', 'brent crude', 'north sea', 'ice brent', 'brent price', 'brent oil', 'european crude', 'brent futures'],
  ARRAY['opec', 'north sea production', 'oil demand', 'oil supply', 'brent-wti spread', 'dated brent', 'forties', 'ekofisk'],
  ARRAY['palm oil', 'olive oil', 'coconut oil']),
  
('NG', 'Natural Gas', 'commodity',
  ARRAY['natural gas', 'lng', 'gas price', 'gas prices', 'natural gas futures', 'henry hub', 'nymex gas', 'us gas', 'gas demand', 'gas supply'],
  ARRAY['gas storage', 'gas injection', 'gas withdrawal', 'lng export', 'lng terminal', 'freeport lng', 'gas production', 'gas rig count', 'weather gas demand'],
  ARRAY['gasoline', 'petrol', 'gas station', 'gas pump', 'greenhouse gas', 'gas turbine']),

-- Commodities - Precious Metals
('GC', 'Gold', 'commodity',
  ARRAY['gold', 'gold price', 'gold prices', 'xau', 'gold futures', 'comex gold', 'spot gold', 'gold etf', 'gold demand', 'gold supply'],
  ARRAY['central bank gold', 'gold reserve', 'gold mining', 'safe haven', 'inflation hedge', 'precious metals', 'gold jewelry', 'gold coin', 'gold bar'],
  ARRAY['goldman', 'golden', 'gold medal', 'gold coast']),
  
('SI', 'Silver', 'commodity',
  ARRAY['silver', 'silver price', 'xag', 'silver prices', 'silver futures', 'comex silver', 'spot silver', 'silver etf', 'silver demand'],
  ARRAY['silver mining', 'industrial silver', 'silver jewelry', 'photovoltaic silver', 'silver coins', 'precious metals'],
  ARRAY['silver lining', 'silver bullet', 'silver screen']),
  
('HG', 'Copper', 'commodity',
  ARRAY['copper', 'copper price', 'copper prices', 'comex copper', 'lme copper', 'copper futures', 'copper demand', 'copper supply'],
  ARRAY['copper mining', 'copper production', 'industrial copper', 'dr copper', 'china copper', 'copper inventory', 'copper smelter', 'copper concentrate'],
  ARRAY[]),

-- Commodities - Agriculture
('ZC', 'Corn', 'commodity',
  ARRAY['corn', 'corn price', 'corn prices', 'maize', 'corn futures', 'cbot corn', 'us corn', 'corn harvest', 'corn production'],
  ARRAY['ethanol corn', 'corn ethanol', 'feed corn', 'corn yield', 'corn acreage', 'planting corn', 'corn belt', 'iowa corn', 'corn export'],
  ARRAY['corn syrup', 'popcorn']),
  
('ZS', 'Soybeans', 'commodity',
  ARRAY['soybeans', 'soybean', 'soy price', 'soy prices', 'soybean futures', 'cbot soybeans', 'soybean oil', 'soybean meal', 'us soy'],
  ARRAY['soybean harvest', 'soybean production', 'soybean acreage', 'brazil soy', 'argentina soy', 'soybean export', 'soybean yield', 'soybean crushing'],
  ARRAY[]),
  
('ZW', 'Wheat', 'commodity',
  ARRAY['wheat', 'wheat price', 'wheat prices', 'wheat futures', 'cbot wheat', 'kansas wheat', 'spring wheat', 'winter wheat', 'wheat harvest'],
  ARRAY['wheat production', 'wheat export', 'wheat acreage', 'black sea wheat', 'russia wheat', 'ukraine wheat', 'wheat yield', 'wheat inventory', 'wheat flour'],
  ARRAY[]),
  
('KC', 'Coffee', 'commodity',
  ARRAY['coffee', 'coffee price', 'coffee prices', 'arabica', 'robusta', 'coffee futures', 'ice coffee', 'coffee beans', 'coffee production'],
  ARRAY['brazil coffee', 'vietnam coffee', 'colombia coffee', 'coffee harvest', 'coffee export', 'coffee inventory', 'coffee roasting', 'specialty coffee'],
  ARRAY[]),

-- Forex - Majors
('EURUSD', 'EUR/USD', 'forex',
  ARRAY['eurusd', 'eur/usd', 'euro dollar', 'euro usd', 'eurusd rate', 'euro exchange rate', 'dollar euro'],
  ARRAY['ecb', 'federal reserve', 'fed rate', 'ecb rate', 'eurozone', 'europe economy', 'us economy', 'interest rate differential', 'euro inflation', 'us inflation'],
  ARRAY[]),
  
('GBPUSD', 'GBP/USD', 'forex',
  ARRAY['gbpusd', 'gbp/usd', 'pound dollar', 'cable', 'british pound', 'gbpusd rate', 'pound sterling'],
  ARRAY['bank of england', 'boe rate', 'uk inflation', 'brexit', 'uk economy', 'uk gdp', 'pound dollar rate', 'sterling dollar'],
  ARRAY[]),
  
('USDJPY', 'USD/JPY', 'forex',
  ARRAY['usdjpy', 'usd/jpy', 'dollar yen', 'yen dollar', 'usdjpy rate', 'japan yen', 'dollar yen rate'],
  ARRAY['bank of japan', 'boj', 'boj rate', 'japan economy', 'yen intervention', 'japan inflation', 'carry trade', 'japan gdp', 'abenomics', 'kuroda'],
  ARRAY[]),
  
('USDCHF', 'USD/CHF', 'forex',
  ARRAY['usdchf', 'usd/chf', 'dollar franc', 'swiss franc', 'usdchf rate', 'swiss franc dollar'],
  ARRAY['swiss national bank', 'snb', 'snb rate', 'switzerland economy', 'swiss inflation', 'franc safe haven', 'snb intervention'],
  ARRAY[]),
  
('AUDUSD', 'AUD/USD', 'forex',
  ARRAY['audusd', 'aud/usd', 'aussie dollar', 'australian dollar', 'audusd rate', 'aud dollar'],
  ARRAY['rba', 'reserve bank of australia', 'rba rate', 'australia economy', 'australia inflation', 'iron ore australia', 'china trade'],
  ARRAY[]),
  
('NZDUSD', 'NZD/USD', 'forex',
  ARRAY['nzdusd', 'nzd/usd', 'kiwi dollar', 'new zealand dollar', 'nzdusd rate', 'kiwi'],
  ARRAY['rbnz', 'reserve bank of new zealand', 'nz rate', 'new zealand economy', 'dairy prices', 'new zealand inflation', 'nz gdp'],
  ARRAY[]),
  
('USDCAD', 'USD/CAD', 'forex',
  ARRAY['usdcad', 'usd/cad', 'loonie', 'canadian dollar', 'usdcad rate', 'cad dollar'],
  ARRAY['bank of canada', 'boc rate', 'canada economy', 'canada oil', 'canada inflation', 'cad interest rate', 'usmca', 'canada trade'],
  ARRAY[]),
  
('EURGBP', 'EUR/GBP', 'forex',
  ARRAY['eurgbp', 'eur/gbp', 'euro pound', 'euro sterling', 'eurgbp rate'],
  ARRAY['ecb', 'bank of england', 'boe rate', 'ecb rate', 'eurozone uk trade', 'brexit trade'],
  ARRAY[]),
  
('EURJPY', 'EUR/JPY', 'forex',
  ARRAY['eurjpy', 'eur/jpy', 'euro yen', 'euro yen rate', 'eurjpy rate'],
  ARRAY['ecb', 'bank of japan', 'boj rate', 'ecb rate', 'eurozone japan trade', 'carry trade'],
  ARRAY[]),
  
('GBPJPY', 'GBP/JPY', 'forex',
  ARRAY['gbpjpy', 'gbp/jpy', 'pound yen', 'sterling yen', 'gbpjpy rate', 'gopher'],
  ARRAY['bank of england', 'bank of japan', 'boe rate', 'boj rate', 'uk japan trade', 'carry trade'],
  ARRAY[]);

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 2: Create Match Rate Calculation Function
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION central.calculate_match_rate(
  p_asset_ticker VARCHAR,
  p_headlines TEXT[]
) RETURNS NUMERIC AS $$
DECLARE
  v_keywords RECORD;
  v_match_count INT := 0;
  v_total_count INT := array_length(p_headlines, 1);
  v_headline TEXT;
BEGIN
  -- Get keywords for asset
  SELECT * INTO v_keywords
  FROM central.asset_keywords
  WHERE ticker = p_asset_ticker;
  
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  
  -- Count matches
  FOREACH v_headline IN ARRAY p_headlines LOOP
    IF EXISTS (
      SELECT 1 FROM unnest(v_keywords.primary_keywords) kw
      WHERE LOWER(v_headline) LIKE '%' || LOWER(kw) || '%'
    ) OR EXISTS (
      SELECT 1 FROM unnest(v_keywords.secondary_keywords) kw
      WHERE LOWER(v_headline) LIKE '%' || LOWER(kw) || '%'
    ) THEN
      v_match_count := v_match_count + 1;
    END IF;
  END LOOP;
  
  IF v_total_count = 0 THEN
    RETURN NULL;
  END IF;
  
  RETURN ROUND(100.0 * v_match_count / v_total_count, 1);
END;
$$ LANGUAGE plpgsql;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 3: Create Diagnostic Views
-- ═════════════════════════════════════════════════════════════════════════════

-- View 1: Source Match Rate (per source-asset-mapping)
DROP VIEW IF EXISTS central.v_source_match_rate CASCADE;

CREATE VIEW central.v_source_match_rate AS
WITH source_headlines AS (
  SELECT 
    ds.name AS source_name,
    a.ticker,
    ds.id AS source_id,
    ds.asset_id,
    ds.driver_id,
    ds.active,
    ARRAY_AGG(de.headline) AS headlines
  FROM central.drivers_sources ds
  JOIN central.assets a ON ds.asset_id = a.id
  LEFT JOIN central.drivers_events de ON de.source_id = ds.id
    AND de.created_at > NOW() - INTERVAL '7 days'
  GROUP BY ds.name, a.ticker, ds.id, ds.asset_id, ds.driver_id, ds.active
)
SELECT 
  sh.source_name,
  sh.ticker,
  sh.active,
  array_length(sh.headlines, 1) AS event_count_7d,
  central.calculate_match_rate(sh.ticker, sh.headlines) AS match_rate_pct,
  CASE 
    WHEN central.calculate_match_rate(sh.ticker, sh.headlines) >= 50 THEN 'KEEP'
    WHEN central.calculate_match_rate(sh.ticker, sh.headlines) >= 15 THEN 'REVIEW'
    ELSE 'REMOVE'
  END AS classification,
  CASE 
    WHEN array_length(sh.headlines, 1) IS NULL THEN 0
    ELSE array_length(sh.headlines, 1)
  END AS events
FROM source_headlines sh
ORDER BY match_rate_pct ASC NULLS LAST, events DESC;

-- View 2: Source Quality Summary (by source, across all assets)
DROP VIEW IF EXISTS central.v_source_quality_summary CASCADE;

CREATE VIEW central.v_source_quality_summary AS
SELECT 
  source_name,
  COUNT(*) AS total_mappings,
  COUNT(DISTINCT ticker) AS distinct_assets,
  AVG(match_rate_pct) AS avg_match_rate,
  MIN(match_rate_pct) AS min_match_rate,
  MAX(match_rate_pct) AS max_match_rate,
  SUM(events) AS total_events,
  CASE 
    WHEN COUNT(*) > 10 THEN 'generic'
    WHEN COUNT(*) > 3 THEN 'multi_asset'
    ELSE 'specific'
  END AS source_tier,
  CASE 
    WHEN AVG(match_rate_pct) < 15 THEN 'REMOVE'
    WHEN AVG(match_rate_pct) < 50 THEN 'REVIEW'
    ELSE 'KEEP'
  END AS recommendation
FROM central.v_source_match_rate
GROUP BY source_name
ORDER BY total_mappings DESC, avg_match_rate ASC;

-- View 3: Asset Mismatch Summary (by asset)
DROP VIEW IF EXISTS central.v_asset_mismatch_summary CASCADE;

CREATE VIEW central.v_asset_mismatch_summary AS
SELECT 
  ticker,
  COUNT(*) AS source_count,
  SUM(CASE WHEN classification = 'KEEP' THEN 1 ELSE 0 END) AS keep_sources,
  SUM(CASE WHEN classification = 'REVIEW' THEN 1 ELSE 0 END) AS review_sources,
  SUM(CASE WHEN classification = 'REMOVE' THEN 1 ELSE 0 END) AS remove_sources,
  AVG(match_rate_pct) AS avg_match_rate,
  SUM(events) AS total_events
FROM central.v_source_match_rate
GROUP BY ticker
ORDER BY avg_match_rate ASC;

-- ═════════════════════════════════════════════════════════════════════════════
-- STEP 4: Create Cleanup Target View (Wave 1)
-- ═════════════════════════════════════════════════════════════════════════════

DROP VIEW IF EXISTS central.v_cleanup_wave1_targets CASCADE;

CREATE VIEW central.v_cleanup_wave1_targets AS
SELECT 
  ds.id,
  ds.name AS source_name,
  a.ticker,
  d.name AS driver_name,
  ds.active,
  smr.match_rate_pct,
  smr.classification
FROM central.drivers_sources ds
JOIN central.assets a ON ds.asset_id = a.id
JOIN central.drivers d ON ds.driver_id = d.id
LEFT JOIN central.v_source_match_rate smr ON smr.source_name = ds.name AND smr.ticker = a.ticker
WHERE ds.name IN ('MarketWatch', 'CNBC Markets', 'Bloomberg Markets')
AND ds.active = true
ORDER BY ds.name, a.ticker;

-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES
-- ═════════════════════════════════════════════════════════════════════════════

-- Run after creating views:

-- 1. Source Match Rate (detailed)
-- SELECT * FROM central.v_source_match_rate WHERE match_rate_pct < 15 LIMIT 30;

-- 2. Source Quality Summary
-- SELECT * FROM central.v_source_quality_summary WHERE total_mappings > 5;

-- 3. Asset Mismatch Summary
-- SELECT * FROM central.v_asset_mismatch_summary;

-- 4. Wave 1 Cleanup Targets
-- SELECT * FROM central.v_cleanup_wave1_targets;

-- 5. Count Wave 1 targets
-- SELECT COUNT(*) FROM central.v_cleanup_wave1_targets;

-- ═════════════════════════════════════════════════════════════════════════════
-- END OF FILE
-- ═════════════════════════════════════════════════════════════════════════════