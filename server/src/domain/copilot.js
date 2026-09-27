/**
 * Conversational agent loop.
 *
 * The model is a graph8 LLM skill ("Procurement Copilot"). graph8 skills are
 * single-shot completions, not a tool-calling API, so the loop lives here: we
 * hand the skill the conversation, the tool catalogue and a workspace
 * snapshot, it returns either a tool call or a final reply, and we run the
 * tool and call it again. A ReAct loop over a completion endpoint.
 *
 * Every tool is the same code path the UI uses. The agent has no private
 * back door, and `sql` is read-only.
 */

import { store } from '../store.js';
import * as db from '../db.js';
import { runSkill, SKILLS, runSystemSkill, SYSTEM_SKILLS, isConfigured } from './graph8Skill.js';
import { projectAll, forwardBuy } from './planning.js';
import { compareQuotes, buildRecommendation, daysUntil } from './sourcing.js';
import { runSupplierDiscovery, runRFQPreparation, runQuoteAnalysis, runSupplierAnalysis } from './agents.js';
import { discoverBuyers, qualifyOrDraft, availableChannels } from './sales.js';
import { sendRFQ } from './mail.js';

const S = () => store.state;
const MAX_STEPS = Number(process.env.COPILOT_MAX_STEPS || 6);

/* ------------------------------------------------------------------ tools */

