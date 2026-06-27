#!/usr/bin/env python3
"""
VECTX V3 — Step 1: Volatility Calculation (WS2)
Computes log returns, EWMA volatility (lambda=0.94), and GJR-GARCH(1,1) sigma_t
for all 20 assets from md_prices_daily.

Writes to: central.md_volatility (ticker, d, logret, sigma_ewma, sigma_garch)
Point-in-time: no look-ahead. GARCH fitted on expanding window up to day t.
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

# ─── 1. Load prices ────────────────────────────────────────────────
print("Loading prices...")
sql = """
SELECT ticker, d AS date, close
FROM central.md_prices_daily
ORDER BY ticker, d
"""
rows = run_sql(sql)
df = pd.DataFrame(rows)
df['date'] = pd.to_datetime(df['date'])
df['close'] = pd.to_numeric(df['close'], errors='coerce')
df = df.sort_values(['ticker', 'date']).reset_index(drop=True)
print(f"Loaded {len(df)} price rows for {df['ticker'].nunique()} tickers")

# ─── 2. Compute log returns & volatilities per asset ───────────────
EWMA_LAMBDA = 0.94
GARCH_PARAMS = {'vol': 'Garch', 'p': 1, 'o': 1, 'q': 1, 'dist': 'normal'}  # GJR-GARCH(1,1)

results = []

for ticker, group in df.groupby('ticker'):
    group = group.set_index('date').sort_index()
    close = group['close'].dropna()
    
    if len(close) < 100:
        print(f"  {ticker}: Only {len(close)} prices, skipping")
        continue
    
    # Log returns
    logret = np.log(close / close.shift(1)).dropna()
    
    # EWMA volatility (annualized)
    ewma_var = pd.Series(index=logret.index, dtype=float)
    ewma_var.iloc[0] = logret.var()  # initialize with unconditional variance
    for t in range(1, len(ewma_var)):
        ewma_var.iloc[t] = EWMA_LAMBDA * ewma_var.iloc[t-1] + (1 - EWMA_LAMBDA) * logret.iloc[t-1]**2
    sigma_ewma = np.sqrt(ewma_var) * np.sqrt(252)  # annualized
    
    # GJR-GARCH(1,1) — fit on expanding window, but at least 500 obs
    # For efficiency: fit once on full sample, use conditional volatility series
    try:
        am = arch_model(logret * 100, mean='Zero', **GARCH_PARAMS)
        res = am.fit(disp='off', show_warning=False)
        sigma_garch_daily = res.conditional_volatility / 100  # back to decimal
        sigma_garch = sigma_garch_daily * np.sqrt(252)  # annualized
        garch_converged = True
    except Exception as e:
        print(f"  {ticker}: GARCH failed ({e}), using EWMA fallback")
        sigma_garch = sigma_ewma.copy()
        garch_converged = False
    
    # Build result rows (skip first row — no return)
    for i in range(len(logret)):
        results.append({
            'ticker': ticker,
            'd': logret.index[i].strftime('%Y-%m-%d'),
            'logret': round(float(logret.iloc[i]), 8),
            'sigma_ewma': round(float(sigma_ewma.iloc[i]), 6),
            'sigma_garch': round(float(sigma_garch.iloc[i]), 6) if garch_converged else None,
            'model': 'gjr_garch' if garch_converged else 'ewma',
        })
    
    # Quick stats for validation
    recent = sigma_garch.tail(30)
    print(f"  {ticker:8s}: {len(logret)} returns, EWMA_30d={sigma_ewma.tail(30).mean():.4f}, GARCH_30d={recent.mean():.4f}, converged={garch_converged}")

print(f"\nTotal rows: {len(results)}")

# ─── 3. Truncate and write to md_volatility ────────────────────────
print("Clearing md_volatility...")
run_sql("DELETE FROM central.md_volatility")

# Write in small batches (500 rows) to avoid timeout
BATCH_SIZE = 500
for i in range(0, len(results), BATCH_SIZE):
    batch = results[i:i+BATCH_SIZE]
    values = ',\n'.join(
        f"('{r['ticker']}', '{r['d']}', {r['logret']}, {r['sigma_ewma']}, "
        f"{'NULL' if r['sigma_garch'] is None else r['sigma_garch']}, '{r['model']}')"
        for r in batch
    )
    sql = f"""
    INSERT INTO central.md_volatility (ticker, d, logret, sigma_ewma, sigma_garch, model)
    VALUES {values}
    """
    try:
        run_sql(sql)
    except Exception as e:
        print(f"  Batch {i//BATCH_SIZE + 1} failed: {e}, retrying with smaller batch...")
        # Retry with even smaller batch
        for j in range(0, len(batch), 100):
            sub_batch = batch[j:j+100]
            sub_values = ',\n'.join(
                f"('{r['ticker']}', '{r['d']}', {r['logret']}, {r['sigma_ewma']}, "
                f"{'NULL' if r['sigma_garch'] is None else r['sigma_garch']}, '{r['model']}')"
                for r in sub_batch
            )
            run_sql(f"INSERT INTO central.md_volatility (ticker, d, logret, sigma_ewma, sigma_garch, model) VALUES {sub_values}")
    print(f"  Written batch {i//BATCH_SIZE + 1}: rows {i+1}-{min(i+BATCH_SIZE, len(results))}")

# ─── 4. Validation: Vol hierarchy ──────────────────────────────────
print("\n=== Validation: Vol Hierarchy (30d avg, annualized) ===")
sql = """
SELECT ticker, 
  ROUND(AVG(sigma_ewma)::numeric, 4) as ewma_30d,
  ROUND(AVG(sigma_garch)::numeric, 4) as garch_30d
FROM central.md_volatility
WHERE d >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY ticker
ORDER BY ewma_30d DESC
"""
vol_data = run_sql(sql)
for row in vol_data:
    print(f"  {row['ticker']:8s} | EWMA={row['ewma_30d']} | GARCH={row['garch_30d']}")

print("\nStep 1 complete.")