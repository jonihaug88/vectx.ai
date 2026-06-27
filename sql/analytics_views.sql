-- ═══════════════════════════════════════════════════════════════════
-- vectX.ai — Paper Trading Analytics Suite
-- ═══════════════════════════════════════════════════════════════════

-- 1. PROFIT FACTOR
CREATE OR REPLACE VIEW central.v_pt_profit_factor AS
WITH closed AS (
  SELECT pnl_leveraged_pct, pnl_r_multiple, asset_name, signal_direction, leverage
  FROM central.paper_trades
  WHERE status = 'closed' AND pnl_leveraged_pct IS NOT NULL
),
aggregated AS (
  SELECT
    COUNT(*) AS total_trades,
    COUNT(*) FILTER (WHERE pnl_leveraged_pct > 0) AS winners,
    COUNT(*) FILTER (WHERE pnl_leveraged_pct < 0) AS losers,
    COUNT(*) FILTER (WHERE pnl_leveraged_pct = 0) AS breakevens,
    COALESCE(SUM(pnl_leveraged_pct) FILTER (WHERE pnl_leveraged_pct > 0), 0) AS gross_profit_pct,
    COALESCE(ABS(SUM(pnl_leveraged_pct) FILTER (WHERE pnl_leveraged_pct < 0)), 0) AS gross_loss_pct,
    COALESCE(SUM(pnl_r_multiple) FILTER (WHERE pnl_r_multiple > 0), 0) AS gross_profit_r,
    COALESCE(ABS(SUM(pnl_r_multiple) FILTER (WHERE pnl_r_multiple < 0)), 0) AS gross_loss_r,
    COALESCE(AVG(pnl_leveraged_pct) FILTER (WHERE pnl_leveraged_pct > 0), 0) AS avg_winner_pct,
    COALESCE(AVG(pnl_leveraged_pct) FILTER (WHERE pnl_leveraged_pct < 0), 0) AS avg_loser_pct,
    COALESCE(AVG(pnl_r_multiple), 0) AS expectancy_r
  FROM closed
)
SELECT
  total_trades, winners, losers, breakevens,
  CASE WHEN total_trades > 0 THEN ROUND(100.0 * winners / total_trades, 1) ELSE 0 END AS win_rate_pct,
  ROUND(gross_profit_pct::numeric, 2) AS gross_profit_pct,
  ROUND(gross_loss_pct::numeric, 2) AS gross_loss_pct,
  CASE WHEN gross_loss_pct > 0 THEN ROUND((gross_profit_pct / gross_loss_pct)::numeric, 2) ELSE NULL END AS profit_factor_pct,
  CASE WHEN gross_loss_r > 0 THEN ROUND((gross_profit_r / gross_loss_r)::numeric, 2) ELSE NULL END AS profit_factor_r,
  ROUND(avg_winner_pct::numeric, 2) AS avg_winner_pct,
  ROUND(avg_loser_pct::numeric, 2) AS avg_loser_pct,
  CASE WHEN avg_loser_pct < 0 THEN ROUND(ABS(avg_winner_pct / avg_loser_pct)::numeric, 2) ELSE NULL END AS payoff_ratio,
  ROUND(expectancy_r::numeric, 3) AS expectancy_per_trade_r
FROM aggregated;

