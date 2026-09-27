import React, { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api.js';
import {
  Page, Card, CardHead, Badge, Callout, Prov, StatusBadge, PriorityBadge,
  useAsync, Skeleton, Empty, KV, fmt,
} from '../components/ui.jsx';
import DeepDive from '../components/DeepDive.jsx';

/* The six spec sections 4.4–4.9 are one continuous piece of work on a single
   requirement, so they live as steps on one screen rather than six pages you
   have to navigate between and lose context. */
const STEPS = [
  { id: 'review', label: 'Review' },
  { id: 'discovery', label: 'Supplier discovery' },
  { id: 'rfq', label: 'RFQ' },
  { id: 'quotes', label: 'Quotations' },
  { id: 'compare', label: 'Comparison' },
  { id: 'approval', label: 'Approval' },
];

const SOURCE_BADGE = {
  graph8: { tone: 'green', label: 'graph8 result' },
  directory: { tone: 'accent', label: 'existing supplier' },
  user_added: { tone: 'violet', label: 'user added' },
};

export default function RequirementDetail({ role }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data, loading, reload } = useAsync(() => api.requirement(id), [id]);
  const { data: channel } = useAsync(() => api.channel(), []);
  const [step, setStep] = useState(params.get('new') ? 'discovery' : 'review');
  const [busy, setBusy] = useState(null);

  if (loading || !data) return <Page title="Requirement"><Card><Skeleton h={240} /></Card></Page>;

  const { requirement: r, shortlist, rfqs, quotes, comparison, recommendation, tasks, decisions } = data;

  const done = {
    review: true,
    discovery: shortlist.length > 0,
    rfq: rfqs.length > 0,
    quotes: quotes.length > 0,
    compare: Boolean(comparison),
    approval: decisions.length > 0,
  };

  const act = async (key, fn) => {
    setBusy(key);
    try { await fn(); await reload(); } finally { setBusy(null); }
  };

  return (
    <Page
      title={r.title}
      sub={`${r.id} · ${fmt.n(r.quantity)} ${r.uom} of ${r.materialName} for ${r.siteName}, required by ${r.requiredBy}`}
      right={
        <div className="row" style={{ gap: 8 }}>
          <PriorityBadge priority={r.priority} />
          <StatusBadge status={r.status} />
        </div>
      }
    >
      <Card flat>
        <div className="steps">
          {STEPS.map((s, i) => (
            <React.Fragment key={s.id}>
              {i > 0 && <span className="step-sep" />}
              <button className={`step ${step === s.id ? 'now' : ''} ${done[s.id] && step !== s.id ? 'done' : ''}`}
                onClick={() => setStep(s.id)} style={{ border: 'none', background: 'none', cursor: 'pointer' }}>
                <span className="step-idx">{done[s.id] && step !== s.id ? '✓' : i + 1}</span>
                <span className="step-label">{s.label}</span>
              </button>
            </React.Fragment>
          ))}
        </div>
      </Card>

      <div className="mt-lg">
        <AnimatePresence mode="wait">
          <motion.div key={step}
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
            transition={{ duration: .22 }}>
            {step === 'review' && <Review r={r} tasks={tasks} onSaved={reload} busy={busy} act={act} setStep={setStep} />}
            {step === 'discovery' && <Discovery r={r} shortlist={shortlist} reload={reload} busy={busy} act={act} setStep={setStep} />}
            {step === 'rfq' && <RFQ r={r} rfqs={rfqs} shortlist={shortlist} reload={reload} busy={busy} act={act} setStep={setStep} inboxUrl={channel?.inboxUrl} />}
            {step === 'quotes' && <Quotes r={r} quotes={quotes} shortlist={shortlist} rfqs={rfqs} reload={reload} busy={busy} act={act} setStep={setStep} />}
            {step === 'compare' && <Compare r={r} comparison={comparison} recommendation={recommendation} setStep={setStep} />}
            {step === 'approval' && <Approval r={r} recommendation={recommendation} comparison={comparison} decisions={decisions} role={role} reload={reload} busy={busy} act={act} navigate={navigate} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </Page>
  );
}

/* --------------------------------------------------------------- 4.4 review */

function Review({ r, tasks, busy, act, setStep }) {
  const [form, setForm] = useState({ quantity: r.quantity, requiredBy: r.requiredBy, specification: r.specification, priority: r.priority });
  const [saved, setSaved] = useState(null);
  const dirty = String(form.quantity) !== String(r.quantity) || form.requiredBy !== r.requiredBy
    || form.specification !== r.specification || form.priority !== r.priority;

  const save = () => act('save', async () => {
    const res = await api.updateRequirement(r.id, { ...form, actor: 'officer' });
    setSaved(res.changed);
  });

  return (
    <div className="grid grid-side">
      <Card large>
        <CardHead title="Requirement review" note="Edit and the agent re-runs discovery on the new values" right={<Prov kind="user" />} />

        <div className="grid grid-2" style={{ gap: 14 }}>
          <div className="field">
            <label className="label" htmlFor="q">Quantity ({r.uom})</label>
            <input id="q" type="number" className="input" value={form.quantity}
              onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label className="label" htmlFor="rb">Required by</label>
            <input id="rb" type="date" className="input" value={form.requiredBy}
              onChange={(e) => setForm({ ...form, requiredBy: e.target.value })} />
          </div>
        </div>

        <div className="field mt">
          <label className="label" htmlFor="pr">Priority</label>
          <select id="pr" className="select" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            <option value="routine">Routine</option><option value="urgent">Urgent</option><option value="critical">Critical</option>
          </select>
        </div>

        <div className="field mt">
          <label className="label" htmlFor="sp">Specification</label>
          <textarea id="sp" className="textarea" style={{ minHeight: 82 }} value={form.specification}
            onChange={(e) => setForm({ ...form, specification: e.target.value })} />
        </div>

        <div className="row mt" style={{ gap: 11 }}>
          <button className="btn btn-primary" onClick={save} disabled={!dirty || busy === 'save'}>
            {busy === 'save' ? 'Saving…' : 'Save and re-run discovery'}
          </button>
          <button className="btn" onClick={() => setStep('discovery')}>Accept and source →</button>
        </div>

        {saved && (
          <div className="mt">
            <Callout tone="green" icon="✓">
              Updated {saved.join(', ')}. Supplier discovery re-ran against the new values — open the
              discovery step to see the refreshed shortlist.
            </Callout>
          </div>
        )}
      </Card>

      <div className="col" style={{ gap: 16 }}>
        <Card>
          <CardHead title="As submitted" right={<Prov kind="user" />} />
          <div className="col" style={{ gap: 0 }}>
            <KV k="Material" v={r.materialName} />
            <KV k="Category" v={r.category} />
            <KV k="Site" v={`${r.siteName}, ${r.siteCountry}`} />
            <KV k="Quantity" v={`${fmt.n(r.quantity)} ${r.uom}`} />
            <KV k="Required by" v={`${r.requiredBy} (${r.daysToRequired}d)`} />
            <KV k="Target price" v={r.targetPrice ? `${r.targetPrice}/${r.uom}` : null} />
            <KV k="Raised by" v={r.raisedBy} />
          </div>
          <div className="divider" />
          <div className="label" style={{ marginBottom: 5 }}>Reason given</div>
          <p className="sm muted">{r.reason}</p>
        </Card>

        <Card>
          <CardHead title="History" />
          <div className="col" style={{ gap: 9 }}>
            {r.history.map((h, i) => (
              <div key={i}>
                <div className="xs dim">{new Date(h.at).toLocaleString()} · {h.actor}</div>
                <div className="sm">{h.action}</div>
              </div>
            ))}
          </div>
        </Card>

        {tasks.length > 0 && (
          <Card>
            <CardHead title="Agent tasks" note={`${tasks.length} run on this requirement`} />
            <div className="col" style={{ gap: 8 }}>
              {tasks.slice(0, 4).map((t) => (
                <div key={t.id} className="row-between">
                  <span className="sm">{t.title}</span>
                  <Badge tone={t.status === 'completed' ? 'green' : t.status === 'failed' ? 'red' : 'amber'} dot>{t.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 4.5 discovery */

const VERDICT_TONE = { credible: 'green', possible: 'amber', weak: 'red' };

function Discovery({ r, shortlist, reload, busy, act, setStep }) {
  const { data, loading, reload: reloadDisc } = useAsync(() => api.discovery(r.id), [r.id]);
  const { data: engine } = useAsync(() => api.engine(), []);
  const [research, setResearch] = React.useState(null);
  const shortlisted = new Set(shortlist.map((s) => s.supplierId));

  // Deep research runs in the background; poll while it is in flight.
  React.useEffect(() => {
    let alive = true;
    const tick = () => api.analyses(r.id).then((d) => {
      if (!alive) return;
      setResearch(d);
      if (d.running) setTimeout(tick, 2500);
    }).catch(() => {});
    tick();
    return () => { alive = false; };
  }, [r.id]);

  const runResearch = () => act('research', async () => {
    await api.analyseSuppliers(r.id, [...shortlisted]);
    setResearch(await api.analyses(r.id));
  });

  const toggle = (supplierId, on, reason) => act(`sl-${supplierId}`, async () => {
    if (on) await api.shortlist(r.id, supplierId, reason);
    else await api.unshortlist(r.id, supplierId);
    await reloadDisc();
  });

  const rerun = () => act('rerun', async () => {
    await api.discover(r.id, 'Manual re-run from the discovery step');
    await reloadDisc();
  });

  if (loading) return <Card><Skeleton h={220} /></Card>;
  const d = data?.discovery;

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card>
        <CardHead
          title="Search criteria the agent used"
          note="Taken from this requirement, not a fixed query"
          right={<div className="row" style={{ gap: 8 }}>
            <button className="btn btn-sm" onClick={rerun} disabled={busy === 'rerun'}>{busy === 'rerun' ? 'Running…' : 'Re-run discovery'}</button>
          </div>}
        />
        {d ? (
          <div className="row wrap" style={{ gap: 7 }}>
            {Object.entries(d.criteriaUsed).filter(([, v]) => v).map(([k, v]) => (
              <span key={k} className="chip"><span className="dim">{k}:</span> {String(v)}</span>
            ))}
          </div>
        ) : <Empty>No discovery has run yet.</Empty>}
      </Card>

      {d && (
        <>
          <div className="row wrap" style={{ gap: 10 }}>
            <Badge tone="green" dot>{d.counts.graph8} from graph8</Badge>
            <Badge tone="accent" dot>{d.counts.directory} existing suppliers</Badge>
            {d.counts.userAdded > 0 && <Badge tone="violet" dot>{d.counts.userAdded} user added</Badge>}
            <Badge tone="neutral">{shortlisted.size} shortlisted</Badge>
          </div>

          {engine?.engine === 'graph8' ? (
            <Callout tone={research?.running ? 'info' : 'green'} icon={research?.running ? '◐' : '✓'}>
              {research?.running ? (
                <><strong>graph8 is researching these suppliers.</strong> The Supplier Fit Analyst skill checks
                  what each company actually does — verdicts appear below as they land.</>
              ) : Object.keys(research?.analyses || {}).length ? (
                <><strong>Researched by graph8.</strong> The verdicts below come from the Supplier Fit Analyst
                  skill, which searches the web to establish what each company really does — not just what
                  the record says.</>
              ) : (
                <><strong>graph8 research available.</strong>{' '}
                  <button className="btn btn-sm" onClick={runResearch}
                    disabled={busy === 'research' || shortlisted.size === 0}>
                    {busy === 'research' ? 'Researching…' : `Research ${shortlisted.size} shortlisted`}
                  </button></>
              )}
            </Callout>
          ) : (
            <Callout tone="amber" icon="⚠">
              A graph8 result confirms a company exists and who works there. It does <strong>not</strong> confirm
              the company can supply this material, holds certification, or has capacity. Everything below is a
              potential supplier only. <span className="dim">Set GRAPH8_API_KEY to have graph8 research each
              candidate properly.</span>
            </Callout>
          )}

          {d.results.length === 0 ? (
            <Card><Empty title="No candidates">No supplier in the workspace matches this material.</Empty></Card>
          ) : (
            <div className="col" style={{ gap: 12 }}>
              {d.results.map((row, i) => {
                const s = row.supplier;
                const sb = SOURCE_BADGE[s.source] || SOURCE_BADGE.graph8;
                const on = shortlisted.has(s.id);
                return (
                  <motion.div key={s.id} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * .04, .35) }}>
                    <Card>
                      <div className="row-between" style={{ alignItems: 'flex-start' }}>
                        <div style={{ minWidth: 0 }}>
                          <div className="row" style={{ gap: 9 }}>
                            <span className="strong">{s.company}</span>
                            <Badge tone={sb.tone} dot>{sb.label}</Badge>
                            {s.status && <Badge tone="neutral">{s.status}</Badge>}
                          </div>
                          <div className="xs faint mono" style={{ marginTop: 2 }}>{s.domain || 'no domain on file'}</div>
                          <div className="xs faint">
                            {[s.industry, s.employeeCount, [s.state, s.country].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                        <div className="row" style={{ gap: 9 }}>
                          {research?.analyses?.[s.id] && (
                            <Badge tone={VERDICT_TONE[research.analyses[s.id].verdict] || 'neutral'} dot>
                              graph8: {research.analyses[s.id].verdict} {research.analyses[s.id].score}
                            </Badge>
                          )}
                          <Badge tone={row.match.score >= 60 ? 'green' : row.match.score >= 35 ? 'amber' : 'neutral'}>
                            match {row.match.score}
                          </Badge>
                          <button className={`btn btn-sm ${on ? '' : 'btn-primary'}`}
                            onClick={() => toggle(s.id, !on, row.match.reasons[0])}
                            disabled={busy === `sl-${s.id}`}>
                            {busy === `sl-${s.id}` ? '…' : on ? 'Remove' : 'Shortlist'}
                          </button>
                        </div>
                      </div>

                      <div className="divider" />

                      <div className="grid grid-2" style={{ gap: 18 }}>
                        <div>
                          <div className="label" style={{ marginBottom: 6 }}>Why it came up</div>
                          <div className="col" style={{ gap: 4 }}>
                            {row.match.reasons.map((x, j) => <div key={j} className="sm muted">• {x}</div>)}
                          </div>
                        </div>
                        <div>
                          <div className="label" style={{ marginBottom: 6 }}>Not known</div>
                          <div className="col" style={{ gap: 4 }}>
                            {row.match.unknowns.map((x, j) => <div key={j} className="sm" style={{ color: 'var(--amber)' }}>• {x}</div>)}
                          </div>
                        </div>
                      </div>

                      {(() => {
                        const a = research?.analyses?.[s.id];
                        if (!a) return null;
                        const tone = VERDICT_TONE[a.verdict] === 'red' ? 'red'
                          : VERDICT_TONE[a.verdict] === 'green' ? 'green' : 'amber';
                        const disagrees = (a.verdict === 'weak' && row.match.score >= 50)
                          || (a.verdict === 'credible' && row.match.score < 40);
                        return (
                          <div className="mt">
                            <Callout tone={tone} icon={a.verdict === 'weak' ? '⚠' : a.verdict === 'credible' ? '✓' : 'ℹ'}>
                              <strong>graph8 research: {a.verdict} ({a.score}/100).</strong> {a.oneLine}
                              {disagrees && (
                                <div style={{ marginTop: 6, fontWeight: 600 }}>
                                  This disagrees with the record-match score of {row.match.score}. Trust the research.
                                </div>
                              )}
                              {a.reasons?.length > 0 && (
                                <ul style={{ margin: '7px 0 0 16px' }}>
                                  {a.reasons.slice(0, 3).map((x, j) => <li key={j} style={{ marginBottom: 2 }}>{x}</li>)}
                                </ul>
                              )}
                              {a.questionsForSupplier?.length > 0 && (
                                <div style={{ marginTop: 7 }}>
                                  <strong>Ask them:</strong>
                                  <ul style={{ margin: '4px 0 0 16px' }}>
                                    {a.questionsForSupplier.slice(0, 2).map((x, j) => <li key={j} style={{ marginBottom: 2 }}>{x}</li>)}
                                  </ul>
                                </div>
                              )}
                              {a.meta?.webSearches > 0 && (
                                <div className="xs" style={{ marginTop: 7, opacity: .75 }}>
                                  {a.meta.webSearches} web search{a.meta.webSearches === 1 ? '' : 'es'} · {a.meta.model} · {(a.meta.durationMs / 1000).toFixed(0)}s · ${(a.meta.costUsd || 0).toFixed(4)}
                                </div>
                              )}
                            </Callout>
                          </div>
                        );
                      })()}

                      <DeepDive entity="supplier" id={s.id} company={s.company} />

                      {s.contact && (
                        <div className="row wrap mt" style={{ gap: 6 }}>
                          <span className="chip">{s.contact.firstName} {s.contact.lastName} — {s.contact.jobTitle}</span>
                          <span className="chip">{s.contact.hasWorkEmail ? '✓ work email' : '✕ no email'}</span>
                          {typeof s.contact.confidenceScore === 'number' && <span className="chip">confidence {s.contact.confidenceScore}</span>}
                        </div>
                      )}
                    </Card>
                  </motion.div>
                );
              })}
            </div>
          )}

          <div className="row">
            <button className="btn btn-primary" disabled={shortlisted.size === 0} onClick={() => setStep('rfq')}>
              Continue to RFQ ({shortlisted.size} shortlisted) →
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 4.6 RFQ */

const SEND_TONE = { draft: 'neutral', queued: 'amber', sent: 'green', failed: 'red', not_configured: 'amber', bounced: 'red' };
const SEND_LABEL = { draft: 'draft', queued: 'queued', sent: 'sent', failed: 'failed', not_configured: 'no channel', bounced: 'bounced' };

function RFQ({ r, rfqs, shortlist, reload, busy, act, setStep, inboxUrl }) {
  const [openId, setOpenId] = useState(rfqs[0]?.id || null);
  const open = rfqs.find((x) => x.id === openId) || rfqs[0];
  const [edit, setEdit] = useState(null);

  const prepare = () => act('prep', async () => { await api.prepareRFQs(r.id); });
  const send = (rfqId) => act(`send-${rfqId}`, async () => {
    if (edit && edit.id === rfqId) await api.updateRFQ(rfqId, { subject: edit.subject, body: edit.body });
    await api.sendRFQ(rfqId);
    setEdit(null);
  });

  if (shortlist.length === 0) {
    return <Card><Empty title="Nothing shortlisted">Shortlist at least one supplier first.{' '}
      <button className="btn btn-sm" onClick={() => setStep('discovery')}>Back to discovery</button></Empty></Card>;
  }

  if (rfqs.length === 0) {
    return (
      <Card large>
        <CardHead title="Prepare RFQs" note={`A separate request will be drafted for each of the ${shortlist.length} shortlisted suppliers`} />
        <Callout icon="ℹ">
          Each RFQ is built from this requirement's own material, quantity, date, site and specification —
          not a generic template.
        </Callout>
        <div className="mt">
          <button className="btn btn-primary" onClick={prepare} disabled={busy === 'prep'}>
            {busy === 'prep' ? 'Preparing…' : `Prepare ${shortlist.length} RFQ draft${shortlist.length > 1 ? 's' : ''}`}
          </button>
        </div>
      </Card>
    );
  }

  const body = edit?.id === open?.id ? edit.body : open?.body;
  const subject = edit?.id === open?.id ? edit.subject : open?.subject;

  return (
    <div className="grid grid-side-l">
      <Card>
        <CardHead title={`${rfqs.length} RFQ${rfqs.length > 1 ? 's' : ''}`} />
        <div className="col" style={{ gap: 7 }}>
          {rfqs.map((x) => (
            <button key={x.id} onClick={() => { setOpenId(x.id); setEdit(null); }}
              className="role-card" style={openId === x.id ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}>
              <div className="row-between">
                <span className="sm strong">{x.supplierName}</span>
                <Badge tone={x.awaitingReply ? 'amber' : SEND_TONE[x.sendStatus] || 'neutral'} dot>
                  {x.awaitingReply ? 'awaiting reply' : x.repliedAt ? 'replied' : SEND_LABEL[x.sendStatus] || x.sendStatus}
                </Badge>
              </div>
              <div className="xs faint" style={{ marginTop: 2 }}>{x.toName || 'no contact'}</div>
            </button>
          ))}
        </div>
        <div className="mt">
          <button className="btn btn-sm" onClick={prepare} disabled={busy === 'prep'}>Re-draft all</button>
        </div>
      </Card>

      {open && (
        <Card large>
          <CardHead
            title={`RFQ to ${open.supplierName}`}
            note={`${open.toName}${open.toTitle ? ` · ${open.toTitle}` : ''}`}
            right={<Badge tone={open.awaitingReply ? 'amber' : SEND_TONE[open.sendStatus] || 'neutral'} dot>
              {open.awaitingReply ? 'awaiting reply' : open.repliedAt ? 'replied' : SEND_LABEL[open.sendStatus] || open.sendStatus}
            </Badge>}
          />

          {!open.canEmail && (
            <div style={{ marginBottom: 14 }}>
              <Callout icon="ℹ">
                graph8 masks contact emails, so this RFQ goes to a demo address for {open.supplierName}.
              </Callout>
            </div>
          )}

          <div className="field">
            <label className="label" htmlFor="subj">Subject</label>
            <input id="subj" className="input" value={subject}
              onChange={(e) => setEdit({ id: open.id, subject: e.target.value, body })} />
          </div>

          <div className="field mt">
            <label className="label" htmlFor="bd">Message</label>
            <textarea id="bd" className="textarea textarea-mono" style={{ minHeight: 320 }} value={body}
              onChange={(e) => setEdit({ id: open.id, subject, body: e.target.value })} />
          </div>

          <div className="row wrap mt" style={{ gap: 6 }}>
            <span className="label" style={{ width: '100%' }}>Fields requested</span>
            {open.requestedFields.map((f) => <span key={f} className="chip">{f.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>)}
          </div>

          {open.sendDetail && (
            <div className="mt">
              <Callout tone={open.sendStatus === 'sent' ? 'green' : open.sendStatus === 'failed' ? 'red' : 'amber'}
                icon={open.sendStatus === 'sent' ? '✓' : '⚠'}>
                <strong>
                  {open.sendStatus === 'sent'
                    ? open.awaitingReply ? 'Sent — awaiting supplier response.' : open.repliedAt ? 'Sent, and the supplier has replied.' : 'Sent.'
                    : `Delivery status: ${open.sendStatus.replace('_', ' ')}.`}
                </strong>{' '}
                {open.sendDetail}
                {inboxUrl && open.sendStatus === 'sent' && (
                  <> <a href={inboxUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>Open the inbox</a>.</>
                )}
              </Callout>
            </div>
          )}

          <div className="row mt" style={{ gap: 11 }}>
            <button className="btn btn-primary" onClick={() => send(open.id)} disabled={busy === `send-${open.id}`}>
              {busy === `send-${open.id}` ? 'Sending…' : open.approved ? 'Send again' : 'Approve and send'}
            </button>
            <button className="btn" onClick={() => setStep('quotes')}>Record a quotation →</button>
          </div>
        </Card>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- 4.7 quotes */

function Quotes({ r, quotes, shortlist, reload, busy, act, setStep }) {
  const blank = {
    supplierId: shortlist[0]?.supplierId || '', unitPrice: '', currency: 'USD', additionalCharges: '',
    minimumOrderQty: '', availableQty: '', leadTimeDays: '', validityDays: '',
    deliveryTerms: '', paymentTerms: '', specCompliance: '', certifications: '', notes: '',
    entryMode: 'supplier_reply',
  };
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = () => act('quote', async () => {
    try {
      await api.addQuote(r.id, form);
      setForm(blank); setErrors({});
    } catch (err) { setErrors(err.errors || { _: err.message }); }
  });

  const del = (qid) => act(`del-${qid}`, async () => { await api.deleteQuote(qid); });

  return (
    <div className="grid grid-side">
      <div className="col" style={{ gap: 16 }}>
        <Card large>
          <CardHead title="Record a quotation" note="For a supplier reply received outside the system, or one that arrived by email" />

          <Callout tone="amber" icon="⚠">
            Mark honestly where this came from. A quotation you type in on a supplier's behalf is
            <strong> user-entered</strong>, and is labelled that way everywhere it appears. It is never shown
            as an actual supplier reply.
          </Callout>

          <div className="grid grid-2 mt" style={{ gap: 14 }}>
            <div className="field">
              <label className="label" htmlFor="sup">Supplier *</label>
              <select id="sup" className={`select ${errors.supplierId ? 'input-err' : ''}`} value={form.supplierId} onChange={set('supplierId')}>
                <option value="">Select…</option>
                {shortlist.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.supplier?.company || s.supplierId}</option>)}
              </select>
              {errors.supplierId && <span className="err-text">{errors.supplierId}</span>}
            </div>
            <div className="field">
              <label className="label" htmlFor="mode">How it arrived</label>
              <select id="mode" className="select" value={form.entryMode} onChange={set('entryMode')}>
                <option value="supplier_reply">Supplier reply (received)</option>
                <option value="manual_entry">Entered by me (demo / offline)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-3 mt" style={{ gap: 14 }}>
            <div className="field"><label className="label" htmlFor="up">Unit price</label>
              <input id="up" type="number" step="0.0001" className="input" placeholder="Leave blank if not provided" value={form.unitPrice} onChange={set('unitPrice')} /></div>
            <div className="field"><label className="label" htmlFor="cc">Currency</label>
              <select id="cc" className="select" value={form.currency} onChange={set('currency')}>
                <option>USD</option><option>EUR</option><option>PKR</option><option>GBP</option>
              </select></div>
            <div className="field"><label className="label" htmlFor="ch">Additional charges</label>
              <input id="ch" type="number" step="0.01" className="input" value={form.additionalCharges} onChange={set('additionalCharges')} /></div>
          </div>

          <div className="grid grid-3 mt" style={{ gap: 14 }}>
            <div className="field"><label className="label" htmlFor="moq">Minimum order qty</label>
              <input id="moq" type="number" className="input" value={form.minimumOrderQty} onChange={set('minimumOrderQty')} /></div>
            <div className="field"><label className="label" htmlFor="av">Available qty</label>
              <input id="av" type="number" className="input" value={form.availableQty} onChange={set('availableQty')} /></div>
            <div className="field"><label className="label" htmlFor="lt">Lead time (days)</label>
              <input id="lt" type="number" className="input" value={form.leadTimeDays} onChange={set('leadTimeDays')} /></div>
          </div>

          <div className="grid grid-3 mt" style={{ gap: 14 }}>
            <div className="field"><label className="label" htmlFor="vd">Validity (days)</label>
              <input id="vd" type="number" className="input" value={form.validityDays} onChange={set('validityDays')} /></div>
            <div className="field"><label className="label" htmlFor="dt">Delivery terms</label>
              <input id="dt" className="input" placeholder="e.g. CIF Karachi" value={form.deliveryTerms} onChange={set('deliveryTerms')} /></div>
            <div className="field"><label className="label" htmlFor="pt">Payment terms</label>
              <input id="pt" className="input" placeholder="e.g. Net 30" value={form.paymentTerms} onChange={set('paymentTerms')} /></div>
          </div>

          <div className="grid grid-2 mt" style={{ gap: 14 }}>
            <div className="field"><label className="label" htmlFor="sc">Specification compliance</label>
              <input id="sc" className="input" placeholder="What the supplier confirmed" value={form.specCompliance} onChange={set('specCompliance')} /></div>
            <div className="field"><label className="label" htmlFor="ce">Certifications</label>
              <input id="ce" className="input" placeholder="e.g. HACCP, ISO 22000" value={form.certifications} onChange={set('certifications')} /></div>
          </div>

          {errors._ && <div className="mt"><Callout tone="red" icon="✕">{errors._}</Callout></div>}

          <div className="row mt" style={{ gap: 11 }}>
            <button className="btn btn-primary" onClick={save} disabled={busy === 'quote'}>
              {busy === 'quote' ? 'Saving…' : 'Save quotation'}
            </button>
            <span className="xs faint">Blank fields stay “Not provided”. Nothing is estimated.</span>
          </div>
        </Card>

        {quotes.length > 0 && (
          <Card large>
            <CardHead title={`${quotes.length} quotation${quotes.length > 1 ? 's' : ''} recorded`} />
            <div className="col" style={{ gap: 12 }}>
              {quotes.map((q) => (
                <div key={q.id} className="row-between" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="sm strong mono">{q.id}</span>
                      <Prov kind={q.provenance} />
                      {q.receivedVia && <span className="chip xs">via {q.receivedVia}</span>}
                    </div>
                    <div className="xs faint">
                      {q.unitPrice !== null ? `${q.currency} ${q.unitPrice}/${r.uom}` : 'no price'} ·
                      {q.leadTimeDays !== null ? ` ${q.leadTimeDays}d lead` : ' no lead time'}
                    </div>
                  </div>
                  <button className="btn btn-sm btn-danger" onClick={() => del(q.id)} disabled={busy === `del-${q.id}`}>Remove</button>
                </div>
              ))}
            </div>
            <div className="mt"><button className="btn btn-primary" onClick={() => setStep('compare')}>Compare quotations →</button></div>
          </Card>
        )}
      </div>

      <Card>
        <CardHead title="What the RFQ asked for" />
        <div className="col sm muted" style={{ gap: 5 }}>
          {['Unit price and currency', 'Minimum order quantity', 'Quantity available by the required date',
            'Lead time from PO', 'Quote validity', 'Delivery and payment terms',
            'Specification compliance', 'Certifications and documents'].map((x) => <div key={x}>• {x}</div>)}
        </div>
        <div className="divider" />
        <p className="xs dim">
          Anything a supplier did not answer is left blank here and shown as “Not provided” in the
          comparison, rather than filled with an assumption.
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- 4.8 compare */

function Compare({ r, comparison, recommendation, setStep }) {
  if (!comparison || comparison.rows.length === 0) {
    return <Card><Empty title="Nothing to compare">Record at least one quotation first.{' '}
      <button className="btn btn-sm" onClick={() => setStep('quotes')}>Record a quotation</button></Empty></Card>;
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card large>
        <CardHead
          title="Quotation comparison"
          note={`${comparison.requirementQty.toLocaleString()} ${r.uom} required in ${comparison.daysToNeed} days`}
          right={<Prov kind="derived" />}
        />
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Supplier</th><th>Source</th><th className="num">Unit price</th><th className="num">Total</th>
                <th className="num">Lead time</th><th className="num">Available</th><th>Terms</th><th>Missing</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.quoteId} style={row.quoteId === recommendation?.recommendedQuoteId ? { background: 'var(--green-soft)' } : undefined}>
                  <td>
                    <div className="strong">{row.supplierName}</div>
                    <div className="xs"><Prov kind={row.provenance} /></div>
                  </td>
                  <td>{(() => { const sb = SOURCE_BADGE[row.supplierSource] || SOURCE_BADGE.graph8; return <Badge tone={sb.tone}>{sb.label}</Badge>; })()}</td>
                  <td className="num tnum">{row.unitPrice !== null ? `${row.currency} ${row.unitPrice}` : <span className="kv-missing">Not provided</span>}</td>
                  <td className="num tnum strong">{row.total !== null ? fmt.money(row.total, row.currency) : <span className="kv-missing">—</span>}</td>
                  <td className="num tnum">
                    {row.leadTimeDays !== null
                      ? <span style={row.leadTimeOk === false ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{row.leadTimeDays}d</span>
                      : <span className="kv-missing">—</span>}
                  </td>
                  <td className="num tnum">
                    {row.availableQty !== null
                      ? <span style={row.qtyShortfall > 0 ? { color: 'var(--red)', fontWeight: 600 } : undefined}>{fmt.n(row.availableQty)}</span>
                      : <span className="kv-missing">—</span>}
                  </td>
                  <td className="xs faint">{[row.deliveryTerms, row.paymentTerms].filter(Boolean).join(' · ') || <span className="kv-missing">Not provided</span>}</td>
                  <td className="xs">{row.missing.length ? <Badge tone="amber">{row.missing.length} field{row.missing.length > 1 ? 's' : ''}</Badge> : <Badge tone="green">complete</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {recommendation && (
        <Card large>
          <CardHead title="Agent analysis" note="Decision support, not an approval" right={<Prov kind="derived" />} />
          <div className="row" style={{ gap: 10, marginBottom: 12 }}>
            <Badge tone={recommendation.status === 'ready_for_review' ? 'green' : recommendation.status === 'conditional' ? 'amber' : 'red'} dot>
              {recommendation.status.replace(/_/g, ' ')}
            </Badge>
            <span className="strong">{recommendation.headline}</span>
          </div>

          <div className="grid grid-3" style={{ gap: 18 }}>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Findings</div>
              <div className="col sm muted" style={{ gap: 5 }}>{recommendation.findings.map((x, i) => <div key={i}>• {x}</div>)}</div>
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Risks</div>
              <div className="col sm" style={{ gap: 5, color: 'var(--amber)' }}>{recommendation.risks.map((x, i) => <div key={i}>• {x}</div>)}</div>
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>Assumptions</div>
              <div className="col sm muted" style={{ gap: 5 }}>{recommendation.assumptions.map((x, i) => <div key={i}>• {x}</div>)}</div>
            </div>
          </div>

          {recommendation.requiredBeforeDecision.length > 0 && (
            <div className="mt">
              <Callout tone="amber" icon="⚠">
                <strong>Needed before a decision:</strong>
                <ul style={{ margin: '6px 0 0 16px' }}>{recommendation.requiredBeforeDecision.map((x, i) => <li key={i}>{x}</li>)}</ul>
              </Callout>
            </div>
          )}

          <div className="mt"><Callout icon="ℹ">{recommendation.caveat}</Callout></div>

          <div className="row mt"><button className="btn btn-primary" onClick={() => setStep('approval')}>Send for approval →</button></div>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- 4.9 approval */

function Approval({ r, recommendation, comparison, decisions, role, busy, act, navigate }) {
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState({});
  const isHead = role === 'head';

  const decide = (action) => act(action, async () => {
    try {
      await api.decide(r.id, { action, note, quoteId: recommendation?.recommendedQuoteId, actor: role });
      setNote(''); setErrors({});
    } catch (err) { setErrors(err.errors || { _: err.message }); }
  });

  const recRow = comparison?.rows.find((x) => x.quoteId === recommendation?.recommendedQuoteId);

  return (
    <div className="grid grid-side">
      <Card large>
        <CardHead title="Sourcing decision" note="Recorded against this requirement with a full audit trail" />

        {!recommendation || recommendation.status === 'insufficient_evidence' ? (
          <Callout tone="amber" icon="⚠">
            {recommendation?.headline || 'No recommendation yet.'} A decision can still be recorded, but there
            is no supported recommendation to approve.
          </Callout>
        ) : (
          <>
            <Callout tone={recommendation.status === 'conditional' ? 'amber' : 'green'} icon={recommendation.status === 'conditional' ? '⚠' : '✓'}>
              <strong>{recommendation.headline}</strong>
            </Callout>
            {recRow && (
              <div className="grid grid-3 mt" style={{ gap: 14 }}>
                <Card flat style={{ background: 'var(--surface-2)' }}>
                  <div className="stat-label">Supplier</div><div className="strong mt" style={{ fontSize: 15 }}>{recRow.supplierName}</div>
                </Card>
                <Card flat style={{ background: 'var(--surface-2)' }}>
                  <div className="stat-label">Estimated total</div><div className="stat-value" style={{ fontSize: 22 }}>{fmt.money(recRow.total, recRow.currency)}</div>
                </Card>
                <Card flat style={{ background: 'var(--surface-2)' }}>
                  <div className="stat-label">Lead time</div><div className="stat-value" style={{ fontSize: 22 }}>{recRow.leadTimeDays ?? '—'}d</div>
                </Card>
              </div>
            )}
          </>
        )}

        {r.targetPrice && recRow?.unitPrice != null && (
          <div className="mt">
            <Callout tone={recRow.unitPrice <= r.targetPrice ? 'green' : 'amber'} icon={recRow.unitPrice <= r.targetPrice ? '✓' : '⚠'}>
              Quoted {recRow.currency} {recRow.unitPrice}/{r.uom} against a target of {r.targetPrice}/{r.uom} —{' '}
              {recRow.unitPrice <= r.targetPrice ? 'within budget' : `${(((recRow.unitPrice - r.targetPrice) / r.targetPrice) * 100).toFixed(1)}% over`}.
            </Callout>
          </div>
        )}

        <div className="field mt">
          <label className="label" htmlFor="note">Decision note {!isHead && <span className="dim">(required for reject / revise)</span>}</label>
          <textarea id="note" className={`textarea ${errors.note ? 'input-err' : ''}`} style={{ minHeight: 80 }}
            placeholder="Reasoning, conditions, or what must change" value={note} onChange={(e) => setNote(e.target.value)} />
          {errors.note && <span className="err-text">{errors.note}</span>}
        </div>

        {!isHead && (
          <div className="mt"><Callout icon="ℹ">
            You are signed in as <strong>{role}</strong>. Switch to Procurement Head in the sidebar to record
            the approval as the accountable role.
          </Callout></div>
        )}

        <div className="row wrap mt" style={{ gap: 10 }}>
          <button className="btn btn-primary" onClick={() => decide('approve')} disabled={busy === 'approve'}>
            {busy === 'approve' ? 'Recording…' : 'Approve recommendation'}
          </button>
          <button className="btn" onClick={() => decide('revise')} disabled={busy === 'revise'}>Request revision</button>
          <button className="btn btn-danger" onClick={() => decide('reject')} disabled={busy === 'reject'}>Reject</button>
        </div>

        <div className="mt">
          <Callout tone="amber" icon="⚠">
            Approval here records an internal sourcing decision only. It does not raise a purchase order,
            commit funds, or place an order with any supplier.
          </Callout>
        </div>
      </Card>

      <div className="col" style={{ gap: 16 }}>
        <Card>
          <CardHead title="Requirement summary" />
          <div className="col" style={{ gap: 0 }}>
            <KV k="Material" v={r.materialName} />
            <KV k="Quantity" v={`${fmt.n(r.quantity)} ${r.uom}`} />
            <KV k="Site" v={r.siteName} />
            <KV k="Required by" v={r.requiredBy} />
            <KV k="Priority" v={r.priority} />
          </div>
          <div className="divider" />
          <div className="label" style={{ marginBottom: 5 }}>Department justification</div>
          <p className="sm muted">{r.reason}</p>
        </Card>

        <Card>
          <CardHead title={`Decisions (${decisions.length})`} />
          {decisions.length === 0 ? <Empty>No decision recorded yet.</Empty> : (
            <div className="col" style={{ gap: 12 }}>
              {decisions.map((d) => (
                <div key={d.id}>
                  <div className="row" style={{ gap: 8 }}>
                    <Badge tone={d.action === 'approve' ? 'green' : d.action === 'reject' ? 'red' : 'amber'} dot>{d.action}</Badge>
                    <span className="xs dim">{new Date(d.at).toLocaleString()} · {d.actor}</span>
                  </div>
                  {d.note && <div className="sm muted" style={{ marginTop: 4 }}>{d.note}</div>}
                  <div className="xs dim" style={{ marginTop: 4 }}>{d.scopeNote}</div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <button className="btn" onClick={() => navigate('/requirements')}>← All requirements</button>
      </div>
    </div>
  );
}
