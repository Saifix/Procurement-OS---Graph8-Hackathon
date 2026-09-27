import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, CardHead, Badge, Callout, Prov, useAsync, Skeleton, Empty } from '../components/ui.jsx';

const KIND = {
  supplier_discovery: 'Supplier discovery',
  rfq_preparation: 'RFQ preparation',
  quote_analysis: 'Quotation analysis',
  inventory_projection: 'Inventory projection',
};
const STATUS = {
  completed: { tone: 'green', label: 'completed' },
  running: { tone: 'amber', label: 'running' },
  failed: { tone: 'red', label: 'failed' },
  needs_attention: { tone: 'amber', label: 'needs attention' },
};

export default function AgentCenter() {
  const navigate = useNavigate();
  const { data, loading, reload } = useAsync(() => api.tasks({}), []);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(null);

  const tasks = data?.tasks || [];
  const open = tasks.find((t) => t.id === openId) || tasks[0];

  const retry = async (id) => {
    setBusy(id);
    try { await api.retryTask(id); await reload(); } finally { setBusy(null); }
  };

  if (loading) return <Page title="Agent activity"><Card><Skeleton h={250} /></Card></Page>;

  return (
    <Page
      title="Agent activity"
      sub="Every task an agent has run, what triggered it, the inputs it read, what it produced, and where it hit a limit."
    >
      {tasks.length === 0 ? (
        <Card><Empty title="No agent tasks yet">
          Agents run when you submit a requirement, edit one, prepare RFQs, record a quotation, or change the
          production plan.{' '}
          <button className="btn btn-sm" onClick={() => navigate('/raise')}>Raise a requirement</button>
        </Empty></Card>
      ) : (
        <div className="grid grid-side-l">
          <Card>
            <CardHead title={`${tasks.length} task${tasks.length === 1 ? '' : 's'}`} note="Newest first" />
            <div className="col" style={{ gap: 7, maxHeight: 640, overflowY: 'auto' }}>
              {tasks.map((t) => {
                const st = STATUS[t.status] || STATUS.completed;
                return (
                  <button key={t.id} className="role-card" onClick={() => setOpenId(t.id)}
                    style={open?.id === t.id ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}>
                    <div className="row-between">
                      <span className="sm strong">{KIND[t.kind] || t.kind}</span>
                      <Badge tone={st.tone} dot>{st.label}</Badge>
                    </div>
                    <div className="xs faint" style={{ marginTop: 3 }}>{t.title}</div>
                    <div className="xs dim" style={{ marginTop: 2 }}>
                      {new Date(t.startedAt).toLocaleTimeString()} {t.requirementId ? `· ${t.requirementId}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          {open && (
            <motion.div key={open.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .22 }}>
              <Card large>
                <CardHead
                  title={open.title}
                  note={`${KIND[open.kind] || open.kind} · ${open.id}`}
                  right={<div className="row" style={{ gap: 8 }}>
                    <Badge tone={(STATUS[open.status] || STATUS.completed).tone} dot>{open.status}</Badge>
                    <button className="btn btn-sm" onClick={() => retry(open.id)} disabled={busy === open.id}>
                      {busy === open.id ? 'Running…' : 'Re-run'}
                    </button>
                  </div>}
                />

                <Callout icon="▶"><strong>Triggered by:</strong> {open.trigger}</Callout>

                {Object.keys(open.inputs || {}).length > 0 && (
                  <div className="mt">
                    <div className="label" style={{ marginBottom: 7 }}>Inputs it read</div>
                    <div className="row wrap" style={{ gap: 6 }}>
                      {Object.entries(open.inputs).map(([k, v]) => (
                        <span key={k} className="chip"><span className="dim">{k}:</span> {String(v)}</span>
                      ))}
                    </div>
                  </div>
                )}

                {open.steps?.length > 0 && (
                  <div className="mt">
                    <div className="label" style={{ marginBottom: 7 }}>What it did</div>
                    <div className="col" style={{ gap: 6 }}>
                      {open.steps.map((s, i) => (
                        <div key={i} className="sm muted">
                          <span className="xs dim mono" style={{ marginRight: 8 }}>{new Date(s.at).toLocaleTimeString()}</span>
                          {s.text}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {open.sources?.length > 0 && (
                  <div className="mt">
                    <div className="label" style={{ marginBottom: 7 }}>Sources used</div>
                    <div className="col" style={{ gap: 8 }}>
                      {open.sources.map((s, i) => (
                        <div key={i} className="row" style={{ gap: 9, alignItems: 'flex-start' }}>
                          <Prov kind={s.provenance} />
                          <div>
                            <div className="sm strong">{s.name}</div>
                            <div className="xs faint">{s.detail}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {open.findings?.length > 0 && (
                  <div className="mt">
                    <div className="label" style={{ marginBottom: 7 }}>Findings</div>
                    <div className="col sm muted" style={{ gap: 5 }}>
                      {open.findings.map((f, i) => <div key={i}>• {f}</div>)}
                    </div>
                  </div>
                )}

                {open.limitations?.length > 0 && (
                  <div className="mt">
                    <Callout tone="amber" icon="⚠">
                      <strong>Limitations</strong>
                      <ul style={{ margin: '6px 0 0 16px' }}>
                        {open.limitations.map((l, i) => <li key={i} style={{ marginBottom: 3 }}>{l}</li>)}
                      </ul>
                    </Callout>
                  </div>
                )}

                {open.error && <div className="mt"><Callout tone="red" icon="✕"><strong>Error:</strong> {open.error}</Callout></div>}

                {open.requirementId && (
                  <div className="row mt">
                    <button className="btn btn-primary" onClick={() => navigate(`/requirements/${open.requirementId}`)}>
                      Open {open.requirementId} →
                    </button>
                  </div>
                )}
              </Card>
            </motion.div>
          )}
        </div>
      )}
    </Page>
  );
}