-- 2. CALIBRATION PLOT
CREATE OR REPLACE VIEW central.v_pt_calibration AS
WITH buckets AS (
  SELECT
    CASE
      WHEN trade_confidence < 0.40 THEN '0.0-0.4'
      WHEN trade_confidence < 0.50 THEN '0.4-0.5'
      WHEN trade_confidence < 0.60 THEN '0.5-0.6'
      WHEN trade_confidence < 0.70 THEN '0.6-0.7'
      WHEN trade_confidence < 0.80 THEN '0.7-0.8'
      WHEN trade_confidence < 0.90 THEN '0.8-0.9'
      ELSE '0.9-1.0'
    END AS confidence_bucket,
    CASE
      WHEN trade_confidence < 0.40 THEN 0.20
      WHEN trade_confidence < 0.50 THEN 0.45
      WHEN trade_confidence < 0.60 THEN 0.55
      WHEN trade_confidence < 0.70 THEN 0.65
      WHEN trade_confidence < 0.80 THEN 0.75
      WHEN trade_confidence < 0.90 THEN 0.85
      ELSE 0.95
    END AS bucket_midpoint,
    trade_confidence,
    CASE WHEN pnl_leveraged_pct > 0 THEN 1 ELSE 0 END AS is_winner,
    pnl_r_multiple
  FROM central.paper_trades
  WHERE status = 'closed' AND pnl_leveraged_pct IS NOT NULL
)
SELECT
  confidence_bucket,
  bucket_midpoint AS expected_win_rate,
  COUNT(*) AS trade_count,
  ROUND(AVG(is_winner) * 100, 1) AS actual_win_rate_pct,
  ROUND((AVG(is_winner) - bucket_midpoint) * 100, 1) AS calibration_error_pct,
  CASE
    WHEN AVG(is_winner) > bucket_midpoint + 0.05 THEN 'underconfident'
    WHEN AVG(is_winner) < bucket_midpoint - 0.05 THEN 'overconfident'
    ELSE 'calibrated'
  END AS calibration_status,
  ROUND(AVG(pnl_r_multiple)::numeric, 3) AS avg_r_multiple
FROM buckets
GROUP BY confidence_bucket, bucket_midpoint
HAVING COUNT(*) >= 3
ORDER BY confidence_bucket;

-- 3. HEDGE ATTRIBUTION
CREATE OR REPLACE VIEW central.v_pt_hedge_attribution AS
WITH trades_classified AS (
  SELECT
    CASE WHEN hedge_ticker IS NOT NULL THEN 'with_hedge' ELSE 'without_hedge' END AS hedge_status,
    pnl_leveraged_pct, pnl_r_multiple, hedge_pnl_pct, max_adverse_pct,
    CASE WHEN pnl_leveraged_pct > 0 THEN 1 ELSE 0 END AS is_winner
  FROM central.paper_trades
  WHERE status = 'closed' AND pnl_leveraged_pct IS NOT NULL
)
SELECT
  hedge_status,
  COUNT(*) AS trade_count,
  ROUND(AVG(is_winner) * 100, 1) AS win_rate_pct,
  ROUND(AVG(pnl_leveraged_pct)::numeric, 3) AS avg_pnl_pct,
  ROUND(AVG(pnl_r_multiple)::numeric, 3) AS avg_r_multiple,
  ROUND(STDDEV(pnl_r_multiple)::numeric, 3) AS stddev_r_multiple,
  ROUND((AVG(pnl_r_multiple) / NULLIF(STDDEV(pnl_r_multiple), 0))::numeric, 3) AS risk_adjusted_return,
  ROUND(AVG(max_adverse_pct)::numeric, 2) AS avg_max_adverse_pct,
  ROUND(MIN(pnl_leveraged_pct)::numeric, 2) AS worst_trade_pct,
  ROUND(AVG(hedge_pnl_pct)::numeric, 3) AS avg_hedge_pnl_pct
FROM trades_classified
GROUP BY hedge_status
ORDER BY hedge_status;

-- 4. SKIP QUALITY SUMMARY
CREATE OR REPLACE VIEW central.v_pt_skip_quality_summary AS
SELECT
  COUNT(*) AS total_skips,
  COUNT(*) FILTER (WHERE hypothetical_outcome = 'would_have_won') AS would_have_won,
  COUNT(*) FILTER (WHERE hypothetical_outcome = 'would_have_lost') AS would_have_lost,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE hypothetical_outcome = 'would_have_won')
    / NULLIF(COUNT(*) FILTER (WHERE hypothetical_outcome IN ('would_have_won','would_have_lost')), 0),
  1) AS skip_missed_opportunity_pct
FROM central.v_pt_skip_quality;

-- 5. R-MULTIPLE DISTRIBUTION
CREATE OR REPLACE VIEW central.v_pt_r_distribution AS
SELECT
  CASE
    WHEN pnl_r_multiple < -2.0 THEN '< -2R'
    WHEN pnl_r_multiple < -1.0 THEN '-2R to -1R'
    WHEN pnl_r_multiple < 0    THEN '-1R to 0R'
    WHEN pnl_r_multiple < 1.0  THEN '0R to +1R'
    WHEN pnl_r_multiple < 2.0  THEN '+1R to +2R'
    WHEN pnl_r_multiple < 3.0  THEN '+2R to +3R'
    ELSE '> +3R'
  END AS r_bucket,
  COUNT(*) AS trade_count,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_total,
  ROUND(AVG(pnl_leveraged_pct)::numeric, 2) AS avg_pnl_pct
