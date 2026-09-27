import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, CardHead, Badge, Callout, Prov, useAsync, Skeleton, Empty } from '../components/ui.jsx';

const SOURCE = {
  graph8: { tone: 'green', label: 'graph8 result', prov: 'graph8_live' },
  directory: { tone: 'accent', label: 'existing supplier', prov: 'demo' },
  user_added: { tone: 'violet', label: 'user added', prov: 'user' },
};

export default function Suppliers({ workspace }) {
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const { data, loading } = useAsync(() => api.suppliers({ q, tag }), [tag]);

  const tags = [...new Set(workspace.materials.map((m) => m.materialTag))].sort();
  const rows = (data?.suppliers || []).filter((s) => !q || s.company.toLowerCase().includes(q.toLowerCase()));

  return (
    <Page
      title="Suppliers"
      sub="Everything the workspace knows about: live graph8 discovery results, existing directory suppliers, and anything added by hand."
    >
      <Card flat>
        <div className="row wrap" style={{ gap: 14 }}>
          <div className="field" style={{ flex: 1, minWidth: 210 }}>
            <label className="label" htmlFor="q">Search</label>
            <input id="q" className="input" placeholder="Company or domain…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="field" style={{ minWidth: 215 }}>
            <label className="label" htmlFor="t">Material category</label>
            <select id="t" className="select" value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All materials</option>
              {tags.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
        </div>
      </Card>

      <div className="mt">
        <Callout tone="amber" icon="⚠">
          Presence in this list does not make a company an approved or qualified supplier. graph8 confirms a
          company exists and who works there — capability, certification and capacity still have to be verified.
        </Callout>
      </div>

      {loading && <Card className="mt"><Skeleton h={200} /></Card>}

      {!loading && (
        <Card large className="mt">
          <CardHead title={`${rows.length} supplier${rows.length === 1 ? '' : 's'}`} right={<Prov kind="mixed" />} />
          {rows.length === 0 ? <Empty title="No matches">Nothing matches that search.</Empty> : (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead><tr><th>Company</th><th>Source</th><th>Industry</th><th>Location</th><th>Contact</th><th>Materials</th></tr></thead>
                <tbody>
                  {rows.map((s, i) => {
                    const src = SOURCE[s.source] || SOURCE.graph8;
                    const c = s.contact || {};
                    return (
                      <motion.tr key={s.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * .03, .35) }}>
                        <td>
                          <div className="strong">{s.company}</div>
                          <div className="xs faint mono">{s.domain || '—'}</div>
                        </td>
                        <td><Badge tone={src.tone} dot>{src.label}</Badge>{s.status && <div className="xs faint mt" style={{ marginTop: 4 }}>{s.status}</div>}</td>
                        <td className="sm faint">{s.industry || '—'}</td>
                        <td className="sm faint">{[s.state, s.country].filter(Boolean).join(', ') || '—'}</td>
                        <td className="sm">
                          {c.firstName ? <>
                            <div>{c.firstName} {c.lastName}</div>
                            <div className="xs faint">{c.jobTitle}</div>
                            <div className="xs" style={{ color: c.hasWorkEmail ? 'var(--green)' : 'var(--amber)' }}>
                              {c.hasWorkEmail ? '✓ email on file' : '✕ no email'}
                            </div>
                          </> : '—'}
                        </td>
                        <td>
                          <div className="row wrap" style={{ gap: 4 }}>
                            {(s.materialTags || []).slice(0, 3).map((t) => <span key={t} className="chip xs">{t.replace(/_/g, ' ')}</span>)}
                          </div>
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </Page>
  );
}
