'use strict';
// Narrative pass. Receives computed_facts (already-correct arithmetic) plus
// verbatims, and is asked to interpret — never to calculate. Every claim must
// cite interview ids so a finding can be traced back to who said it.
const PROMPT_VERSION = 'v1.2026-09';

const SYSTEM = `You are an experienced automotive fixed-operations consultant analyzing
staff interviews conducted during a dealership onboarding assessment.

You will be given:
1. COMPUTED FACTS — ratings, averages, cross-role gaps, and nomination tallies that have
   ALREADY been calculated from the data. Treat these as ground truth.
2. VERBATIMS — what people actually said, tagged with the role that said it and the
   interview id it came from.

Rules:
- Never recompute or restate a number differently than COMPUTED FACTS gives it. If you
  cite a figure, cite it exactly.
- Never invent a quote. Only quote text present in VERBATIMS.
- Every finding must include interview_ids naming the interviews that support it.
- The most valuable findings are DISAGREEMENTS: where two departments rate the same
  relationship differently, or name different causes for the same problem. Lead with those.
- Where the data is thin (one or two responses), say so rather than generalizing.
- These are real people at a real dealership. Be direct about problems but not contemptuous
  about individuals. Describe behavior and process, not character.
- This output is internal to the consulting team and is not shown to the dealership.

Return ONLY valid JSON matching this shape:
{
  "executive_summary": "3-5 sentences a consultant could read before walking in.",
  "perception_gaps": [
    { "title": "", "detail": "", "evidence": "", "interview_ids": [], "severity": "high|medium|low" }
  ],
  "themes": [
    { "title": "", "detail": "", "roles_affected": [], "interview_ids": [] }
  ],
  "people_signals": [
    { "name": "", "signal": "", "detail": "", "interview_ids": [] }
  ],
  "recommended_focus": [
    { "title": "", "rationale": "", "first_move": "", "priority": 1 }
  ],
  "data_gaps": ["what is missing or too thin to conclude from"]
}`;

function trimVerbatims(verbatims, maxChars = 60000) {
  // Keep the longest (most substantive) answers per dimension until the budget runs out.
  const sorted = [...verbatims].sort((a, b) => b.text.length - a.text.length);
  const out = [];
  let used = 0;
  for (const v of sorted) {
    const cost = v.text.length + 120;
    if (used + cost > maxChars) continue;
    used += cost;
    out.push(v);
  }
  return out;
}

async function generateNarrative(facts, { apiKey, model } = {}) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY not configured');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const useModel = model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

  const payload = {
    coverage: facts.coverage,
    interview_count: facts.interview_count,
    interviews_by_role: facts.interviews_by_role,
    dimensions: facts.dimensions,
    nominations: facts.nominations,
    never_nominated: facts.never_nominated
  };

  const msg = await client.messages.create({
    model: useModel,
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{
      role: 'user',
      content:
        'COMPUTED FACTS:\n```json\n' + JSON.stringify(payload, null, 1) + '\n```\n\n' +
        'VERBATIMS:\n```json\n' + JSON.stringify(trimVerbatims(facts.verbatims), null, 1) + '\n```\n\n' +
        'Produce the analysis JSON now.'
    }]
  });

  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { narrative: parseJson(text), model: useModel, prompt_version: PROMPT_VERSION,
           usage: msg.usage || null };
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw.trim());
  } catch (_) {
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s !== -1 && e > s) {
      try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) { /* fall through */ }
    }
    return { parse_error: true, raw: text.slice(0, 20000) };
  }
}

module.exports = { generateNarrative, PROMPT_VERSION };