export const TOOLS = {
  sql: {
    description: 'Run a read-only SQL query over the workspace Postgres. Use for any question about existing records: counts, totals, comparisons, lookups. SELECT or WITH only.',
    args: { query: 'string — a single SELECT or WITH statement' },
    run: async ({ query }) => {
      const r = await db.agentQuery(query, { limit: 100 });
      return { rowCount: r.rowCount, fields: r.fields, rows: r.rows };
    },
  },

  list_materials: {
    description: 'The material catalogue: ids, names, units, lead times, safety stock.',
    args: {},
    run: async () => ({ materials: S().planning.materials.map((m) => ({ id: m.id, name: m.name, category: m.category, uom: m.uom, leadTimeDays: m.leadTimeDays, safetyStock: m.safetyStock })) }),
  },

  list_sites: {
    description: 'Plants and sites that can raise a requirement.',
    args: {},
    run: async () => ({ sites: store.workspace.sites }),
  },

  inventory_projection: {
    description: 'Current stock projection across the bill of materials: days of cover, shortage day, suggested reorder quantity per material.',
    args: {},
    run: async () => {
      const p = projectAll(S().planning, store.workspace.products[0]);
      return {
        inputs: p.inputs,
        totals: p.totals,
        rows: p.rows.map((r) => ({
          material: r.materialName, status: r.status, daysOfCover: r.daysOfCover,
          shortageDay: r.shortageDay, orderByDay: r.orderByDay,
          suggestedOrderQty: r.suggestedOrderQty, uom: r.uom,
        })),
      };
    },
  },

  raise_requirement: {
    description: 'Create a real requirement record. Triggers supplier discovery automatically. Confirm with the user before calling.',
    args: {
      materialId: 'string — from list_materials',
      quantity: 'number',
      siteId: 'string — from list_sites',
      requiredBy: 'string — YYYY-MM-DD',
      priority: 'routine | urgent | critical',
      specification: 'string — QUOTE the user\'s own words about grade or quality. If they said nothing about specification, pass an empty string. Restating the material name here is not a specification.',
      reason: 'string — the business need',
      title: 'string — short title',
    },
    run: async (a) => {
      const material = store.material(a.materialId);
      const site = store.site(a.siteId) || store.workspace.sites[0];
      if (!material) throw new Error(`Unknown materialId "${a.materialId}". Call list_materials first.`);
      if (!a.quantity || Number(a.quantity) <= 0) throw new Error('quantity must be greater than zero.');
      if (!a.requiredBy) throw new Error('requiredBy is required (YYYY-MM-DD).');
      // The model sometimes echoes conversational words here ("Approved").
      const PRIORITIES = ['routine', 'urgent', 'critical'];
      const priority = PRIORITIES.includes(String(a.priority || '').toLowerCase())
        ? String(a.priority).toLowerCase()
        : 'routine';

      const r = {
        id: store.nextId('req', 'REQ'),
        title: a.title || `${material.name} requirement`,
        materialId: material.id, materialName: material.name, category: material.category, uom: material.uom,
        siteId: site.id, siteName: site.name, siteCountry: site.country,
        quantity: Number(a.quantity), requiredBy: a.requiredBy,
        priority,
        specification: a.specification || '', notes: '', targetPrice: null,
        reason: a.reason || 'Raised through the copilot.',
        raisedBy: 'copilot', status: 'submitted', assignedTo: null,
        createdAt: new Date().toISOString(),
        history: [{ at: new Date().toISOString(), actor: 'copilot', action: 'Raised through the conversational agent' }],
      };
      // The agent sometimes fills a specification the buyer never gave. Keep it
      // — it may be useful — but say on the record that the agent wrote it, so
      // nobody later reads it as the requester's own requirement.
      if (r.specification) {
        r.specificationSource = 'copilot';
        r.history.push({
          at: new Date().toISOString(),
          actor: 'copilot',
          action: `Specification "${r.specification}" was written by the agent, not stated by the requester — confirm before it goes into an RFQ`,
        });
      }

      S().requirements.push(r);
      store.logActivity({ type: 'requirement', message: `${r.id} raised by the copilot: ${r.quantity.toLocaleString()} ${r.uom} of ${r.materialName}`, actor: 'copilot', refId: r.id });

      const task = runSupplierDiscovery(r, { trigger: `Copilot raised ${r.id}` });
      r.status = task.status === 'needs_attention' ? 'needs_info' : 'awaiting_review';
      store.persist();
      return { requirementId: r.id, status: r.status, candidatesFound: task.result?.results?.length ?? 0 };
    },
  },

  get_requirement: {
    description: 'Full detail on one requirement: shortlist, RFQs, quotes, comparison and recommendation.',
    args: { requirementId: 'string' },
    run: async ({ requirementId }) => {
      const r = store.requirement(requirementId);
      if (!r) throw new Error(`No requirement ${requirementId}.`);
      const quotes = store.quotesFor(r.id);
      const suppliers = store.allSuppliers();
      const comparison = quotes.length ? compareQuotes({ requirement: r, quotes, suppliers }) : null;
      const recommendation = comparison ? buildRecommendation({ requirement: r, comparison, suppliers }) : null;
      return {
        requirement: { id: r.id, title: r.title, material: r.materialName, quantity: r.quantity, uom: r.uom, site: r.siteName, requiredBy: r.requiredBy, daysToRequired: daysUntil(r.requiredBy), status: r.status, specification: r.specification },
        shortlist: store.shortlistFor(r.id).map((s) => ({ supplierId: s.supplierId, company: store.supplier(s.supplierId)?.company, source: s.source })),
        rfqs: store.rfqsFor(r.id).map((x) => ({ id: x.id, supplier: x.supplierName, sendStatus: x.sendStatus, replied: Boolean(x.repliedAt) })),
        comparison: comparison?.rows.map((x) => ({ supplier: x.supplierName, unitPrice: x.unitPrice, total: x.total, leadTimeDays: x.leadTimeDays, leadTimeOk: x.leadTimeOk, shortfall: x.qtyShortfall, missing: x.missing })) ?? [],
        recommendation: recommendation ? { status: recommendation.status, headline: recommendation.headline, risks: recommendation.risks } : null,
      };
    },
  },

  discover_suppliers: {
    description: 'Re-run supplier discovery for a requirement and return the ranked candidates.',
    args: { requirementId: 'string' },
    run: async ({ requirementId }) => {
      const r = store.requirement(requirementId);
      if (!r) throw new Error(`No requirement ${requirementId}.`);
      const task = runSupplierDiscovery(r, { trigger: 'Copilot requested discovery' });
      return {
        taskId: task.id,
        counts: task.result?.counts,
        candidates: (task.result?.results || []).slice(0, 8).map((x) => ({ supplierId: x.supplier.id, company: x.supplier.company, source: x.supplier.source, matchScore: x.match.score })),
      };
    },
  },

  research_supplier: {
    description: "Run graph8's own research skills on a supplier or buyer to establish what the company actually does. Slow (15-45s) and costs credits, so use it when capability is genuinely in question.",
    args: { entity: 'supplier | buyer', id: 'string', skill: 'productMapping | deepResearch | riskAnalysis | buyingSignals' },
    run: async ({ entity, id, skill = 'productMapping' }) => {
      if (!isConfigured()) throw new Error('No GRAPH8_API_KEY, so graph8 research is unavailable.');
      if (!SYSTEM_SKILLS[skill]) throw new Error(`Unknown skill "${skill}".`);
      const subject = entity === 'buyer' ? store.buyer(id) : store.supplier(id);
      if (!subject) throw new Error(`Unknown ${entity} "${id}".`);
      const cacheKey = `${entity}:${id}:${skill}`;
      if (S().deepDives[cacheKey]) {
        const c = S().deepDives[cacheKey];
        return { cached: true, company: c.company, skill: c.skillName, summary: c.markdown.slice(0, 1400) };
      }
      const { skill: meta, markdown, meta: run } = await runSystemSkill({
        key: skill,
        input: { company_name: subject.company, company_domain: subject.domain || '', context: `Assessing whether this company is a credible ${entity} for us.` },
      });
      const report = { id: store.nextId('dive', 'DIVE'), entity, entityId: id, company: subject.company, skillKey: skill, skillName: meta.name, owner: meta.owner, markdown, meta: run, at: new Date().toISOString() };
      S().deepDives[cacheKey] = report;
      store.persist();
      return { cached: false, company: subject.company, skill: meta.name, webSearches: run.webSearches, costUsd: run.costUsd, summary: markdown.slice(0, 1400) };
    },
  },

  shortlist_suppliers: {
    description: 'Add suppliers to a requirement shortlist.',
    args: { requirementId: 'string', supplierIds: 'array of supplier ids' },
    run: async ({ requirementId, supplierIds }) => {
      const r = store.requirement(requirementId);
      if (!r) throw new Error(`No requirement ${requirementId}.`);
      const list = S().shortlists[r.id] || (S().shortlists[r.id] = []);
      const added = [];
      (supplierIds || []).forEach((sid) => {
        const s = store.supplier(sid);
        if (!s) return;
        if (list.find((x) => x.supplierId === sid)) return;
        list.push({ supplierId: sid, source: s.source, reason: 'Added by the copilot', addedAt: new Date().toISOString() });
        added.push(s.company);
      });
      store.persist();
      return { shortlisted: added, total: list.length };
    },
  },

  draft_rfqs: {
    description: 'Draft an RFQ for every shortlisted supplier on a requirement. Drafts only, nothing is sent.',
    args: { requirementId: 'string' },
    run: async ({ requirementId }) => {
      const r = store.requirement(requirementId);
      if (!r) throw new Error(`No requirement ${requirementId}.`);
      const ids = store.shortlistFor(r.id).map((s) => s.supplierId);
      if (!ids.length) throw new Error('Nothing is shortlisted on that requirement yet.');
      S().rfqs = S().rfqs.filter((x) => !(x.requirementId === r.id && !x.approved));
      runRFQPreparation(r, ids, { trigger: 'Copilot requested RFQ drafts' });
      r.status = 'rfq_prepared';
      store.persist();
      return { rfqs: store.rfqsFor(r.id).map((x) => ({ id: x.id, supplier: x.supplierName, canEmail: x.canEmail })) };
    },
  },

  send_rfq: {
    description: 'Approve and actually send one RFQ over SMTP. Ask the user to confirm before calling this.',
    args: { rfqId: 'string' },
    run: async ({ rfqId }) => {
      const rfq = store.rfq(rfqId);
      if (!rfq) throw new Error(`No RFQ ${rfqId}.`);
      const supplier = store.supplier(rfq.supplierId);
      rfq.approved = true;
      rfq.approvedAt = new Date().toISOString();
      const result = await sendRFQ({ rfq, supplier });
      Object.assign(rfq, result);
      store.logActivity({ type: 'rfq', message: `Copilot sent RFQ to ${rfq.supplierName} — ${result.sendStatus}`, actor: 'copilot', refId: rfq.requirementId, provenance: 'live' });
      store.persist();
      return { sendStatus: result.sendStatus, to: result.to, detail: result.sendDetail };
    },
  },

  compare_quotes: {
    description: 'Compare every recorded quotation on a requirement and return the analysis and recommendation.',
    args: { requirementId: 'string' },
    run: async ({ requirementId }) => {
      const r = store.requirement(requirementId);
      if (!r) throw new Error(`No requirement ${requirementId}.`);
      const task = runQuoteAnalysis(r, { trigger: 'Copilot requested comparison' });
      const { comparison, recommendation } = task.result || {};
      if (!comparison) throw new Error('No quotations recorded on that requirement yet.');
      return {
        rows: comparison.rows.map((x) => ({ supplier: x.supplierName, unitPrice: x.unitPrice, total: x.total, currency: x.currency, leadTimeDays: x.leadTimeDays, leadTimeOk: x.leadTimeOk, shortfall: x.qtyShortfall, missingFields: x.missing })),
        recommendation: { status: recommendation.status, headline: recommendation.headline, risks: recommendation.risks, requiredBeforeDecision: recommendation.requiredBeforeDecision },
      };
    },
  },

  forward_buy: {
    description: 'Compare buying now, buying later, or splitting the order for one material under a price scenario.',
    args: { materialId: 'string', scenarioId: 'ps_flat | ps_up8 | ps_up15 | ps_down5', months: 'number, 1-3' },
    run: async ({ materialId, scenarioId = 'ps_up8', months = 1 }) => {
      const material = store.material(materialId);
      if (!material) throw new Error(`Unknown materialId "${materialId}".`);
      const projection = projectAll(S().planning, store.workspace.products[0]);
      const row = projection.rows.find((x) => x.materialId === materialId);
      if (!row) throw new Error('That material is not on the current bill of materials.');
      const scenario = store.workspace.priceScenarios.find((s) => s.id === scenarioId) || store.workspace.priceScenarios[0];
      const quotes = S().quotes.filter((q) => { const r = store.requirement(q.requirementId); return r && r.materialId === materialId && q.unitPrice !== null; });
      const best = quotes.length ? quotes.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a)) : null;
      const analysis = forwardBuy({
        qty: row.suggestedOrderQty || Math.ceil(row.dailyConsumption * material.leadTimeDays),
        unitPrice: best ? best.unitPrice : material.unitCostAssumption,
        priceSource: best ? 'quote' : 'assumption',
        changePct: scenario.changePct,
        holdingCostPctPerMonth: S().planning.holdingCostPctPerMonth,
        monthsDeferred: months,
        shortageDay: row.shortageDay,
        leadTimeDays: material.leadTimeDays,
      });
      return { material: material.name, scenario: scenario.label, priceSource: analysis.priceSource, unitPrice: analysis.unitPrice, options: analysis.options, recommended: analysis.recommendedKey, rationale: analysis.rationale, caveat: analysis.caveat };
    },
  },

  list_products: {
    description: 'The products we manufacture and can sell, with their target channels. Call this before find_buyers if you are unsure of a product id.',
    args: {},
    run: async () => ({
      products: store.market.products.map((p) => ({ productId: p.id, name: p.name, pack: p.pack, category: p.productCategory, targetChannels: p.targetChannels })),
      availableChannels: availableChannels(store.market.buyers),
      buyerCount: store.market.buyers.length,
    }),
  },

  find_buyers: {
    description: 'Find prospective buyers for a product we manufacture, from the graph8 contact index. Omit channel to see every buyer ranked by fit.',
    args: { productId: 'string — a productId from list_products', channel: 'optional; one of the availableChannels. Omit it unless the user named a channel.' },
    run: async ({ productId, channel }) => {
      const product = store.product(productId);
      if (!product) {
        // Silently substituting products[0] used to make the agent answer a
        // question about one product with another product's buyers.
        return {
          error: `No product with id "${productId}".`,
          availableProducts: store.market.products.map((p) => ({ productId: p.id, name: p.name })),
        };
      }
      const d = discoverBuyers({ product, buyers: store.market.buyers, channel });
      return {
        product: product.name,
        channelRequested: channel || null,
        channelMatched: d.criteria.channelMatched,
        note: d.note,
        availableChannels: d.availableChannels,
        total: d.total,
        buyers: d.results.slice(0, 12).map((r) => ({
          buyerId: r.buyer.id,
          company: r.buyer.company,
          industry: r.buyer.industry,
          channelTags: r.buyer.channelTags,
          matchScore: r.match.score,
          contact: `${r.buyer.contact?.firstName || ''} ${r.buyer.contact?.lastName || ''}`.trim() || null,
          title: r.buyer.contact?.jobTitle || null,
        })),
      };
    },
  },

  qualify_buyers: {
    description: 'Have graph8 qualify buyers for a product and draft their outreach emails. Slow (15-25s each).',
    args: { productId: 'string', buyerIds: 'array of buyer ids' },
    run: async ({ productId, buyerIds }) => {
      const product = store.product(productId) || store.market.products[0];
      const out = [];
      for (const id of (buyerIds || []).slice(0, 3)) {
        const buyer = store.buyer(id);
        if (!buyer) continue;
        const d = await qualifyOrDraft({ buyer, product });
        const row = S().campaigns.find((c) => c.buyerId === id && c.productId === product.id) || { id: store.nextId('camp', 'CAMP'), buyerId: id, productId: product.id, createdAt: new Date().toISOString() };
        Object.assign(row, { buyerCompany: buyer.company, productName: product.name, verdict: d.verdict, score: d.score, channelFit: d.channelFit, reasons: d.reasons, risks: d.risks, hook: d.hook, subject: d.subject, body: d.body, followUp: d.followUp, engine: d.meta?.engine === 'local' ? 'local' : 'graph8', meta: d.meta, status: row.status || 'draft' });
        if (!S().campaigns.includes(row)) S().campaigns.push(row);
        out.push({ campaignId: row.id, company: buyer.company, verdict: d.verdict, score: d.score, subject: d.subject });
      }
      store.persist();
      return { qualified: out };
    },
  },
};

