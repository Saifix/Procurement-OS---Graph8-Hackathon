/**
 * Sell-side routes: discover buyers, qualify them with graph8, draft and send
 * outreach, and push the qualified list back into the graph8 CRM.
 */

import express from 'express';
import { store } from '../store.js';
import { discoverBuyers, qualifyOrDraft, sendOutreach } from '../domain/sales.js';
import { isConfigured, SKILLS } from '../domain/graph8Skill.js';

export const salesRouter = express.Router();
const S = () => store.state;

salesRouter.get('/products', (_req, res) =>
  res.json({ products: store.market.products, meta: store.market.meta })
);

salesRouter.get('/buyers', (req, res) => {
  const product = store.product(req.query.productId) || store.market.products[0];
  const discovery = discoverBuyers({ product, buyers: store.market.buyers, channel: req.query.channel });
  const campaigns = S().campaigns;
  res.json({
    product,
    ...discovery,
    results: discovery.results.map((r) => ({
      ...r,
      campaign: campaigns.find((c) => c.buyerId === r.buyer.id && c.productId === product.id) || null,
    })),
    channels: [...new Set(store.market.buyers.flatMap((b) => b.channelTags || []))].sort(),
    engine: isConfigured() ? 'graph8' : 'local',
  });
});

/**
 * Qualify buyers and draft their outreach.
 *
 * Runs them in parallel — each graph8 call is 15-25s, so doing three in series
 * would be a minute of dead air.
 */
salesRouter.post('/qualify', async (req, res) => {
  const product = store.product(req.body?.productId) || store.market.products[0];
  const ids = req.body?.buyerIds || [];
  if (!ids.length) return res.status(400).json({ error: 'Pass buyerIds to qualify.' });

  const results = await Promise.all(
    ids.map(async (id) => {
      const buyer = store.buyer(id);
      if (!buyer) return null;
      const drafted = await qualifyOrDraft({ buyer, product });

      const existing = S().campaigns.find((c) => c.buyerId === id && c.productId === product.id);
      const row = existing || {
        id: store.nextId('camp', 'CAMP'),
        buyerId: id,
        productId: product.id,
        createdAt: new Date().toISOString(),
      };

      Object.assign(row, {
        buyerCompany: buyer.company,
        productName: product.name,
        verdict: drafted.verdict,
        score: drafted.score,
        channelFit: drafted.channelFit,
        reasons: drafted.reasons || [],
        risks: drafted.risks || [],
        hook: drafted.hook,
        subject: drafted.subject,
        body: drafted.body,
        followUp: drafted.followUp,
        engine: drafted.meta?.engine === 'local' ? 'local' : 'graph8',
        meta: drafted.meta || null,
        fallbackReason: drafted.fallbackReason || null,
        status: row.status && row.status !== 'draft' ? row.status : 'draft',
        qualifiedAt: new Date().toISOString(),
      });

      if (!existing) S().campaigns.push(row);
      return row;
    })
  );

  const rows = results.filter(Boolean);
  store.logActivity({
    type: 'sales',
    message: `${rows.length} buyer(s) qualified for ${product.name} by ${rows[0]?.engine === 'graph8' ? 'the graph8 Buyer Outreach Agent' : 'the local engine'}`,
    actor: 'agent',
    provenance: 'live',
  });
  store.persist();
  res.json({ campaigns: rows, product });
});

salesRouter.get('/campaigns', (_req, res) => {
  const rows = S().campaigns.map((c) => ({ ...c, buyer: store.buyer(c.buyerId) }));
  const sent = rows.filter((r) => r.sendStatus === 'sent').length;
  res.json({
    total: rows.length,
    sent,
    replied: rows.filter((r) => r.replied).length,
    campaigns: rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
  });
});

salesRouter.patch('/campaigns/:id', (req, res) => {
  const row = store.campaign(req.params.id);
  if (!row) return res.status(404).json({ error: 'Campaign row not found' });
  if (req.body?.subject !== undefined) row.subject = req.body.subject;
  if (req.body?.body !== undefined) row.body = req.body.body;
  store.persist();
  res.json({ campaign: row });
});

