/**
 * Client for LLM skills hosted in the user's graph8 organisation.
 *
 * graph8's skill runtime is what makes this app agentic rather than a set of
 * scoring formulas. Skills live in the org, are editable in the graph8 UI, and
 * run on graph8's own models — several of which have web search, so a skill can
 * establish what a company actually does rather than trusting a CRM record.
 *
 * Execution is asynchronous: POST returns `pending`, the result is polled.
 */

const DEFAULT_BASE = 'https://be.graph8.com/api/v1';

export const SKILLS = {
  intake: {
    id: process.env.GRAPH8_INTAKE_SKILL_ID || '2730f9a5-a7ee-4159-9396-986bd1be7cfa',
    name: 'Procurement Intake Parser',
    purpose: 'Turns a free-text request into a structured requirement.',
    model: 'claude-sonnet-4-6',
  },
  supplierFit: {
    id: process.env.GRAPH8_SUPPLIER_SKILL_ID || 'e404c4cb-50ef-416d-a083-f3757aedf063',
    name: 'Supplier Fit Analyst',
    purpose: 'Researches a candidate supplier and judges whether it is a credible source.',
    model: 'claude-sonnet-4-6',
  },
  copilot: {
    id: process.env.GRAPH8_COPILOT_SKILL_ID || '81f7eeee-2c53-4383-99f1-86c72f88c625',
    name: 'Procurement Copilot',
    purpose: 'Conversational agent that drives the workspace through tools.',
    model: 'claude-sonnet-4-6',
  },
  buyerOutreach: {
    id: process.env.GRAPH8_BUYER_SKILL_ID || '09d7bea3-db85-4db5-908a-02615dcebc0a',
    name: 'Buyer Outreach Agent',
    purpose: 'Qualifies a prospective buyer for a product and writes their opening email.',
    model: 'claude-sonnet-4-6',
  },
};

/**
 * Skills graph8 ships with every org. We did not write these — they belong to
 * graph8 and are the same ones you see in the product. They take free-form
 * `input_data` and several of them run multiple web searches.
 */
export const SYSTEM_SKILLS = {
  productMapping: {
    id: '189ae8ce-eaf8-4f4e-a1b3-07dd90db3e6d',
    name: 'Product/Service Mapping',
    purpose: 'Establishes what a company actually sells, and to whom.',
    owner: 'graph8 system skill',
  },
  deepResearch: {
    id: '45401c32-a85a-4d5b-993f-7c05906f663c',
    name: 'Deep Company Research',
    purpose: 'Background, financials and strategy on a company.',
    owner: 'graph8 system skill',
  },
  riskAnalysis: {
    id: '40ad69c8-b89c-449b-a512-75575e9268ca',
    name: 'Risk Analysis',
    purpose: 'Risks in a deal or partnership.',
    owner: 'graph8 system skill',
  },
  buyingSignals: {
    id: '1da87550-6d42-4f3d-a4e6-a2a29f5d4568',
    name: 'Buying Signals Scan',
    purpose: 'Buying intent from a digital footprint.',
    owner: 'graph8 system skill',
  },
  contactDossier: {
    id: 'ff43d93b-209c-4f5c-badb-85575bb8e724',
    name: 'Contact Dossier',
    purpose: 'Research on an individual contact.',
    owner: 'graph8 system skill',
  },
};

