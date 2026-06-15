// ═════════════════════════════════════════════════════════════════════════════
// L1 PRE-FILTER - Main Filter Framework
// ═════════════════════════════════════════════════════════════════════════════
//
// Zweck: Events filtern VOR dem LLM-Call basierend auf Keywords
// Deploy: In L1 Analyze vor dem LLM-Call aufrufen
//
// Shadow Mode (Tag 4-5): Nur loggen, nicht filtern
// Production Mode (Tag 6+): Wirklich filtern
//
// Erstellt: 2026-05-09
// ═════════════════════════════════════════════════════════════════════════════

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { matchesAsset, ASSET_KEYWORDS } from "./03a_keywords.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const config = JSON.parse(readFileSync(resolve(__dirname, "../config.json"), "utf-8"));

const SUPABASE_URL = config.supabase_url;
const ADMIN_TOKEN = config.supabase_admin_token;

// ═════════════════════════════════════════════════════════════════════════════
// KONFIGURATION
// ═════════════════════════════════════════════════════════════════════════════

// Shadow Mode: true = nur loggen, false = wirklich filtern
const SHADOW_MODE = true;

// Minimum Content Length (Characters)
const MIN_CONTENT_LENGTH = 50;

// ═════════════════════════════════════════════════════════════════════════════
// TYPES
// ═════════════════════════════════════════════════════════════════════════════

export interface PreFilterResult {
  pass: boolean;
  reason: 'passed' | 'no_asset_match' | 'excluded' | 'headline_only' | 'too_short' | 'url_content';
  details?: {
    matchingAssets?: string[];
    excludeMatch?: string;
    primaryMatch?: string;
    contentLength?: number;
    isUrl?: boolean;
  };
}

export interface DriverEvent {
  id: string;
  asset_id: string;
  asset_name: string;
  headline: string;
  output: string;
  driver_name: string;
  source_name: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// PRE-FILTER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Pre-Filter für ein einzelnes Event
 * Prüft: Asset-Match, Content-Length, URL-Detection
 */
export function preFilterEvent(event: DriverEvent, targetAssetTicker: string): PreFilterResult {
  
  // 1. Content-Length prüfen
  const contentLength = event.output?.length || 0;
  if (contentLength < MIN_CONTENT_LENGTH) {
    return {
      pass: false,
      reason: 'too_short',
      details: { contentLength }
    };
  }
  
  // 2. URL-Detection
  if (event.output?.startsWith('http://') || event.output?.startsWith('https://')) {
    return {
      pass: false,
      reason: 'url_content',
      details: { isUrl: true }
    };
  }
  
  // 3. Headline-Only Detection
  if (event.output === event.headline) {
    return {
      pass: false,
      reason: 'headline_only',
      details: { contentLength }
    };
  }
  
  // 4. Asset-Keyword Match
  const matchResult = matchesAsset(event.headline, targetAssetTicker);
  
  if (!matchResult.matches) {
    if (matchResult.reason === 'excluded') {
      return {
        pass: false,
        reason: 'excluded',
        details: { excludeMatch: matchResult.excludeMatch }
      };
    }
    return {
      pass: false,
      reason: 'no_asset_match',
      details: { matchingAssets: getMatchingAssets(event.headline) }
    };
  }
  
  // Passed all filters
  return {
    pass: true,
    reason: 'passed',
    details: {
      primaryMatch: matchResult.primaryMatch
    }
  };
}

/**
 * Batch Pre-Filter für alle Events eines Assets
 * Gibt zurück: (passed events, rejects)
 */
export function preFilterEvents(
  events: DriverEvent[],
  targetAssetTicker: string
): { passed: DriverEvent[]; rejects: Array<{ event: DriverEvent; result: PreFilterResult }> } {
  
  const passed: DriverEvent[] = [];
  const rejects: Array<{ event: DriverEvent; result: PreFilterResult }> = [];
  
  for (const event of events) {
    const result = preFilterEvent(event, targetAssetTicker);
    
    if (result.pass) {
      passed.push(event);
    } else {
      rejects.push({ event, result });
    }
  }
  
  return { passed, rejects };
}

// ═════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═════════════════════════════════════════════════════════════════════════════

async function runSql<T>(query: string): Promise<T[]> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/run-sql`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ sql: query }),
  });
  const result = await response.json();
  return result.data || [];
}

/**
 * Log rejects to database (for both Shadow and Production modes)
 */
export async function logRejects(
  rejects: Array<{ event: DriverEvent; result: PreFilterResult }>,
  assetTicker: string
): Promise<void> {
  if (rejects.length === 0) return;
  
  const values = rejects.map(r => `
    (
      '${r.event.id}',
      '${r.event.asset_id}',
      '${assetTicker}',
      '${r.event.driver_name?.replace(/'/g, "''")}',
      '${r.event.headline?.replace(/'/g, "''")}',
      '${r.result.reason}',
      '${JSON.stringify(r.result.details || {}).replace(/'/g, "''")}',
      ${SHADOW_MODE}
    )
  `).join(",");
  
  await runSql(`
    INSERT INTO central.l1_pre_filter_rejects (
      driver_event_id, asset_id, asset_ticker, driver_name, headline,
      reject_reason, reject_details, shadow_mode
    )
    VALUES ${values}
  `);
}

/**
 * Get filter statistics for last 24 hours
 */
export async function getFilterStats(): Promise<{
  total: number;
  passed: number;
  rejected: number;
  shadowMode: number;
  productionMode: number;
  byReason: Record<string, number>;
}> {
  const stats = await runSql<any>(`
    SELECT 
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE shadow_mode = false) as production_mode,
      COUNT(*) FILTER (WHERE shadow_mode = true) as shadow_mode
    FROM central.l1_pre_filter_rejects
    WHERE rejected_at > NOW() - INTERVAL '24 hours'
  `);
  
  const byReason = await runSql<any>(`
    SELECT reject_reason, COUNT(*) as count
    FROM central.l1_pre_filter_rejects
    WHERE rejected_at > NOW() - INTERVAL '24 hours'
    GROUP BY reject_reason
    ORDER BY count DESC
  `);
  
  const byReasonMap: Record<string, number> = {};
  for (const r of byReason) {
    byReasonMap[r.reject_reason] = r.count;
  }
  
  return {
    total: stats[0]?.total || 0,
    passed: 0, // Would need to track separately
    rejected: stats[0]?.total || 0,
    shadowMode: stats[0]?.shadow_mode || 0,
    productionMode: stats[0]?.production_mode || 0,
    byReason: byReasonMap
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORT FOR L1 ANALYZE
// ═════════════════════════════════════════════════════════════════════════════

export { SHADOW_MODE };