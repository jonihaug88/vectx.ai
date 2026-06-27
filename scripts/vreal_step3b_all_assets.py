#!/usr/bin/env python3
"""
VECTX V3 — Step 3b: V_real Baseline for ALL 20 Assets
Extends the Gold baseline approach to all assets:
1) Rolling regression of log(price) on macro factors (USD, Risk, Real Rate)
2) Asymmetric 68% quantile band calibrated per asset
3) Writes to central.vreal_v2_shadow with model_version = 'v2_<ticker>_baseline'
"""

import json
import requests
import numpy as np
import pandas as pd
from statsmodels.regression.rolling import RollingOLS
import warnings
warnings.filterwarnings('ignore')

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

# ─── 1. Load all prices ──────────────────────────────────────────────
print("Loading prices...")
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
print(f"  Loaded {len(prices)} price rows for {len(tickers)} assets")

# ─── 2. Load volatility ─────────────────────────────────────────────
print("Loading volatility...")
vol_rows = run_sql("""
SELECT ticker, d, sigma_garch
FROM central.md_volatility
ORDER BY ticker, d
""")
vol_df = pd.DataFrame(vol_rows)
vol_df['d'] = pd.to_datetime(vol_df['d'])
vol_df['sigma_garch'] = pd.to_numeric(vol_df['sigma_garch'], errors='coerce')
vol_df = vol_df.sort_values(['ticker', 'd']).reset_index(drop=True)
print(f"  Loaded {len(vol_df)} volatility rows")

# ─── 3. Load fundamentals ─────────────────────────────────────────────
print("Loading fundamentals...")
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
print(f"  Fundamentals: {len(fund_wide)} days")

# ─── 4. Load existing alpha for current prices ───────────────────────
print("Loading current prices from assets table...")
asset_rows = run_sql("SELECT id::text, ticker, current_price FROM central.assets ORDER BY ticker")
assets = {r['ticker']: {'id': r['id'], 'price': float(r['current_price'])} for r in asset_rows}

# ─── 5. Compute per-asset baseline ──────────────────────────────────
ROLLING_WINDOW = 252  # 1 year

results_summary = []