export function toolCatalogue() {
  return Object.entries(TOOLS)
    .map(([name, t]) => `- ${name}(${Object.keys(t.args).join(', ') || ''})\n    ${t.description}`)
    .join('\n');
}

/* ----------------------------------------------------------------- snapshot */

function snapshot() {
  const reqs = S().requirements;
  const projection = projectAll(S().planning, store.workspace.products[0]);
  const risky = projection.rows.filter((r) => r.status !== 'ok');
  return [
    `Requirements: ${reqs.length} total, ${reqs.filter((r) => !['approved', 'rejected'].includes(r.status)).length} open.`,
    reqs.length ? `Most recent: ${reqs.slice(-3).map((r) => `${r.id} (${r.materialName}, ${r.status})`).join('; ')}.` : 'No requirements raised yet.',
    `Quotations recorded: ${S().quotes.length}. RFQs: ${S().rfqs.length}, of which ${S().rfqs.filter((x) => x.sendStatus === 'sent').length} delivered.`,
    `Production plan: ${S().planning.unitsPerDay.toLocaleString()} bottles/day over ${S().planning.horizonDays} days.`,
    risky.length ? `Materials at risk: ${risky.map((r) => `${r.materialName} (${r.status}, day ${r.shortageDay ?? r.safetyBreachDay})`).join('; ')}.` : 'No material shortages projected.',
    `Sell side: ${S().campaigns.length} buyer(s) qualified, ${store.market.buyers.length} in the index.`,
    `Products we manufacture and can sell: ${store.market.products.map((p) => `${p.name} (productId ${p.id})`).join('; ')}. These are the ONLY sellable products.`,
    `Buyer channel tags present in the index: ${availableChannels(store.market.buyers).join(', ')}.`,
  ].join('\n');
}

