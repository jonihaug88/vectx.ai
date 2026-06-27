#!/usr/bin/env python3
"""
VECTX V3 — Step 3: Gold Baseline (WS3, first)
Baseline_Gold = time-varying regression of log(GC-close) on (DFII10, DTWEXBGS, VIXCLS).
V_real_Gold = exp(Baseline) (Adjust=0 for now).
Band = +/- z * sigma_t (from md_volatility).
Writes to: central.vreal_v2_shadow with model_version='v2_gold_baseline'.
"""

import json
import requests
import numpy as np
import pandas as pd
from statsmodels.regression.rolling import RollingOLS
import warnings
warnings.filterwarnings('ignore')

# ─── Config ────────────────────────────────────────────────────────
with open('/data/.openclaw/workspace/intel/config.json') as f:
    config = json.load(f)

SUPABASE_URL = config['supabase_url']
ADMIN_TOKEN = config['supabase_admin_token']

Z_SCORE = 1.0  # 68% band

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

# ─── 1. Load Gold prices ─────────────────────────────────────────
print("Loading Gold prices and volatility...")
gold_rows = run_sql("""
SELECT p.ticker, p.d, p.close, v.sigma_garch
FROM central.md_prices_daily p
LEFT JOIN central.md_volatility v ON p.ticker = v.ticker AND p.d = v.d
WHERE p.ticker = 'GC'
ORDER BY p.d
""")
gold_df = pd.DataFrame(gold_rows)
gold_df['d'] = pd.to_datetime(gold_df['d'])
gold_df['close'] = pd.to_numeric(gold_df['close'], errors='coerce')
gold_df['sigma_garch'] = pd.to_numeric(gold_df['sigma_garch'], errors='coerce')
gold_df = gold_df.sort_values('d').reset_index(drop=True)
print(f"  Gold: {len(gold_df)} rows, {gold_df['d'].min()} → {gold_df['d'].max()}")

# ─── 2. Load fundamentals ────────────────────────────────────────
fund_rows = run_sql("""
SELECT series_id, d, value
FROM central.md_fundamentals
WHERE series_id IN ('DFII10', 'DTWEXBGS', 'VIXCLS')
ORDER BY series_id, d
""")
fund_df = pd.DataFrame(fund_rows)
fund_df['d'] = pd.to_datetime(fund_df['d'])
fund_df['value'] = pd.to_numeric(fund_df['value'], errors='coerce')

# Pivot fundamentals wide
fund_wide = fund_df.pivot(index='d', columns='series_id', values='value')
fund_wide.columns = ['DFII10', 'DTWEXBGS', 'VIXCLS']  # ensure order
print(f"  Fundamentals: {len(fund_wide)} days")

# ─── 3. Merge and compute baseline ────────────────────────────────
print("Computing Gold baseline regression...")

# Merge Gold with fundamentals
merged = gold_df[['d', 'close', 'sigma_garch']].merge(fund_wide, on='d', how='left')
merged = merged.dropna().reset_index(drop=True)
merged['log_gc'] = np.log(merged['close'])

# Rolling regression: log(GC) = alpha + beta1*DFII10 + beta2*DTWEXBGS + beta3*VIXCLS + eps
ROLLING_WINDOW = 252  # 1 year

results = []
for end_idx in range(ROLLING_WINDOW, len(merged)):
    window = merged.iloc[end_idx - ROLLING_WINDOW:end_idx + 1]
    
    y = window['log_gc'].values
    X = window[['DFII10', 'DTWEXBGS', 'VIXCLS']].values
    X_with_const = np.column_stack([np.ones(len(y)), X])
    
    # OLS
    try:
        beta = np.linalg.lstsq(X_with_const, y, rcond=None)[0]
        resid = y - X_with_const @ beta
        sigma_resid = np.std(resid, ddof=3)
        
        # Day t values
        row = merged.iloc[end_idx]
        current_X = np.array([1, row['DFII10'], row['DTWEXBGS'], row['VIXCLS']])
        baseline = float(current_X @ beta)
        
        # V_real = exp(baseline), Adjust = 0 for now
        vreal = np.exp(baseline)
        current_price = float(row['close'])
        
        # Band: use daily sigma from md_volatility, convert to log-space
        # sigma_annual = row['sigma_garch'], sigma_daily = sigma_annual / sqrt(252)
        sigma_daily = float(row['sigma_garch']) / np.sqrt(252) if pd.notna(row['sigma_garch']) else sigma_resid / np.sqrt(252)
        
        # alpha_gap = (vreal - current_price) / current_price
        alpha_gap_pct = (vreal - current_price) / current_price
        
        results.append({
            'd': row['d'].strftime('%Y-%m-%d'),
            'current_price': round(current_price, 4),
            'baseline': round(float(baseline), 8),
            'vreal': round(float(vreal), 4),
            'sigma_daily': round(float(sigma_daily), 8),
            'band_low': round(float(vreal * np.exp(-Z_SCORE * sigma_daily * np.sqrt(252))), 4),
            'band_high': round(float(vreal * np.exp(Z_SCORE * sigma_daily * np.sqrt(252))), 4),
            'alpha_gap_pct': round(float(alpha_gap_pct * 100), 4),
            'dfii10_coef': round(float(beta[1]), 6),
            'dtwexbgs_coef': round(float(beta[2]), 6),
            'vixcls_coef': round(float(beta[3]), 6),
            'intercept': round(float(beta[0]), 6),
        })
    except Exception:
        continue

