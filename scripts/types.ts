// ═══════════════════════════════════════════════════════════════════
// vectX.ai — Shared Types
// ═══════════════════════════════════════════════════════════════════

export interface Asset {
  id: string;
  ticker: string;
  name: string;
  asset_class: string;
  current_price: number | null;
}

export interface Driver {
  id: string;
  asset_id: string;
  driver_name: string;
  class?: string;
  description?: string;
  supply_or_demand: string;
  quantitative_or_qualitative: string;
  impact_score?: number;
  act_weighting?: number;
}

export interface ClassifiedEvent {
  id: string;
  asset_id: string;
  asset_name?: string;
  event_type: string;
  headline: string;
  summary: string;
  impact_score: number;
  sentiment_score: number;
  quantitative_or_qualitative: string;
  supply_or_demand: string;
  timeline_score: number;
  driver_name: string;
  weighting?: number;
  created_at: string;
}

export interface FutureEvent {
  id?: string;
  asset_id: string;
  event_type: string;
  headline: string;
  summary: string;
  driver_name: string;
  impact_score: number;
  sentiment_score: number;
  supply_or_demand: string;
  quantitative_or_qualitative: string;
  probability: number;
  timeline_score: number;
  expected_date_range?: string;
  supporting_event_ids?: string[];
  invalidation_signal?: string;
  created_at?: string;
}