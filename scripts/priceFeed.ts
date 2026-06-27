// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Price Feed Abstraction Layer
// ═══════════════════════════════════════════════════════════════════
//
// Purpose: Decouple the lifecycle tracker from specific price providers.
// Allows adding/swapping providers (Twelve Data, Alpha Vantage, EIA, ...)
// without touching business logic.
//
// Usage:
//   const feed = new PriceFeed([
//     new TwelveDataProvider(process.env.TWELVE_DATA_KEY),
//     new AlphaVantageProvider(process.env.ALPHA_VANTAGE_KEY),
//   ]);
//   const price = await feed.getLatest("OIL_WTI");
//
// ═══════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// Load config
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = resolve(__dirname, '../config.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const TWELVE_DATA_API_KEY = config.twelve_data_api_key || process.env.TWELVE_DATA_API_KEY;
const ALPHA_VANTAGE_API_KEY = config.alpha_vantage_api_key || process.env.ALPHA_VANTAGE_API_KEY;
const EIA_API_KEY = config.eia_api_key;

export interface PriceTick {
  ticker: string;
  price: number;
  timestamp: Date;
  source: string;       // which provider delivered this
  is_stale: boolean;    // true if > 2 min old for non-market hours assets
  bid?: number;
  ask?: number;
  volume?: number;
}

export interface PriceBar {
  ticker: string;
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface PriceProvider {
  readonly name: string;
  readonly supports: (ticker: string) => boolean;
  getLatest(ticker: string): Promise<PriceTick>;
  /** Get OHLC bars — needed for backfilling max_favorable/max_adverse */
  getBars(
    ticker: string,
    interval: "1min" | "5min" | "15min" | "1h" | "1day",
    from: Date,
    to: Date
  ): Promise<PriceBar[]>;
}

// ─── Ticker normalization ──────────────────────────────────────────
// Each provider uses different ticker conventions. Normalize internally.
//   Your DB:         Twelve Data:    Alpha Vantage:   EIA:
//   "OIL_WTI"        "CL=F" or "WTI" "WTI"            "PET.RWTC.D"
//   "EURUSD"         "EUR/USD"       "EURUSD"         —

export const TICKER_MAP: Record<string, Record<string, string>> = {
  twelve_data: {
    // Commodities (10) - Futures symbols
    WTI: "CL",              // Crude Oil WTI Futures
    BRENT: "BZ",            // Brent Crude Futures
    NG: "NG",               // Natural Gas Futures
    GC: "GC",               // Gold Futures
    SI: "SI",               // Silver Futures
    HG: "HG",               // Copper Futures
    ZC: "ZC",               // Corn Futures
    ZS: "ZS",               // Soybeans Futures
    ZW: "ZW",               // Wheat Futures
    KC: "KC",               // Coffee Futures
    // Forex (10) - Currency pairs
    EURUSD: "EUR/USD",
    GBPUSD: "GBP/USD",
    USDJPY: "USD/JPY",
    USDCHF: "USD/CHF",
    USDCAD: "USD/CAD",
    AUDUSD: "AUD/USD",
    NZDUSD: "NZD/USD",
    EURGBP: "EUR/GBP",
    EURJPY: "EUR/JPY",
    GBPJPY: "GBP/JPY",
  },
  alpha_vantage: {
    // Commodities (limited support)
    WTI: "WTI",
    BRENT: "BRENT",
    // Forex (all majors)
    EURUSD: "EURUSD",
    GBPUSD: "GBPUSD",
    USDJPY: "USDJPY",
    USDCHF: "USDCHF",
    USDCAD: "USDCAD",
    AUDUSD: "AUDUSD",
    NZDUSD: "NZDUSD",
    EURGBP: "EURGBP",
    EURJPY: "EURJPY",
    GBPJPY: "GBPJPY",
  },
  eia: {
    // Energy only (free, unlimited)
    WTI: "PET.RWTC.D",
    BRENT: "PET.RBRTE.D",
    NG: "NG.RNGWHHD.D",
  },
};

// ─── Provider: Twelve Data ─────────────────────────────────────────

export class TwelveDataProvider implements PriceProvider {
  readonly name = "twelve_data";
  private readonly baseUrl = "https://api.twelvedata.com";

  constructor(private readonly apiKey: string) {}

  supports(ticker: string): boolean {
    return ticker in TICKER_MAP.twelve_data;
  }

  async getLatest(ticker: string): Promise<PriceTick> {
    const externalTicker = TICKER_MAP.twelve_data[ticker];
    if (!externalTicker) throw new Error(`${this.name} does not support ${ticker}`);

    const url = `${this.baseUrl}/price?symbol=${encodeURIComponent(
      externalTicker
    )}&apikey=${this.apiKey}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === "error") {
      throw new Error(`${this.name} error: ${data.message}`);
    }

    const price = parseFloat(data.price);
    if (!Number.isFinite(price)) {
      throw new Error(`${this.name} returned invalid price: ${data.price}`);
    }

    return {
      ticker,
      price,
      timestamp: new Date(),
      source: this.name,
      is_stale: false,
    };
  }

  async getBars(
    ticker: string,
    interval: "1min" | "5min" | "15min" | "1h" | "1day",
    from: Date,
    to: Date
  ): Promise<PriceBar[]> {
    const externalTicker = TICKER_MAP.twelve_data[ticker];
    if (!externalTicker) throw new Error(`${this.name} does not support ${ticker}`);

    const intervalMap: Record<string, string> = {
      "1min": "1min",
      "5min": "5min",
      "15min": "15min",
      "1h": "1h",
      "1day": "1day",
    };

    const url =
      `${this.baseUrl}/time_series` +
      `?symbol=${encodeURIComponent(externalTicker)}` +
      `&interval=${intervalMap[interval]}` +
      `&start_date=${from.toISOString()}` +
      `&end_date=${to.toISOString()}` +
      `&apikey=${this.apiKey}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === "error" || !Array.isArray(data.values)) {
      throw new Error(`${this.name} error: ${data.message || "no data"}`);
    }

    return (data.values as any[])
      .map((v) => ({
        ticker,
        timestamp: new Date(v.datetime),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: v.volume ? parseFloat(v.volume) : undefined,
      }))
      .reverse();
  }
}

// ─── Provider: Alpha Vantage (fallback for FOREX) ──────────────────

export class AlphaVantageProvider implements PriceProvider {
  readonly name = "alpha_vantage";
  private readonly baseUrl = "https://www.alphavantage.co/query";

  constructor(private readonly apiKey: string) {}

  supports(ticker: string): boolean {
    return ticker in TICKER_MAP.alpha_vantage;
  }

  async getLatest(ticker: string): Promise<PriceTick> {
    const externalTicker = TICKER_MAP.alpha_vantage[ticker];
    if (!externalTicker) throw new Error(`${this.name} does not support ${ticker}`);

    // AV distinguishes FX from commodities
    const isFx = /^[A-Z]{6}$/.test(externalTicker);
    const params = isFx
      ? new URLSearchParams({
          function: "CURRENCY_EXCHANGE_RATE",
          from_currency: externalTicker.slice(0, 3),
          to_currency: externalTicker.slice(3),
          apikey: this.apiKey,
        })
      : new URLSearchParams({
          function: "WTI",
          interval: "daily",
          apikey: this.apiKey,
        });

    const res = await fetch(`${this.baseUrl}?${params}`);
    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    const data = await res.json();

    let price: number;
    let ts: Date;

    if (isFx) {
      const rate = data["Realtime Currency Exchange Rate"];
      if (!rate) throw new Error(`${this.name} returned no FX data`);
      price = parseFloat(rate["5. Exchange Rate"]);
      ts = new Date(rate["6. Last Refreshed"] + " UTC");
    } else {
      const latest = data.data?.[0];
      if (!latest) throw new Error(`${this.name} returned no commodity data`);
      price = parseFloat(latest.value);
      ts = new Date(latest.date);
    }

    if (!Number.isFinite(price)) throw new Error(`${this.name} invalid price`);

    const ageMinutes = (Date.now() - ts.getTime()) / 60_000;
    return {
      ticker,
      price,
      timestamp: ts,
      source: this.name,
      is_stale: ageMinutes > 30,
    };
  }

  async getBars(): Promise<PriceBar[]> {
    throw new Error(`${this.name} getBars not implemented — use Twelve Data for bars`);
  }
}

// ─── Provider: Yahoo Finance (last resort) ─────────────────────────

export class YahooFinanceProvider implements PriceProvider {
  readonly name = "yahoo_finance";

  private readonly symbols: Record<string, string> = {
    WTI: "CL=F",
    BRENT: "BZ=F",
    NG: "NG=F",
    GC: "GC=F",
    SI: "SI=F",
    HG: "HG=F",
    ZC: "ZC=F",
    ZS: "ZS=F",
    ZW: "ZW=F",
    KC: "KC=F",
    EURUSD: "EURUSD=X",
    GBPUSD: "GBPUSD=X",
    USDJPY: "USDJPY=X",
    USDCHF: "USDCHF=X",
    USDCAD: "USDCAD=X",
    AUDUSD: "AUDUSD=X",
    NZDUSD: "NZDUSD=X",
    EURGBP: "EURGBP=X",
    EURJPY: "EURJPY=X",
    GBPJPY: "GBPJPY=X",
  };

  supports(ticker: string): boolean {
    return ticker in this.symbols;
  }

  async getLatest(ticker: string): Promise<PriceTick> {
    const symbol = this.symbols[ticker];
    if (!symbol) throw new Error(`${this.name} does not support ${ticker}`);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    if (!res.ok) throw new Error(`${this.name} HTTP ${res.status}`);
    const data = await res.json();

    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!price || !Number.isFinite(price)) {
      throw new Error(`${this.name} no valid price for ${ticker}`);
    }

    return {
      ticker,
      price,
      timestamp: new Date(),
      source: this.name,
      is_stale: false,
    };
  }

  async getBars(): Promise<PriceBar[]> {
    throw new Error(`${this.name} getBars not implemented`);
  }
}

