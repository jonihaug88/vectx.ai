#!/usr/bin/env python3
"""
VECTX V3 — V_real v2 Rolling Baseline Fix (EURUSD, USDJPY, GC)

Fixes the anti-trend bias from static full-period OLS by using:
1. Rolling 2-year OLS (504 trading days) instead of expanding window
2. FX-specific: DGS2 (US short rate) replaces DTWEXBGS for EURUSD/USDJPY
3. GC: Keeps all 3 factors but with rolling window

Writes to: central.vreal_v2_shadow with model_version = 'v2_<ticker>_rolling'
Shadow-only — NEVER touches production tables.
"""

import json
import requests
import numpy as np
import pandas as pd
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

ROLLING_WINDOW = 504  # 2 years
WEEKLY_STEP = 5

# Asset-specific factor configurations
ASSET_FACTORS = {
    'EURUSD': ['DFII10', 'DGS2', 'VIXCLS'],   # DGS2 replaces DTWEXBGS
    'USDJPY': ['DFII10', 'DGS2', 'VIXCLS'],     # DGS2 replaces DTWEXBGS
    'GC':     ['DFII10', 'DTWEXBGS', 'VIXCLS'],  # Keep original factors, just rolling window
}

# ─── 1. Load data ────────────────────────────────────────────────────
print("=== V_real v2 Rolling Baseline Fix ===")
print(f"Assets: {list(ASSET_FACTORS.keys())}")

print("\nLoading prices...")
price_rows = run_sql("SELECT ticker, d AS date, close FROM central.md_prices_daily ORDER BY ticker, d")
prices = pd.DataFrame(price_rows)
prices['date'] = pd.to_datetime(prices['date'])
prices['close'] = pd.to_numeric(prices['close'], errors='coerce')
prices = prices.sort_values(['ticker', 'date']).reset_index(drop=True)

print("Loading fundamentals...")
fund_rows = run_sql("""
SELECT series_id, d, value
FROM central.md_fundamentals
WHERE series_id IN ('DFII10', 'DTWEXBGS', 'VIXCLS', 'DGS2')
ORDER BY series_id, d
""")
fund_df = pd.DataFrame(fund_rows)
fund_df['d'] = pd.to_datetime(fund_df['d'])
fund_df['value'] = pd.to_numeric(fund_df['value'], errors='coerce')
fund_wide = fund_df.pivot(index='d', columns='series_id', values='value')
# Ensure all needed columns exist
for col in ['DFII10', 'DTWEXBGS', 'VIXCLS', 'DGS2']:
    if col not in fund_wide.columns:
        fund_wide[col] = np.nan
print(f"  Fundamentals: {len(fund_wide)} days, columns: {list(fund_wide.columns)}")

print("Loading volatility...")
vol_rows = run_sql("SELECT ticker, d, sigma_garch FROM central.md_volatility ORDER BY ticker, d")
vol_df = pd.DataFrame(vol_rows)
vol_df['d'] = pd.to_datetime(vol_df['d'])
vol_df['sigma_garch'] = pd.to_numeric(vol_df['sigma_garch'], errors='coerce')

# ─── 2. Compute rolling baselines ─────────────────────────────────────
results_summary = []

