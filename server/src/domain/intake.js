/**
 * Natural-language procurement intake.
 *
 * One free-text box replaces a nine-field form. Two engines sit behind it:
 *
 *   graph8  — an LLM skill hosted IN the user's graph8 org
 *             (`Procurement Intake Parser`, Claude Sonnet 4.6). Verified
 *             working: it converts tonnes to kg, resolves "end of November"
 *             to a date, reads urgency, and refuses to invent a specification
 *             the buyer never stated. Requires GRAPH8_API_KEY.
 *
 *   local   — a deterministic parser used when no key is configured. No
 *             network, no credits, no surprises. Weaker on unusual phrasing,
 *             and it says so via a lower confidence score.
 *
 * Both return the SAME shape, and both must populate `assumptions` — the user
 * has to be able to see what was inferred rather than read.
 */

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);

/* ------------------------------------------------------------ graph8 path */

const SKILL_ID = process.env.GRAPH8_INTAKE_SKILL_ID || '2730f9a5-a7ee-4159-9396-986bd1be7cfa';

async function callGraph8({ request, materials, sites, apiKey, baseUrl }) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const root = baseUrl.replace(/\/$/, '');

  const start = await fetch(`${root}/skills/${SKILL_ID}/execute`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      input_data: {
        today: iso(new Date()),
        request,
        materials: materials.map((m) => `${m.id} | ${m.name} | ${m.category} | ${m.uom} | ${m.leadTimeDays}`).join('\n'),
        sites: sites.map((s) => `${s.id} | ${s.name} | ${s.country}`).join('\n'),
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!start.ok) throw new Error(`graph8 execute returned ${start.status}`);
  const started = await start.json();
  const execId = started.execution_id || started.data?.execution_id;
  if (!execId) throw new Error('graph8 execute returned no execution_id');

  // Execution is asynchronous — the POST returns `pending` and the result has
  // to be polled. Measured at ~9s for this prompt, so allow generous headroom.
  for (let attempt = 0; attempt < 25; attempt++) {
    await new Promise((r) => setTimeout(r, attempt < 3 ? 700 : 1200));
    const res = await fetch(`${root}/workflows/executions/${execId}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) continue;
    const body = await res.json();
    const row = body.data || body;
    if (row.status === 'completed') return { raw: row.output_data?.result, meta: row };
    if (row.status === 'failed') throw new Error(row.error_message || 'graph8 execution failed');
  }
  throw new Error('graph8 execution did not complete in time');
}

/** The model wraps JSON in a fence despite being told not to. Tolerate it. */
function extractJson(text) {
  if (!text) throw new Error('empty model output');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('no JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

/* ------------------------------------------------------------- local path */

const UNIT_TO_KG = { t: 1000, tonne: 1000, tonnes: 1000, ton: 1000, tons: 1000, mt: 1000, kg: 1, kgs: 1, kilo: 1, kilos: 1, kilogram: 1, kilograms: 1, g: 0.001 };
const COUNT_UNITS = ['pcs', 'pc', 'units', 'unit', 'pieces', 'piece', 'each', 'ea', 'cases', 'case'];
const VOLUME_UNITS = ['l', 'litre', 'litres', 'liter', 'liters'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WORD_NUM = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, a: 1, an: 1, couple: 2, few: 3,
};

/** Any word that is not a recognised unit is just the next word in the
    sentence ("200,000 flip-top closures"), not a unit we failed to convert. */
function knownUnit(u) {
  return Boolean(u) && (UNIT_TO_KG[u] !== undefined || COUNT_UNITS.includes(u) || VOLUME_UNITS.includes(u));
}

function parseQuantity(text, material, assumptions) {
  // "50 tonnes", "50,000 kg", "120k pcs", "2.5 t", "200,000 flip-top closures"
  const re = /(\d[\d,.]*)\s*(k\b|thousand|million|m\b)?\s*([a-zA-Z]+)?/g;
  let parts;
  while ((parts = re.exec(text)) !== null) {
    let n = Number(String(parts[1]).replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;

    const mult = (parts[2] || '').toLowerCase();
    if (mult === 'k' || mult === 'thousand') n *= 1000;
    if (mult === 'm' || mult === 'million') n *= 1_000_000;

    const unit = (parts[3] || '').toLowerCase();

    // A mass unit against a kg material: convert.
    if (knownUnit(unit) && UNIT_TO_KG[unit] !== undefined && material.uom === 'kg') {
      const factor = UNIT_TO_KG[unit];
      if (factor !== 1) {
        assumptions.push(`Converted ${n.toLocaleString()} ${unit} to ${(n * factor).toLocaleString()} kg to match the catalogue unit.`);
        return n * factor;
      }
      return n;
    }

    // A mass unit against a non-mass material is a mismatch worth flagging.
    if (UNIT_TO_KG[unit] !== undefined && material.uom !== 'kg') {
      assumptions.push(`Request said "${unit}" but ${material.name} is counted in ${material.uom}. Used the number as-is — confirm it.`);
      return n;
    }

    // Matching count/volume unit, or no recognisable unit at all.
    if (!knownUnit(unit)) return n;
    if (COUNT_UNITS.includes(unit) && material.uom === 'pcs') return n;
    if (VOLUME_UNITS.includes(unit) && material.uom === 'L') return n;
    return n;
  }
  return null;
}

function parseDate(text, today, assumptions) {
  const t = text.toLowerCase();

  // "in three weeks" / "in 3 weeks" / "within two months"
  const words = Object.keys(WORD_NUM).join('|');
  const inN = t.match(new RegExp(`(?:in|within|inside)\\s+(\\d+|${words})\\s+(day|week|month)s?`));
  if (inN) {
    const n = Number.isNaN(Number(inN[1])) ? WORD_NUM[inN[1]] : Number(inN[1]);
    const days = inN[2] === 'week' ? n * 7 : inN[2] === 'month' ? n * 30 : n;
    assumptions.push(`Interpreted "${inN[0]}" as ${days} days from today.`);
    return iso(addDays(today, days));
  }

  const explicit = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (explicit) return explicit[0];

  for (let i = 0; i < 12; i++) {
    if (!t.includes(MONTHS[i])) continue;
    const endOf = /end of|by the end of|late/.test(t);
    const startOf = /start of|beginning of|early/.test(t);
    const year = i < today.getUTCMonth() ? today.getUTCFullYear() + 1 : today.getUTCFullYear();
    const day = endOf ? new Date(Date.UTC(year, i + 1, 0)).getUTCDate() : startOf ? 5 : 15;
    assumptions.push(`Interpreted "${endOf ? 'end of ' : startOf ? 'start of ' : ''}${MONTHS[i]}" as ${year}-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}.`);
    return `${year}-${String(i + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  if (/next month/.test(t)) { assumptions.push('Interpreted "next month" as 30 days from today.'); return iso(addDays(today, 30)); }
  if (/asap|immediately|right away/.test(t)) { assumptions.push('Interpreted "asap" as 14 days from today, the shortest realistic window.'); return iso(addDays(today, 14)); }

  return null;
}

/** Token-overlap scoring: robust to "tomato paste" vs "Tomato Paste 28-30% Brix". */
function matchMaterial(text, materials) {
  const t = text.toLowerCase();
  let best = null;
  for (const m of materials) {
    const tokens = m.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    const hits = tokens.filter((w) => t.includes(w)).length;
    if (!hits) continue;
    const score = hits / tokens.length;
    if (!best || score > best.score) best = { material: m, score };
  }
  return best;
}

function matchSite(text, sites) {
  const t = text.toLowerCase();
  return sites.find((s) => t.includes(s.name.toLowerCase().replace(/\s+(plant|dc)$/, '')) || t.includes(s.name.toLowerCase())) || null;
}

function parseLocal({ request, materials, sites }) {
  const today = new Date(iso(new Date()) + 'T00:00:00Z');
  const assumptions = [];
  const clarifications = [];
  const t = request.toLowerCase();

  const matched = matchMaterial(request, materials);
  const material = matched?.material || null;
  if (!material) clarifications.push('Could not identify the material from the catalogue. Pick it manually.');
  else if (matched.score < 0.5) clarifications.push(`Matched "${material.name}" on a partial name overlap — confirm it is the right grade.`);

  const quantity = material ? parseQuantity(request, material, assumptions) : null;
  if (!quantity) clarifications.push('No quantity found in the request.');

  const site = matchSite(request, sites);
  if (!site) assumptions.push(`No site named, so the requirement defaults to ${sites[0].name}.`);

  let requiredBy = parseDate(request, today, assumptions);
  if (!requiredBy) {
    const lead = material?.leadTimeDays || 21;
    requiredBy = iso(addDays(today, lead + 14));
    assumptions.push(`No date given, so required-by defaults to ${lead + 14} days out (lead time plus a two-week buffer).`);
  }

  const priority = /critical|line down|line will stop|line stops|will stop|shut ?down|stoppage|halt|emergency/.test(t) ? 'critical'
    : /urgent|asap|immediately|right away|running low|running out|short of|stockout/.test(t) ? 'urgent'
      : 'routine';
  if (priority !== 'routine') assumptions.push(`Priority set to ${priority} from wording in the request.`);

  const reasonMatch = request.match(/\b(?:for|because|due to|to cover|to support)\s+([^.,;]{6,90})/i);
  const reason = reasonMatch ? reasonMatch[1].trim() : '';
  if (!reason) clarifications.push('No business reason found — procurement will ask for one.');

  // Deliberately never invents a specification.
  const specMatch = request.match(/\b(\d{1,3}\s*[-–]\s*\d{1,3}\s*%?\s*brix|food[- ]grade|haccp|iso\s*\d+|organic|kosher|halal)\b/gi);
  const specification = specMatch ? [...new Set(specMatch.map((s) => s.trim()))].join(', ') : '';

  let confidence = 40;
  if (material) confidence += matched.score >= 0.5 ? 20 : 10;
  if (quantity) confidence += 15;
  if (parseDate(request, today, [])) confidence += 12;
  if (site) confidence += 8;
  if (reason) confidence += 5;

  return {
    engine: 'local',
    materialId: material?.id || null,
    quantity,
    siteId: site?.id || sites[0].id,
    requiredBy,
    priority,
    title: material ? `${material.name} — ${quantity ? quantity.toLocaleString() + ' ' + material.uom : 'quantity TBC'}`.slice(0, 70) : request.slice(0, 70),
    specification,
    reason,
    confidence: Math.min(confidence, 88),
    assumptions,
    clarifications,
  };
}

/* ------------------------------------------------------------------ entry */

export async function parseRequest({ request, materials, sites, env = process.env }) {
  const apiKey = env.GRAPH8_API_KEY;
  const baseUrl = env.GRAPH8_API_BASE || 'https://be.graph8.com/api/v1';
  const started = Date.now();

  if (apiKey) {
    try {
      const { raw, meta } = await callGraph8({ request, materials, sites, apiKey, baseUrl });
      const parsed = extractJson(raw);
      return {
        ...parsed,
        engine: 'graph8',
        engineDetail: `graph8 LLM skill "Procurement Intake Parser" · ${meta.output_data?.model || 'model'} · ${meta.duration_ms}ms · $${(meta.cost_usd ?? 0).toFixed(4)}`,
        skillId: SKILL_ID,
        executionId: meta.execution_id,
        tokens: { input: meta.tokens_input, output: meta.tokens_output },
        costUsd: meta.cost_usd,
        durationMs: meta.duration_ms,
      };
    } catch (err) {
      // Never fail the intake because the model was slow or unreachable.
      const local = parseLocal({ request, materials, sites });
      return {
        ...local,
        engineDetail: 'Local parser — the graph8 skill could not be reached.',
        fallbackReason: String(err.message || err),
        durationMs: Date.now() - started,
      };
    }
  }

  const local = parseLocal({ request, materials, sites });
  return {
    ...local,
    engineDetail: 'Local parser. Set GRAPH8_API_KEY to route intake through the graph8 LLM skill instead.',
    durationMs: Date.now() - started,
  };
}

export { parseLocal, extractJson };
