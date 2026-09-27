import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, CardHead, Badge, Callout, Prov, useAsync, Skeleton, Empty, fmt } from '../components/ui.jsx';
import DeepDive from '../components/DeepDive.jsx';

const VERDICT = { strong: 'green', possible: 'amber', weak: 'red' };
const SEND = { sent: 'green', failed: 'red', not_configured: 'amber', draft: 'neutral' };

/**
 * Sell side. The procurement pages ask who can supply us; this asks who buys
 * what we make — which is the question graph8's contact index was built for.
 */
export default function Sales() {
  const products = useAsync(() => api.salesProducts(), []);
  const [productId, setProductId] = useState(null);
  const [channel, setChannel] = useState('');
  const pid = productId || products.data?.products?.[0]?.id;

  const market = useAsync(() => (pid ? api.salesBuyers({ productId: pid, channel }) : Promise.resolve(null)), [pid, channel]);
  const campaigns = useAsync(() => api.salesCampaigns(), []);
  const pushes = useAsync(() => api.crmPushes(), []);

  const [busy, setBusy] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [edit, setEdit] = useState(null);
  const [pushResult, setPushResult] = useState(null);
  const [error, setError] = useState(null);

  const product = market.data?.product;
  const rows = market.data?.results || [];
  const engine = market.data?.engine;

  const reloadAll = async () => { await market.reload(); await campaigns.reload(); };

  const qualify = (ids) => run(`q-${ids.join(',')}`, async () => {
    await api.salesQualify(pid, ids);
    await reloadAll();
  });

  const run = async (key, fn) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(null); }
  };

  const send = (campaignId) => run(`s-${campaignId}`, async () => {
    if (edit?.id === campaignId) await api.salesUpdateCampaign(campaignId, { subject: edit.subject, body: edit.body });
    await api.salesSend(campaignId);
    setEdit(null);
    await reloadAll();
  });

  const push = () => run('push', async () => {
    const r = await api.crmPush(pid);
    setPushResult(r.push);
    await pushes.reload();
  });

  const open = rows.find((r) => r.buyer.id === openId)?.campaign || null;
  const unqualified = rows.filter((r) => !r.campaign);
  const qualified = rows.filter((r) => r.campaign);

  if (products.loading) return <Page title="Sell what we make"><Card><Skeleton h={240} /></Card></Page>;

  return (
    <Page
      title="Sell what we make"
      sub="The procurement side asks who can supply us. This asks who buys what we manufacture — the question graph8's contact index was built for."
      right={<Badge tone={engine === 'graph8' ? 'green' : 'neutral'} dot>{engine === 'graph8' ? 'graph8 Buyer Outreach Agent' : 'local engine'}</Badge>}
    >
      <Card flat>
        <div className="row wrap" style={{ gap: 14 }}>
          <div className="field" style={{ minWidth: 260 }}>
            <label className="label" htmlFor="prod">Product</label>
            <select id="prod" className="select" value={pid || ''} onChange={(e) => { setProductId(e.target.value); setOpenId(null); }}>
              {products.data?.products?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 220 }}>
            <label className="label" htmlFor="ch">Channel</label>
            <select id="ch" className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">All channels</option>
              {market.data?.channels?.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          {unqualified.length > 0 && (
            <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }}
              onClick={() => qualify(unqualified.slice(0, 3).map((r) => r.buyer.id))}
              disabled={Boolean(busy)}>
              {busy?.startsWith('q-') ? 'Researching…' : `Qualify top ${Math.min(3, unqualified.length)} with graph8`}
            </button>
          )}
        </div>
      </Card>

      {product && (
        <div className="grid grid-4 mt">
          <Card><div className="stat-label">Buyers in index</div><div className="stat-value" style={{ fontSize: 24 }}>{rows.length}</div><div className="stat-hint">from graph8 discovery</div></Card>
          <Card><div className="stat-label">Qualified</div><div className="stat-value" style={{ fontSize: 24 }}>{qualified.length}</div><div className="stat-hint">{qualified.filter((r) => r.campaign.verdict === 'strong').length} strong</div></Card>
          <Card><div className="stat-label">Outreach sent</div><div className="stat-value" style={{ fontSize: 24 }}>{campaigns.data?.sent ?? 0}</div><div className="stat-hint">over SMTP</div></Card>
          <Card><div className="stat-label">Pushed to graph8 CRM</div><div className="stat-value" style={{ fontSize: 24 }}>{pushes.data?.pushes?.length ?? 0}</div><div className="stat-hint">lists created</div></Card>
        </div>
      )}

      {error && <div className="mt"><Callout tone="red" icon="✕">{error}</Callout></div>}

      {pushResult && (
        <div className="mt">
          <Callout tone="green" icon="✓">
            <strong>Pushed to graph8.</strong> Created list <strong>{pushResult.title}</strong> (id {pushResult.listId})
            with {pushResult.added} contact{pushResult.added === 1 ? '' : 's'}
            {pushResult.skipped > 0 && `, ${pushResult.skipped} skipped`}.{' '}
            <a href={pushResult.appUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Open it in graph8</a>.
          </Callout>
        </div>
      )}

      <div className="grid grid-side mt-lg">
        <div className="col" style={{ gap: 14 }}>
          {market.loading && <Card><Skeleton h={200} /></Card>}

          {!market.loading && rows.length === 0 && <Card><Empty title="No buyers">Nothing matches that channel filter.</Empty></Card>}

          {rows.map((r, i) => {
            const b = r.buyer;
            const c = r.campaign;
            const contact = b.contact || {};
            return (
              <motion.div key={b.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * .04, .3) }}>
                <Card>
                  <div className="row-between" style={{ alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 9 }}>
                        <span className="strong">{b.company}</span>
                        <Badge tone="green" dot>graph8 result</Badge>
                        {c && <Badge tone={VERDICT[c.verdict] || 'neutral'} dot>{c.verdict} {c.score}</Badge>}
                        {c?.sendStatus && <Badge tone={SEND[c.sendStatus] || 'neutral'} dot>{c.sendStatus.replace('_', ' ')}</Badge>}
                      </div>
                      <div className="xs faint mono" style={{ marginTop: 2 }}>{b.domain}</div>
                      <div className="xs faint">
                        {[b.industry, b.employeeCount, [b.state, b.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                      </div>
                      <div className="xs faint" style={{ marginTop: 3 }}>
                        {contact.firstName} {contact.lastName} — {contact.jobTitle}
                        {typeof contact.confidenceScore === 'number' && ` · confidence ${contact.confidenceScore}`}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <Badge tone={r.match.score >= 60 ? 'green' : r.match.score >= 35 ? 'amber' : 'neutral'}>match {r.match.score}</Badge>
                      {!c ? (
                        <button className="btn btn-sm btn-primary" onClick={() => qualify([b.id])} disabled={Boolean(busy)}>
                          {busy === `q-${b.id}` ? '…' : 'Qualify'}
                        </button>
                      ) : (
                        <button className="btn btn-sm" onClick={() => { setOpenId(openId === b.id ? null : b.id); setEdit(null); }}>
                          {openId === b.id ? 'Hide' : 'Open email'}
                        </button>
                      )}
                    </div>
                  </div>

                  {c && (
                    <div className="mt">
                      <Callout tone={VERDICT[c.verdict] === 'red' ? 'red' : VERDICT[c.verdict] === 'green' ? 'green' : 'amber'}
                        icon={c.verdict === 'strong' ? '✓' : c.verdict === 'weak' ? '⚠' : 'ℹ'}>
                        <strong>{c.channelFit}.</strong> {c.hook}
                        {c.meta?.webSearches > 0 && (
                          <div className="xs" style={{ marginTop: 6, opacity: .75 }}>
                            {c.meta.webSearches} web search · {c.meta.model} · {(c.meta.durationMs / 1000).toFixed(0)}s · ${(c.meta.costUsd || 0).toFixed(4)}
                          </div>
                        )}
                      </Callout>
                      {c.risks?.length > 0 && (
                        <div className="xs mt" style={{ color: 'var(--amber)' }}>
                          {c.risks.slice(0, 2).map((x, j) => <div key={j}>• {x}</div>)}
                        </div>
                      )}
                    </div>
                  )}

                  <DeepDive entity="buyer" id={b.id} company={b.company} />

                  <AnimatePresence>
                    {openId === b.id && c && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                        style={{ overflow: 'hidden' }}>
                        <div className="divider" />
                        <div className="field">
                          <label className="label">Subject</label>
                          <input className="input" value={edit?.id === c.id ? edit.subject : c.subject}
                            onChange={(e) => setEdit({ id: c.id, subject: e.target.value, body: edit?.id === c.id ? edit.body : c.body })} />
                        </div>
                        <div className="field mt">
                          <label className="label">Message · written by {c.engine === 'graph8' ? 'the graph8 agent' : 'the local engine'}</label>
                          <textarea className="textarea textarea-mono" style={{ minHeight: 210 }}
                            value={edit?.id === c.id ? edit.body : c.body}
                            onChange={(e) => setEdit({ id: c.id, subject: edit?.id === c.id ? edit.subject : c.subject, body: e.target.value })} />
                        </div>
                        {c.sendDetail && (
                          <div className="mt">
                            <Callout tone={c.sendStatus === 'sent' ? 'green' : 'amber'} icon={c.sendStatus === 'sent' ? '✓' : '⚠'}>
                              <strong>{c.sendStatus === 'sent' ? 'Sent.' : `Status: ${c.sendStatus}.`}</strong> {c.sendDetail}
                            </Callout>
                          </div>
                        )}
                        <div className="row mt" style={{ gap: 10 }}>
                          <button className="btn btn-primary" onClick={() => send(c.id)} disabled={busy === `s-${c.id}`}>
                            {busy === `s-${c.id}` ? 'Sending…' : c.sendStatus === 'sent' ? 'Send again' : 'Approve and send'}
                          </button>
                          <button className="btn" onClick={() => qualify([b.id])} disabled={Boolean(busy)}>Rewrite with graph8</button>
                          <span className="xs faint">{c.followUp}</span>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </Card>
              </motion.div>
            );
          })}
        </div>

        <div className="col" style={{ gap: 14 }}>
          {product && (
            <Card>
              <CardHead title="What we're selling" right={<Prov kind="demo" />} />
              <div className="col" style={{ gap: 0 }}>
                <div className="kv"><span className="kv-k">Product</span><span className="kv-v">{product.name}</span></div>
                <div className="kv"><span className="kv-k">Pack</span><span className="kv-v">{product.pack}</span></div>
                <div className="kv"><span className="kv-k">Capacity</span><span className="kv-v" style={{ textAlign: 'right' }}>{product.capacity}</span></div>
                <div className="kv"><span className="kv-k">Lead time</span><span className="kv-v">{product.leadTime}</span></div>
                <div className="kv"><span className="kv-k">Certifications</span><span className="kv-v">{product.certifications}</span></div>
              </div>
              <div className="divider" />
              <div className="xs faint">{product.differentiators}</div>
            </Card>
          )}

          <Card>
            <CardHead title="Push to graph8 CRM" note="Qualified buyers become a real list in your graph8 account" right={<Prov kind="live" />} />
            <p className="sm muted">
              Writes the non-weak buyers into graph8 as contacts on a new list, so a rep can work them in
              graph8's own UI or drop them into a sequence.
            </p>
            <div className="row mt" style={{ gap: 10 }}>
              <button className="btn btn-primary" onClick={push} disabled={Boolean(busy) || qualified.length === 0}>
                {busy === 'push' ? 'Pushing…' : 'Push qualified buyers'}
              </button>
            </div>
            {pushes.data?.pushes?.length > 0 && (
              <>
                <div className="divider" />
                <div className="col" style={{ gap: 8 }}>
                  {pushes.data.pushes.slice(0, 4).map((p) => (
                    <div key={p.id}>
                      <div className="sm strong">list {p.listId} · {p.added} contact{p.added === 1 ? '' : 's'}</div>
                      <div className="xs faint">{new Date(p.at).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>

          <Callout icon="ℹ">
            A graph8 result means the company exists and someone works there. It does <strong>not</strong> mean
            they buy this product or want to be contacted. Nothing here claims a buying signal that has not
            been established.
          </Callout>
        </div>
      </div>
    </Page>
  );
}
