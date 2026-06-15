-- =====================================================
-- VECTX V3 DATABASE SCHEMA
-- Created: 2026-04-17
-- =====================================================

-- Create central schema
CREATE SCHEMA IF NOT EXISTS central;

-- =====================================================
-- CENTRAL.ASSETS
-- Alle Asset-Daten zentral geführt
-- =====================================================
CREATE TABLE central.assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    asset_class VARCHAR(20) NOT NULL CHECK (asset_class IN ('commodity', 'forex')),
    base_currency VARCHAR(10),
    quote_currency VARCHAR(10),
    current_price DECIMAL(18, 6),
    vreal DECIMAL(18, 6),
    alpha_gap DECIMAL(10, 4),
    alpha_interval VARCHAR(50),
    act_trademarket_informations JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- CENTRAL.DRIVERS
-- Treiber pro Asset (z.B. OPEC für oil_wti)
-- =====================================================
CREATE TABLE central.drivers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    driver_name VARCHAR(100) NOT NULL,
    class VARCHAR(50),
    description TEXT,
    supply_or_demand VARCHAR(10) CHECK (supply_or_demand IN ('supply', 'demand', 'both')),
    quantitative_or_qualitative VARCHAR(20) CHECK (quantitative_or_qualitative IN ('quantitative', 'qualitative', 'both')),
    impact_score DECIMAL(3, 2),
    act_sentiment_score DECIMAL(4, 3),
    act_weighting DECIMAL(4, 3),
    rules JSONB,
    llm_context TEXT,
    source_count INT DEFAULT 0,
    event_count INT DEFAULT 0,
    analysis_interval VARCHAR(50) DEFAULT '1h',
    last_analysis TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_drivers_asset ON central.drivers(asset_id);
CREATE INDEX idx_drivers_name ON central.drivers(driver_name);

-- =====================================================
-- CENTRAL.DRIVERS_SOURCES
-- RSS-Quellen pro Treiber
-- =====================================================
CREATE TABLE central.drivers_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    driver_id UUID REFERENCES central.drivers(id) ON DELETE CASCADE,
    driver_name VARCHAR(100),
    name VARCHAR(200) NOT NULL,
    description TEXT,
    url VARCHAR(500) NOT NULL,
    source_type VARCHAR(50) DEFAULT 'rss',
    trust_score DECIMAL(3, 2) DEFAULT 0.5,
    impact_score DECIMAL(3, 2),
    auto_analyze BOOLEAN DEFAULT TRUE,
    last_fetch TIMESTAMPTZ,
    last_result VARCHAR(50),
    active BOOLEAN DEFAULT TRUE,
    error_count INT DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sources_driver ON central.drivers_sources(driver_id);
CREATE INDEX idx_sources_asset ON central.drivers_sources(asset_id);

-- =====================================================
-- CENTRAL.DRIVERS_EVENTS
-- Events aus RSS-Feeds (Layer 1 Collect)
-- =====================================================
CREATE TABLE central.drivers_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    driver_id UUID REFERENCES central.drivers(id) ON DELETE CASCADE,
    driver_name VARCHAR(100),
    source_id UUID REFERENCES central.drivers_sources(id) ON DELETE CASCADE,
    source_name VARCHAR(200),
    headline TEXT NOT NULL,
    output TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_drivers_events_asset ON central.drivers_events(asset_id);
CREATE INDEX idx_drivers_events_driver ON central.drivers_events(driver_id);
CREATE INDEX idx_drivers_events_created ON central.drivers_events(created_at);

-- =====================================================
-- CENTRAL.RESEARCH_EVENTS
-- Events aus Research-Job (Layer 1 Research)
-- =====================================================
CREATE TABLE central.research_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    headline TEXT NOT NULL,
    summary TEXT,
    impact_score DECIMAL(3, 2),
    sentiment_score DECIMAL(4, 3),
    existing_driver VARCHAR(100),
    existing_source VARCHAR(200),
    new_driver VARCHAR(100),
    new_source VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_research_events_asset ON central.research_events(asset_id);
CREATE INDEX idx_research_events_created ON central.research_events(created_at);

-- =====================================================
-- CENTRAL.EVENTS
-- Analysierte Events (Layer 1 Analyze Output)
-- =====================================================
CREATE TABLE central.events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    event_type VARCHAR(50),
    headline TEXT NOT NULL,
    summary TEXT,
    impact_score DECIMAL(3, 2),
    sentiment_score DECIMAL(4, 3),
    quantitative_or_qualitative VARCHAR(20) CHECK (quantitative_or_qualitative IN ('quantitative', 'qualitative', 'both')),
    supply_or_demand VARCHAR(10) CHECK (supply_or_demand IN ('supply', 'demand', 'both')),
    timeline_score INT,
    l2_analysis_id UUID,
    weighting DECIMAL(4, 3),
    driver_name VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_asset ON central.events(asset_id);
CREATE INDEX idx_events_driver ON central.events(driver_name);
CREATE INDEX idx_events_created ON central.events(created_at);

