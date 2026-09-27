/**
 * Agentic Procurement OS — API + static host.
 *
 * Nothing that looks like a number on a dashboard is stored: totals, statuses
 * and savings are computed from the records that exist at request time. If the
 * workspace is empty, the endpoints return empty and the UI shows an empty
 * state rather than a decorative figure.
 */

import express from 'express';
import compression from 'compression';
import morgan from 'morgan';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { store } from './store.js';
import * as db from './db.js';
import { projectAll, forwardBuy, round } from './domain/planning.js';
import { compareQuotes, buildRecommendation, daysUntil } from './domain/sourcing.js';
import { runSupplierDiscovery, runRFQPreparation, runQuoteAnalysis, runInventoryProjection, runSupplierAnalysis } from './domain/agents.js';
import { engineStatus, isConfigured, runSystemSkill, SYSTEM_SKILLS } from './domain/graph8Skill.js';
import { salesRouter } from './routes/sales.js';
import { converse, TOOLS } from './domain/copilot.js';
import { parseRequest } from './domain/intake.js';
import { sendRFQ, sendDemoReply, buildDemoQuote, canAutoRespond, channelStatus, demoAddressFor } from './domain/mail.js';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const WEB_DIST = join(__dirname, '..', 'public');

const app = express();

/**
 * The demo mail inbox, served through this app at /inbox.
 *
 * Mailpit listens on its own port, which is fine on localhost but unreachable
 * for anyone visiting through a tunnel or from another machine. Proxying it
 * under our own origin means the "open the inbox" link works wherever the app
 * is reachable, over one port, with websockets passed through so the inbox
 * still updates live.
 *
 * MP_WEBROOT=/inbox on the Mailpit container makes it emit its asset paths
 * under /inbox, so nothing needs rewriting here.
 */
const MAIL_UI_ORIGIN = process.env.MAIL_UI_ORIGIN || 'http://mail:8025';
const mailProxy = createProxyMiddleware({
  // Filtered at the root rather than mounted on '/inbox': express strips the
  // mount path before the handler sees it, which would forward '/' to Mailpit
  // and 404, since Mailpit serves everything under its own /inbox webroot.
  pathFilter: (path) => path === '/inbox' || path.startsWith('/inbox/'),
  target: MAIL_UI_ORIGIN,
  changeOrigin: true,
  ws: true,
  on: {
    error: (_err, _req, res) => {
      if (res.writeHead) {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        res.end('<h1>Mail inbox unavailable</h1><p>The Mailpit service is not running.</p>');
      }
    },
  },
});
app.use(mailProxy);

app.use(compression());
app.use(express.json({ limit: '2mb' }));
if (process.env.LOG_REQUESTS !== 'false') app.use(morgan('tiny'));

// Behind ngrok or any reverse proxy, so req.protocol and the client IP are read
// from the forwarded headers rather than the tunnel's own socket.
app.set('trust proxy', true);

const api = express.Router();
const S = () => store.state;

/* ------------------------------------------------------------- workspace */

api.get('/health', (_req, res) =>
  res.json({
    ok: true,
    workspace: store.workspace.meta.workspaceName,
    graph8Suppliers: store.graph8.suppliers.length,
    requirements: S().requirements.length,
    uptimeSeconds: Math.round(process.uptime()),
  })
);

api.get('/workspace', (_req, res) =>
  res.json({
    meta: store.workspace.meta,
    roles: store.workspace.roles,
    sites: store.workspace.sites,
    categories: store.workspace.categories,
    materials: S().planning.materials,
    products: store.workspace.products,
    priceScenarios: store.workspace.priceScenarios,
    graph8Meta: store.graph8.meta,
    engine: engineStatus(),
    intake: {
      engine: process.env.GRAPH8_API_KEY ? 'graph8' : 'local',
      skillId: process.env.GRAPH8_INTAKE_SKILL_ID || '2730f9a5-a7ee-4159-9396-986bd1be7cfa',
      skillName: 'Procurement Intake Parser',
      model: 'claude-sonnet-4-6',
      note: process.env.GRAPH8_API_KEY
        ? 'Requests are parsed by an LLM skill hosted in your graph8 organisation.'
        : 'Using the built-in deterministic parser. Set GRAPH8_API_KEY to route intake through the graph8 LLM skill instead.',
    },
  })
);

/* ---------------------------------------------------------- requirements */

function decorate(r) {
  const days = daysUntil(r.requiredBy);
  const quotes = store.quotesFor(r.id);
  const rfqs = store.rfqsFor(r.id);
  const shortlist = store.shortlistFor(r.id);
  return {
    ...r,
    daysToRequired: days,
    overdue: days !== null && days < 0,
    counts: {
      shortlisted: shortlist.length,
      rfqs: rfqs.length,
      rfqsSent: rfqs.filter((x) => x.sendStatus === 'sent').length,
      quotes: quotes.length,
    },
  };
}

api.get('/requirements', (req, res) => {
  const { status, siteId, priority, category } = req.query;
  let rows = S().requirements.map(decorate);
  if (status) rows = rows.filter((r) => r.status === status);
  if (siteId) rows = rows.filter((r) => r.siteId === siteId);
  if (priority) rows = rows.filter((r) => r.priority === priority);
  if (category) rows = rows.filter((r) => r.category === category);
  rows.sort((a, b) => (a.daysToRequired ?? 9e9) - (b.daysToRequired ?? 9e9));
  res.json({ total: rows.length, requirements: rows });
});

