-- =====================================================
-- VECTX V3 - Layer 3 Schema Additions
-- Missing columns for layer3_research.ts
-- =====================================================

-- Add l3 tracking columns to assets
ALTER TABLE central.assets
ADD COLUMN IF NOT EXISTS l3_ready BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS l3_researched_at TIMESTAMPTZ;

-- Create index for Layer 3 research queries
CREATE INDEX IF NOT EXISTS idx_assets_l3_ready ON central.assets(l3_ready, l3_researched_at);

-- Add correlation metadata columns
ALTER TABLE central.correlations
ADD COLUMN IF NOT EXISTS stability VARCHAR(20) DEFAULT 'moderate',
ADD COLUMN IF NOT EXISTS hedge_suitability INT DEFAULT 5,
ADD COLUMN IF NOT EXISTS reasoning TEXT,
ADD COLUMN IF NOT EXISTS last_update TIMESTAMPTZ DEFAULT NOW();

-- Mark assets that have alpha data as ready for L3 research
UPDATE central.assets a
SET l3_ready = true
WHERE EXISTS (
  SELECT 1 FROM central.alpha alpha 
  WHERE alpha.asset_id = a.id
);

-- Verify the changes
SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'central' 
AND table_name = 'assets'
ORDER BY ordinal_position;

SELECT column_name, data_type 
FROM information_schema.columns 
WHERE table_schema = 'central' 
AND table_name = 'correlations'
ORDER BY ordinal_position;