salesRouter.post('/campaigns/:id/send', async (req, res) => {
  const row = store.campaign(req.params.id);
  if (!row) return res.status(404).json({ error: 'Campaign row not found' });
  const buyer = store.buyer(row.buyerId);

  row.approved = true;
  row.approvedAt = new Date().toISOString();
  const result = await sendOutreach({ campaignRow: row, buyer });
  Object.assign(row, result);
  row.status = result.sendStatus === 'sent' ? 'sent' : result.sendStatus;

  store.logActivity({
    type: 'sales',
    message: result.sendStatus === 'sent'
      ? `Outreach delivered to ${buyer.company} at ${result.to}`
      : `Outreach to ${buyer.company} — ${result.sendStatus}`,
    actor: 'sales',
    provenance: 'live',
  });
  store.persist();
  res.json({ campaign: row });
});

/**
 * Push qualified buyers into the graph8 CRM as a real list.
 *
 * This is the point where the app stops treating graph8 as a read-only index:
 * the buyers it surfaced come back as CRM records the user can work in graph8's
 * own UI, sequence from, or hand to a rep.
 */
salesRouter.post('/crm-push', async (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ error: 'No GRAPH8_API_KEY configured, so nothing can be written to the graph8 CRM.' });
  }

  const product = store.product(req.body?.productId) || store.market.products[0];
  const rows = S().campaigns.filter((c) => c.productId === product.id && c.verdict !== 'weak');
  if (!rows.length) return res.status(400).json({ error: 'Qualify at least one buyer first. Weak-verdict buyers are not pushed.' });

  const base = (process.env.GRAPH8_API_BASE || 'https://be.graph8.com/api/v1').replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${process.env.GRAPH8_API_KEY}`, 'Content-Type': 'application/json' };
  const title = `${product.name} — qualified buyers (${new Date().toISOString().slice(0, 10)})`;

  try {
    const listRes = await fetch(`${base}/lists`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, type: 'contacts' }),
      signal: AbortSignal.timeout(15_000),
    });
    const listBody = await listRes.json().catch(() => ({}));
    if (!listRes.ok) throw new Error(`list create returned ${listRes.status}: ${JSON.stringify(listBody).slice(0, 180)}`);

    const listId = listBody.data?.id ?? listBody.id ?? listBody.list_id;

    const added = [];
    const skipped = [];
    for (const row of rows) {
      const b = store.buyer(row.buyerId);
      const c = b?.contact || {};
      if (!c.hasWorkEmail) { skipped.push({ company: b?.company, why: 'no work email on the graph8 record' }); continue; }
      try {
        const payload = {
          first_name: c.firstName,
          last_name: c.lastName,
          job_title: c.jobTitle,
          company_domain: b.domain,
          seniority_level: c.seniority,
          linkedin_url: c.linkedinUrl,
          country: b.country,
          state: b.state,
          list_id: listId,
        };
        const r = await fetch(`${base}/contacts`, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000) });
        const body = await r.json().catch(() => ({}));
        if (r.ok) added.push({ company: b.company, contactId: body.data?.id ?? body.id ?? null });
        else skipped.push({ company: b.company, why: `contact create returned ${r.status}` });
      } catch (err) {
        skipped.push({ company: b?.company, why: err.message });
      }
    }

    const push = {
      id: store.nextId('push', 'PUSH'),
      at: new Date().toISOString(),
      listId, title, productId: product.id,
      added: added.length, skipped: skipped.length,
      detail: { added, skipped },
      appUrl: 'https://app.graph8.com/lists',
    };
    S().crmPushes.unshift(push);
    store.logActivity({
      type: 'sales',
      message: `Pushed ${added.length} qualified buyer(s) into the graph8 CRM as list "${title}"`,
      actor: 'sales',
      provenance: 'live',
    });
    store.persist();
    res.json({ push });
  } catch (err) {
    res.status(502).json({ error: `graph8 CRM write failed: ${err.message}` });
  }
});

salesRouter.get('/crm-pushes', (_req, res) => res.json({ pushes: S().crmPushes }));

salesRouter.get('/status', (_req, res) => {
  const rows = S().campaigns;
  res.json({
    engine: isConfigured() ? 'graph8' : 'local',
    skill: SKILLS.buyerOutreach,
    buyersInIndex: store.market.buyers.length,
    products: store.market.products.length,
    qualified: rows.length,
    strong: rows.filter((r) => r.verdict === 'strong').length,
    sent: rows.filter((r) => r.sendStatus === 'sent').length,
    pushes: S().crmPushes.length,
  });
});
