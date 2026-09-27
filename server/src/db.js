/**
 * Postgres persistence.
 *
 * Every workspace record lives in a real table with the fields you would
 * actually filter on promoted to columns, and the full record kept in a JSONB
 * `doc`. That combination is what makes the chat agent useful: it can run
 * genuine SQL over requirements, quotes and campaigns instead of being handed
 * a pre-baked summary.
 *
 * With no DATABASE_URL the app falls back to the JSON file store, so it still
 * runs standalone.
 */

import pg from 'pg';

const { Pool } = pg;
let pool = null;
let ready = false;

export function isEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!isEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
    });
    pool.on('error', (err) => console.warn('[db] idle client error:', err.message));
  }
  return pool;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requirements (
  id            text PRIMARY KEY,
  title         text,
  material_id   text,
  material_name text,
  category      text,
  site_id       text,
  site_name     text,
  quantity      numeric,
  uom           text,
  required_by   date,
  priority      text,
  status        text,
  raised_by     text,
  created_at    timestamptz DEFAULT now(),
  doc           jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS requirements_status_idx   ON requirements (status);
CREATE INDEX IF NOT EXISTS requirements_material_idx ON requirements (material_id);
CREATE INDEX IF NOT EXISTS requirements_required_idx ON requirements (required_by);

CREATE TABLE IF NOT EXISTS shortlists (
  requirement_id text NOT NULL,
  supplier_id    text NOT NULL,
  source         text,
  match_score    int,
  added_at       timestamptz DEFAULT now(),
  doc            jsonb NOT NULL,
  PRIMARY KEY (requirement_id, supplier_id)
);

CREATE TABLE IF NOT EXISTS rfqs (
  id             text PRIMARY KEY,
  requirement_id text,
  supplier_id    text,
  supplier_name  text,
  send_status    text,
  approved       boolean DEFAULT false,
  created_at     timestamptz DEFAULT now(),
  doc            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS rfqs_requirement_idx ON rfqs (requirement_id);

CREATE TABLE IF NOT EXISTS quotes (
  id             text PRIMARY KEY,
  requirement_id text,
  supplier_id    text,
  unit_price     numeric,
  currency       text,
  lead_time_days int,
  available_qty  numeric,
  provenance     text,
  created_at     timestamptz DEFAULT now(),
  doc            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS quotes_requirement_idx ON quotes (requirement_id);

CREATE TABLE IF NOT EXISTS decisions (
  id             text PRIMARY KEY,
  requirement_id text,
  action         text,
  actor          text,
  decided_at     timestamptz DEFAULT now(),
  doc            jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id             text PRIMARY KEY,
  kind           text,
  requirement_id text,
  status         text,
  started_at     timestamptz DEFAULT now(),
  doc            jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_tasks_req_idx ON agent_tasks (requirement_id);

CREATE TABLE IF NOT EXISTS activity (
  id         text PRIMARY KEY,
  type       text,
  actor      text,
  ref_id     text,
  provenance text,
  at         timestamptz DEFAULT now(),
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_at_idx ON activity (at DESC);

CREATE TABLE IF NOT EXISTS campaigns (
  id            text PRIMARY KEY,
  buyer_id      text,
  product_id    text,
  buyer_company text,
  verdict       text,
  score         int,
  send_status   text,
  created_at    timestamptz DEFAULT now(),
  doc           jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS deep_dives (
  cache_key  text PRIMARY KEY,
  entity     text,
  entity_id  text,
  company    text,
  skill_key  text,
  at         timestamptz DEFAULT now(),
  doc        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_pushes (
  id         text PRIMARY KEY,
  list_id    text,
  title      text,
  added      int,
  at         timestamptz DEFAULT now(),
  doc        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id         text PRIMARY KEY,
  role_id    text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  doc        jsonb NOT NULL
);

-- Single-row buckets for things that are genuinely one blob.
CREATE TABLE IF NOT EXISTS kv (
  k   text PRIMARY KEY,
  doc jsonb NOT NULL
);
`;

export async function init({ retries = 12 } = {}) {
  if (!isEnabled()) return false;
  const p = getPool();
  for (let i = 0; i < retries; i++) {
    try {
      await p.query(SCHEMA);
      ready = true;
      const { rows } = await p.query('SELECT count(*)::int AS n FROM requirements');
      console.log(`[db] postgres ready — ${rows[0].n} requirement(s) on record`);
      return true;
    } catch (err) {
      if (i === retries - 1) {
        console.warn('[db] could not initialise postgres, falling back to file store:', err.message);
        return false;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return false;
}

export function isReady() { return ready; }

/* ------------------------------------------------------------------ upserts */

const d = (v) => (v === undefined ? null : v);

export async function saveRequirement(r) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO requirements (id,title,material_id,material_name,category,site_id,site_name,quantity,uom,required_by,priority,status,raised_by,doc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET
       title=EXCLUDED.title, quantity=EXCLUDED.quantity, required_by=EXCLUDED.required_by,
       priority=EXCLUDED.priority, status=EXCLUDED.status, doc=EXCLUDED.doc`,
    [r.id, d(r.title), d(r.materialId), d(r.materialName), d(r.category), d(r.siteId), d(r.siteName),
      d(r.quantity), d(r.uom), d(r.requiredBy), d(r.priority), d(r.status), d(r.raisedBy), JSON.stringify(r)]
  );
}

export async function saveShortlist(requirementId, entry) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO shortlists (requirement_id,supplier_id,source,match_score,doc)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (requirement_id,supplier_id) DO UPDATE SET doc=EXCLUDED.doc, match_score=EXCLUDED.match_score`,
    [requirementId, entry.supplierId, d(entry.source), d(entry.matchScore), JSON.stringify(entry)]
  );
}

export async function deleteShortlist(requirementId, supplierId) {
  if (!ready) return;
  await getPool().query('DELETE FROM shortlists WHERE requirement_id=$1 AND supplier_id=$2', [requirementId, supplierId]);
}

export async function saveRfq(x) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO rfqs (id,requirement_id,supplier_id,supplier_name,send_status,approved,doc)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET send_status=EXCLUDED.send_status, approved=EXCLUDED.approved, doc=EXCLUDED.doc`,
    [x.id, d(x.requirementId), d(x.supplierId), d(x.supplierName), d(x.sendStatus), Boolean(x.approved), JSON.stringify(x)]
  );
}

export async function saveQuote(q) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO quotes (id,requirement_id,supplier_id,unit_price,currency,lead_time_days,available_qty,provenance,doc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc`,
    [q.id, d(q.requirementId), d(q.supplierId), d(q.unitPrice), d(q.currency), d(q.leadTimeDays),
      d(q.availableQty), d(q.provenance), JSON.stringify(q)]
  );
}

export async function deleteQuote(id) {
  if (!ready) return;
  await getPool().query('DELETE FROM quotes WHERE id=$1', [id]);
}

export async function saveDecision(x) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO decisions (id,requirement_id,action,actor,doc) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc`,
    [x.id, d(x.requirementId), d(x.action), d(x.actor), JSON.stringify(x)]
  );
}

export async function saveTask(t) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO agent_tasks (id,kind,requirement_id,status,doc) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, doc=EXCLUDED.doc`,
    [t.id, d(t.kind), d(t.requirementId), d(t.status), JSON.stringify(t)]
  );
}

export async function saveActivity(a) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO activity (id,type,actor,ref_id,provenance,at,doc) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [a.id, d(a.type), d(a.actor), d(a.refId), d(a.provenance), a.at || new Date().toISOString(), JSON.stringify(a)]
  );
}

export async function saveCampaign(c) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO campaigns (id,buyer_id,product_id,buyer_company,verdict,score,send_status,doc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET verdict=EXCLUDED.verdict, score=EXCLUDED.score,
       send_status=EXCLUDED.send_status, doc=EXCLUDED.doc`,
    [c.id, d(c.buyerId), d(c.productId), d(c.buyerCompany), d(c.verdict), d(c.score), d(c.sendStatus), JSON.stringify(c)]
  );
}

