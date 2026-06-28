/**
 * VECTX V3 — Driver Weighting Stufe A (Edge Function)
 *
 * Weekly driver weighting research via Gemini 2.5 Pro.
 * Writes to central.driver_weighting_history with source_method='edge'.
 * Runs in PARALLEL to VPS — VPS remains production source until cutover.
 *
 * Environment secrets (set via Supabase Dashboard → Edge Functions → Secrets):
 *   GEMINI_API_KEY  — Google AI API key
 *   ADMIN_TOKEN     — x-admin-token for run-sql Edge Function
 *   SUPABASE_URL    — Project URL (optional, defaults to project URL)
 *
 * Invoke via: POST /functions/v1/driver-weighting-stufe-a
 *   Body: { "tickers": ["GC", "WTI"] }  — optional, processes all assets if omitted
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const GEMINI_MODEL = 'gemini-2.5-pro'
const MIN_WEIGHT = 0.01
const MAX_WEIGHT = 0.35
const PROJECT_URL = 'https://umjerckgospmifikdrli.supabase.co'

// ─── Helpers ────────────────────────────────────────────────────────

async function runSql(sql: string, adminToken: string, supabaseUrl: string): Promise<any[]> {
  const res = await fetch(`${supabaseUrl}/functions/v1/run-sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken,
    },
    body: JSON.stringify({ sql }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`SQL error: ${JSON.stringify(data)}`)
  return data.data || []
}

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
    throw new Error(`Gemini API error ${res.status}: ${err.substring(0, 500)}`)
  }
  const json = await res.json()
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Empty Gemini response')
  return text
}

// ─── Main Logic ─────────────────────────────────────────────────────

async function processAsset(
  asset: { id: string; ticker: string; asset_name?: string },
  adminToken: string,
  supabaseUrl: string,
  apiKey: string
): Promise<{ success: boolean; error?: string; weightCount?: number }> {
  const assetId = asset.id
  const ticker = asset.ticker

  console.log(`Processing ${ticker}...`)

  // 1. Get active drivers
  const drivers = await runSql(`
    SELECT id, driver_name, act_weighting, description, supply_or_demand
    FROM central.drivers
    WHERE asset_id = '${assetId}' AND active = TRUE
    ORDER BY act_weighting DESC NULLS LAST
  `, adminToken, supabaseUrl)

  if (drivers.length === 0) {
    return { success: false, error: 'No active drivers' }
  }

  // 2. Get recent events (last 7 days)
  const events = await runSql(`
    SELECT de.headline, d.driver_name
    FROM central.drivers_events de
    JOIN central.drivers d ON de.driver_id = d.id
    WHERE d.asset_id = '${assetId}' AND d.active = TRUE
      AND de.created_at >= NOW() - INTERVAL '7 days'
    ORDER BY de.created_at DESC
    LIMIT 30
  `, adminToken, supabaseUrl)

  // 3. Build prompt
  const driverList = drivers.map((d: any) =>
    `- ${d.driver_name} (current: ${d.act_weighting ?? 'unassigned'}, ${d.supply_or_demand ?? 'unknown'}): ${d.description ?? 'No description'}`
  ).join('\n')

  const eventList = events.slice(0, 20).map((e: any) =>
    `[${e.driver_name}] ${e.headline}`
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

  // 6. Write to driver_weighting_history (shadow — NOT drivers.act_weighting)
  const runId = crypto.randomUUID()
  const values = Array.from(normalized.entries()).map(([name, weight]) => {
    const driver = driverMap.get(name)!
    const currentWeight = Number(driver.act_weighting ?? 0)
    const delta = Math.round((weight - currentWeight) * 10000) / 10000
    const conf = Number(weightings.find((w: any) => w.driver_name === name)?.confidence ?? 0.5)
    return `('${runId}', '${assetId}', '${driver.id}', '${name.replace(/'/g, "''")}', ${weight}, ${delta}, ${conf}, 0, 'edge', NOW())`
  }).join(',\n  ')

  await runSql(`
    INSERT INTO central.driver_weighting_history
      (run_id, asset_id, driver_id, driver_name, weighting, weighting_delta, confidence, evidence_count, source_method, created_at)
    VALUES
      ${values}
  `, adminToken, supabaseUrl)

  console.log(`${ticker}: ${normalized.size} weights written (run_id=${runId})`)
  return { success: true, weightCount: normalized.size }
}

// ─── HTTP Handler ────────────────────────────────────────────────────

serve(async (req: Request) => {
  const startTime = Date.now()

  const apiKey = Deno.env.get('GEMINI_API_KEY')
  const adminToken = Deno.env.get('ADMIN_TOKEN')
  const supabaseUrl = Deno.env.get('SUPABASE_URL') || PROJECT_URL

  if (!apiKey || !adminToken) {
    return new Response(JSON.stringify({ error: 'Missing GEMINI_API_KEY or ADMIN_TOKEN' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const body = await req.json().catch(() => ({}))
  const tickers = body.tickers || null

  // Get assets
  const assetFilter = tickers
    ? `WHERE ticker IN (${tickers.map((t: string) => `'${t}'`).join(',')})`
    : ''

  const assets = await runSql(
    `SELECT id, ticker, asset_name FROM central.assets ${assetFilter} ORDER BY ticker`,
    adminToken, supabaseUrl
  )

  // Process assets sequentially
  const results: any[] = []
  let successCount = 0
  let failCount = 0

  for (const asset of assets) {
    try {
      const result = await processAsset(asset, adminToken, supabaseUrl, apiKey)
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