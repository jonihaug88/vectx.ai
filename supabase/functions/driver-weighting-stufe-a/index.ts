/**
 * VECTX V3 — Driver Weighting Stufe A (Edge Function)
 *
 * Weekly driver weighting research via Gemini 2.5 Pro.
 * Writes to central.driver_weighting_history with source_method='edge'.
 * Runs in PARALLEL to VPS — VPS remains production source until cutover.
 *
 * ZERO manual env vars — reads all secrets from central.edge_secrets
 * via auto-injected SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 *
 * Invoke: POST /functions/v1/driver-weighting-stufe-a
 *   Body: { "tickers": ["GC", "WTI"] }  — optional, processes all if omitted
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GEMINI_MODEL = 'gemini-2.5-pro'
const MIN_WEIGHT = 0.01
const MAX_WEIGHT = 0.35

// ─── Supabase Client (auto-injected) ────────────────────────────────

function getSupabaseClient() {
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  return createClient(url, key, { auth: { persistSession: false } })
}

async function getSecret(name: string): Promise<string> {
  const sb = getSupabaseClient()
  // Must target central schema — secrets live in central.edge_secrets, not public
  const { data, error } = await sb
    .schema('central')
    .from('edge_secrets')
    .select('value')
    .eq('name', name)
    .single()
  if (error || !data) throw new Error(`Secret '${name}' not found: ${error?.message}`)
  return data.value
}

// ─── Gemini ──────────────────────────────────────────────────────────

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini ${res.status}: ${err.substring(0, 500)}`)
  }
  const json = await res.json()
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty Gemini response')
  return text
}

// ─── Main Logic ─────────────────────────────────────────────────────

async function processAsset(
  asset: { id: string; ticker: string; name?: string },
  apiKey: string
): Promise<{ success: boolean; error?: string; weightCount?: number }> {
  const sb = getSupabaseClient()
  const assetId = asset.id
  const ticker = asset.ticker

  // 1. Active drivers (central schema)
  const { data: drivers, error: dErr } = await sb
    .schema('central')
    .from('drivers')
    .select('id, driver_name, act_weighting, description, supply_or_demand')
    .eq('asset_id', assetId)
    .eq('active', true)
    .order('act_weighting', { ascending: false, nullsFirst: false })

  if (dErr || !drivers || drivers.length === 0) {
    return { success: false, error: dErr?.message || 'No active drivers' }
  }

  // 2. Recent events (last 7 days, central schema)
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const { data: events } = await sb
    .schema('central')
    .from('drivers_events')
    .select('headline, driver_id')
    .gte('created_at', weekAgo)
    .in('driver_id', drivers.map((d: any) => d.id))
    .order('created_at', { ascending: false })
    .limit(30)

  // Build driver→name map for event labeling
  const driverNameMap = new Map(drivers.map((d: any) => [d.id, d.driver_name]))
  const eventList = (events || []).slice(0, 20).map((e: any) => {
    const name = driverNameMap.get(e.driver_id) || 'unknown'
    return `[${name}] ${e.headline}`
  }).join('\n')

  // 3. Build prompt
  const driverList = drivers.map((d: any) =>
    `- ${d.driver_name} (current: ${d.act_weighting ?? 'unassigned'}, ${d.supply_or_demand ?? 'unknown'}): ${d.description ?? 'No description'}`
  ).join('\n')

  const prompt = `You are a macro analysis engine for ${ticker}.

ASSIGN WEIGHTS to the following drivers based on current market conditions and recent events.

CURRENT DRIVERS:
${driverList}

RECENT EVENTS (last 7 days):
${eventList || 'No recent events available.'}

RULES:
1. Weights must sum to EXACTLY 1.0
2. Minimum weight: ${MIN_WEIGHT} (never 0)
3. Maximum weight: ${MAX_WEIGHT}
4. Consider: Which drivers are most active/relevant RIGHT NOW?
5. Supply drivers should have higher weight during supply crises, demand drivers during demand shifts

OUTPUT FORMAT (JSON only):
{
  "weightings": [
    {"driver_name": "exact driver name", "weight": 0.XXXX, "confidence": 0.XX, "reasoning": "brief explanation"}
  ],
  "market_regime": "risk_on|risk_off|neutral",
  "top_driver": "name of most important driver"
}`

  // 4. Call Gemini
  let weightings: any[]
  try {
    const response = await callGemini(prompt, apiKey)
    const parsed = JSON.parse(response)
    weightings = parsed.weightings || parsed
  } catch (e: any) {
    return { success: false, error: `Gemini call failed: ${e.message}` }
  }

  if (!Array.isArray(weightings) || weightings.length === 0) {
    return { success: false, error: 'No weightings returned' }
  }

  // 5. Validate and normalize
  const driverMap = new Map(drivers.map((d: any) => [d.driver_name, d]))
  const assignedWeights: Map<string, number> = new Map()

  for (const w of weightings) {
    const name = w.driver_name
    if (!driverMap.has(name)) continue
    let weight = Number(w.weight)
    if (isNaN(weight) || weight < MIN_WEIGHT) weight = MIN_WEIGHT
    if (weight > MAX_WEIGHT) weight = MAX_WEIGHT
    assignedWeights.set(name, weight)
  }

  // Assign MIN_WEIGHT to drivers not mentioned
  for (const d of drivers) {
    if (!assignedWeights.has(d.driver_name)) {
      assignedWeights.set(d.driver_name, MIN_WEIGHT)
    }
  }

  // Normalize to sum = 1.0
  const total = Array.from(assignedWeights.values()).reduce((a, b) => a + b, 0)
  const normalized = new Map<string, number>()
  let remainder = 1.0
  const entries = Array.from(assignedWeights.entries())
  entries.forEach(([name, weight], i) => {
    if (i === entries.length - 1) {
      normalized.set(name, Math.round(remainder * 10000) / 10000)
    } else {
      const nw = Math.round((weight / total) * 10000) / 10000
      normalized.set(name, nw)
      remainder -= nw
    }
  })

  // 6. Write to driver_weighting_history (shadow — NOT drivers.act_weighting, central schema)
  const runId = crypto.randomUUID()
  const rows = Array.from(normalized.entries()).map(([name, weight]) => {
    const driver = driverMap.get(name)!
    const currentWeight = Number(driver.act_weighting ?? 0)
    const delta = Math.round((weight - currentWeight) * 10000) / 10000
    const conf = Number(weightings.find((w: any) => w.driver_name === name)?.confidence ?? 0.5)
    return {
      run_id: runId,
      asset_id: assetId,
      driver_id: driver.id,
      driver_name: name,
      weighting: weight,
      weighting_delta: delta,
      confidence: conf,
      evidence_count: 0,
      source_method: 'edge',
    }
  })

  const { error: insertErr } = await sb
    .schema('central')
    .from('driver_weighting_history')
    .insert(rows)

  if (insertErr) {
    return { success: false, error: `DB insert failed: ${insertErr.message}` }
  }

  console.log(`${ticker}: ${normalized.size} weights written (run_id=${runId})`)
  return { success: true, weightCount: normalized.size }
}

// ─── HTTP Handler ────────────────────────────────────────────────────

serve(async (req: Request) => {
  const startTime = Date.now()

  // Read GEMINI_API_KEY from edge_secrets
  let apiKey: string
  try {
    apiKey = await getSecret('GEMINI_API_KEY')
  } catch (e: any) {
    return new Response(JSON.stringify({ error: `Secret error: ${e.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const body = await req.json().catch(() => ({}))
  const tickers = body.tickers || null

  // Get assets (central schema)
  const sb = getSupabaseClient()
  let query = sb.schema('central').from('assets').select('id, ticker, name').order('ticker')
  if (tickers && Array.isArray(tickers) && tickers.length > 0) {
    query = query.in('ticker', tickers)
  }
  const { data: assets, error: aErr } = await query
  if (aErr || !assets) {
    return new Response(JSON.stringify({ error: `Asset query failed: ${aErr?.message}` }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Process sequentially (rate limiting)
  const results: any[] = []
  let successCount = 0
  let failCount = 0

  for (const asset of assets) {
    try {
      const result = await processAsset(asset, apiKey)
      results.push({ ticker: asset.ticker, ...result })
      if (result.success) successCount++
      else failCount++
    } catch (e: any) {
      results.push({ ticker: asset.ticker, success: false, error: e.message })
      failCount++
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1)

  return new Response(JSON.stringify({
    ok: true,
    source: 'edge_stufe_a',
    model: GEMINI_MODEL,
    assets_processed: assets.length,
    success: successCount,
    failed: failCount,
    duration_seconds: duration,
    results,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})