/**
 * Workspace store.
 *
 * Reference data (materials, BOM, roles, graph8 suppliers) is loaded from the
 * seed files. Everything a user creates or edits lives in `state` and is
 * persisted to disk so a requirement raised before a coffee break is still
 * there afterwards.
 *
 * Writes are atomic (temp file + rename) because a half-written JSON file on
 * a demo machine is a very bad morning.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import * as db from './db.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const STATE_DIR = process.env.STATE_DIR || join(__dirname, '..', 'state');
const STATE_FILE = join(STATE_DIR, 'workspace-state.json');

const workspace = JSON.parse(readFileSync(join(DATA_DIR, 'workspace.json'), 'utf-8'));
const graph8 = JSON.parse(readFileSync(join(DATA_DIR, 'graph8-suppliers.json'), 'utf-8'));
const market = JSON.parse(readFileSync(join(DATA_DIR, 'graph8-buyers.json'), 'utf-8'));

function emptyState() {
  return {
    requirements: [],
    shortlists: {},     // requirementId -> [{ supplierId, source, reason, addedAt }]
    rfqs: [],
    quotes: [],
    decisions: [],
    agentTasks: [],
    activity: [],
    // Sell side: qualified buyers and the outreach sent to them.
    campaigns: [],
    crmPushes: [],
    deepDives: {},   // `${entity}:${id}:${skill}` -> report
    // Editable copies of the illustrative planning inputs.
    planning: {
      unitsPerDay: workspace.productionPlan.unitsPerDay,
      horizonDays: workspace.productionPlan.horizonDays,
      inventory: workspace.inventory.map((r) => ({ ...r })),
      receipts: workspace.expectedReceipts.map((r) => ({ ...r })),
      bom: workspace.products[0].bom.map((r) => ({ ...r })),
      materials: workspace.materials.map((m) => ({ ...m })),
      holdingCostPctPerMonth: workspace.assumptions.holdingCostPctPerMonth,
    },
    seq: { req: 0, rfq: 0, quote: 0, task: 0, act: 0, dec: 0 },
    createdAt: new Date().toISOString(),
  };
}

let state = emptyState();

function load() {
  try {
    if (existsSync(STATE_FILE)) {
      const disk = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      // Merge so a seed change adds new fields without wiping user records.
      state = { ...emptyState(), ...disk, planning: { ...emptyState().planning, ...(disk.planning || {}) } };
      console.log(`[store] restored ${state.requirements.length} requirement(s) from disk`);
    }
  } catch (err) {
    console.warn('[store] could not restore state, starting fresh:', err.message);
    state = emptyState();
  }
}

/**
 * Full write-through sync to Postgres.
 *
 * Upserting every collection on each persist is more work than strictly
 * needed, but at these volumes it costs nothing and removes a whole class of
 * "which rows changed?" bugs. The in-memory state stays the working copy.
 */
async function syncToPostgres() {
  if (!db.isReady()) return;
  try {
    await Promise.all([
      ...state.requirements.map((r) => db.saveRequirement(r)),
      ...state.rfqs.map((x) => db.saveRfq(x)),
      ...state.quotes.map((q) => db.saveQuote(q)),
      ...state.decisions.map((x) => db.saveDecision(x)),
      ...state.agentTasks.slice(0, 80).map((t) => db.saveTask(t)),
      ...state.activity.slice(0, 120).map((a) => db.saveActivity(a)),
      ...(state.campaigns || []).map((c) => db.saveCampaign(c)),
      ...(state.crmPushes || []).map((x) => db.saveCrmPush(x)),
      ...Object.entries(state.shortlists).flatMap(([reqId, list]) =>
        list.map((entry) => db.saveShortlist(reqId, entry))),
      ...Object.entries(state.deepDives || {}).map(([k, r]) => db.saveDeepDive(k, r)),
      db.saveKv('planning', state.planning),
      db.saveKv('seq', state.seq),
    ]);
  } catch (err) {
    console.warn('[store] postgres sync failed:', err.message);
  }
}