for ticker, factors in ASSET_FACTORS.items():
    model_version = f'v2_{ticker.lower()}_rolling'
    print(f"\n{'='*60}")
    print(f"Processing {ticker} with factors {factors}...")
    print(f"  Model version: {model_version}")
    
    asset_prices = prices[prices['ticker'] == ticker].set_index('date')['close'].dropna()
    if len(asset_prices) < 300:
        print(f"  Skipping {ticker}: only {len(asset_prices)} prices")
        continue
    
    asset_vol = vol_df[vol_df['ticker'] == ticker].set_index('d')['sigma_garch'].dropna()
    
    # Merge with fundamentals (only needed factors)
    merged = asset_prices.to_frame('close').join(fund_wide[factors], how='left').dropna()
    merged['log_price'] = np.log(merged['close'])
    
    if len(merged) < ROLLING_WINDOW:
        print(f"  Skipping {ticker}: only {len(merged)} merged rows")
        continue
    
    # Prepare regression
    y = merged['log_price'].values
    X_factors = np.column_stack([merged[f].values for f in factors])
    X_const = np.column_stack([np.ones(len(y)), X_factors])
    
    # Compute ALL residuals for band calibration (full period)
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
    coverage = np.mean([(r >= p16 and r <= p84) for r in all_residuals_pct])
    print(f"  Band calibration: p16={p16:.4f}, p84={p84:.4f}, coverage={coverage:.3f}")
    
    # Compute rolling baselines (every 5 trading days)
    new_rows = []
    betas_over_time = []
    
    for end_idx in range(ROLLING_WINDOW, len(merged), WEEKLY_STEP):
        window_y = y[end_idx - ROLLING_WINDOW:end_idx + 1]
        window_X = X_const[end_idx - ROLLING_WINDOW:end_idx + 1]
        mask = ~(np.isnan(window_y) | np.isnan(window_X).any(axis=1))
        if mask.sum() < 60:
            continue
        
        try:
            beta = np.linalg.lstsq(window_X[mask], window_y[mask], rcond=None)[0]
            date_t = merged.index[end_idx]
            date_compare = date_t.tz_localize(None) if date_t.tzinfo is not None else date_t
            current_X = X_const[end_idx]
            baseline = float(current_X @ beta)
            vreal = np.exp(baseline)
            current_price = float(merged['close'].iloc[end_idx])
            sigma_garch = float(asset_vol.get(date_t, np.nan)) if date_t in asset_vol.index else np.nan
            
            # Factor betas for diagnostics
            factor_betas = {factors[i]: round(float(beta[i + 1]), 6) for i in range(len(factors))}
            factor_betas['intercept'] = round(float(beta[0]), 6)
            
            # Sign check
            if ticker in ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD']:
                # XXX/USD: USD rate beta should be positive (higher US rate → higher USD → lower pair)
                # But DGS2 is direct, so positive DGS2 → higher yield → lower EURUSD
                # Actually: higher DGS2 → higher US yields → stronger USD → EURUSD goes down
                # So DGS2 coefficient should be NEGATIVE for EURUSD
                pass
            
            new_rows.append({
                'ticker': ticker,
                'observation_d': date_compare.strftime('%Y-%m-%d'),
                'current_price': round(current_price, 4),
                'baseline': round(baseline, 8),
                'adjust': 0,
                'vreal': round(vreal, 4),
                'sigma': round(float(sigma_garch) / np.sqrt(252) if not np.isnan(sigma_garch) else np.std(all_residuals_pct) / np.sqrt(252), 8),
                'band_low': round(vreal * (1 + p16), 2),
                'band_high': round(vreal * (1 + p84), 2),
                'confidence': round(coverage, 4),
                'model_version': model_version,
                'components': json.dumps({
                    **factor_betas,
                    'window': ROLLING_WINDOW,
                    'p16': round(p16, 6),
                    'p84': round(p84, 6),
                    'factors': factors,
                }),
            })
        except Exception:
            continue
    
    # Write to vreal_v2_shadow
    if new_rows:
        BATCH = 50
        for i in range(0, len(new_rows), BATCH):
            batch = new_rows[i:i + BATCH]
            values = ',\n'.join([
                f"('{r['ticker']}', '{r['observation_d']}', {r['current_price']}, {r['baseline']}, "
                f"{r['adjust']}, {r['vreal']}, {r['sigma']}, {r['band_low']}, {r['band_high']}, "
                f"{r['confidence']}, '{r['model_version']}', "
                f"$$" + r['components'].replace("'", "''") + "$$)"
                for r in batch
            ])
            run_sql(f"""
            INSERT INTO central.vreal_v2_shadow (ticker, observation_d, current_price, baseline, adjust, vreal, sigma, band_low, band_high, confidence, model_version, components)
            VALUES {values}
            ON CONFLICT (ticker, observation_d, model_version) DO NOTHING
            """)
        
        print(f"  Written {len(new_rows)} rows")
        
        # Verify coverage
        verify = run_sql(f"""
        SELECT 
          COUNT(*)::text as total,
          COUNT(*) FILTER (WHERE current_price >= band_low AND current_price <= band_high)::text as in_band
        FROM central.vreal_v2_shadow
        WHERE model_version = '{model_version}'
        """)
        v = verify[0] if verify else {}
        total = int(v.get('total', 0))
        in_band = int(v.get('in_band', 0))
        cov_pct = round(in_band / total * 100, 1) if total > 0 else 0
        
        # Average factor betas
        avg_betas = {}
        for f in factors:
            avg_betas[f] = round(np.mean([json.loads(r['components']).get(f, 0) for r in new_rows]), 6)
        
        results_summary.append({
            'ticker': ticker,
            'rows': total,
            'coverage': f"{cov_pct}%",
            'p16': f"{p16:.4f}",
            'p84': f"{p84:.4f}",
            'avg_betas': avg_betas,
            'gap_mean': round(np.mean(all_residuals_pct) * 100, 2),
        })
    else:
        print(f"  No new rows computed")

