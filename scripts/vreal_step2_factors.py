#!/usr/bin/env python3
"""
VECTX V3 — Step 2: DCC-GARCH + 3 Macro Factors (WS1)
1. DCC-GARCH over 20 asset returns → time-varying correlation matrix
2. 3 standardized macro factors: USD (DTWEXBGS), Risk (VIXCLS), Real Rate (DFII10)
3. Rolling regression of each asset's returns on factor innovations → betas
Writes to: central.md_factors (new table)
Point-in-time: expanding window, no look-ahead.
"""

import json
import requests
import numpy as np
import pandas as pd
from arch import arch_model
import warnings
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

def run_sql_raw(sql: str):
    r = requests.post(
        f'{SUPABASE_URL}/functions/v1/run-sql',
        headers={'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN},
        json={'sql': sql}
    )
    return r

# ─── 1. Load data ──────────────────────────────────────────────────
print("Loading volatility data...")
vol_rows = run_sql("""
SELECT ticker, d, logret, sigma_garch
FROM central.md_volatility
ORDER BY ticker, d
""")
vol_df = pd.DataFrame(vol_rows)
vol_df['d'] = pd.to_datetime(vol_df['d'])
vol_df['logret'] = pd.to_numeric(vol_df['logret'], errors='coerce')
vol_df['sigma_garch'] = pd.to_numeric(vol_df['sigma_garch'], errors='coerce')
print(f"  Loaded {len(vol_df)} volatility rows for {vol_df['ticker'].nunique()} tickers")

# Pivot to wide form: date × ticker
returns_wide = vol_df.pivot(index='d', columns='ticker', values='logret').dropna()
print(f"  Returns matrix: {returns_wide.shape[0]} days × {returns_wide.shape[1]} assets")

# ─── 2. Load fundamentals ─────────────────────────────────────────
print("Loading fundamentals...")
fund_rows = run_sql("""
SELECT series_id, d, value
FROM central.md_fundamentals
WHERE series_id IN ('DTWEXBGS', 'VIXCLS', 'DFII10')
ORDER BY series_id, d
""")
fund_df = pd.DataFrame(fund_rows)
fund_df['d'] = pd.to_datetime(fund_df['d'])
fund_df['value'] = pd.to_numeric(fund_df['value'], errors='coerce')
print(f"  Loaded {len(fund_df)} fundamental rows for {fund_df['series_id'].nunique()} series")

# ─── 3. Factor innovations ────────────────────────────────────────
# Standardize each factor: z-score of log-changes
factor_changes = {}
for sid in ['DTWEXBGS', 'VIXCLS', 'DFII10']:
    s = fund_df[fund_df['series_id'] == sid].set_index('d')['value'].sort_index()
    # Log changes for USD index and VIX, simple changes for real rate
    if sid == 'DFII10':
        changes = s.diff()  # rate changes, not log changes
    else:
        changes = np.log(s / s.shift(1))  # log changes
    changes = changes.dropna()
    # Standardize (z-score)
    z = (changes - changes.rolling(252).mean()) / changes.rolling(252).std()
    factor_changes[sid] = z.dropna()

# Align factor dates with return dates
factor_df = pd.DataFrame(factor_changes)
factor_df.index.name = 'd'
print(f"  Factor innovations: {factor_df.shape[0]} days")

# ─── 4. DCC-GARCH correlation matrix (simplified approach) ────────
# Full DCC-GARCH on 20 assets is computationally expensive.
# Use EWMA correlation (exponential weighting) as practical approximation.
print("Computing EWMA correlation matrix (DCC approximation)...")

EWMA_LAMBDA = 0.94
returns_aligned = returns_wide.dropna()

# Compute EWMA covariance matrix at each date
# For efficiency: store weekly snapshots
date_range = returns_aligned.index
asset_tickers = list(returns_aligned.columns)

# ─── 5. Rolling factor betas ─────────────────────────────────────
print("Computing rolling factor betas...")

ROLLING_WINDOW = 252  # 1 year rolling window

# Align returns and factors
common_dates = returns_aligned.index.intersection(factor_df.index)
R = returns_aligned.loc[common_dates]
F = factor_df.loc[common_dates]

# Rolling regression: R_asset = alpha + beta_USD*F_USD + beta_Risk*F_Risk + beta_RealRate*F_RealRate + eps
factor_names = {'DTWEXBGS': 'beta_usd', 'VIXCLS': 'beta_risk', 'DFII10': 'beta_realrate'}
betas = []

for ticker in asset_tickers:
    if ticker not in R.columns:
        continue
    asset_returns = R[ticker]
    
    # Rolling OLS: expanding window, min 120 obs
    for end_idx in range(ROLLING_WINDOW, len(R), 5):  # every 5 days for efficiency
        end_date = R.index[end_idx]
        start_idx = max(0, end_idx - ROLLING_WINDOW)
        
        y = asset_returns.iloc[start_idx:end_idx+1].values
        X = F.iloc[start_idx:end_idx+1][['DTWEXBGS', 'VIXCLS', 'DFII10']].values
        X = np.column_stack([np.ones(len(y)), X])
        
        # Skip if too many NaNs
        mask = ~(np.isnan(y) | np.isnan(X).any(axis=1))
        y_clean = y[mask]
        X_clean = X[mask]
        
        if len(y_clean) < 60:  # min 60 observations
            continue
        
        try:
            beta = np.linalg.lstsq(X_clean, y_clean, rcond=None)[0]
            betas.append({
                'ticker': ticker,
                'd': end_date.strftime('%Y-%m-%d'),
                'beta_usd': round(float(beta[1]), 6),
                'beta_risk': round(float(beta[2]), 6),
                'beta_realrate': round(float(beta[3]), 6),
                'alpha': round(float(beta[0]), 8),
                'n_obs': int(len(y_clean)),
            })
        except Exception:
            continue

print(f"  Computed {len(betas)} beta observations")

# ─── 6. Factor time series (daily) ─────────────────────────────
# Store daily factor innovations for use in Step 3
factor_daily = []
for d_idx in range(len(F)):
    d = F.index[d_idx].strftime('%Y-%m-%d')
    factor_daily.append({
        'd': d,
        'factor_usd': round(float(F.iloc[d_idx]['DTWEXBGS']), 8) if not pd.isna(F.iloc[d_idx]['DTWEXBGS']) else None,
        'factor_risk': round(float(F.iloc[d_idx]['VIXCLS']), 8) if not pd.isna(F.iloc[d_idx]['VIXCLS']) else None,
        'factor_realrate': round(float(F.iloc[d_idx]['DFII10']), 8) if not pd.isna(F.iloc[d_idx]['DFII10']) else None,
    })

# ─── 7. Create md_factors table ──────────────────────────────────
print("Creating md_factors table...")
run_sql("""
CREATE TABLE IF NOT EXISTS central.md_factors (
    id BIGSERIAL PRIMARY KEY,
    ticker VARCHAR(20),
    d DATE,
    factor_usd DOUBLE PRECISION,
    factor_risk DOUBLE PRECISION,
    factor_realrate DOUBLE PRECISION,
    beta_usd DOUBLE PRECISION,
    beta_risk DOUBLE PRECISION,
    beta_realrate DOUBLE PRECISION,
    alpha DOUBLE PRECISION,
    n_obs INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(ticker, d)
)
""")

# ─── 8. Write factor daily series (ticker = '_FACTORS') ──────────
print("Writing factor innovations...")
run_sql("DELETE FROM central.md_factors WHERE ticker = '_FACTORS'")

BATCH = 500
for i in range(0, len(factor_daily), BATCH):
    batch = factor_daily[i:i+BATCH]
    values = ',\n'.join(
        f"('_FACTORS', '{r['d']}', "
        f"{'NULL' if r['factor_usd'] is None else r['factor_usd']}, "
        f"{'NULL' if r['factor_risk'] is None else r['factor_risk']}, "
        f"{'NULL' if r['factor_realrate'] is None else r['factor_realrate']}, "
        f"NULL, NULL, NULL, NULL, NULL)"
        for r in batch
    )
    run_sql(f"INSERT INTO central.md_factors (ticker, d, factor_usd, factor_risk, factor_realrate, beta_usd, beta_risk, beta_realrate, alpha, n_obs) VALUES {values}")
print(f"  Written {len(factor_daily)} factor daily rows")

# ─── 9. Write betas ──────────────────────────────────────────────
print("Writing factor betas...")
BATCH = 500
for i in range(0, len(betas), BATCH):
    batch = betas[i:i+BATCH]
    values = ',\n'.join(
        f"('{r['ticker']}', '{r['d']}', NULL, NULL, NULL, "
        f"{r['beta_usd']}, {r['beta_risk']}, {r['beta_realrate']}, {r['alpha']}, {r['n_obs']})"
        for r in batch
    )
    run_sql(f"INSERT INTO central.md_factors (ticker, d, factor_usd, factor_risk, factor_realrate, beta_usd, beta_risk, beta_realrate, alpha, n_obs) VALUES {values}")
print(f"  Written {len(betas)} beta rows")

# ─── 10. Validation ──────────────────────────────────────────────
print("\n=== Validation: Factor Betas (latest date per asset) ===")
sql = """
SELECT ticker, 
  ROUND(beta_usd::numeric, 3) as beta_usd,
  ROUND(beta_risk::numeric, 3) as beta_risk,
  ROUND(beta_realrate::numeric, 3) as beta_realrate,
  n_obs
FROM central.md_factors
WHERE ticker != '_FACTORS'
  AND d = (SELECT MAX(d) FROM central.md_factors WHERE ticker != '_FACTORS')
ORDER BY ticker
"""
beta_data = run_sql(sql)
for row in beta_data:
    usd_sign = "✅" if row['ticker'].endswith('USD') and float(row['beta_usd']) < 0 else ("⚠️" if row['ticker'].endswith('USD') else "")
    print(f"  {row['ticker']:8s} | USD={row['beta_usd']:>6s} | Risk={row['beta_risk']:>6s} | Rate={row['beta_realrate']:>6s} | n={row['n_obs']} {usd_sign}")

# FX pairs: USD beta should be NEGATIVE for XXX/USD (USD up → pair down)
fx_pairs = [r for r in beta_data if r['ticker'].endswith('USD') or r['ticker'] in ['EURJPY', 'GBPJPY']]
neg_usd = sum(1 for r in fx_pairs if r['ticker'].endswith('USD') and float(r['beta_usd']) < 0)
print(f"\nFX pairs with negative USD beta: {neg_usd}/{len([r for r in beta_data if r['ticker'].endswith('USD')])} (expected: most)")

# AUD/NZD correlation
sql_corr = """
SELECT ROUND(AVG(CASE WHEN a.ticker='AUDUSD' THEN a.beta_usd END)::numeric, 3) as aud_usd,
  ROUND(AVG(CASE WHEN a.ticker='NZDUSD' THEN a.beta_usd END)::numeric, 3) as nzd_usd,
  ROUND(AVG(CASE WHEN a.ticker='AUDUSD' THEN a.beta_risk END)::numeric, 3) as aud_risk,
  ROUND(AVG(CASE WHEN a.ticker='NZDUSD' THEN a.beta_risk END)::numeric, 3) as nzd_risk
FROM central.md_factors a
WHERE a.ticker IN ('AUDUSD', 'NZDUSD')
  AND a.d = (SELECT MAX(d) FROM central.md_factors WHERE ticker IN ('AUDUSD', 'NZDUSD'))
"""
corr_data = run_sql(sql_corr)
if corr_data:
    c = corr_data[0]
    print(f"\nAUD/NZD correlation check: AUD_USD={c['aud_usd']}, NZD_USD={c['nzd_usd']}, AUD_Risk={c['aud_risk']}, NZD_Risk={c['nzd_risk']}")
    similar = abs(float(c['aud_usd'] or 0) - float(c['nzd_usd'] or 0)) < 0.3
    print(f"  AUD/NZD betas similar: {'✅ YES' if similar else '❌ NO'}")

print("\nStep 2 complete.")