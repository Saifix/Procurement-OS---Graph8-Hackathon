import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api.js';
import { Badge, Callout } from './ui.jsx';

/**
 * Runs one of graph8's own prebuilt system skills against a company we hold.
 *
 * These are not skills we wrote — they ship with every graph8 org and are the
 * same ones available inside the graph8 product. Product/Service Mapping is
 * the default because "what does this company actually sell" is the question
 * that catches a plausible-looking record being wrong.
 */
const SKILLS = [
  { key: 'productMapping', label: 'What do they actually sell?' },
  { key: 'deepResearch', label: 'Deep company research' },
  { key: 'riskAnalysis', label: 'Risk analysis' },
  { key: 'buyingSignals', label: 'Buying signals' },
];

/** The reports come back as markdown prose; render the structure that matters
    without pulling in a full markdown dependency. */
function Markdown({ text }) {
  const lines = (text || '').split('\n');
  return (
    <div className="col" style={{ gap: 6 }}>
      {lines.map((ln, i) => {
        const t = ln.trim();
        if (!t) return <div key={i} style={{ height: 4 }} />;
        if (t === '---') return <div key={i} className="divider" style={{ margin: '6px 0' }} />;
        if (t.startsWith('### ')) return <div key={i} className="sm strong" style={{ marginTop: 6 }}>{t.slice(4)}</div>;
        if (t.startsWith('## ')) return <div key={i} className="strong" style={{ fontSize: 14, marginTop: 8 }}>{t.slice(3)}</div>;
        if (t.startsWith('# ')) return <div key={i} className="strong" style={{ fontSize: 15, marginTop: 8 }}>{t.slice(2)}</div>;
        if (/^[-*]\s/.test(t)) return <div key={i} className="sm muted" style={{ paddingLeft: 12 }}>• {inline(t.slice(2))}</div>;
        if (/^\d+\.\s/.test(t)) return <div key={i} className="sm muted" style={{ paddingLeft: 12 }}>{inline(t)}</div>;
        return <div key={i} className="sm muted">{inline(t)}</div>;
      })}
    </div>
  );
}

/** Bold spans only — enough for these reports, and no HTML injection. */
function inline(t) {
  const parts = t.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i}>{p.slice(2, -2)}</strong>
      : <React.Fragment key={i}>{p}</React.Fragment>
  );
}

export default function DeepDive({ entity, id, company, compact }) {
  const [skill, setSkill] = useState('productMapping');
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);

  const run = async (key = skill, force = false) => {
    setBusy(true); setError(null); setSkill(key);
    try {
      const cached = force ? null : await api.getDeepDive(entity, id, key).catch(() => null);
      if (cached?.report) { setReport(cached.report); setOpen(true); return; }
      const r = await api.deepDive({ entity, id, skill: key, force });
      setReport(r.report); setOpen(true);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className={compact ? '' : 'mt'}>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn btn-sm" onClick={() => (report && open ? setOpen(false) : run())} disabled={busy}>
          {busy ? 'graph8 is researching…' : report && open ? 'Hide report' : 'Deep dive with graph8'}
        </button>
        {report && open && (
          <select className="select" style={{ width: 'auto', padding: '5px 28px 5px 10px', fontSize: 12 }}
            value={skill} onChange={(e) => run(e.target.value)} disabled={busy}>
            {SKILLS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        )}
      </div>

      {error && <div className="mt"><Callout tone="red" icon="✕">{error}</Callout></div>}

      <AnimatePresence>
        {open && report && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            style={{ overflow: 'hidden' }}>
            <div className="card card-flat mt" style={{ background: 'var(--surface-2)' }}>
              <div className="row-between" style={{ marginBottom: 10 }}>
                <div>
                  <div className="card-title">{report.skillName}</div>
                  <div className="card-note">graph8 system skill · {company}</div>
                </div>
                <div className="row" style={{ gap: 7 }}>
                  <Badge tone="green" dot>graph8 built-in</Badge>
                  <button className="btn btn-sm btn-ghost" onClick={() => run(skill, true)} disabled={busy}>Re-run</button>
                </div>
              </div>

              <Markdown text={report.markdown} />

              <div className="divider" />
              <div className="xs dim">
                {report.meta?.webSearches || 0} web search{report.meta?.webSearches === 1 ? '' : 'es'} ·{' '}
                {report.meta?.model} · {((report.meta?.durationMs || 0) / 1000).toFixed(0)}s ·{' '}
                ${(report.meta?.costUsd || 0).toFixed(4)} · this skill ships with graph8, we did not write it
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