# ─── 3. Compare old vs new ───────────────────────────────────────────
print(f"\n{'='*60}")
print("=== Rolling vs Static Baseline Comparison ===")
print(f"{'Ticker':8s} | {'Model':30s} | {'Rows':>5s} | {'Cov':>6s} | {'Gap%':>6s} | {'p16':>8s} | {'p84':>8s} | {'Betas'}")
print("-"*100)

for r in results_summary:
    betas_str = ' | '.join([f"{k}={v}" for k, v in r['avg_betas'].items()])
    print(f"  {r['ticker']:8s} | v2_{r['ticker'].lower()}_rolling | {r['rows']:>5} | {r['coverage']:>6s} | {r['gap_mean']:>6.2f}% | {r['p16']:>8s} | {r['p84']:>8s} | {betas_str}")

# Show old baselines for comparison
for ticker in ASSET_FACTORS.keys():
    old_model = f'v2_{ticker.lower()}_baseline'
    old = run_sql(f"""
    SELECT 
      COUNT(*)::text as total,
      ROUND(AVG((current_price - vreal) / vreal * 100)::numeric, 2) as avg_gap,
      ROUND(COUNT(*) FILTER (WHERE current_price >= band_low AND current_price <= band_high)::numeric / COUNT(*)::numeric * 100, 1) as coverage
    FROM central.vreal_v2_shadow
    WHERE model_version = '{old_model}'
    """)
    if old:
        print(f"  {ticker:8s} | {old_model:30s} | {old[0].get('total', '?'):>5s} | {old[0].get('coverage', '?'):>5s}% | {old[0].get('avg_gap', '?'):>6s}% | (static)")

# ─── 4. Gap→Return correlation check ─────────────────────────────────
print(f"\n{'='*60}")
print("=== Gap→+21T Return Correlation (key metric) ===")

for ticker in ASSET_FACTORS.keys():
    # Rolling model
    rolling_model = f'v2_{ticker.lower()}_rolling'
    static_model = f'v2_{ticker.lower()}_baseline'
    
    for model_name, model_version in [('ROLLING', rolling_model), ('STATIC', static_model)]:
        data = run_sql(f"""
        WITH vreal AS (
          SELECT ticker, observation_d::date as d, vreal, current_price,
                 (current_price - vreal) / vreal as gap_pct
          FROM central.vreal_v2_shadow
          WHERE model_version = '{model_version}'
        ),
        prices AS (
          SELECT ticker, d::date as d, close,
                 LEAD(close, 21) OVER (PARTITION BY ticker ORDER BY d) as close_21d
          FROM central.md_prices_daily
          WHERE ticker = '{ticker}'
        )
        SELECT ROUND(CORR(v.gap_pct, (p.close_21d - p.close) / p.close)::numeric, 4) as corr_gap_return
        FROM vreal v
        JOIN prices p ON v.d = p.d AND p.close_21d IS NOT NULL
        WHERE p.close_21d IS NOT NULL AND p.close > 0
        """)
        if data:
            corr = data[0].get('corr_gap_return', '?')
            print(f"  {ticker:8s} | {model_name:8s} | corr(gap→+21T) = {corr}")

print("\nDone. All writes to shadow tables only (vreal_v2_shadow with model_version='v2_*_rolling').")