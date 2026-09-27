import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, StatusBadge, PriorityBadge, useAsync, Skeleton, Empty, Prov, fmt } from '../components/ui.jsx';

export default function Requirements({ workspace }) {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({ status: '', siteId: '', priority: '', category: '' });
  const { data, loading } = useAsync(() => api.requirements(filters), [filters.status, filters.siteId, filters.priority, filters.category]);

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const clear = () => setFilters({ status: '', siteId: '', priority: '', category: '' });
  const active = Object.values(filters).some(Boolean);

  return (
    <Page
      title="Requirements"
      sub="Every requirement raised in this workspace. Filters query the records — they do not hide rows client-side."
      right={<button className="btn btn-primary" onClick={() => navigate('/raise')}>Raise requirement</button>}
    >
      <Card flat style={{ background: 'var(--surface)' }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="field" style={{ minWidth: 165 }}>
            <label className="label" htmlFor="f-status">Status</label>
            <select id="f-status" className="select" value={filters.status} onChange={set('status')}>
              <option value="">All statuses</option>
              {['submitted', 'researching', 'awaiting_review', 'needs_info', 'rfq_prepared', 'awaiting_quotes', 'quotes_in', 'approved', 'rejected', 'revision_requested'].map((s) => (
                <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
              ))}
            </select>
          </div>
          <div className="field" style={{ minWidth: 175 }}>
            <label className="label" htmlFor="f-site">Site</label>
            <select id="f-site" className="select" value={filters.siteId} onChange={set('siteId')}>
              <option value="">All sites</option>
              {workspace.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 145 }}>
            <label className="label" htmlFor="f-prio">Priority</label>
            <select id="f-prio" className="select" value={filters.priority} onChange={set('priority')}>
              <option value="">All priorities</option>
              <option value="routine">Routine</option>
              <option value="urgent">Urgent</option>
              <option value="critical">Critical</option>
            </select>
          </div>
          <div className="field" style={{ minWidth: 155 }}>
            <label className="label" htmlFor="f-cat">Category</label>
            <select id="f-cat" className="select" value={filters.category} onChange={set('category')}>
              <option value="">All categories</option>
              {workspace.categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          {active && <button className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-end' }} onClick={clear}>Clear filters</button>}
        </div>
      </Card>

      <Card large className="mt">
        <div className="card-head">
          <div>
            <div className="card-title">{loading ? 'Loading…' : `${data?.total ?? 0} requirement${data?.total === 1 ? '' : 's'}`}</div>
            <div className="card-note">Soonest required-by first</div>
          </div>
          <Prov kind="user" label="workspace records" />
        </div>

        {loading && <Skeleton h={180} />}
        {!loading && data?.total === 0 && (
          <Empty title={active ? 'No matches' : 'No requirements yet'}>
            {active ? 'No requirement matches these filters.' : 'Raise the first requirement to start the workflow.'}{' '}
            <button className="btn btn-sm" onClick={active ? clear : () => navigate('/raise')}>
              {active ? 'Clear filters' : 'Raise requirement'}
            </button>
          </Empty>
        )}

        {!loading && data?.total > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th><th>Title</th><th>Material</th><th>Site</th>
                  <th className="num">Qty</th><th>Due</th><th>Priority</th><th>Status</th><th className="num">Progress</th>
                </tr>
              </thead>
              <tbody>
                {data.requirements.map((r, i) => (
                  <motion.tr key={r.id}
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * .035, .4) }}
                    style={{ cursor: 'pointer' }} onClick={() => navigate(`/requirements/${r.id}`)}>
                    <td className="mono xs">{r.id}</td>
                    <td className="strong">{r.title}</td>
                    <td className="sm faint">{r.materialName}</td>
                    <td className="sm faint">{r.siteName}</td>
                    <td className="num tnum">{fmt.n(r.quantity)} {r.uom}</td>
                    <td className="sm" style={r.daysToRequired <= 7 ? { color: 'var(--red)', fontWeight: 600 } : undefined}>
                      {r.overdue ? `${Math.abs(r.daysToRequired)}d overdue` : `${r.daysToRequired}d`}
                    </td>
                    <td><PriorityBadge priority={r.priority} /></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="num xs faint tnum">
                      {r.counts.shortlisted}·{r.counts.rfqs}·{r.counts.quotes}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
            <div className="xs dim mt">Progress column: shortlisted · RFQs · quotations.</div>
          </div>
        )}
      </Card>
    </Page>
  );
}
