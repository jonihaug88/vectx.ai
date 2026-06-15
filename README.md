# VectX v3 Pipeline

Commodity & Forex alpha generation pipeline (3-layer architecture).

## Architecture

- **Layer 1**: Data collection (RSS, web search) + event analysis
- **Layer 2**: Driver weighting + future events + V_real computation
- **Layer 3**: Trade generation (correlations, risk/reward, paper trades)

## Production Scripts

| Script | Layer | Model | Purpose |
|--------|-------|-------|---------|
| `layer1_collect.ts` | L1 | None | RSS feed harvesting |
| `layer1_research.ts` | L1 | Gemini 3 Flash | Web search analysis |
| `l1_analyze_gemini.ts` | L1 | Gemini 2.5 Flash | Event scoring |
| `layer2_collect.ts` | L2 | None | Event marking |
| `layer2_research_v2.ts` | L2 | Gemini 3 Flash | Driver weightings + future events |
| `layer2_analyze_v2.ts` | L2 | GLM-5 (Ollama Cloud) | V_real computation |
| `layer3_collect.ts` | L3 | None | Asset + alpha data collection |
| `layer3_research.ts` | L3 | Gemini 3 Flash | Correlations + trading metrics |
| `layer3_analyze.ts` | L3 | Gemini 2.5 Flash | Trade recommendations |
| `paper_trade_lifecycle_v2.ts` | LC | GLM-5 | Paper trade tracking |
| `updatePrices.ts` | PF | None | Multi-provider price feed |
| `driver_first_research.ts` | DF | Gemini 2.5 Flash | Driver-first shadow research |

## Setup

1. Copy `config.template.json` to `config.json` and fill in API keys
2. `npm install`
3. Run schema: `schema_v3.sql` then `schema_v3_additions.sql`

## Current Status

- Paper trading (dry_run: true)
- 20 assets (10 commodities + 10 forex)
- Weighting-Fix deployed (SUM=1.0 enforcement)
- future_damper_v3 = 0.3