// ─── Price Cache ───────────────────────────────────────────────────

interface CacheEntry {
  tick: PriceTick;
  cachedAt: number;
}

const PRICE_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getCachedPrice(ticker: string): PriceTick | null {
  const entry = PRICE_CACHE.get(ticker);
  if (!entry) return null;
  
  const age = Date.now() - entry.cachedAt;
  if (age > CACHE_TTL_MS) {
    PRICE_CACHE.delete(ticker);
    return null;
  }
  
  return {
    ...entry.tick,
    is_stale: age > 2 * 60 * 1000, // Mark stale if > 2 min old
  };
}

function setCachedPrice(ticker: string, tick: PriceTick): void {
  PRICE_CACHE.set(ticker, {
    tick,
    cachedAt: Date.now(),
  });
}

// ─── Orchestrator: PriceFeed ───────────────────────────────────────

export class PriceFeed {
  constructor(private readonly providers: PriceProvider[]) {
    if (providers.length === 0) throw new Error("PriceFeed requires ≥1 provider");
  }

  async getLatest(ticker: string, useCache = true): Promise<PriceTick> {
    // Check cache first
    if (useCache) {
      const cached = getCachedPrice(ticker);
      if (cached) {
        console.log(`  [CACHE] ${ticker}: $${cached.price.toFixed(4)} (age: ${((Date.now() - PRICE_CACHE.get(ticker)!.cachedAt) / 1000).toFixed(0)}s)`);
        return cached;
      }
    }

    const errors: string[] = [];

    for (const provider of this.providers) {
      if (!provider.supports(ticker)) continue;
      try {
        const tick = await provider.getLatest(ticker);
        if (tick.is_stale) {
          errors.push(`${provider.name}: stale`);
          continue;
        }
        // Cache the result
        setCachedPrice(ticker, tick);
        return tick;
      } catch (err) {
        errors.push(`${provider.name}: ${(err as Error).message}`);
      }
    }

    throw new Error(
      `No provider delivered ${ticker}. Errors: ${errors.join(" | ")}`
    );
  }