FROM central.paper_trades
WHERE status = 'closed' AND pnl_r_multiple IS NOT NULL
GROUP BY r_bucket
ORDER BY r_bucket;

-- 6. DASHBOARD SUMMARY
CREATE OR REPLACE VIEW central.v_pt_dashboard_summary AS
WITH base AS (
  SELECT * FROM central.paper_trades WHERE status = 'closed'
)
SELECT
  (SELECT COUNT(*) FROM base) AS total_closed_trades,
  (SELECT COUNT(*) FROM central.paper_trades WHERE status = 'open') AS currently_open,
  (SELECT COUNT(*) FROM central.paper_trades WHERE status = 'pending') AS currently_pending,
  (SELECT COUNT(*) FROM central.trade_skips) AS total_skips,
  ROUND((100.0 * (SELECT COUNT(*) FROM base WHERE pnl_leveraged_pct > 0) / NULLIF((SELECT COUNT(*) FROM base), 0)), 1) AS win_rate_pct,
  ROUND(((SELECT COALESCE(SUM(pnl_r_multiple), 0) FROM base WHERE pnl_r_multiple > 0)
    / NULLIF((SELECT COALESCE(ABS(SUM(pnl_r_multiple)), 0) FROM base WHERE pnl_r_multiple < 0), 0))::numeric, 2) AS profit_factor_r,
  ROUND((SELECT COALESCE(AVG(pnl_r_multiple), 0) FROM base)::numeric, 3) AS expectancy_r,
  ROUND((SELECT COALESCE(SUM(pnl_leveraged_pct), 0) FROM base)::numeric, 2) AS cumulative_pnl_pct,
  (SELECT MAX(exit_at) FROM base) AS last_closed_at,
  (SELECT MAX(last_checked_at) FROM central.paper_trades WHERE status IN ('open','pending')) AS tracker_last_ran;

-- 7. PERFORMANCE BY ASSET
CREATE OR REPLACE VIEW central.v_pt_performance_by_asset AS
SELECT
  asset_name,
  COUNT(*) AS trades,
  ROUND(100.0 * COUNT(*) FILTER (WHERE pnl_leveraged_pct > 0) / COUNT(*), 1) AS win_rate_pct,
  ROUND(AVG(pnl_r_multiple)::numeric, 3) AS expectancy_r,
  ROUND(SUM(pnl_leveraged_pct)::numeric, 2) AS cumulative_pnl_pct
FROM central.paper_trades
WHERE status = 'closed' AND pnl_leveraged_pct IS NOT NULL
GROUP BY asset_name
HAVING COUNT(*) >= 3
ORDER BY expectancy_r DESC;

-- 8. EQUITY CURVE
CREATE OR REPLACE VIEW central.v_pt_equity_curve AS
SELECT
  exit_at,
  ROUND(pnl_leveraged_pct::numeric, 2) AS trade_pnl_pct,
  ROUND(SUM(pnl_leveraged_pct) OVER (ORDER BY exit_at)::numeric, 2) AS cumulative_pnl_pct
FROM central.paper_trades
WHERE status = 'closed' AND exit_at IS NOT NULL
ORDER BY exit_at;

-- 9. MFE/MAE ANALYSIS
CREATE OR REPLACE VIEW central.v_pt_mfe_mae_analysis AS
SELECT
  CASE WHEN pnl_leveraged_pct > 0 THEN 'winners' ELSE 'losers' END AS outcome,
  COUNT(*) AS trade_count,
  ROUND(AVG(max_favorable_pct)::numeric, 2) AS avg_mfe_pct,
  ROUND(AVG(max_adverse_pct)::numeric, 2) AS avg_mae_pct
FROM central.paper_trades
WHERE status = 'closed' AND max_favorable_pct IS NOT NULL AND max_adverse_pct IS NOT NULL
GROUP BY outcome;