import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import {
  Page, Card, CardHead, Stat, Badge, Callout, Prov, StatusBadge, PriorityBadge,
  useAsync, Skeleton, Empty, fmt,
} from '../components/ui.jsx';

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, loading } = useAsync(() => api.dashboard(), []);
  const d = data;

  return (
    <Page
      title="Procurement overview"
      sub="Consolidated demand, sourcing activity and material risk. Every figure is computed from the records that exist right now."
      right={<button className="btn btn-primary" onClick={() => navigate('/raise')}>Raise requirement</button>}
    >
      <div className="grid grid-4">
        {loading || !d ? Array.from({ length: 4 }).map((_, i) => <Card key={i}><Skeleton h={62} /></Card>) : (
          <>
            <Card><Stat label="Open requirements" value={d.counts.open} hint={`${d.counts.requirements} raised in total`} /></Card>
            <Card><Stat label="Awaiting decision" value={d.counts.awaitingDecision} hint="quotes in or out for quote" /></Card>
            <Card><Stat label="Due within 14 days" value={d.counts.atRisk} tone={d.counts.atRisk ? 'amber' : undefined} hint="not yet approved" /></Card>
            <Card><Stat label="Material shortages" value={d.counts.shortages + d.counts.belowSafety} tone={(d.counts.shortages + d.counts.belowSafety) ? 'red' : undefined} hint={`${d.counts.shortages} stockout, ${d.counts.belowSafety} below safety`} /></Card>
          </>
        )}
      </div>

      {d && (
        <div className="grid grid-side mt-lg">
          <div className="col" style={{ gap: 16 }}>

            <Card large>
              <CardHead
                title="Requirements needing attention"
                note="Closest required-by date first"
                right={<Prov kind="user" label="workspace records" />}
              />
              {d.atRisk.length === 0 && d.awaitingDecision.length === 0 ? (
                <Empty title="Nothing outstanding">
                  No requirement is inside 14 days or waiting on a decision.{' '}
                  <button className="btn btn-sm" onClick={() => navigate('/raise')}>Raise one</button>
                </Empty>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="table">
                    <thead><tr><th>ID</th><th>Material</th><th>Site</th><th className="num">Qty</th><th>Due</th><th>Priority</th><th>Status</th></tr></thead>
                    <tbody>
                      {[...d.atRisk, ...d.awaitingDecision.filter((x) => !d.atRisk.find((y) => y.id === x.id))].map((r, i) => (
                        <motion.tr key={r.id}
                          initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * .04 }}
                          style={{ cursor: 'pointer' }} onClick={() => navigate(`/requirements/${r.id}`)}>
                          <td className="mono xs">{r.id}</td>
                          <td className="strong">{r.materialName}</td>
                          <td className="faint sm">{r.siteName}</td>
                          <td className="num tnum">{fmt.n(r.quantity)} {r.uom}</td>
                          <td className={r.daysToRequired <= 7 ? 'strong' : ''} style={r.daysToRequired <= 7 ? { color: 'var(--red)' } : undefined}>
                            {r.daysToRequired < 0 ? `${Math.abs(r.daysToRequired)}d overdue` : `${r.daysToRequired}d`}
                          </td>
                          <td><PriorityBadge priority={r.priority} /></td>
                          <td><StatusBadge status={r.status} /></td>
                        </motion.tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card large>
              <CardHead
                title="Material risk from the production plan"
                note="Projected against the current ketchup line plan"
                right={<Prov kind="derived" />}
              />
              {d.shortageRows.length === 0 ? (
                <Empty>No material falls below safety stock in the current horizon.</Empty>
              ) : (
                <div className="col" style={{ gap: 0 }}>
                  {d.shortageRows.map((r, i) => (
                    <motion.div key={r.materialId}
                      initial={{ opacity: 0, x: -5 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * .045 }}
                      className="row-between" style={{ padding: '11px 0', borderBottom: '1px solid var(--line)' }}>
                      <div>
                        <div className="sm strong">{r.materialName}</div>
                        <div className="xs faint">
                          {r.status === 'shortage'
                            ? `Stock out on day ${r.shortageDay} · ${fmt.orderBy(r.orderByDay)}`
                            : `Below safety on day ${r.safetyBreachDay} · ${fmt.orderBy(r.orderByDay)}`}
                        </div>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="xs faint tnum">{fmt.n(r.suggestedOrderQty)} {r.uom}</span>
                        <Badge tone={r.status === 'shortage' ? 'red' : 'amber'} dot>
                          {r.status === 'shortage' ? 'shortage' : 'below safety'}
                        </Badge>
                      </div>
                    </motion.div>
                  ))}
                  <div className="mt">
                    <button className="btn btn-sm" onClick={() => navigate('/inventory')}>Open inventory planning →</button>
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <CardHead title="Quoted spend exposure" note="Only counted where a real priced quotation exists" right={<Prov kind="derived" />} />
              {d.quotedLines === 0 ? (
                <Callout icon="—">{d.exposureNote}</Callout>
              ) : (
                <>
                  <div className="stat-value">{fmt.money(d.quotedExposure)}</div>
                  <div className="stat-hint">{d.exposureNote}</div>
                </>
              )}
            </Card>
          </div>

          <div className="col" style={{ gap: 16 }}>
            <Card>
              <CardHead title="Pipeline" note="By status" />
              {Object.keys(d.byStatus).length === 0 ? <Empty>No requirements yet.</Empty> : (
                <div className="col" style={{ gap: 9 }}>
                  {Object.entries(d.byStatus).map(([s, n]) => (
                    <div key={s} className="row-between">
                      <StatusBadge status={s} />
                      <span className="tnum strong">{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card>
              <CardHead title="Sourcing activity" />
              <div className="col" style={{ gap: 9 }}>
                <div className="row-between"><span className="faint sm">RFQs prepared</span><span className="tnum strong">{d.counts.rfqs}</span></div>
                <div className="row-between"><span className="faint sm">RFQs delivered</span><span className="tnum strong">{d.counts.rfqsSent}</span></div>
                <div className="row-between"><span className="faint sm">Quotations recorded</span><span className="tnum strong">{d.counts.quotes}</span></div>
                <div className="row-between"><span className="faint sm">Decisions taken</span><span className="tnum strong">{d.counts.decisions}</span></div>
              </div>
              {d.counts.rfqs > 0 && d.counts.rfqsSent > 0 && (
                <div className="mt">
                  <Callout tone="green" icon="✓">
                    {d.counts.rfqsSent} of {d.counts.rfqs} RFQ{d.counts.rfqs === 1 ? '' : 's'} delivered over SMTP.
                  </Callout>
                </div>
              )}
              {d.counts.rfqs > 0 && d.counts.rfqsSent === 0 && (
                <div className="mt">
                  <Callout icon="ℹ">Drafts are ready. Approve one to send it.</Callout>
                </div>
              )}
            </Card>

            <Card>
              <CardHead title="Recent activity" />
              {d.activity.length === 0 ? <Empty>Nothing yet.</Empty> : (
                <div className="col" style={{ gap: 11 }}>
                  {d.activity.map((a, i) => (
                    <motion.div key={a.id} initial={{ opacity: 0, x: 5 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * .03 }}>
                      <div className="row" style={{ gap: 7 }}>
                        <Prov kind={a.provenance === 'live' ? 'live' : a.provenance === 'user' ? 'user' : 'demo'} />
                        <span className="xs dim">{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="sm" style={{ marginTop: 2 }}>{a.message}</div>
                    </motion.div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </Page>
  );
}