print(f"  Computed {len(results)} baseline observations")

# ─── 4. Write to vreal_v2_shadow ────────────────────────────────
# Check table schema
schema = run_sql("""
SELECT column_name, data_type FROM information_schema.columns 
WHERE table_schema = 'central' AND table_name = 'vreal_v2_shadow'
ORDER BY ordinal_position
""")
print(f"\n  vreal_v2_shadow schema: {[(s['column_name'], s['data_type']) for s in schema]}")

# Clear existing v2_gold_baseline
run_sql("DELETE FROM central.vreal_v2_shadow WHERE model_version = 'v2_gold_baseline'")

# Write in batches of 50
BATCH = 50
written = 0
for i in range(0, len(results), BATCH):
    batch = results[i:i+BATCH]
    value_strs = []
    for r in batch:
        components = json.dumps({
            'dfii10_coef': r['dfii10_coef'],
            'dtwexbgs_coef': r['dtwexbgs_coef'],
            'vixcls_coef': r['vixcls_coef'],
            'intercept': r['intercept']
        })
        value_strs.append(
            f"('GC', '{r['d']}', {r['current_price']}, {r['baseline']}, 0, {r['vreal']}, "
            f"{r['sigma_daily']}, {r['band_low']}, {r['band_high']}, NULL, "
            f"'v2_gold_baseline', '{components}')"
        )
    values = ',\n'.join(value_strs)
    sql = f"""
    INSERT INTO central.vreal_v2_shadow (ticker, observation_d, current_price, baseline, adjust, vreal, sigma, band_low, band_high, confidence, model_version, components)
    VALUES {values}
    """
    run_sql(sql)
    written += len(batch)
    if (written % 500) == 0:
        print(f"  Written {written}/{len(results)} rows...")

# ─── 5. Validation ────────────────────────────────────────────────
print("\n=== Validation: Gold Baseline ===")

# V_real vs Spot: should diverge informatively
sql = """
SELECT observation_d as d, current_price, vreal, band_low, band_high, sigma,
  ((vreal - current_price) / current_price * 100) as alpha_gap_pct
FROM central.vreal_v2_shadow
WHERE model_version = 'v2_gold_baseline'
ORDER BY observation_d DESC LIMIT 5
"""
recent = run_sql(sql)
print("\nLast 5 observations:")
for row in recent:
    gap_sign = "+" if float(row['alpha_gap_pct']) > 0 else ""
    print(f"  {row['d']}: Spot=${row['current_price']}, V_real=${row['vreal']}, gap={gap_sign}{row['alpha_gap_pct']}%, band=[${row['band_low']}-${row['band_high']}]")

# Band coverage (z=1, target ~68%)
sql2 = """
SELECT 
  COUNT(*)::text as total,
  COUNT(*) FILTER (WHERE current_price >= band_low AND current_price <= band_high)::text as in_band,
  ROUND(COUNT(*) FILTER (WHERE current_price >= band_low AND current_price <= band_high)::numeric / COUNT(*)::numeric * 100, 1)::text as coverage_pct
FROM central.vreal_v2_shadow
WHERE model_version = 'v2_gold_baseline'
"""
cov = run_sql(sql2)[0]
print(f"\nBand coverage (z={Z_SCORE}): {cov['in_band']}/{cov['total']} = {cov['coverage_pct']}% (target: ~68%)")

# V_real vs Spot: should NOT be ~= Spot
sql3 = """
SELECT 
  ROUND(AVG(ABS((vreal - current_price) / current_price * 100))::numeric, 2) as avg_abs_gap,
  ROUND(STDDEV((vreal - current_price) / current_price * 100)::numeric, 2) as std_gap,
  ROUND(MIN((vreal - current_price) / current_price * 100)::numeric, 2) as min_gap,
  ROUND(MAX((vreal - current_price) / current_price * 100)::numeric, 2) as max_gap
FROM central.vreal_v2_shadow
WHERE model_version = 'v2_gold_baseline'
"""
stats = run_sql(sql3)[0]
print(f"\nAlpha gap stats: avg_abs={stats['avg_abs_gap']}%, std={stats['std_gap']}%, range=[{stats['min_gap']}%, {stats['max_gap']}%]")

# Factor coefficients interpretation
sql4 = """
SELECT 
  ROUND(AVG((components->>'dfii10_coef')::numeric)::numeric, 4) as avg_dfii10,
  ROUND(AVG((components->>'dtwexbgs_coef')::numeric)::numeric, 4) as avg_dtwexbgs,
  ROUND(AVG((components->>'vixcls_coef')::numeric)::numeric, 4) as avg_vixcls
FROM central.vreal_v2_shadow
WHERE model_version = 'v2_gold_baseline'
  AND components IS NOT NULL
"""
coefs = run_sql(sql4)[0]
print(f"\nAvg coefficients: DFII10={coefs['avg_dfii10']} (real rate↓ → gold↑?), DTWEXBGS={coefs['avg_dtwexbgs']} (USD↑ → gold↓?), VIXCLS={coefs['avg_vixcls']} (risk↑ → gold↑?)")

print("\nStep 3 complete.")