export async function saveDeepDive(cacheKey, r) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO deep_dives (cache_key,entity,entity_id,company,skill_key,doc) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (cache_key) DO UPDATE SET doc=EXCLUDED.doc, at=now()`,
    [cacheKey, d(r.entity), d(r.entityId), d(r.company), d(r.skillKey), JSON.stringify(r)]
  );
}

export async function saveCrmPush(p) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO crm_pushes (id,list_id,title,added,doc) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO NOTHING`,
    [p.id, String(d(p.listId)), d(p.title), d(p.added), JSON.stringify(p)]
  );
}

export async function saveConversation(c) {
  if (!ready) return;
  await getPool().query(
    `INSERT INTO conversations (id,role_id,doc) VALUES ($1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`,
    [c.id, d(c.roleId), JSON.stringify(c)]
  );
}

/** Recent conversations for the chat history list. The doc holds the whole
    transcript; this returns just enough to render the picker. */
export async function listConversations({ roleId, limit = 25 } = {}) {
  if (!ready) return [];
  const rows = roleId
    ? await getPool().query(
        'SELECT id, role_id, created_at, updated_at, doc FROM conversations WHERE role_id = $1 ORDER BY updated_at DESC LIMIT $2',
        [roleId, limit])
    : await getPool().query(
        'SELECT id, role_id, created_at, updated_at, doc FROM conversations ORDER BY updated_at DESC LIMIT $1',
        [limit]);
  return rows.rows.map((r) => ({
    id: r.id,
    roleId: r.role_id,
    title: r.doc?.title || 'Untitled',
    messageCount: (r.doc?.messages || []).length,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getConversation(id) {
  if (!ready) return null;
  const r = await getPool().query('SELECT doc FROM conversations WHERE id = $1', [id]);
  return r.rows[0]?.doc || null;
}

export async function deleteConversation(id) {
  if (!ready) return false;
  const r = await getPool().query('DELETE FROM conversations WHERE id = $1', [id]);
  return r.rowCount > 0;
}

export async function saveKv(k, doc) {
  if (!ready) return;
  await getPool().query(
    'INSERT INTO kv (k,doc) VALUES ($1,$2) ON CONFLICT (k) DO UPDATE SET doc=EXCLUDED.doc',
    [k, JSON.stringify(doc)]
  );
}

/* ------------------------------------------------------------------- loads */

export async function loadAll() {
  if (!ready) return null;
  const p = getPool();
  const q = async (sql) => (await p.query(sql)).rows.map((r) => r.doc);

  const [requirements, rfqs, quotes, decisions, agentTasks, activity, campaigns, crmPushes] = await Promise.all([
    q('SELECT doc FROM requirements ORDER BY created_at'),
    q('SELECT doc FROM rfqs ORDER BY created_at'),
    q('SELECT doc FROM quotes ORDER BY created_at'),
    q('SELECT doc FROM decisions ORDER BY decided_at'),
    q('SELECT doc FROM agent_tasks ORDER BY started_at DESC'),
    q('SELECT doc FROM activity ORDER BY at DESC LIMIT 400'),
    q('SELECT doc FROM campaigns ORDER BY created_at'),
    q('SELECT doc FROM crm_pushes ORDER BY at DESC'),
  ]);

  const slRows = (await p.query('SELECT requirement_id, doc FROM shortlists ORDER BY added_at')).rows;
  const shortlists = {};
  slRows.forEach((r) => {
    (shortlists[r.requirement_id] ||= []).push(r.doc);
  });

  const ddRows = (await p.query('SELECT cache_key, doc FROM deep_dives')).rows;
  const deepDives = {};
  ddRows.forEach((r) => { deepDives[r.cache_key] = r.doc; });

  const kvRows = (await p.query("SELECT k, doc FROM kv")).rows;
  const kv = {};
  kvRows.forEach((r) => { kv[r.k] = r.doc; });

  return { requirements, rfqs, quotes, decisions, agentTasks, activity, campaigns, crmPushes, shortlists, deepDives, kv };
}

export async function truncateAll() {
  if (!ready) return;
  await getPool().query(`TRUNCATE requirements, shortlists, rfqs, quotes, decisions,
    agent_tasks, activity, campaigns, deep_dives, crm_pushes, conversations, kv`);
}

/* --------------------------------------------------------------- agent SQL */

const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|vacuum)\b/i;

/**
 * Read-only SQL for the chat agent.
 *
 * Single statement, SELECT or WITH only, no write keywords, hard row cap, and a
 * statement timeout. The agent gets real query power over real tables without
 * being able to damage anything.
 */
export async function agentQuery(sql, { limit = 200, timeoutMs = 5000 } = {}) {
  if (!ready) throw new Error('Postgres is not connected.');
  const trimmed = String(sql).trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) throw new Error('One statement at a time.');
  if (!/^(select|with)\b/i.test(trimmed)) throw new Error('Only SELECT or WITH queries are allowed.');
  if (FORBIDDEN.test(trimmed)) throw new Error('That query contains a write or DDL keyword.');

  const client = await getPool().connect();
  try {
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);
    const wrapped = `SELECT * FROM (${trimmed}) AS agent_q LIMIT ${Number(limit)}`;
    const res = await client.query(wrapped);
    return { rows: res.rows, rowCount: res.rowCount, fields: res.fields.map((f) => f.name) };
  } finally {
    client.release();
  }
}

export const SCHEMA_SUMMARY = `
requirements(id, title, material_id, material_name, category, site_id, site_name,
             quantity, uom, required_by, priority, status, raised_by, created_at, doc)
shortlists(requirement_id, supplier_id, source, match_score, added_at, doc)
rfqs(id, requirement_id, supplier_id, supplier_name, send_status, approved, created_at, doc)
quotes(id, requirement_id, supplier_id, unit_price, currency, lead_time_days,
       available_qty, provenance, created_at, doc)
decisions(id, requirement_id, action, actor, decided_at, doc)
agent_tasks(id, kind, requirement_id, status, started_at, doc)
activity(id, type, actor, ref_id, provenance, at, doc)
campaigns(id, buyer_id, product_id, buyer_company, verdict, score, send_status, created_at, doc)
deep_dives(cache_key, entity, entity_id, company, skill_key, at, doc)
crm_pushes(id, list_id, title, added, at, doc)

Every table keeps the full record in the jsonb column "doc", so fields not
promoted to a column are still reachable, e.g. doc->>'specification'.

NOT IN POSTGRES — do not write SQL against these, use the tools instead:
  material catalogue and sites  -> list_materials, list_sites
  stock levels and projections  -> inventory_projection
  suppliers and buyers          -> discover_suppliers, find_buyers
These are reference data held outside the database.
requirement status values: submitted, researching, awaiting_review, needs_info,
rfq_prepared, awaiting_quotes, quotes_in, approved, rejected, revision_requested.
`.trim();