  async getBars(
    ticker: string,
    interval: "1min" | "5min" | "15min" | "1h" | "1day",
    from: Date,
    to: Date
  ): Promise<PriceBar[]> {
    for (const provider of this.providers) {
      if (!provider.supports(ticker)) continue;
      try {
        return await provider.getBars(ticker, interval, from, to);
      } catch (err) {
        // Try next provider
      }
    }
    throw new Error(`No provider delivered bars for ${ticker}`);
  }
  
  // Clear cache (useful for testing)
  clearCache(): void {
    PRICE_CACHE.clear();
  }
  
  // Get cache stats
  getCacheStats(): { size: number; tickers: string[] } {
    return {
      size: PRICE_CACHE.size,
      tickers: Array.from(PRICE_CACHE.keys()),
    };
  }
}

// ─── Factory: Create configured PriceFeed ───────────────────────────

export function createPriceFeed(): PriceFeed {
  const providers: PriceProvider[] = [];

  // Yahoo Finance first for commodities (more reliable for futures)
  providers.push(new YahooFinanceProvider());

  // Twelve Data as fallback for forex
  if (TWELVE_DATA_API_KEY) {
    providers.push(new TwelveDataProvider(TWELVE_DATA_API_KEY));
  }

  // Alpha Vantage for additional forex support
  if (ALPHA_VANTAGE_API_KEY) {
    providers.push(new AlphaVantageProvider(ALPHA_VANTAGE_API_KEY));
  }

  return new PriceFeed(providers);
}