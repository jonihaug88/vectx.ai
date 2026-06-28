#!/usr/bin/env python3
"""
VECTX V3 — Weekly V_real v2 Recompute (Orchestrator)
Runs Steps 1-3 incrementally: only new weeks since last observation_d.
Writes ONLY to shadow tables (md_volatility, md_factors, vreal_v2_shadow).
NEVER touches production tables (central.alpha, central.events, central.vreal_history).

Idempotent: uses ON CONFLICT DO NOTHING for deduplication.
Cron: Weekly, Monday ~06:00 UTC (after FRED/price refresh)
"""

import json
import requests
import numpy as np
import pandas as pd
from arch import arch_model
from statsmodels.regression.rolling import RollingOLS
import warnings
import sys
from datetime import datetime, timedelta

warnings.filterwarnings('ignore')

# ─── Config ────────────────────────────────────────────────────────
with open('/data/.openclaw/workspace/intel/config.json') as f:
    config = json.load(f)

SUPABASE_URL = config['supabase_url']
ADMIN_TOKEN = config['supabase_admin_token']

def run_sql(sql: str) -> list:
    r = requests.post(
        f'{SUPABASE_URL}/functions/v1/run-sql',
        headers={'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN},
        json={'sql': sql}
    )
    try:
        data = r.json()
    except Exception:
        data = {}
    return data.get('data', [])

def run_sql_ok(sql: str) -> bool:
    r = run_sql(sql)
    return True  # if no exception, it's ok

ROLLING_WINDOW = 252  # 1 year for baseline regression
WEEKLY_STEP = 5       # compute every 5 trading days

# ─── 1. Load data ───────────────────────────────────────────────────
print("=== V_real v2 Weekly Recompute ===")
print(f"Time: {datetime.utcnow().isoformat()}")

print("\n[Step 1] Loading prices...")
price_rows = run_sql("""
SELECT ticker, d AS date, close
FROM central.md_prices_daily
ORDER BY ticker, d
""")
prices = pd.DataFrame(price_rows)
prices['date'] = pd.to_datetime(prices['date'])
prices['close'] = pd.to_numeric(prices['close'], errors='coerce')
prices = prices.sort_values(['ticker', 'date']).reset_index(drop=True)
tickers = sorted(prices['ticker'].unique())
print(f"  {len(prices)} price rows for {len(tickers)} assets")

print("[Step 1] Loading fundamentals...")
fund_rows = run_sql("""
SELECT series_id, d, value
FROM central.md_fundamentals
WHERE series_id IN ('DFII10', 'DTWEXBGS', 'VIXCLS')
ORDER BY series_id, d
""")
fund_df = pd.DataFrame(fund_rows)
fund_df['d'] = pd.to_datetime(fund_df['d'])
fund_df['value'] = pd.to_numeric(fund_df['value'], errors='coerce')
fund_wide = fund_df.pivot(index='d', columns='series_id', values='value')
fund_wide.columns = ['DFII10', 'DTWEXBGS', 'VIXCLS']
print(f"  {len(fund_wide)} fundamental days")

# ─── 2. Load existing shadow data to determine new weeks ────────────
print("\n[Step 1] Checking existing shadow data...")
existing_vreal = run_sql("""
SELECT ticker, MAX(observation_d)::text as last_date
FROM central.vreal_v2_shadow
WHERE model_version LIKE 'v2_%_baseline'
GROUP BY ticker
""")
existing_map = {r['ticker']: r['last_date'] for r in existing_vreal}
print(f"  Existing V_real for {len(existing_map)} assets")

existing_vol = run_sql("""
SELECT ticker, MAX(d)::text as last_date
FROM central.md_volatility
GROUP BY ticker
""")
vol_map = {r['ticker']: r['last_date'] for r in existing_vol}
print(f"  Existing volatility for {len(vol_map)} assets")

existing_factors = run_sql("""
SELECT ticker, MAX(d)::text as last_date
FROM central.md_factors
GROUP BY ticker
""")
factors_map = {r['ticker']: r['last_date'] for r in existing_factors}
print(f"  Existing factors for {len(factors_map)} assets")

# ─── 3. Volatility + Factors (full recompute, idempotent) ──────────
# We recompute the tail end (last 252 days) to update rolling estimates

print("\n[Step 1] Computing volatility for all assets...")
vol_results = []

for ticker in tickers:
    asset_prices = prices[prices['ticker'] == ticker].set_index('date')['close'].dropna()
    if len(asset_prices) < 60:
        continue
    
    logret = np.log(asset_prices / asset_prices.shift(1)).dropna()
    
    # EWMA volatility (lambda=0.94)
    lam = 0.94
    var_ewma = logret.var()
    ewma = [var_ewma]
    for r in logret.iloc[1:]:
        var_ewma = lam * var_ewma + (1 - lam) * r**2
        ewma.append(var_ewma)
    sigma_ewma = np.sqrt(ewma) * np.sqrt(252)  # annualized
    
    # GJR-GARCH(1,1)
    try:
        am = arch_model(logret * 100, vol='Garch', p=1, o=1, q=1, dist='studentst')
        res = am.fit(disp='off', options={'maxiter': 200})
        cond_vol = res.conditional_volatility / 100 * np.sqrt(252)  # annualized
    except Exception:
        cond_vol = pd.Series(sigma_ewma[-len(logret):], index=logret.index)
    
    # Build volatility dataframe — only new entries since last known date
    vol_df_ticker = pd.DataFrame({
        'ticker': ticker,
        'd': logret.index,
        'logret': logret.values,
        'sigma_ewma': sigma_ewma[-len(logret):],
        'sigma_garch': cond_vol.values[:len(logret)],
    })
    vol_results.append(vol_df_ticker)

if vol_results:
    all_vol = pd.concat(vol_results, ignore_index=True)
    # Upsert to md_volatility (ON CONFLICT DO UPDATE)
    BATCH = 50
    for i in range(0, len(all_vol), BATCH):
        batch = all_vol.iloc[i:i+BATCH]
        values = ',\n'.join([
            f"('{r['ticker']}', '{r['d'].strftime('%Y-%m-%d')}', "
            f"{float(r['logret']):.8f}, {float(r['sigma_ewma']):.6f}, {float(r['sigma_garch']):.6f})"
            for _, r in batch.iterrows()
        ])
        run_sql(f"""
        INSERT INTO central.md_volatility (ticker, d, logret, sigma_ewma, sigma_garch)
        VALUES {values}
        ON CONFLICT (ticker, d) DO UPDATE SET
          logret = EXCLUDED.logret,
          sigma_ewma = EXCLUDED.sigma_ewma,
          sigma_garch = EXCLUDED.sigma_garch
        """)
    print(f"  Upserted {len(all_vol)} volatility rows")

# ─── 4. Factor betas (rolling regression) ────────────────────────────
print("\n[Step 2] Computing factor betas for all assets...")

for ticker in tickers:
    asset_prices = prices[prices['ticker'] == ticker].set_index('date')['close'].dropna()
    if len(asset_prices) < 300:
        continue
    
    merged = asset_prices.to_frame('close').join(fund_wide, how='left').dropna()
    merged['log_price'] = np.log(merged['close'])
    
    if len(merged) < ROLLING_WINDOW:
        continue
    
    y = merged['log_price'].values
    X = np.column_stack([merged['DFII10'].values, merged['DTWEXBGS'].values, merged['VIXCLS'].values])
    X_const = np.column_stack([np.ones(len(y)), X])
    
    factor_rows = []
    for end_idx in range(ROLLING_WINDOW, len(merged), WEEKLY_STEP):
        window_y = y[end_idx - ROLLING_WINDOW:end_idx + 1]
        window_X = X_const[end_idx - ROLLING_WINDOW:end_idx + 1]
        
        mask = ~(np.isnan(window_y) | np.isnan(window_X).any(axis=1))
        if mask.sum() < 60:
            continue
        
        try:
            beta = np.linalg.lstsq(window_X[mask], window_y[mask], rcond=None)[0]
            date_t = merged.index[end_idx].strftime('%Y-%m-%d')
            
            factor_rows.append({
                'ticker': ticker,
                'd': date_t,
                'factor_usd': float(merged['DTWEXBGS'].iloc[end_idx]),
                'factor_risk': float(merged['VIXCLS'].iloc[end_idx]),
                'factor_realrate': float(merged['DFII10'].iloc[end_idx]),
                'beta_usd': round(float(beta[2]), 6),
                'beta_risk': round(float(beta[3]), 6),
                'beta_realrate': round(float(beta[1]), 6),
                'alpha': round(float(beta[0]), 6),
                'n_obs': int(mask.sum()),
            })
        except Exception:
            continue
    
    if factor_rows:
        # Upsert to md_factors
        BATCH = 50
        for i in range(0, len(factor_rows), BATCH):
            batch = factor_rows[i:i+BATCH]
            values = ',\n'.join([
                f"('{r['ticker']}', '{r['d']}', "
                f"{r['factor_usd']:.4f}, {r['factor_risk']:.4f}, {r['factor_realrate']:.4f}, "
                f"{r['beta_usd']:.6f}, {r['beta_risk']:.6f}, {r['beta_realrate']:.6f}, "
                f"{r['alpha']:.6f}, {r['n_obs']})"
                for r in batch
            ])
            run_sql(f"""
            INSERT INTO central.md_factors (ticker, d, factor_usd, factor_risk, factor_realrate, beta_usd, beta_risk, beta_realrate, alpha, n_obs)
            VALUES {values}
            ON CONFLICT (ticker, d) DO UPDATE SET
              factor_usd = EXCLUDED.factor_usd,
              factor_risk = EXCLUDED.factor_risk,
              factor_realrate = EXCLUDED.factor_realrate,
              beta_usd = EXCLUDED.beta_usd,
              beta_risk = EXCLUDED.beta_risk,
              beta_realrate = EXCLUDED.beta_realrate,
              alpha = EXCLUDED.alpha,
              n_obs = EXCLUDED.n_obs
            """)
    print(f"  {ticker}: {len(factor_rows)} factor rows")

# ─── 5. V_real baselines (incremental — only new weeks) ─────────────
print("\n[Step 3] Computing V_real baselines (incremental)...")

# Reload volatility after upsert
vol_rows_new = run_sql("""
SELECT ticker, d, sigma_garch
FROM central.md_volatility
ORDER BY ticker, d
""")
vol_df = pd.DataFrame(vol_rows_new)
vol_df['d'] = pd.to_datetime(vol_df['d'])
vol_df['sigma_garch'] = pd.to_numeric(vol_df['sigma_garch'], errors='coerce')

results_summary = []

for ticker in tickers:
    model_version = f'v2_{ticker.lower()}_baseline'
    
    asset_prices = prices[prices['ticker'] == ticker].set_index('date')['close'].dropna()
    if len(asset_prices) < 300:
        continue
    
    asset_vol = vol_df[vol_df['ticker'] == ticker].set_index('d')['sigma_garch'].dropna()
    merged = asset_prices.to_frame('close').join(fund_wide, how='left').dropna()
    merged['log_price'] = np.log(merged['close'])
    
    if len(merged) < ROLLING_WINDOW:
        continue
    
    # Determine start point: only compute weeks after existing data
    last_existing = existing_map.get(ticker, '2000-01-01')
    last_dt = pd.Timestamp(last_existing) + pd.Timedelta(days=1)
    # Ensure both are tz-naive for comparison
    if last_dt.tzinfo is not None:
        last_dt = last_dt.tz_localize(None)
    
    # Find indices after last_existing
    start_idx = max(ROLLING_WINDOW, 0)
    indices_to_compute = []
    
    y = merged['log_price'].values
    X_const = np.column_stack([np.ones(len(y)), merged['DFII10'].values, merged['DTWEXBGS'].values, merged['VIXCLS'].values])
    
    for end_idx in range(ROLLING_WINDOW, len(merged), WEEKLY_STEP):
        date_t = merged.index[end_idx]
        # Ensure tz-naive for comparison
        date_compare = date_t.tz_localize(None) if date_t.tzinfo is not None else date_t
        if date_compare > last_dt:
            indices_to_compute.append(end_idx)
    
    if len(indices_to_compute) == 0:
        print(f"  {ticker}: no new weeks to compute")
        continue
    
    # Compute residuals for ALL observations (for band calibration)
    all_residuals_pct = []
    for end_idx in range(ROLLING_WINDOW, len(merged), 1):
        window_y = y[end_idx - ROLLING_WINDOW:end_idx + 1]
        window_X = X_const[end_idx - ROLLING_WINDOW:end_idx + 1]
        mask = ~(np.isnan(window_y) | np.isnan(window_X).any(axis=1))
        if mask.sum() < 60:
            continue
        try:
            beta = np.linalg.lstsq(window_X[mask], window_y[mask], rcond=None)[0]
            current_X = X_const[end_idx]
            baseline_val = float(current_X @ beta)
            vreal_val = np.exp(baseline_val)
            current_price_val = float(merged['close'].iloc[end_idx])
            if vreal_val > 0:
                all_residuals_pct.append((current_price_val - vreal_val) / vreal_val)
        except Exception:
            continue
    
    p16 = np.percentile(all_residuals_pct, 16)
    p84 = np.percentile(all_residuals_pct, 84)
    
    # Compute new weeks only
    new_rows = []
    for end_idx in indices_to_compute:
        window_y = y[end_idx - ROLLING_WINDOW:end_idx + 1]
        window_X = X_const[end_idx - ROLLING_WINDOW:end_idx + 1]
        mask = ~(np.isnan(window_y) | np.isnan(window_X).any(axis=1))
        if mask.sum() < 60:
            continue
        
        try:
            beta = np.linalg.lstsq(window_X[mask], window_y[mask], rcond=None)[0]
            date_t = merged.index[end_idx]
            current_X = X_const[end_idx]
            baseline = float(current_X @ beta)
            vreal = np.exp(baseline)
            current_price = float(merged['close'].iloc[end_idx])
            sigma_garch = float(asset_vol.get(date_t, np.nan)) if date_t in asset_vol.index else np.nan
            
            new_rows.append({
                'ticker': ticker,
                'observation_d': date_t.strftime('%Y-%m-%d'),
                'current_price': round(current_price, 4),
                'baseline': round(baseline, 8),
                'adjust': 0,
                'vreal': round(vreal, 4),
                'sigma': round(float(sigma_garch) / np.sqrt(252) if not np.isnan(sigma_garch) else np.std([r for r in all_residuals_pct]) / np.sqrt(252), 8),
                'band_low': round(vreal * (1 + p16), 2),
                'band_high': round(vreal * (1 + p84), 2),
                'confidence': 0.68,
                'model_version': model_version,
                'components': json.dumps({
                    'dfii10_coef': round(float(beta[1]), 6),
                    'dtwexbgs_coef': round(float(beta[2]), 6),
                    'vixcls_coef': round(float(beta[3]), 6),
                    'intercept': round(float(beta[0]), 6),
                    'p16': round(p16, 6),
                    'p84': round(p84, 6),
                }),
            })
        except Exception:
            continue
    
    if new_rows:
        # Upsert to vreal_v2_shadow (ON CONFLICT DO NOTHING for idempotency)
        BATCH = 50
        for i in range(0, len(new_rows), BATCH):
            batch = new_rows[i:i+BATCH]
            values = ',\n'.join([
                f"('{r['ticker']}', '{r['observation_d']}', {r['current_price']}, {r['baseline']}, "
                f"{r['adjust']}, {r['vreal']}, {r['sigma']}, {r['band_low']}, {r['band_high']}, "
                f"{r['confidence']}, '{r['model_version']}', $$"
                + r['components'].replace("'", "''")
                + "$$)"
                for r in batch
            ])
            run_sql(f"""
            INSERT INTO central.vreal_v2_shadow (ticker, observation_d, current_price, baseline, adjust, vreal, sigma, band_low, band_high, confidence, model_version, components)
            VALUES {values}
            ON CONFLICT (ticker, observation_d, model_version) DO NOTHING
            """)
        
        print(f"  {ticker}: {len(new_rows)} new rows, band=[{p16:.2%}, +{p84:.2%}]")
        results_summary.append({'ticker': ticker, 'new_rows': len(new_rows), 'p16': p16, 'p84': p84})
    else:
        print(f"  {ticker}: 0 new rows (all up to date)")

# ─── 6. Summary ─────────────────────────────────────────────────────
print(f"\n{'='*60}")
print("=== V_real v2 Weekly Recompute Complete ===")
for r in results_summary:
    print(f"  {r['ticker']:8s}: {r['new_rows']:>4d} rows, band=[{r['p16']:.2%}, +{r['p84']:.2%}]")
print(f"\nTotal assets updated: {len(results_summary)}")

# Verify totals
total = run_sql("SELECT COUNT(*)::text as total FROM central.vreal_v2_shadow WHERE model_version LIKE 'v2_%_baseline'")
vol_total = run_sql("SELECT COUNT(*)::text as total FROM central.md_volatility")
fac_total = run_sql("SELECT COUNT(*)::text as total FROM central.md_factors")
print(f"\nShadow table totals:")
print(f"  vreal_v2_shadow: {total[0]['total']} rows")
print(f"  md_volatility: {vol_total[0]['total']} rows")
print(f"  md_factors: {fac_total[0]['total']} rows")