api.post('/requirements', (req, res) => {
  const b = req.body || {};
  const errors = {};

  if (!b.title?.trim()) errors.title = 'Give the request a title.';
  if (!b.materialId) errors.materialId = 'Select a material.';
  if (!b.siteId) errors.siteId = 'Select a plant or site.';
  if (!b.quantity || Number(b.quantity) <= 0) errors.quantity = 'Quantity must be greater than zero.';
  if (!b.requiredBy) errors.requiredBy = 'Set a required-by date.';
  else if (daysUntil(b.requiredBy) < 0) errors.requiredBy = 'Required-by date is in the past.';
  if (!b.reason?.trim()) errors.reason = 'State the production or operational need.';

  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const material = store.material(b.materialId);
  const site = store.site(b.siteId);
  if (!material || !site) return res.status(400).json({ errors: { materialId: 'Unknown material or site.' } });

  const requirement = {
    id: store.nextId('req', 'REQ'),
    title: b.title.trim(),
    materialId: material.id,
    materialName: material.name,
    category: material.category,
    uom: material.uom,
    siteId: site.id,
    siteName: site.name,
    siteCountry: site.country,
    quantity: Number(b.quantity),
    requiredBy: b.requiredBy,
    priority: b.priority || 'routine',
    specification: b.specification?.trim() || '',
    notes: b.notes?.trim() || '',
    targetPrice: b.targetPrice ? Number(b.targetPrice) : null,
    reason: b.reason.trim(),
    raisedBy: b.raisedBy || 'requester',
    status: 'submitted',
    assignedTo: null,
    createdAt: new Date().toISOString(),
    history: [{ at: new Date().toISOString(), actor: b.raisedBy || 'requester', action: 'Requirement submitted' }],
  };

  S().requirements.push(requirement);
  store.logActivity({ type: 'requirement', message: `${requirement.id} raised: ${requirement.quantity.toLocaleString()} ${requirement.uom} of ${requirement.materialName} for ${requirement.siteName}`, actor: requirement.raisedBy, refId: requirement.id });

  // Submitting genuinely triggers the research workflow on these values.
  requirement.status = 'researching';
  const task = runSupplierDiscovery(requirement, { trigger: `Requirement ${requirement.id} submitted` });
  requirement.history.push({ at: new Date().toISOString(), actor: 'agent', action: `Supplier discovery started (${task.id})` });
  requirement.status = task.status === 'needs_attention' ? 'needs_info' : 'awaiting_review';
  store.persist();

  res.status(201).json({ requirement: decorate(requirement), taskId: task.id });
});

/* ------------------------------------------------- natural-language intake */

/**
 * One free-text box, the whole chain.
 *
 * Parse → create the requirement → discover suppliers → shortlist the best
 * candidates → draft an RFQ for each. Every step is the same code path the
 * manual UI uses, so nothing here is a shortcut that only works in the demo.
 *
 * `preview: true` parses and stops, so the UI can show what was understood
 * before anything is written.
 */
