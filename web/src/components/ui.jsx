import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';

/* Provenance labelling is a hard requirement of the spec: a viewer must always
   be able to tell live graph8 data from a calculation from illustrative demo
   content. Every surface that shows a fact carries one of these. */
const PROV = {
  graph8_live: ['prov-live', 'graph8 live'],
  live: ['prov-live', 'live'],
  supplier_provided: ['prov-live', 'supplier provided'],
  derived: ['prov-derived', 'calculated'],
  mixed: ['prov-derived', 'mixed sources'],
  user: ['prov-user', 'user entered'],
  user_entered: ['prov-user', 'user entered'],
  demo: ['prov-demo', 'illustrative'],
};

export function Prov({ kind = 'demo', label }) {
  const [cls, text] = PROV[kind] || PROV.demo;
  return <span className={`prov ${cls}`}>{label || text}</span>;
}

export function Badge({ children, tone = 'neutral', dot }) {
  return <span className={`badge badge-${tone}`}>{dot && <span className="badge-dot" />}{children}</span>;
}

export function Card({ children, className = '', large, flat, ...rest }) {
  return <div className={`card ${large ? 'card-lg' : ''} ${flat ? 'card-flat' : ''} ${className}`} {...rest}>{children}</div>;
}

export function CardHead({ title, note, right }) {
  return (
    <div className="card-head">
      <div>
        <div className="card-title">{title}</div>
        {note && <div className="card-note">{note}</div>}
      </div>
      {right}
    </div>
  );
}

export function Callout({ tone, icon = 'ℹ', children }) {
  return <div className={`callout ${tone ? `callout-${tone}` : ''}`}><span className="callout-icon">{icon}</span><div>{children}</div></div>;
}

export function Stat({ label, value, hint, tone }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone ? { color: `var(--${tone})` } : undefined}>
        <CountUp value={value} />
      </div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function CountUp({ value, duration = 560 }) {
  const numeric = typeof value === 'number' && Number.isFinite(value);
  const [n, setN] = useState(numeric ? 0 : value);
  useEffect(() => {
    if (!numeric) { setN(value); return; }
    if (value === 0) { setN(0); return; }
    let raf; const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      setN(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, numeric]);
  return <>{numeric ? n.toLocaleString() : n}</>;
}

export function Page({ title, sub, right, fill = false, children }) {
  return (
    <motion.div className={fill ? 'page page-fill' : 'page'}
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .3, ease: [0.16, 1, 0.3, 1] }}>
      <div className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </motion.div>
  );
}

export function Empty({ title, children }) {
  return <div className="empty">{title && <div className="empty-title">{title}</div>}{children}</div>;
}

export function Skeleton({ h = 18, w = '100%', style }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

export function Avatar({ name = '' }) {
  const initials = name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  return <div className="avatar">{initials || '?'}</div>;
}

/** Key/value row that renders missing data as "Not provided" rather than blank
    or, worse, a guess. */
export function KV({ k, v, missing = 'Not provided' }) {
  const empty = v === null || v === undefined || v === '';
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className={`kv-v ${empty ? 'kv-missing' : ''}`}>{empty ? missing : v}</span>
    </div>
  );
}

const STATUS_TONE = {
  submitted: 'neutral', researching: 'accent', awaiting_review: 'accent',
  needs_info: 'amber', rfq_prepared: 'violet', awaiting_quotes: 'violet',
  quotes_in: 'accent', approved: 'green', rejected: 'red', revision_requested: 'amber',
};
const STATUS_LABEL = {
  submitted: 'Submitted', researching: 'Researching', awaiting_review: 'Awaiting review',
  needs_info: 'Needs info', rfq_prepared: 'RFQ prepared', awaiting_quotes: 'Awaiting quotes',
  quotes_in: 'Quotes in', approved: 'Approved', rejected: 'Rejected', revision_requested: 'Revision requested',
};
export function StatusBadge({ status }) {
  return <Badge tone={STATUS_TONE[status] || 'neutral'} dot>{STATUS_LABEL[status] || status}</Badge>;
}

const PRIO_TONE = { routine: 'neutral', urgent: 'amber', critical: 'red' };
export function PriorityBadge({ priority }) {
  return <Badge tone={PRIO_TONE[priority] || 'neutral'}>{priority}</Badge>;
}

/** Inline stock projection sparkline. Shows the zero line and the safety
    level so a dip below either is visible at a glance. */
export function StockSpark({ series, safetyStock, width = 260, height = 58 }) {
  if (!series?.length) return null;
  const vals = series.map((p) => p.projected);
  const max = Math.max(...vals, safetyStock, 0);
  const min = Math.min(...vals, 0);
  const span = max - min || 1;
  const x = (i) => (i / (series.length - 1)) * width;
  const y = (v) => height - ((v - min) / span) * height;

  const path = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.projected).toFixed(1)}`).join(' ');
  const area = `${path} L${width},${y(min)} L0,${y(min)} Z`;
  const negative = vals.some((v) => v < 0);
  const stroke = negative ? 'var(--red)' : vals.some((v) => v < safetyStock) ? 'var(--amber)' : 'var(--green)';

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" y1={y(safetyStock)} x2={width} y2={y(safetyStock)} stroke="var(--line-2)" strokeWidth="1" strokeDasharray="3 3" />
      {min < 0 && <line x1="0" y1={y(0)} x2={width} y2={y(0)} stroke="var(--red)" strokeWidth="1" opacity=".35" />}
      <motion.path d={area} fill={stroke} opacity=".08"
        initial={{ opacity: 0 }} animate={{ opacity: .08 }} transition={{ duration: .5 }} />
      <motion.path d={path} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round"
        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: .75, ease: [0.16, 1, 0.3, 1] }} />
    </svg>
  );
}

export function useAsync(fn, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => { if (alive) { setData(d); setError(null); } })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => run(), [run]);
  return { data, error, loading, reload: run, setData };
}

export const fmt = {
  n: (v, dp = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })),
  money: (v, ccy = 'USD') => (v === null || v === undefined ? '—' : `${ccy} ${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`),
  days: (d) => (d === null || d === undefined ? '—' : `${d} day${Math.abs(d) === 1 ? '' : 's'}`),

  /** A negative order-by day means the window has already closed. Saying
      "order by day 0" would read as on-time; it is not. */
  orderBy: (d) => {
    if (d === null || d === undefined) return 'no order needed';
    if (d < 0) return `order overdue by ${Math.abs(d)}d`;
    if (d === 0) return 'order today';
    return `order within ${d}d`;
  },
};