let writeTimer = null;
function persist() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      const tmp = `${STATE_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2));
      renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.warn('[store] file persist failed:', err.message);
    }
    syncToPostgres();
  }, 150);
}

/** Called once at boot, after db.init(), so Postgres wins over the file. */
async function hydrateFromPostgres() {
  if (!db.isReady()) return false;
  try {
    const loaded = await db.loadAll();
    if (!loaded) return false;
    const hasRecords = loaded.requirements.length || loaded.campaigns.length;
    if (!hasRecords) {
      // Empty database: push whatever the file store had so nothing is lost.
      await syncToPostgres();
      return false;
    }
    state.requirements = loaded.requirements;
    state.rfqs = loaded.rfqs;
    state.quotes = loaded.quotes;
    state.decisions = loaded.decisions;
    state.agentTasks = loaded.agentTasks;
    state.activity = loaded.activity;
    state.campaigns = loaded.campaigns;
    state.crmPushes = loaded.crmPushes;
    state.shortlists = loaded.shortlists;
    state.deepDives = loaded.deepDives;
    if (loaded.kv.planning) state.planning = { ...state.planning, ...loaded.kv.planning };
    if (loaded.kv.seq) state.seq = { ...state.seq, ...loaded.kv.seq };
    console.log(`[store] hydrated from postgres — ${state.requirements.length} requirement(s), ${state.campaigns.length} campaign(s)`);
    return true;
  } catch (err) {
    console.warn('[store] postgres hydrate failed:', err.message);
    return false;
  }
}

function nextId(kind, prefix) {
  state.seq[kind] = (state.seq[kind] || 0) + 1;
  persist();
  return `${prefix}_${String(state.seq[kind]).padStart(4, '0')}`;
}

function logActivity({ type, message, actor = 'system', refId = null, provenance = 'live' }) {
  const entry = {
    id: nextId('act', 'act'),
    type, message, actor, refId, provenance,
    at: new Date().toISOString(),
  };
  state.activity.unshift(entry);
  if (state.activity.length > 400) state.activity.pop();
  persist();
  return entry;
}

function reset() {
  state = emptyState();
  if (db.isReady()) db.truncateAll().catch((e) => console.warn('[store] truncate failed:', e.message));
  persist();
}

load();

export const store = {
  get state() { return state; },
  workspace,
  graph8,
  market,
  nextId,
  logActivity,
  persist,
  reset,
  hydrateFromPostgres,
  syncToPostgres,

  material: (id) => state.planning.materials.find((m) => m.id === id),
  site: (id) => workspace.sites.find((s) => s.id === id),
  role: (id) => workspace.roles.find((r) => r.id === id),
  requirement: (id) => state.requirements.find((r) => r.id === id),
  rfq: (id) => state.rfqs.find((r) => r.id === id),
  quotesFor: (requirementId) => state.quotes.filter((q) => q.requirementId === requirementId),
  rfqsFor: (requirementId) => state.rfqs.filter((r) => r.requirementId === requirementId),
  shortlistFor: (requirementId) => state.shortlists[requirementId] || [],
  tasksFor: (requirementId) => state.agentTasks.filter((t) => t.requirementId === requirementId),

  /** Every supplier the workspace knows about, from all three sources. */
  allSuppliers() {
    const g8 = graph8.suppliers.map((s) => ({ ...s, source: 'graph8' }));
    const dir = workspace.directorySuppliers.map((s) => ({ ...s, source: 'directory' }));
    const added = (state.userSuppliers || []).map((s) => ({ ...s, source: 'user_added' }));
    return [...g8, ...dir, ...added];
  },

  supplier(id) {
    return this.allSuppliers().find((s) => s.id === id) || null;
  },

  buyer: (id) => market.buyers.find((b) => b.id === id) || null,
  product: (id) => market.products.find((p) => p.id === id) || null,
  campaign: (id) => state.campaigns.find((c) => c.id === id) || null,
};