api.post('/intake', async (req, res) => {
  const { request, preview = false, autoShortlist = 3, autoRFQ = true } = req.body || {};
  if (!request || !request.trim()) {
    return res.status(400).json({ errors: { request: 'Describe what you need.' } });
  }

  const materials = S().planning.materials;
  const sites = store.workspace.sites;

  let parsed;
  try {
    parsed = await parseRequest({ request: request.trim(), materials, sites });
  } catch (err) {
    return res.status(500).json({ error: `Intake parsing failed: ${err.message}` });
  }

  const material = parsed.materialId ? store.material(parsed.materialId) : null;

  // The model can return a site id that does not resolve, or none at all.
  // Falling back to the default site (and saying so) is better than blocking a
  // requirement over a field the buyer probably did not care about.
  let site = parsed.siteId ? store.site(parsed.siteId) : null;
  if (!site) {
    site = store.workspace.sites[0];
    parsed.assumptions = [
      ...(parsed.assumptions || []),
      `No site was identified in the request, so it defaults to ${site.name}.`,
    ];
  }

  const blockers = [];
  if (!material) blockers.push('material');
  if (!parsed.quantity || Number(parsed.quantity) <= 0) blockers.push('quantity');
  if (!parsed.requiredBy) blockers.push('requiredBy');

  const understood = {
    ...parsed,
    materialName: material?.name || null,
    uom: material?.uom || null,
    siteName: site?.name || null,
    blockers,
    ready: blockers.length === 0,
  };

  if (preview || blockers.length) {
    return res.json({ understood, requirement: null, chain: [], note: blockers.length ? `Needs ${blockers.join(' and ')} before it can be raised.` : null });
  }

  const chain = [];

  // 1. Create the requirement — this already triggers supplier discovery.
  const requirement = {
    id: store.nextId('req', 'REQ'),
    title: parsed.title || `${material.name} requirement`,
    materialId: material.id,
    materialName: material.name,
    category: material.category,
    uom: material.uom,
    siteId: site.id,
    siteName: site.name,
    siteCountry: site.country,
    quantity: Number(parsed.quantity),
    requiredBy: parsed.requiredBy,
    priority: parsed.priority || 'routine',
    specification: parsed.specification || '',
    notes: '',
    targetPrice: null,
    reason: parsed.reason || 'Raised from a natural-language request.',
    raisedBy: req.body.raisedBy || 'requester',
    status: 'submitted',
    assignedTo: null,
    createdAt: new Date().toISOString(),
    intake: {
      request: request.trim(),
      engine: parsed.engine,
      engineDetail: parsed.engineDetail,
      confidence: parsed.confidence,
      assumptions: parsed.assumptions || [],
      clarifications: parsed.clarifications || [],
      skillId: parsed.skillId || null,
      executionId: parsed.executionId || null,
      costUsd: parsed.costUsd ?? null,
    },
    history: [{ at: new Date().toISOString(), actor: parsed.engine === 'graph8' ? 'graph8 agent' : 'intake parser', action: `Raised from a free-text request (${parsed.engine}, confidence ${parsed.confidence})` }],
  };
  S().requirements.push(requirement);
  store.logActivity({ type: 'requirement', message: `${requirement.id} raised from a natural-language request: ${requirement.quantity.toLocaleString()} ${requirement.uom} of ${requirement.materialName}`, actor: requirement.raisedBy, refId: requirement.id });
  chain.push({ step: 'requirement', label: 'Requirement created', detail: requirement.id, ok: true });

  // 2. Supplier discovery against these exact values.
  const discoveryTask = runSupplierDiscovery(requirement, { trigger: `Natural-language intake for ${requirement.id}` });
  requirement.status = discoveryTask.status === 'needs_attention' ? 'needs_info' : 'awaiting_review';
  const results = discoveryTask.result?.results || [];
  chain.push({ step: 'discovery', label: 'Suppliers discovered', detail: `${results.length} candidates (${discoveryTask.result?.counts?.graph8 ?? 0} from graph8)`, ok: results.length > 0, taskId: discoveryTask.id });

  // 3. Shortlist the strongest candidates.
  let shortlisted = [];
  if (autoShortlist > 0 && results.length) {
    const list = S().shortlists[requirement.id] || (S().shortlists[requirement.id] = []);
    results.slice(0, autoShortlist).forEach((r) => {
      list.push({ supplierId: r.supplier.id, source: r.supplier.source, reason: r.match.reasons[0] || '', addedAt: new Date().toISOString(), autoSelected: true, matchScore: r.match.score });
    });
    shortlisted = list;
    store.logActivity({ type: 'shortlist', message: `${list.length} supplier(s) auto-shortlisted for ${requirement.id}`, actor: 'agent', refId: requirement.id });
    chain.push({ step: 'shortlist', label: 'Shortlisted', detail: list.map((s) => store.supplier(s.supplierId)?.company).filter(Boolean).join(', '), ok: true });

    // Deep research runs in the background — each supplier takes 15-25s, which
    // is far too long to hold the request open.
    if (isConfigured()) {
      const ids = list.map((s) => s.supplierId);
      runSupplierAnalysis(requirement, ids, { trigger: `Auto-shortlist for ${requirement.id}` })
        .catch((err) => console.warn('[supplier-analysis]', err.message));
      chain.push({ step: 'analysis', label: 'Deep research started', detail: `graph8 is researching ${ids.length} supplier(s) — results appear in the discovery view`, ok: true });
    }
  }

  // 4. Draft an RFQ per shortlisted supplier. Drafts only — never sent.
  let rfqTask = null;
  if (autoRFQ && shortlisted.length) {
    rfqTask = runRFQPreparation(requirement, shortlisted.map((s) => s.supplierId), { trigger: `Natural-language intake for ${requirement.id}` });
    requirement.status = 'rfq_prepared';
    const n = store.rfqsFor(requirement.id).length;
    chain.push({ step: 'rfq', label: 'RFQ drafts prepared', detail: `${n} draft${n === 1 ? '' : 's'} — awaiting your approval, nothing sent`, ok: n > 0, taskId: rfqTask.id });
  }

  store.persist();

  res.status(201).json({
    understood,
    requirement: decorate(requirement),
    chain,
    shortlist: shortlisted.map((s) => ({ ...s, supplier: store.supplier(s.supplierId) })),
    rfqs: store.rfqsFor(requirement.id),
    tasks: store.tasksFor(requirement.id),
  });
});

api.get('/requirements/:id', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const quotes = store.quotesFor(r.id);
  const suppliers = store.allSuppliers();
  const comparison = quotes.length ? compareQuotes({ requirement: r, quotes, suppliers }) : null;
  const recommendation = comparison ? buildRecommendation({ requirement: r, comparison, suppliers }) : null;

  res.json({
    requirement: decorate(r),
    shortlist: store.shortlistFor(r.id).map((s) => ({ ...s, supplier: store.supplier(s.supplierId) })),
    rfqs: store.rfqsFor(r.id),
    quotes,
    comparison,
    recommendation,
    tasks: store.tasksFor(r.id),
    decisions: S().decisions.filter((d) => d.requirementId === r.id),
  });
});

api.patch('/requirements/:id', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const b = req.body || {};
  const changed = [];

  ['quantity', 'requiredBy', 'specification', 'priority', 'notes', 'targetPrice'].forEach((k) => {
    if (b[k] !== undefined && String(b[k]) !== String(r[k])) {
      r[k] = k === 'quantity' || k === 'targetPrice' ? (b[k] === null || b[k] === '' ? null : Number(b[k])) : b[k];
      changed.push(k);
    }
  });

  if (b.status) { r.status = b.status; changed.push('status'); }
  if (b.assignedTo !== undefined) { r.assignedTo = b.assignedTo; changed.push('assignedTo'); }

  if (changed.length) {
    r.history.push({ at: new Date().toISOString(), actor: b.actor || 'officer', action: `Updated ${changed.join(', ')}` });
    store.logActivity({ type: 'requirement', message: `${r.id} updated: ${changed.join(', ')}`, actor: b.actor || 'officer', refId: r.id });
    store.persist();
  }

  // Values that change what a supplier is being asked for re-run discovery.
  let task = null;
  if (changed.some((k) => ['quantity', 'requiredBy', 'specification'].includes(k))) {
    task = runSupplierDiscovery(r, { trigger: `Requirement ${r.id} edited (${changed.join(', ')})` });
    r.history.push({ at: new Date().toISOString(), actor: 'agent', action: `Re-ran supplier discovery after edit (${task.id})` });
    store.persist();
  }

  res.json({ requirement: decorate(r), changed, taskId: task?.id || null });
});

