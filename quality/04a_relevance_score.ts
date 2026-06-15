// ═════════════════════════════════════════════════════════════════════════════
// L1 RELEVANCE SCORE - LLM Prompt Enhancement
// ═════════════════════════════════════════════════════════════════════════════
//
// Zweck: Relevanz-Score im LLM-Prompt erzwingen
// Deploy: In L1 Analyze Prompt integrieren (Tag 8-10)
//
// Der LLM muss bewerten: "Wie sehr passt dieses Event zu Asset X und Driver Y?"
// Score 0-10, bei <7 wird das Event verworfen
//
// Erstellt: 2026-05-09
// ═════════════════════════════════════════════════════════════════════════════

// ─── RELEVANCE THRESHOLD ──────────────────────────────────────────────────────

export const RELEVANCE_THRESHOLD = 7; // Events mit Score < 7 werden verworfen

// ─── PROMPT ADDITION FOR RELEVANCE ─────────────────────────────────────────────

export const RELEVANCE_PROMPT_ADDITION = `
IMPORTANT: Before classifying any event, you MUST evaluate its relevance to the asset and driver.

For each event, provide a relevance_score (0-10):
- 0-3: Not relevant (event has NO connection to the asset/driver)
- 4-6: Low relevance (event mentions related topics but not directly connected)
- 7-8: Moderately relevant (event is related but not central to the asset/driver)
- 9-10: Highly relevant (event directly impacts the asset/driver)

Scoring guidelines:
- Does the headline mention the asset name or ticker? +2
- Does the headline mention key terms for this driver? +2
- Is the event from a primary source for this asset/driver? +1
- Is the event about a different asset? -5
- Is the event generic news (e.g., "Trump signs bill") without clear connection? -3

Events with relevance_score < 7 should be returned with recommendation: "skip" and skip_reason explaining why.

Example:
- WTI + "Oil prices surge on Middle East tensions" → relevance_score: 9
- WTI + "Wall Street banks prepare to sell X loans" → relevance_score: 2, skip
- EUR/USD + "ECB signals rate hike" → relevance_score: 8
- EUR/USD + "Crocodile found in Australian river" → relevance_score: 0, skip
`;

// ─── OUTPUT SCHEMA ADDITION ─────────────────────────────────────────────────────

export const RELEVANCE_OUTPUT_SCHEMA = `
{
  "events": [
    {
      "i": "event_id",
      "imp": 7,
      "sent": -0.5,
      "tl": 3,
      "sd": "supply",
      "qq": "qualitative",
      "w": 0.25,
      "d": "Driver Name",
      "relevance_score": 8,
      "recommendation": "classify"
    },
    {
      "i": "event_id_2",
      "relevance_score": 3,
      "recommendation": "skip",
      "skip_reason": "Event about different asset (Technology stocks) with no connection to Oil prices"
    }
  ]
}
`;

// ─── SKIP REASON EXAMPLES ─────────────────────────────────────────────────────

export const SKIP_REASON_EXAMPLES = [
  "Event about different asset (X) with no connection to target asset",
  "Generic news headline without clear driver connection",
  "Off-topic event (sports, entertainment, local crime)",
  "Event about unrelated geographic region",
  "Event about different commodity class",
  "Corporate news without market impact",
  "Duplicate/similar to previous event"
];

// ═════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Check if an event should be skipped based on LLM output
 */
export function shouldSkipEvent(llmOutput: {
  relevance_score?: number;
  recommendation?: string;
}): { skip: boolean; reason?: string } {
  
  if (llmOutput.recommendation === 'skip') {
    return { skip: true, reason: 'llm_skip' };
  }
  
  if (llmOutput.relevance_score !== undefined && llmOutput.relevance_score < RELEVANCE_THRESHOLD) {
    return { skip: true, reason: 'low_relevance' };
  }
  
  return { skip: false };
}

/**
 * Extract skip reason from LLM output
 */
export function getSkipReason(llmOutput: {
  relevance_score?: number;
  skip_reason?: string;
}): string {
  if (llmOutput.skip_reason) {
    return llmOutput.skip_reason;
  }
  if (llmOutput.relevance_score !== undefined) {
    return `Low relevance score: ${llmOutput.relevance_score}`;
  }
  return 'Unknown skip reason';
}