for ticker in tickers:
    print(f"\n{'='*60}")
    print(f"Processing {ticker}...")
    
    # Get asset prices
    asset_prices = prices[prices['ticker'] == ticker].set_index('date')['close'].dropna()
    if len(asset_prices) < 300:
        print(f"  Skipping {ticker}: only {len(asset_prices)} prices")
        continue
    
    # Get asset volatility
    asset_vol = vol_df[vol_df['ticker'] == ticker].set_index('d')['sigma_garch'].dropna()
    
    # Merge with fundamentals
    merged = asset_prices.to_frame('close').join(fund_wide, how='left')
    merged = merged.dropna()
    merged['log_price'] = np.log(merged['close'])
    
    if len(merged) < ROLLING_WINDOW:
        print(f"  Skipping {ticker}: only {len(merged)} merged rows")
        continue
    
    # Rolling regression: log(price) = alpha + b1*DFII10 + b2*DTWEXBGS + b3*VIXCLS
    y = merged['log_price'].values
    X = merged[['DFII10', 'DTWEXBGS', 'VIXCLS']].values
    X_with_const = np.column_stack([np.ones(len(y)), X])
    
    results = []
    for end_idx in range(ROLLING_WINDOW, len(merged), 5):  # every 5 days for efficiency
        window_y = y[end_idx - ROLLING_WINDOW:end_idx + 1]
        window_X = X_with_const[end_idx - ROLLING_WINDOW:end_idx + 1]
        
        mask = ~(np.isnan(window_y) | np.isnan(window_X).any(axis=1))
        y_clean = window_y[mask]
        X_clean = window_X[mask]
        
        if len(y_clean) < 60:
            continue
        
        try:
            beta = np.linalg.lstsq(X_clean, y_clean, rcond=None)[0]
            resid = y_clean - X_clean @ beta
            
            # Day t values
            date_t = merged.index[end_idx]
            current_X = X_with_const[end_idx]
            baseline = float(current_X @ beta)
            vreal = np.exp(baseline)
            current_price = float(merged['close'].iloc[end_idx])
            sigma_garch = float(asset_vol.get(date_t, np.nan)) if date_t in asset_vol.index else np.nan
            
            results.append({
                'd': date_t.strftime('%Y-%m-%d'),
                'current_price': round(current_price, 4),
                'baseline': round(float(baseline), 8),
                'vreal': round(float(vreal), 4),
                'sigma_annual': round(float(sigma_garch) if not np.isnan(sigma_garch) else np.std(resid) * np.sqrt(252), 6),
                'alpha_gap_pct': round((vreal - current_price) / current_price * 100, 4),
                'dfii10_coef': round(float(beta[1]), 6),
                'dtwexbgs_coef': round(float(beta[2]), 6),
                'vixcls_coef': round(float(beta[3]), 6),
                'intercept': round(float(beta[0]), 6),
            })
        except Exception:
            continue
    
    if len(results) < 100:
        print(f"  Skipping {ticker}: only {len(results)} baseline observations")
        continue
    
    # ─── Calibrate band using empirical 16th/84th percentiles of residuals ───
    residuals_pct = [(r['current_price'] - r['vreal']) / r['vreal'] for r in results]
    p16 = np.percentile(residuals_pct, 16)
    p84 = np.percentile(residuals_pct, 84)
    
    # Write to vreal_v2_shadow
    model_version = f'v2_{ticker.lower()}_baseline'
    print(f"  Writing {len(results)} rows with model_version={model_version}")
    print(f"  Residual p16={p16:.4f}, p84={p84:.4f}, coverage target: ~68%")
    
    # Clear existing
    run_sql(f"DELETE FROM central.vreal_v2_shadow WHERE model_version = '{model_version}'")
    
    # Write in batches of 50
    BATCH = 50
    for i in range(0, len(results), BATCH):
        batch = results[i:i+BATCH]
        value_strs = []
        for r in batch:
            components = json.dumps({
                'dfii10_coef': r['dfii10_coef'],
                'dtwexbgs_coef': r['dtwexbgs_coef'],
                'vixcls_coef': r['vixcls_coef'],
                'intercept': r['intercept'],
                'p16': round(p16, 6),
                'p84': round(p84, 6),
            })
            band_low = round(r['vreal'] * (1 + p16), 2)
            band_high = round(r['vreal'] * (1 + p84), 2)
            value_strs.append(
                f"('{ticker}', '{r['d']}', {r['current_price']}, {r['baseline']}, 0, {r['vreal']}, "
                f"{r['sigma_annual'] / np.sqrt(252) if r['sigma_annual'] else 'NULL'}, "
                f"{band_low}, {band_high}, 0.68, '{model_version}', '{components}')"
            )
        values = ',\n'.join(value_strs)
        run_sql(f"""
        INSERT INTO central.vreal_v2_shadow (ticker, observation_d, current_price, baseline, adjust, vreal, sigma, band_low, band_high, confidence, model_version, components)
        VALUES {values}
        """)
    
    # Coverage check
    coverage_sql = f"""
    SELECT 
      COUNT(*)::text as total,
      COUNT(*) FILTER (WHERE current_price >= band_low AND current_price <= band_high)::text as in_band
    FROM central.vreal_v2_shadow WHERE model_version = '{model_version}'
    """
    cov = run_sql(coverage_sql)[0]
    total = int(cov['total'])
    in_band = int(cov['in_band'])
    pct = round(in_band/total*100, 1) if total > 0 else 0
    
    # Factor coefficients
    avg_coef_sql = f"""
    SELECT 
      ROUND(AVG((components->>'dfii10_coef')::numeric), 4) as avg_dfii10,
      ROUND(AVG((components->>'dtwexbgs_coef')::numeric), 4) as avg_dtwexbgs,
      ROUND(AVG((components->>'vixcls_coef')::numeric), 4) as avg_vixcls
    FROM central.vreal_v2_shadow WHERE model_version = '{model_version}' AND components IS NOT NULL
    """
    coefs = run_sql(avg_coef_sql)[0]
    
    results_summary.append({
        'ticker': ticker,
        'rows': total,
        'coverage': f"{pct}%",
        'p16': f"{p16:.4f}",
        'p84': f"{p84:.4f}",
        'avg_dfii10': coefs['avg_dfii10'],
        'avg_dtwexbgs': coefs['avg_dtwexbgs'],
        'avg_vixcls': coefs['avg_vixcls'],
    })
    print(f"  {ticker}: {total} rows, coverage={pct}%, band=[{p16:.2%}, +{p84:.2%}]")
    print(f"  Coefs: DFII10={coefs['avg_dfii10']}, DTWEXBGS={coefs['avg_dtwexbgs']}, VIXCLS={coefs['avg_vixcls']}")

# ─── 6. Summary ──────────────────────────────────────────────────────
print("\n" + "="*60)
print("=== SEQ-2 COMPLETE: V_real Baseline for All Assets ===")
print(f"{'Ticker':8s} | {'Rows':>5s} | {'Coverage':>8s} | {'Band Low':>10s} | {'Band High':>10s} | {'DFII10':>7s} | {'DTWEXBGS':>9s} | {'VIXCLS':>7s}")
print("-"*80)
for r in results_summary:
    print(f"  {r['ticker']:8s} | {r['rows']:>5s} | {r['coverage']:>8s} | {r['p16']:>10s} | {r['p84']:>10s} | {r['avg_dfii10']:>7s} | {r['avg_dtwexbgs']:>9s} | {r['avg_vixcls']:>7s}")

print(f"\nTotal assets processed: {len(results_summary)}")