/* --------------------------------------------------------------- sourcing */

api.post('/requirements/:id/discover', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const task = runSupplierDiscovery(r, { trigger: req.body?.trigger || 'Manual re-run by procurement officer' });
  res.json({ task });
});

api.get('/requirements/:id/discovery', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const task = store.tasksFor(r.id).find((t) => t.kind === 'supplier_discovery' && t.result);
  if (!task) return res.json({ discovery: null });
  const shortlisted = new Set(store.shortlistFor(r.id).map((s) => s.supplierId));
  const discovery = {
    ...task.result,
    results: task.result.results.map((x) => ({ ...x, shortlisted: shortlisted.has(x.supplier.id) })),
  };
  res.json({ discovery, taskId: task.id });
});

api.post('/requirements/:id/analyse-suppliers', async (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const ids = (req.body?.supplierIds?.length ? req.body.supplierIds : store.shortlistFor(r.id).map((s) => s.supplierId));
  if (!ids.length) return res.status(400).json({ error: 'Shortlist a supplier first, or pass supplierIds.' });
  const task = await runSupplierAnalysis(r, ids, { trigger: req.body?.trigger || 'Requested by the procurement officer' });
  res.json({ task });
});

api.get('/requirements/:id/analyses', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const tasks = store.tasksFor(r.id).filter((t) => t.kind === 'supplier_analysis');
  const running = tasks.some((t) => t.status === 'running');
  const analyses = {};
  [...tasks].reverse().forEach((t) => Object.assign(analyses, t.result?.analyses || {}));
  res.json({ analyses, running, tasks: tasks.map((t) => ({ id: t.id, status: t.status, startedAt: t.startedAt })) });
});

api.post('/requirements/:id/shortlist', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const { supplierId, reason } = req.body || {};
  const supplier = store.supplier(supplierId);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

  const list = S().shortlists[r.id] || (S().shortlists[r.id] = []);
  if (!list.find((x) => x.supplierId === supplierId)) {
    list.push({ supplierId, source: supplier.source, reason: reason || '', addedAt: new Date().toISOString() });
    store.logActivity({ type: 'shortlist', message: `${supplier.company} shortlisted for ${r.id}`, actor: 'officer', refId: r.id });
    store.persist();
  }
  res.json({ shortlist: list });
});

api.delete('/requirements/:id/shortlist/:supplierId', (req, res) => {
  const list = S().shortlists[req.params.id] || [];
  S().shortlists[req.params.id] = list.filter((x) => x.supplierId !== req.params.supplierId);
  store.persist();
  res.json({ shortlist: S().shortlists[req.params.id] });
});

/* -------------------------------------------------------------------- RFQ */

api.post('/requirements/:id/rfqs', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const ids = (store.shortlistFor(r.id) || []).map((s) => s.supplierId);
  if (!ids.length) return res.status(400).json({ error: 'Shortlist at least one supplier before preparing RFQs.' });

  // Drop any previous drafts for this requirement that were never approved.
  S().rfqs = S().rfqs.filter((x) => !(x.requirementId === r.id && !x.approved));
  const task = runRFQPreparation(r, ids, { trigger: req.body?.trigger || 'Officer requested RFQ preparation' });
  r.status = 'rfq_prepared';
  r.history.push({ at: new Date().toISOString(), actor: 'officer', action: 'RFQ drafts prepared' });
  store.persist();
  res.json({ task, rfqs: store.rfqsFor(r.id) });
});

api.patch('/rfqs/:id', (req, res) => {
  const rfq = store.rfq(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });
  const { subject, body } = req.body || {};
  if (subject !== undefined) rfq.subject = subject;
  if (body !== undefined) rfq.body = body;
  store.persist();
  res.json({ rfq });
});

api.get('/channel', (_req, res) => res.json(channelStatus()));
api.get('/engine', (_req, res) => res.json(engineStatus()));

api.get('/system-skills', (_req, res) =>
  res.json({
    available: isConfigured(),
    skills: Object.entries(SYSTEM_SKILLS).map(([key, s]) => ({ key, ...s })),
    note: 'These ship with graph8. We did not author them — they are the same skills available in the graph8 product, run against our records.',
  })
);

/**
 * Deep dive: run one of graph8's own system skills against a supplier or a
 * buyer we hold. Returns markdown prose, cached per entity + skill so a rerun
 * during a demo does not spend credits twice.
 */