/** Free-text (markdown) result rather than JSON — system skills return prose. */
export async function runSystemSkill({ key, input, env = process.env, timeoutMs = 90_000 }) {
  const skill = SYSTEM_SKILLS[key];
  if (!skill) throw new Error(`unknown system skill "${key}"`);
  const apiKey = env.GRAPH8_API_KEY;
  if (!apiKey) throw new Error('GRAPH8_API_KEY is not set');
  const root = (env.GRAPH8_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const start = await fetch(`${root}/skills/${skill.id}/execute`, {
    method: 'POST', headers, body: JSON.stringify({ input_data: input }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!start.ok) throw new Error(`graph8 execute returned ${start.status}`);
  const execId = (await start.json()).execution_id;
  if (!execId) throw new Error('no execution_id returned');

  const deadline = Date.now() + timeoutMs;
  let wait = 1200;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 1.2, 3500);
    const res = await fetch(`${root}/workflows/executions/${execId}`, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) continue;
    const body = await res.json();
    const exec = body?.data ?? body;
    if (exec?.status === 'completed') {
      return {
        skill,
        markdown: exec.output_data?.result || '',
        meta: {
          executionId: execId,
          model: exec.output_data?.model,
          webSearches: exec.output_data?.web_search_count ?? 0,
          durationMs: exec.duration_ms,
          costUsd: exec.cost_usd,
        },
      };
    }
    if (exec?.status === 'failed') throw new Error(exec.error_message || 'execution failed');
  }
  throw new Error(`graph8 system skill did not complete within ${Math.round(timeoutMs / 1000)}s`);
}

export function isConfigured(env = process.env) {
  return Boolean(env.GRAPH8_API_KEY);
}

export function engineStatus(env = process.env) {
  const on = isConfigured(env);
  return {
    engine: on ? 'graph8' : 'local',
    baseUrl: env.GRAPH8_API_BASE || DEFAULT_BASE,
    skills: Object.entries(SKILLS).map(([key, s]) => ({ key, ...s, active: on })),
    note: on
      ? 'Reasoning steps run as LLM skills inside your graph8 organisation.'
      : 'No GRAPH8_API_KEY set, so the built-in deterministic engine is used. Add a key to hand these steps to graph8.',
  };
}

/** The models fence their JSON despite instructions. Tolerate it, and tolerate
    a response that got cut off mid-object. */
export function extractJson(text) {
  if (!text) throw new Error('empty model output');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model output');
  candidate = candidate.slice(start);

  try {
    const end = candidate.lastIndexOf('}');
    if (end !== -1) return JSON.parse(candidate.slice(0, end + 1));
  } catch { /* fall through to repair */ }

  // Truncated output: close any open string, then balance the braces/brackets.
  let repaired = candidate;
  const quotes = (repaired.match(/(?<!\\)"/g) || []).length;
  if (quotes % 2 === 1) repaired += '"';
  const opens = (repaired.match(/[[{]/g) || []).length;
  const closes = (repaired.match(/[\]}]/g) || []).length;
  const stack = [];
  for (const ch of repaired) {
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  while (stack.length) repaired += stack.pop() === '{' ? '}' : ']';
  if (opens === closes && !repaired.trim().endsWith('}')) repaired += '}';

  try {
    return { ...JSON.parse(repaired), _truncated: true };
  } catch (err) {
    throw new Error(`could not parse model output (${err.message})`);
  }
}

/**
 * Run a skill and wait for its result.
 *
 * `timeoutMs` covers the whole poll loop. Supplier research with web search has
 * measured at ~25s, so the default is generous.
 */
export async function runSkill({ skillId, input, env = process.env, timeoutMs = 60_000 }) {
  const apiKey = env.GRAPH8_API_KEY;
  if (!apiKey) throw new Error('GRAPH8_API_KEY is not set');
  const root = (env.GRAPH8_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const start = await fetch(`${root}/skills/${skillId}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input_data: input }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!start.ok) throw new Error(`graph8 execute returned ${start.status}`);
  const started = await start.json();
  const execId = started.execution_id || started.data?.execution_id;
  if (!execId) throw new Error('graph8 execute returned no execution_id');

  const deadline = Date.now() + timeoutMs;
  let wait = 900;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 1.25, 3000);
    const res = await fetch(`${root}/workflows/executions/${execId}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) continue;
    const body = await res.json();
    const exec = body?.data ?? body;
    if (!exec?.status) continue;
    if (exec.status === 'completed') {
      return {
        parsed: extractJson(exec.output_data?.result),
        meta: {
          executionId: execId,
          model: exec.output_data?.model,
          durationMs: exec.duration_ms,
          costUsd: exec.cost_usd,
          tokensIn: exec.tokens_input,
          tokensOut: exec.tokens_output,
          webSearches: exec.output_data?.web_search_count ?? 0,
        },
      };
    }
    if (exec.status === 'failed') throw new Error(exec.error_message || 'graph8 execution failed');
  }
  throw new Error(`graph8 execution did not complete within ${Math.round(timeoutMs / 1000)}s`);
}