-- =====================================================
-- CENTRAL.FUTURE_EVENTS
-- Proaktive Zukunfts-Events (Layer 2 Research Output)
-- =====================================================
CREATE TABLE central.future_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    event_type VARCHAR(50),
    headline TEXT NOT NULL,
    summary TEXT,
    impact_score DECIMAL(3, 2),
    sentiment_score DECIMAL(4, 3),
    probability DECIMAL(4, 3),
    quantitative_or_qualitative VARCHAR(20) CHECK (quantitative_or_qualitative IN ('quantitative', 'qualitative', 'both')),
    supply_or_demand VARCHAR(10) CHECK (supply_or_demand IN ('supply', 'demand', 'both')),
    timeline_score INT,
    driver_name VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_future_events_asset ON central.future_events(asset_id);
CREATE INDEX idx_future_events_created ON central.future_events(created_at);

-- =====================================================
-- CENTRAL.ALPHA
-- Alpha-Analysen Ergebnisse (Layer 2 Analyze Output)
-- =====================================================
CREATE TABLE central.alpha (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    vreal DECIMAL(18, 6),
    alpha_gap DECIMAL(10, 4),
    current_price DECIMAL(18, 6),
    validity_hours INT,
    event_count INT,
    future_event_count INT,
    confidence_score DECIMAL(4, 3),
    calculation_details JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alpha_asset ON central.alpha(asset_id);
CREATE INDEX idx_alpha_created ON central.alpha(created_at);

-- =====================================================
-- CENTRAL.PRICES
-- Preis-Historie
-- =====================================================
CREATE TABLE central.prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    price DECIMAL(18, 6) NOT NULL,
    change_pct DECIMAL(10, 4),
    observation_date TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_prices_asset ON central.prices(asset_id);
CREATE INDEX idx_prices_date ON central.prices(observation_date);

-- =====================================================
-- CENTRAL.CORRELATIONS
-- Korrelationen zwischen Assets (Layer 3 Research Output)
-- =====================================================
CREATE TABLE central.correlations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id_1 UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name_1 VARCHAR(20),
    asset_id_2 UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name_2 VARCHAR(20),
    correlation DECIMAL(5, 4) NOT NULL,
    calculated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(asset_id_1, asset_id_2)
);

CREATE INDEX idx_correlations_asset1 ON central.correlations(asset_id_1);
CREATE INDEX idx_correlations_asset2 ON central.correlations(asset_id_2);

-- =====================================================
-- CENTRAL.TRADES
-- Alle Trades (Layer 3 Analyze Output)
-- =====================================================
CREATE TABLE central.trades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id UUID REFERENCES central.assets(id) ON DELETE CASCADE,
    asset_name VARCHAR(20),
    signal_direction VARCHAR(10) CHECK (signal_direction IN ('long', 'short')),
    hedge_asset_id UUID REFERENCES central.assets(id),
    hedge_direction VARCHAR(10) CHECK (hedge_direction IN ('long', 'short')),
    risk_reward_ratio DECIMAL(10, 4),
    entry_price DECIMAL(18, 6),
    exit_price DECIMAL(18, 6),
    position_size DECIMAL(10, 4),
    leverage DECIMAL(10, 4),
    stop_loss_pct DECIMAL(10, 4),
    take_profit_pct DECIMAL(10, 4),
    kelly_fraction DECIMAL(10, 4),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'open', 'closed', 'cancelled')),
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trades_asset ON central.trades(asset_id);
CREATE INDEX idx_trades_status ON central.trades(status);
CREATE INDEX idx_trades_created ON central.trades(created_at);

-- =====================================================
-- CENTRAL.JOBS
-- Cron-Jobs Übersicht
-- =====================================================
CREATE TABLE central.jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    affected_tables TEXT[],
    time_interval VARCHAR(50),
    last_run TIMESTAMPTZ,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- INSERT DEFAULT ASSETS
-- =====================================================
INSERT INTO central.assets (ticker, name, asset_class, base_currency, quote_currency) VALUES
-- Commodities (10)
('WTI', 'Crude Oil WTI', 'commodity', 'WTI', 'USD'),
('BRENT', 'Crude Oil Brent', 'commodity', 'BRENT', 'USD'),
('NG', 'Natural Gas', 'commodity', 'NG', 'USD'),
('GC', 'Gold', 'commodity', 'XAU', 'USD'),
('SI', 'Silver', 'commodity', 'XAG', 'USD'),
('HG', 'Copper', 'commodity', 'HG', 'USD'),
('ZC', 'Corn', 'commodity', 'ZC', 'USD'),
('ZS', 'Soybeans', 'commodity', 'ZS', 'USD'),
('ZW', 'Wheat', 'commodity', 'ZW', 'USD'),
('KC', 'Coffee Arabica', 'commodity', 'KC', 'USD'),
-- Forex (10)
('EURUSD', 'EUR/USD', 'forex', 'EUR', 'USD'),
('GBPUSD', 'GBP/USD', 'forex', 'GBP', 'USD'),
('USDJPY', 'USD/JPY', 'forex', 'USD', 'JPY'),
('USDCHF', 'USD/CHF', 'forex', 'USD', 'CHF'),
('USDCAD', 'USD/CAD', 'forex', 'USD', 'CAD'),
('AUDUSD', 'AUD/USD', 'forex', 'AUD', 'USD'),
('NZDUSD', 'NZD/USD', 'forex', 'NZD', 'USD'),
('EURGBP', 'EUR/GBP', 'forex', 'EUR', 'GBP'),
('EURJPY', 'EUR/JPY', 'forex', 'EUR', 'JPY'),
('GBPJPY', 'GBP/JPY', 'forex', 'GBP', 'JPY');