api.post('/deep-dive', async (req, res) => {
  const { entity, id, skill = 'productMapping' } = req.body || {};
  if (!isConfigured()) return res.status(400).json({ error: 'No GRAPH8_API_KEY configured.' });
  if (!SYSTEM_SKILLS[skill]) return res.status(400).json({ error: `Unknown skill "${skill}".` });

  const subject = entity === 'buyer' ? store.buyer(id) : store.supplier(id);
  if (!subject) return res.status(404).json({ error: 'Unknown supplier or buyer.' });

  const cacheKey = `${entity}:${id}:${skill}`;
  if (S().deepDives[cacheKey] && !req.body.force) {
    return res.json({ report: S().deepDives[cacheKey], cached: true });
  }

  const c = subject.contact || {};
  const context = entity === 'buyer'
    ? `We manufacture ambient tomato condiments and are assessing whether this company is a credible buyer. Contact on file: ${c.firstName || ''} ${c.lastName || ''}, ${c.jobTitle || 'unknown role'}.`
    : `We are sourcing food ingredients and packaging and need to know whether this company can actually supply them. Contact on file: ${c.firstName || ''} ${c.lastName || ''}, ${c.jobTitle || 'unknown role'}.`;

  try {
    const { skill: meta, markdown, meta: run } = await runSystemSkill({
      key: skill,
      input: { company_name: subject.company, company_domain: subject.domain || '', context },
    });
    const report = {
      id: store.nextId('dive', 'DIVE'),
      entity, entityId: id, company: subject.company,
      skillKey: skill, skillName: meta.name, owner: meta.owner,
      markdown, meta: run, at: new Date().toISOString(),
    };
    S().deepDives[cacheKey] = report;
    store.logActivity({
      type: 'agent',
      message: `graph8 "${meta.name}" researched ${subject.company} (${run.webSearches} web search${run.webSearches === 1 ? '' : 'es'})`,
      actor: 'graph8',
      provenance: 'live',
    });
    store.persist();
    res.json({ report, cached: false });
  } catch (err) {
    res.status(502).json({ error: `graph8 system skill failed: ${err.message}` });
  }
});

api.get('/deep-dive', (req, res) => {
  const { entity, id, skill = 'productMapping' } = req.query;
  res.json({ report: S().deepDives[`${entity}:${id}:${skill}`] || null });
});

/**
 * Approve and send.
 *
 * This performs a real SMTP transaction against the mail server bundled with
 * the compose stack, so `sent` means a message with a real id reached a real
 * inbox. Status is still whatever actually happened — a broken channel reports
 * `failed`, not `sent`.
 *
 * Where the supplier is one of the fictional directory vendors, a quotation
 * reply is scheduled so the round trip completes on its own. Real
 * graph8-discovered companies never auto-reply; inventing a quotation in a real
 * business's name would be a fabrication wherever the mail happened to land.
 */
api.post('/rfqs/:id/send', async (req, res) => {
  const rfq = store.rfq(req.params.id);
  if (!rfq) return res.status(404).json({ error: 'RFQ not found' });

  const supplier = store.supplier(rfq.supplierId);
  rfq.approved = true;
  rfq.approvedAt = new Date().toISOString();
  rfq.sendAttemptedAt = new Date().toISOString();

  const result = await sendRFQ({ rfq, supplier });
  Object.assign(rfq, result);

  store.logActivity({
    type: 'rfq',
    message: result.sendStatus === 'sent'
      ? `RFQ delivered to ${rfq.supplierName} at ${result.to}`
      : `RFQ to ${rfq.supplierName} — ${result.sendStatus.replace('_', ' ')}`,
    actor: 'officer',
    refId: rfq.requirementId,
    provenance: 'live',
  });

  const r = store.requirement(rfq.requirementId);
  if (r && ['rfq_prepared', 'awaiting_review'].includes(r.status)) {
    r.status = 'awaiting_quotes';
    r.history.push({ at: new Date().toISOString(), actor: 'officer', action: `RFQ sent to ${rfq.supplierName}` });
  }

  // Schedule the supplier's reply so the workflow keeps moving without anyone
  // having to type a quotation by hand.
  if (result.sendStatus === 'sent' && supplier && canAutoRespond(supplier) && r) {
    rfq.awaitingReply = true;
    rfq.replyExpectedInSeconds = Number(process.env.DEMO_REPLY_DELAY_SECONDS || 6);
    scheduleDemoReply({ requirementId: r.id, supplierId: supplier.id, rfqId: rfq.id, delayMs: rfq.replyExpectedInSeconds * 1000 });
  }

  store.persist();
  res.json({ rfq });
});

/** Sends the reply, records the quotation, and re-runs the quote analysis. */
function scheduleDemoReply({ requirementId, supplierId, rfqId, delayMs }) {
  setTimeout(async () => {
    try {
      const r = store.requirement(requirementId);
      const supplier = store.supplier(supplierId);
      const rfq = store.rfq(rfqId);
      if (!r || !supplier) return;
      if (S().quotes.some((q) => q.requirementId === r.id && q.supplierId === supplierId)) return;

      const material = store.material(r.materialId);
      const draft = buildDemoQuote({ requirement: r, supplier, material });
      const mail = await sendDemoReply({ requirement: r, supplier, quote: draft });

      const quote = {
        id: store.nextId('quote', 'QTE'),
        requirementId: r.id,
        ...draft,
        provenance: 'demo_reply',
        receivedVia: mail.ok ? 'demo mail channel' : 'demo responder (mail unavailable)',
        messageId: mail.messageId || null,
        createdAt: new Date().toISOString(),
      };
      S().quotes.push(quote);

      if (rfq) { rfq.awaitingReply = false; rfq.repliedAt = new Date().toISOString(); }
      r.status = 'quotes_in';
      r.history.push({ at: new Date().toISOString(), actor: supplier.company, action: `Quotation received (${quote.id})` });

      store.logActivity({
        type: 'quote',
        message: `${supplier.company} replied with a quotation (${quote.id}) for ${r.id}`,
        actor: supplier.company,
        refId: r.id,
        provenance: 'live',
      });

      runQuoteAnalysis(r, { trigger: `Quotation ${quote.id} received from ${supplier.company}` });
      store.persist();
    } catch (err) {
      console.warn('[demo-reply] failed:', err.message);
    }
  }, delayMs).unref?.();
}