/* --------------------------------------------------------------- the loop */

/** One completion from the graph8 copilot skill. */
async function callCopilot({ conversation, role, toolResults }) {
  return runSkill({
    skillId: SKILLS.copilot.id,
    timeoutMs: 60_000,
    input: {
      workspace: store.workspace.meta.workspaceName,
      role: store.role(role)?.label || 'procurement officer',
      today: new Date().toISOString().slice(0, 10),
      tools: toolCatalogue(),
      schema: db.SCHEMA_SUMMARY,
      snapshot: snapshot(),
      history: conversation
        .map((m) => `${m.role === 'user' ? 'USER' : 'COPILOT'}: ${String(m.content).slice(0, 700)}`)
        .join('\n')
        .slice(-4000),
      toolResults: String(toolResults).slice(-6000),
    },
  });
}

export async function converse({ conversation, role, onStep }) {
  if (!isConfigured()) throw new Error('The copilot needs GRAPH8_API_KEY — it runs on a graph8 LLM skill.');

  const steps = [];
  // Accumulated, not overwritten: the agent must be able to see everything it
  // already learned this turn, or it loops re-running the same lookups.
  const transcript = [];
  const renderTranscript = () => {
    if (!transcript.length) return '(no tools called yet this turn)';
    const reminder =
      'Do NOT call a tool you have already called above with the same arguments — ' +
      'you already have that result. Use it.';
    return [...transcript, reminder].join('\n\n');
  };
  let toolResults = renderTranscript();

  for (let i = 0; i < MAX_STEPS; i++) {
    let parsed = null;
    let meta = null;
    let lastError = null;

    // A long prompt occasionally comes back empty. One retry costs a few
    // seconds; failing outright costs the conversation.
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        ({ parsed, meta } = await callCopilot({ conversation, role, toolResults }));
      } catch (err) {
        lastError = err;
        toolResults = `${toolResults}\n(Your previous response could not be parsed. Reply with ONE valid JSON object and nothing else.)`;
      }
    }

    if (!parsed) {
      return {
        reply: `The model did not return anything usable (${lastError?.message || 'unknown error'}). That usually means the question needed too many steps at once — splitting it, or naming the requirement directly, will help.`,
        suggestions: [],
        steps,
        degraded: true,
      };
    }

    if (parsed.reply) {
      return { reply: parsed.reply, suggestions: parsed.suggestions || [], steps, meta };
    }

    const name = parsed.tool;
    const tool = TOOLS[name];
    const step = { tool: name, args: parsed.args || {}, thought: parsed.thought, say: parsed.say, at: new Date().toISOString() };

    if (!tool) {
      step.ok = false;
      step.error = `Unknown tool "${name}".`;
      steps.push(step);
      onStep?.(step);
      transcript.push(`[${transcript.length + 1}] ${name} -> ERROR: no such tool. Available: ${Object.keys(TOOLS).join(', ')}.`);
      toolResults = renderTranscript();
      continue;
    }

    onStep?.(step);
    try {
      const result = await tool.run(parsed.args || {});
      step.ok = true;
      step.result = result;
      transcript.push(
        `[${transcript.length + 1}] ${name}(${JSON.stringify(parsed.args || {}).slice(0, 220)}) ->\n` +
        JSON.stringify(result).slice(0, 2200)
      );
      toolResults = renderTranscript();
    } catch (err) {
      step.ok = false;
      step.error = err.message;
      transcript.push(
        `[${transcript.length + 1}] ${name}(${JSON.stringify(parsed.args || {}).slice(0, 220)}) -> FAILED: ${err.message}`
      );
      toolResults = renderTranscript();
    }
    steps.push(step);
  }

  return {
    reply: `I worked through ${MAX_STEPS} steps without reaching an answer. Here is what I tried: ${steps.map((s) => s.tool).join(' → ')}. Narrowing the question will help.`,
    suggestions: [],
    steps,
    exhausted: true,
  };
}
