// ═════════════════════════════════════════════════════════════════════════════
// L1 PRE-FILTER - Asset & Driver Keywords
// ═════════════════════════════════════════════════════════════════════════════
//
// Zweck: Pre-LLM Filter - Events verwerfen die NICHT zum Asset passen
// Deploy: Teil von 03b_pre_filter.ts
//
// Logik:
//   1. Asset-Keywords prüfen (Pflicht)
//   2. Driver-Keywords prüfen (optional)
//   3. Wenn KEIN Match → Event verwerfen (oder im Shadow Mode loggen)
//
// Erstellt: 2026-05-09
// ═════════════════════════════════════════════════════════════════════════════

export interface AssetKeywords {
  ticker: string;
  name: string;
  asset_class: string;
  
  // Pflicht-Keywords (MINDSTENS einer muss im Headline vorkommen)
  primary_keywords: string[];
  
  // Sekundäre Keywords (verstärken die Relevanz)
  secondary_keywords: string[];
  
  // Ausschluss-Keywords (wenn vorhanden → verwerfen)
  exclude_keywords: string[];
}

export const ASSET_KEYWORDS: AssetKeywords[] = [
  // ═════════════════════════════════════════════════════════════════════════
  // COMMODITIES - Energy
  // ═════════════════════════════════════════════════════════════════════════
  
  {
    ticker: 'WTI',
    name: 'Crude Oil WTI',
    asset_class: 'commodity',
    primary_keywords: [
      'wti', 'west texas', 'crude oil', 'oil price', 'oil prices',
      'brent spread', 'wti price', 'us oil', 'american crude',
      'nymex crude', 'light sweet crude'
    ],
    secondary_keywords: [
      'opec', 'oil production', 'oil demand', 'oil supply',
      'rig count', 'shale oil', 'us inventories', 'api crude',
      'eia crude', 'strategic petroleum reserve', 'spr'
    ],
    exclude_keywords: [
      'palm oil', 'olive oil', 'coconut oil', 'fish oil',
      'motor oil', 'engine oil', 'essential oil'
    ]
  },
  
  {
    ticker: 'BRENT',
    name: 'Crude Oil Brent',
    asset_class: 'commodity',
    primary_keywords: [
      'brent', 'brent crude', 'north sea', 'ice brent',
      'brent price', 'brent oil', 'european crude', 'brent futures'
    ],
    secondary_keywords: [
      'opec', 'north sea production', 'oil demand', 'oil supply',
      'brent-wti spread', 'dated brent', 'forties', 'ekofisk'
    ],
    exclude_keywords: [
      'palm oil', 'olive oil', 'coconut oil'
    ]
  },
  
  {
    ticker: 'NG',
    name: 'Natural Gas',
    asset_class: 'commodity',
    primary_keywords: [
      'natural gas', 'lng', 'gas price', 'gas prices',
      'natural gas futures', 'henry hub', 'nymex gas',
      'us gas', 'gas demand', 'gas supply'
    ],
    secondary_keywords: [
      'gas storage', 'gas injection', 'gas withdrawal',
      'lng export', 'lng terminal', 'freeport lng',
      'gas production', 'gas rig count', 'weather gas demand'
    ],
    exclude_keywords: [
      'gasoline', 'petrol', 'gas station', 'gas pump',
      'greenhouse gas', 'gas turbine'
    ]
  },

  // ═════════════════════════════════════════════════════════════════════════
  // COMMODITIES - Precious Metals
  // ═════════════════════════════════════════════════════════════════════════
  
  {
    ticker: 'GC',
    name: 'Gold',
    asset_class: 'commodity',
    primary_keywords: [
      'gold', 'gold price', 'gold prices', 'xau',
      'gold futures', 'comex gold', 'spot gold',
      'gold etf', 'gold demand', 'gold supply'
    ],
    secondary_keywords: [
      'central bank gold', 'gold reserve', 'gold mining',
      'safe haven', 'inflation hedge', 'precious metals',
      'gold jewelry', 'gold coin', 'gold bar'
    ],
    exclude_keywords: [
      'goldman', 'golden', 'gold medal', 'gold coast'
    ]
  },
  
  {
    ticker: 'SI',
    name: 'Silver',
    asset_class: 'commodity',
    primary_keywords: [
      'silver', 'silver price', 'xag', 'silver prices',
      'silver futures', 'comex silver', 'spot silver',
      'silver etf', 'silver demand'
    ],
    secondary_keywords: [
      'silver mining', 'industrial silver', 'silver jewelry',
      'photovoltaic silver', 'silver coins', 'precious metals'
    ],
    exclude_keywords: [
      'silver lining', 'silver bullet', 'silver screen'
    ]
  },

  {
    ticker: 'HG',
    name: 'Copper',
    asset_class: 'commodity',
    primary_keywords: [
      'copper', 'copper price', 'copper prices',
      'comex copper', 'lme copper', 'copper futures',
      'copper demand', 'copper supply'
    ],
    secondary_keywords: [
      'copper mining', 'copper production', 'industrial copper',
      'dr copper', 'china copper', 'copper inventory',
      'copper smelter', 'copper concentrate'
    ],
    exclude_keywords: []
  },

  // ═════════════════════════════════════════════════════════════════════════
  // COMMODITIES - Agriculture
  // ═════════════════════════════════════════════════════════════════════════
  
  {
    ticker: 'ZC',
    name: 'Corn',
    asset_class: 'commodity',
    primary_keywords: [
      'corn', 'corn price', 'corn prices', 'maize',
      'corn futures', 'cbot corn', 'us corn',
      'corn harvest', 'corn production'
    ],
    secondary_keywords: [
      'ethanol corn', 'corn ethanol', 'feed corn',
      'corn yield', 'corn acreage', 'planting corn',
      'corn belt', 'iowa corn', 'corn export'
    ],
    exclude_keywords: [
      'corn syrup', 'popcorn'
    ]
  },
  
  {
    ticker: 'ZS',
    name: 'Soybeans',
    asset_class: 'commodity',
    primary_keywords: [
      'soybeans', 'soybean', 'soy price', 'soy prices',
      'soybean futures', 'cbot soybeans', 'soybean oil',
      'soybean meal', 'us soy'
    ],
    secondary_keywords: [
      'soybean harvest', 'soybean production', 'soybean acreage',
      'brazil soy', 'argentina soy', 'soybean export',
      'soybean yield', 'soybean crushing'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'ZW',
    name: 'Wheat',
    asset_class: 'commodity',
    primary_keywords: [
      'wheat', 'wheat price', 'wheat prices',
      'wheat futures', 'cbot wheat', 'kansas wheat',
      'spring wheat', 'winter wheat', 'wheat harvest'
    ],
    secondary_keywords: [
      'wheat production', 'wheat export', 'wheat acreage',
      'black sea wheat', 'russia wheat', 'ukraine wheat',
      'wheat yield', 'wheat inventory', 'wheat flour'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'KC',
    name: 'Coffee',
    asset_class: 'commodity',
    primary_keywords: [
      'coffee', 'coffee price', 'coffee prices',
      'arabica', 'robusta', 'coffee futures',
      'ice coffee', 'coffee beans', 'coffee production'
    ],
    secondary_keywords: [
      'brazil coffee', 'vietnam coffee', 'colombia coffee',
      'coffee harvest', 'coffee export', 'coffee inventory',
      'coffee roasting', 'specialty coffee'
    ],
    exclude_keywords: []
  },

  // ═════════════════════════════════════════════════════════════════════════
  // FOREX - Majors
  // ═════════════════════════════════════════════════════════════════════════
  
  {
    ticker: 'EURUSD',
    name: 'EUR/USD',
    asset_class: 'forex',
    primary_keywords: [
      'eurusd', 'eur/usd', 'euro dollar', 'euro usd',
      'eurusd rate', 'euro exchange rate', 'dollar euro'
    ],
    secondary_keywords: [
      'ecb', 'federal reserve', 'fed rate', 'ecb rate',
      'eurozone', 'europe economy', 'us economy',
      'interest rate differential', 'euro inflation', 'us inflation'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'GBPUSD',
    name: 'GBP/USD',
    asset_class: 'forex',
    primary_keywords: [
      'gbpusd', 'gbp/usd', 'pound dollar', 'cable',
      'british pound', 'gbpusd rate', 'pound sterling'
    ],
    secondary_keywords: [
      'bank of england', 'boe rate', 'uk inflation',
      'brexit', 'uk economy', 'uk gdp',
      'pound dollar rate', 'sterling dollar'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'USDJPY',
    name: 'USD/JPY',
    asset_class: 'forex',
    primary_keywords: [
      'usdjpy', 'usd/jpy', 'dollar yen', 'yen dollar',
      'usdjpy rate', 'japan yen', 'dollar yen rate'
    ],
    secondary_keywords: [
      'bank of japan', 'boj', 'boj rate', 'japan economy',
      'yen intervention', 'japan inflation', 'carry trade',
      'japan gdp', 'abenomics', 'kuroda'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'USDCHF',
    name: 'USD/CHF',
    asset_class: 'forex',
    primary_keywords: [
      'usdchf', 'usd/chf', 'dollar franc', 'swiss franc',
      'usdchf rate', 'swiss franc dollar'
    ],
    secondary_keywords: [
      'swiss national bank', 'snb', 'snb rate',
      'switzerland economy', 'swiss inflation',
      'franc safe haven', 'snb intervention'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'AUDUSD',
    name: 'AUD/USD',
    asset_class: 'forex',
    primary_keywords: [
      'audusd', 'aud/usd', 'aussie dollar', 'australian dollar',
      'audusd rate', 'aud dollar'
    ],
    secondary_keywords: [
      'rba', 'reserve bank of australia', 'rba rate',
      'australia economy', 'australia inflation',
      'iron ore australia', 'china trade'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'NZDUSD',
    name: 'NZD/USD',
    asset_class: 'forex',
    primary_keywords: [
      'nzdusd', 'nzd/usd', 'kiwi dollar', 'new zealand dollar',
      'nzdusd rate', 'kiwi'
    ],
    secondary_keywords: [
      'rbnz', 'reserve bank of new zealand', 'nz rate',
      'new zealand economy', 'dairy prices',
      'new zealand inflation', 'nz gdp'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'USDCAD',
    name: 'USD/CAD',
    asset_class: 'forex',
    primary_keywords: [
      'usdcad', 'usd/cad', 'loonie', 'canadian dollar',
      'usdcad rate', 'cad dollar'
    ],
    secondary_keywords: [
      'bank of canada', 'boc rate', 'canada economy',
      'canada oil', 'canada inflation', 'cad interest rate',
      'usmca', 'canada trade'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'EURGBP',
    name: 'EUR/GBP',
    asset_class: 'forex',
    primary_keywords: [
      'eurgbp', 'eur/gbp', 'euro pound', 'euro sterling',
      'eurgbp rate'
    ],
    secondary_keywords: [
      'ecb', 'bank of england', 'boe rate', 'ecb rate',
      'eurozone uk trade', 'brexit trade'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'EURJPY',
    name: 'EUR/JPY',
    asset_class: 'forex',
    primary_keywords: [
      'eurjpy', 'eur/jpy', 'euro yen', 'euro yen rate',
      'eurjpy rate'
    ],
    secondary_keywords: [
      'ecb', 'bank of japan', 'boj rate', 'ecb rate',
      'eurozone japan trade', 'carry trade'
    ],
    exclude_keywords: []
  },
  
  {
    ticker: 'GBPJPY',
    name: 'GBP/JPY',
    asset_class: 'forex',
    primary_keywords: [
      'gbpjpy', 'gbp/jpy', 'pound yen', 'sterling yen',
      'gbpjpy rate', 'gopher'
    ],
    secondary_keywords: [
      'bank of england', 'bank of japan', 'boe rate', 'boj rate',
      'uk japan trade', 'carry trade'
    ],
    exclude_keywords: []
  }
];

// ═════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Check if a headline matches an asset's keywords
 */
export function matchesAsset(headline: string, assetTicker: string): {
  matches: boolean;
  reason: string;
  primaryMatch?: string;
  excludeMatch?: string;
} {
  const asset = ASSET_KEYWORDS.find(a => a.ticker === assetTicker);
  if (!asset) {
    return { matches: false, reason: 'unknown_asset' };
  }
  
  const headlineLower = headline.toLowerCase();
  
  // Check exclusions first
  for (const ex of asset.exclude_keywords) {
    if (headlineLower.includes(ex.toLowerCase())) {
      return { 
        matches: false, 
        reason: 'excluded',
        excludeMatch: ex 
      };
    }
  }
  
  // Check primary keywords (MUST match at least one)
  for (const pk of asset.primary_keywords) {
    if (headlineLower.includes(pk.toLowerCase())) {
      return { 
        matches: true, 
        reason: 'primary_match',
        primaryMatch: pk 
      };
    }
  }
  
  // Check secondary keywords (optional, strengthens confidence)
  for (const sk of asset.secondary_keywords) {
    if (headlineLower.includes(sk.toLowerCase())) {
      return { 
        matches: true, 
        reason: 'secondary_match',
        primaryMatch: sk 
      };
    }
  }
  
  // No match found
  return { 
    matches: false, 
    reason: 'no_keyword_match' 
  };
}

/**
 * Get all asset tickers that might match a headline
 */
export function getMatchingAssets(headline: string): string[] {
  const matches: string[] = [];
  
  for (const asset of ASSET_KEYWORDS) {
    const result = matchesAsset(headline, asset.ticker);
    if (result.matches) {
      matches.push(asset.ticker);
    }
  }
  
  return matches;
}