/* ------------------------------------------------------------------ quotes */

api.post('/requirements/:id/quotes', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const b = req.body || {};
  if (!b.supplierId) return res.status(400).json({ errors: { supplierId: 'Select the supplier this quotation is from.' } });

  const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

  const quote = {
    id: store.nextId('quote', 'QTE'),
    requirementId: r.id,
    supplierId: b.supplierId,
    unitPrice: num(b.unitPrice),
    currency: b.currency || 'USD',
    additionalCharges: num(b.additionalCharges),
    minimumOrderQty: num(b.minimumOrderQty),
    availableQty: num(b.availableQty),
    leadTimeDays: num(b.leadTimeDays),
    validityDays: num(b.validityDays),
    deliveryTerms: b.deliveryTerms || '',
    paymentTerms: b.paymentTerms || '',
    specCompliance: b.specCompliance || '',
    certifications: b.certifications || '',
    notes: b.notes || '',
    // How this record came to exist — supplier reply, or typed in by a human.
    entryMode: b.entryMode || 'manual_entry',
    provenance: b.entryMode === 'supplier_reply' ? 'supplier_provided' : 'user_entered',
    createdAt: new Date().toISOString(),
  };

  S().quotes.push(quote);
  store.logActivity({
    type: 'quote',
    message: `Quotation ${quote.id} recorded for ${r.id} (${quote.entryMode.replace('_', ' ')})`,
    actor: 'officer',
    refId: r.id,
    provenance: quote.provenance === 'supplier_provided' ? 'live' : 'user',
  });

  r.status = 'quotes_in';
  r.history.push({ at: new Date().toISOString(), actor: 'officer', action: `Quotation recorded from ${store.supplier(b.supplierId)?.company || b.supplierId}` });
  store.persist();

  const task = runQuoteAnalysis(r, { trigger: `Quotation ${quote.id} recorded` });
  res.status(201).json({ quote, taskId: task.id });
});

api.delete('/quotes/:id', (req, res) => {
  S().quotes = S().quotes.filter((q) => q.id !== req.params.id);
  store.persist();
  res.json({ ok: true });
});

api.post('/requirements/:id/analyse', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const task = runQuoteAnalysis(r, { trigger: 'Manual re-analysis' });
  res.json({ task });
});

/* --------------------------------------------------------------- decisions */

api.post('/requirements/:id/decision', (req, res) => {
  const r = store.requirement(req.params.id);
  if (!r) return res.status(404).json({ error: 'Requirement not found' });
  const { action, note, quoteId, actor } = req.body || {};
  if (!['approve', 'reject', 'revise'].includes(action)) return res.status(400).json({ error: 'action must be approve, reject or revise' });
  if (action !== 'approve' && !note?.trim()) return res.status(400).json({ errors: { note: 'Give a reason when rejecting or returning for revision.' } });

  const decision = {
    id: store.nextId('dec', 'DEC'),
    requirementId: r.id,
    action,
    note: note?.trim() || '',
    quoteId: quoteId || null,
    actor: actor || 'head',
    at: new Date().toISOString(),
    scopeNote: 'Internal sourcing decision only. This does not raise a purchase order, commit funds, or place an order.',
  };
  S().decisions.push(decision);

  r.status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'revision_requested';
  r.history.push({ at: decision.at, actor: decision.actor, action: `Procurement head ${action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'requested revision on'} the recommendation${note ? `: ${note}` : ''}` });

  store.logActivity({ type: 'decision', message: `${r.id} ${r.status.replace('_', ' ')} by procurement head`, actor: decision.actor, refId: r.id });
  store.persist();
  res.json({ decision, requirement: decorate(r) });
});

/* ---------------------------------------------------------------- planning */

api.get('/planning', (_req, res) => {
  const projection = projectAll(S().planning, store.workspace.products[0]);
  res.json({
    planning: S().planning,
    product: store.workspace.products[0],
    sites: store.workspace.sites,
    projection,
    disclaimer: store.workspace.products[0].bomNote,
  });
});

