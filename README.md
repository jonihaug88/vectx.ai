# VectX.ai Pipeline

Multi-layer commodity/forex analysis pipeline.

## Architecture

### Layer 1 — Data Collection
- **Collect**: RSS feeds → `central.drivers_events` (no LLM)
- **Research**: Web search → `central.research_events` (Gemini Flash)
- **Analyze**: Event scoring → `central.events` (GLM-5)

### Layer 2 — Analysis
- **Collect**: Mark events for L2 processing
- **Research**: Driver weightings + future events (Gemini 3 Flash / Stufe A: Gemini 2.5 Pro)
- **Analyze**: Alpha/V_real calculation (GLM-5)

### Layer 3 — Trade
- **Collect**: Asset + alpha data gathering
- **Research**: Correlations + trading metrics (Gemini 3 Flash)
- **Analyze**: Trade recommendations (Gemini 2.5 Pro)

### V_real Shadow System
- `vreal_step1_volatility.py` — EWMA + GJR-GARCH(1,1) volatility
- `vreal_step2_factors.py` — Macro factor betas (USD, Risk, Real Rate)
- `vreal_step3_gold_baseline.py` — Gold baseline (single asset)
- `vreal_step3b_all_assets.py` — All 20 assets baseline
- Writes to `central.vreal_v2_shadow` (SHADOW, never production tables)
- Asymmetric 68% quantile bands calibrated per asset

### Driver-First (DF) Mode
- `driver_first_research.ts` — Stufe A (weekly weightings) + Stufe B (daily events)
- DF events have `source_method='driver_first'` in `central.events`
- L1 RSS crons are disabled; DF owns all event collection

## Config

Copy `config.template.json` → `config.json` and fill in API keys.

**Never commit `config.json`** — it's in `.gitignore`.

## Database

Supabase (PostgreSQL) via Edge Function `/functions/v1/run-sql`.

## Key Rules

- `active = TRUE` filter on ALL driver queries
- Inactive driver weights must be NULL
- Σ_active = 1.0 per asset (renormalize after any change)
- V_real shadow writes ONLY to `central.alpha_shadow`, never production tables
- Shadow crons stay DISABLED until Jonathan approves cutover
- `trash` > `rm`