api.put('/planning', (req, res) => {
  const b = req.body || {};
  const p = S().planning;
  const changed = [];

  if (b.unitsPerDay !== undefined && Number(b.unitsPerDay) >= 0) { p.unitsPerDay = Number(b.unitsPerDay); changed.push('unitsPerDay'); }
  if (b.horizonDays !== undefined && Number(b.horizonDays) > 0) { p.horizonDays = Math.min(365, Number(b.horizonDays)); changed.push('horizonDays'); }
  if (b.holdingCostPctPerMonth !== undefined) { p.holdingCostPctPerMonth = Number(b.holdingCostPctPerMonth); changed.push('holdingCost'); }

  if (Array.isArray(b.inventory)) {
    b.inventory.forEach((row) => {
      const target = p.inventory.find((i) => i.materialId === row.materialId);
      if (target) {
        if (row.onHand !== undefined) target.onHand = Number(row.onHand);
        if (row.reserved !== undefined) target.reserved = Number(row.reserved);
      }
    });
    changed.push('inventory');
  }
  if (Array.isArray(b.bom)) {
    b.bom.forEach((row) => {
      const target = p.bom.find((i) => i.materialId === row.materialId);
      if (target && row.qtyPerUnit !== undefined) target.qtyPerUnit = Number(row.qtyPerUnit);
    });
    changed.push('bom');
  }
  if (Array.isArray(b.materials)) {
    b.materials.forEach((row) => {
      const target = p.materials.find((m) => m.id === row.id);
      if (target) {
        if (row.safetyStock !== undefined) target.safetyStock = Number(row.safetyStock);
        if (row.leadTimeDays !== undefined) target.leadTimeDays = Number(row.leadTimeDays);
        if (row.unitCostAssumption !== undefined) target.unitCostAssumption = Number(row.unitCostAssumption);
      }
    });
    changed.push('materials');
  }

  store.persist();
  const task = runInventoryProjection({ trigger: `Planning inputs changed (${changed.join(', ') || 'no change'})` });
  const projection = projectAll(p, store.workspace.products[0]);
  res.json({ planning: p, projection, changed, taskId: task.id });
});

api.post('/planning/reset', (_req, res) => {
  const p = S().planning;
  p.unitsPerDay = store.workspace.productionPlan.unitsPerDay;
  p.horizonDays = store.workspace.productionPlan.horizonDays;
  p.inventory = store.workspace.inventory.map((r) => ({ ...r }));
  p.receipts = store.workspace.expectedReceipts.map((r) => ({ ...r }));
  p.bom = store.workspace.products[0].bom.map((r) => ({ ...r }));
  p.materials = store.workspace.materials.map((m) => ({ ...m }));
  store.persist();
  res.json({ planning: p, projection: projectAll(p, store.workspace.products[0]) });
});

/* --------------------------------------------------------------- analytics */

api.get('/analytics/forward-buy', (req, res) => {
  const materialId = req.query.materialId;
  const scenarioId = req.query.scenarioId || 'ps_flat';
  const months = Number(req.query.months || 1);

  const material = store.material(materialId);
  if (!material) return res.status(400).json({ error: 'Unknown material' });

  const projection = projectAll(S().planning, store.workspace.products[0]);
  const row = projection.rows.find((r) => r.materialId === materialId);
  if (!row) return res.status(400).json({ error: 'Material is not on the current bill of materials' });

  // Prefer a real saved quote over the illustrative assumption.
  const quotes = S().quotes.filter((q) => {
    const r = store.requirement(q.requirementId);
    return r && r.materialId === materialId && q.unitPrice !== null;
  });
  const bestQuote = quotes.length ? quotes.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a)) : null;

  const unitPrice = bestQuote ? bestQuote.unitPrice : material.unitCostAssumption;
  const priceSource = bestQuote ? 'quote' : 'assumption';
  const priceSourceDetail = bestQuote
    ? `Saved quotation ${bestQuote.id} from ${store.supplier(bestQuote.supplierId)?.company || bestQuote.supplierId}.`
    : 'Illustrative unit-cost assumption from the demo workspace. Not a market price.';

  const scenario = store.workspace.priceScenarios.find((s) => s.id === scenarioId) || store.workspace.priceScenarios[0];
  const qty = row.suggestedOrderQty || Math.ceil(row.dailyConsumption * material.leadTimeDays);

  const analysis = forwardBuy({
    qty,
    unitPrice,
    priceSource,
    changePct: scenario.changePct,
    holdingCostPctPerMonth: S().planning.holdingCostPctPerMonth,
    monthsDeferred: months,
    shortageDay: row.shortageDay,
    leadTimeDays: material.leadTimeDays,
  });

  res.json({
    material: { id: material.id, name: material.name, uom: material.uom },
    projectionRow: row,
    scenario,
    scenarios: store.workspace.priceScenarios,
    priceSource, priceSourceDetail,
    analysis,
  });
});

/* ------------------------------------------------- dashboard, tasks, admin */

api.get('/dashboard', (_req, res) => {
  const reqs = S().requirements.map(decorate);
  const projection = projectAll(S().planning, store.workspace.products[0]);
  const quotes = S().quotes;

  const byStatus = {};
  reqs.forEach((r) => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });

  const awaitingDecision = reqs.filter((r) => ['quotes_in', 'awaiting_quotes'].includes(r.status));
  const atRisk = reqs.filter((r) => r.daysToRequired !== null && r.daysToRequired <= 14 && !['approved', 'rejected'].includes(r.status));

  // Spend exposure is only counted where a real priced quote exists.
  let quotedExposure = 0;
  let quotedLines = 0;
  reqs.forEach((r) => {
    const rq = quotes.filter((q) => q.requirementId === r.id && q.unitPrice !== null);
    if (rq.length) {
      const cheapest = rq.reduce((a, b) => (b.unitPrice < a.unitPrice ? b : a));
      quotedExposure += cheapest.unitPrice * r.quantity;
      quotedLines++;
    }
  });

  res.json({
    counts: {
      requirements: reqs.length,
      open: reqs.filter((r) => !['approved', 'rejected'].includes(r.status)).length,
      awaitingDecision: awaitingDecision.length,
      atRisk: atRisk.length,
      rfqs: S().rfqs.length,
      rfqsSent: S().rfqs.filter((x) => x.sendStatus === 'sent').length,
      quotes: quotes.length,
      decisions: S().decisions.length,
      shortages: projection.totals.shortages,
      belowSafety: projection.totals.belowSafety,
    },
    byStatus,
    quotedExposure: round(quotedExposure),
    quotedLines,
    exposureNote:
      quotedLines === 0
        ? 'No priced quotation exists yet, so there is no spend figure to show.'
        : `Based on the lowest priced quotation on ${quotedLines} requirement(s). Estimate only — excludes taxes, duties and charges no supplier stated.`,
    atRisk: atRisk.slice(0, 6),
    awaitingDecision: awaitingDecision.slice(0, 6),
    shortageRows: projection.rows.filter((r) => r.status !== 'ok').slice(0, 6),
    activity: S().activity.slice(0, 12),
  });
});

api.get('/tasks', (req, res) => {
  const { requirementId, kind } = req.query;
  let rows = S().agentTasks;
  if (requirementId) rows = rows.filter((t) => t.requirementId === requirementId);
  if (kind) rows = rows.filter((t) => t.kind === kind);
  res.json({ total: rows.length, tasks: rows.slice(0, 60) });
});

api.get('/tasks/:id', (req, res) => {
  const t = S().agentTasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: t });
});

api.post('/tasks/:id/retry', (req, res) => {
  const t = S().agentTasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Task not found' });
  const r = t.requirementId ? store.requirement(t.requirementId) : null;
  let task = null;
  if (t.kind === 'supplier_discovery' && r) task = runSupplierDiscovery(r, { trigger: `Retry of ${t.id}` });
  else if (t.kind === 'quote_analysis' && r) task = runQuoteAnalysis(r, { trigger: `Retry of ${t.id}` });
  else if (t.kind === 'inventory_projection') task = runInventoryProjection({ trigger: `Retry of ${t.id}` });
  else return res.status(400).json({ error: 'This task kind cannot be retried directly.' });
  res.json({ task });
});

api.get('/suppliers', (req, res) => {
  const { q, tag } = req.query;
  let rows = store.allSuppliers();
  if (tag) rows = rows.filter((s) => (s.materialTags || []).includes(tag));
  if (q) {
    const n = q.toLowerCase();
    rows = rows.filter((s) => s.company.toLowerCase().includes(n) || (s.domain || '').toLowerCase().includes(n));
  }
  res.json({ total: rows.length, suppliers: rows });
});

api.get('/activity', (_req, res) => res.json({ total: S().activity.length, activity: S().activity.slice(0, 120) }));

api.post('/reset', (_req, res) => { store.reset(); res.json({ ok: true }); });

/* --------------------------------------------------------------- copilot */

api.get('/chat/tools', (_req, res) =>
  res.json({
    available: isConfigured(),
    tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, args: Object.keys(t.args) })),
  })
);

/**
 * One user turn. The agent may call several tools before answering; the steps
 * come back with the reply so the UI can show its working.
 */
api.post('/chat', async (req, res) => {
  const { messages = [], role = 'officer', conversationId } = req.body || {};
  if (!messages.length) return res.status(400).json({ error: 'Send at least one message.' });
  const last = String(messages[messages.length - 1].content);
  try {
    const out = await converse({ conversation: messages.slice(-12), role });
    store.logActivity({
      type: 'copilot',
      message: `Copilot answered: "${last.slice(0, 70)}"${out.steps.length ? ` (${out.steps.length} tool call${out.steps.length === 1 ? '' : 's'})` : ''}`,
      actor: 'copilot',
      provenance: 'live',
    });
    store.persist();

    // Persist the transcript so it survives a reload. The id comes from the
    // client, so a continuing conversation updates its row rather than
    // accumulating one row per turn.
    const id = conversationId || `conv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const full = [...messages, { role: 'assistant', content: out.reply, steps: out.steps, meta: out.meta, suggestions: out.suggestions }];
    try {
      await db.saveConversation({
        id,
        roleId: role,
        // The first thing the user asked is the most useful label for a list.
        title: String(messages.find((m) => m.role === 'user')?.content || last).slice(0, 80),
        messages: full,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) {
      // A history write must never cost the user their answer.
      console.warn('conversation save failed:', e.message);
    }

    res.json({ ...out, conversationId: id });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------- chat history */

api.get('/chat/conversations', async (req, res) => {
  if (!db.isEnabled()) return res.json({ available: false, conversations: [] });
  try {
    const conversations = await db.listConversations({ roleId: req.query.role || undefined });
    res.json({ available: true, conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.get('/chat/conversations/:id', async (req, res) => {
  try {
    const conv = await db.getConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: 'No such conversation.' });
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.delete('/chat/conversations/:id', async (req, res) => {
  try {
    res.json({ deleted: await db.deleteConversation(req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.use('/sales', salesRouter);

app.use('/api', api);

/* ------------------------------------------------------------ static site */

if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get('*', (_req, res) => res.sendFile(join(WEB_DIST, 'index.html')));
} else {
  app.get('/', (_req, res) => res.status(503).send('<h1>Frontend not built</h1><p>Run the Docker build.</p>'));
}

// Bring Postgres up before serving, then prefer its contents over the file.
if (db.isEnabled()) {
  await db.init();
  await store.hydrateFromPostgres();
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Agentic Procurement OS`);
  console.log(`  ──────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  workspace: ${store.workspace.meta.workspaceName}`);
  console.log(`  graph8 suppliers in index: ${store.graph8.suppliers.length}\n`);
});

// Mailpit's live-update websocket, passed through the same origin.
server.on('upgrade', mailProxy.upgrade);
