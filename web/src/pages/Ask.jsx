import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, Badge, Callout, Prov, useAsync } from '../components/ui.jsx';

const STARTERS = [
  'Which materials are at risk, and which is most urgent?',
  "We're low on tomato paste at Kabirwala — 50 tonnes before end of November, urgent",
  'How many quotations do we have and which supplier is cheapest?',
  'Should we buy tomato paste now or wait a month if prices rise 15%?',
  'Find buyers for our 500 ml ketchup and qualify the top three',
];

const TOOL_LABEL = {
  sql: 'Querying Postgres',
  list_products: 'Reading what we can sell',
  list_materials: 'Reading the material catalogue',
  list_sites: 'Reading sites',
  inventory_projection: 'Projecting stock',
  raise_requirement: 'Raising a requirement',
  get_requirement: 'Opening the requirement',
  discover_suppliers: 'Searching graph8 for suppliers',
  research_supplier: 'graph8 is researching the company',
  shortlist_suppliers: 'Shortlisting',
  draft_rfqs: 'Drafting RFQs',
  send_rfq: 'Sending the RFQ',
  compare_quotes: 'Comparing quotations',
  forward_buy: 'Running buy-now vs buy-later',
  find_buyers: 'Finding buyers in graph8',
  qualify_buyers: 'graph8 is qualifying buyers',
};

/** The four things the copilot can actually do, in the order a procurement
    person would reach for them. `graph8` marks the tools that leave the box
    and hit graph8's API rather than the local Postgres. */
const TOOL_GROUPS = [
  { title: 'Look things up', names: ['sql', 'list_materials', 'list_sites', 'inventory_projection'] },
  { title: 'Raise and plan', names: ['raise_requirement', 'get_requirement', 'forward_buy'] },
  { title: 'Source suppliers', names: ['discover_suppliers', 'research_supplier', 'shortlist_suppliers', 'draft_rfqs', 'send_rfq', 'compare_quotes'] },
  { title: 'Sell our products', names: ['list_products', 'find_buyers', 'qualify_buyers'] },
];
const GRAPH8_TOOLS = new Set(['discover_suppliers', 'research_supplier', 'find_buyers', 'qualify_buyers']);

function Toolbox({ tools }) {
  const [open, setOpen] = useState(null);
  const byName = new Map((tools || []).map((t) => [t.name, t]));
  const grouped = TOOL_GROUPS
    .map((g) => ({ ...g, items: g.names.map((n) => byName.get(n)).filter(Boolean) }))
    .filter((g) => g.items.length);

  // anything the server exposes that this file does not know about yet
  const known = new Set(TOOL_GROUPS.flatMap((g) => g.names));
  const rest = (tools || []).filter((t) => !known.has(t.name));
  if (rest.length) grouped.push({ title: 'Other', items: rest });

  return (
    <div className="toolbox">
      {grouped.map((g) => (
        <div className="tool-group" key={g.title}>
          <div className="tool-group-head">{g.title}</div>
          {g.items.map((t) => (
            <button
              key={t.name}
              className={`tool-row ${open === t.name ? 'open' : ''}`}
              onClick={() => setOpen(open === t.name ? null : t.name)}
              aria-expanded={open === t.name}>
              <span className="tool-row-top">
                <span className="tool-label">{TOOL_LABEL[t.name] || t.name}</span>
                {GRAPH8_TOOLS.has(t.name) && <span className="tool-tag">graph8</span>}
              </span>
              <code className="tool-code">{t.name}</code>
              <span className="tool-desc">{t.description}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "4m ago" style stamps for the conversation list. */
function relTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Minimal markdown: headings, bold, bullets and pipe tables. */
function Rich({ text }) {
  const lines = String(text || '').split('\n');
  const out = [];
  let table = null;

  const flush = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(
      <div key={`t${out.length}`} style={{ overflowX: 'auto', margin: '8px 0' }}>
        <table className="table">
          <thead><tr>{head.map((h, i) => <th key={i}>{inline(h)}</th>)}</tr></thead>
          <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    );
    table = null;
  };

  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (/^\|.*\|$/.test(t)) {
      const cells = t.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // separator row
      (table ||= []).push(cells);
      return;
    }
    flush();
    if (!t) { out.push(<div key={i} style={{ height: 6 }} />); return; }
    if (/^#{1,3}\s/.test(t)) { out.push(<div key={i} className="strong" style={{ fontSize: 14, marginTop: 6 }}>{inline(t.replace(/^#+\s/, ''))}</div>); return; }
    if (/^[-*]\s/.test(t)) { out.push(<div key={i} style={{ paddingLeft: 14 }}>• {inline(t.slice(2))}</div>); return; }
    if (/^\d+\.\s/.test(t)) { out.push(<div key={i} style={{ paddingLeft: 14 }}>{inline(t)}</div>); return; }
    out.push(<div key={i}>{inline(t)}</div>);
  });
  flush();
  return <div className="col" style={{ gap: 2 }}>{out}</div>;
}

function inline(t) {
  return String(t).split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="mono xs" style={{ background: 'var(--surface-3)', padding: '1px 5px', borderRadius: 4 }}>{p.slice(1, -1)}</code>;
    return <React.Fragment key={i}>{p}</React.Fragment>;
  });
}

/** The agent's working: which tools it ran, with arguments and outcome. */
function Steps({ steps }) {
  const [open, setOpen] = useState(false);
  if (!steps?.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} {steps.length} tool call{steps.length === 1 ? '' : 's'}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} style={{ overflow: 'hidden' }}>
            <div className="col" style={{ gap: 8, marginTop: 8 }}>
              {steps.map((s, i) => (
                <div key={i} className="card card-flat" style={{ background: 'var(--surface-2)', padding: 11 }}>
                  <div className="row-between">
                    <span className="sm strong mono">{s.tool}</span>
                    <Badge tone={s.ok ? 'green' : 'red'} dot>{s.ok ? 'ok' : 'failed'}</Badge>
                  </div>
                  {s.thought && <div className="xs faint" style={{ marginTop: 3 }}>{s.thought}</div>}
                  {s.args && Object.keys(s.args).length > 0 && (
                    <pre className="mono xs" style={{ marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-3)' }}>
                      {JSON.stringify(s.args, null, 1).slice(0, 400)}
                    </pre>
                  )}
                  {s.error && <div className="xs" style={{ color: 'var(--red)', marginTop: 5 }}>{s.error}</div>}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function Ask({ role }) {
  const navigate = useNavigate();
  const tools = useAsync(() => api.chatTools(), []);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState(null);
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const endRef = useRef(null);

  const LAST_KEY = `copilot:last:${role}`;

  const refreshHistory = async () => {
    try {
      const d = await api.conversations(role);
      setHistory(d.conversations || []);
    } catch { /* history is a convenience; never block the chat on it */ }
  };

  const newChat = () => {
    setMessages([]);
    setConvId(null);
    try { localStorage.removeItem(LAST_KEY); } catch {}
  };

  const openConversation = async (id) => {
    try {
      const conv = await api.conversation(id);
      setMessages(conv.messages || []);
      setConvId(id);
      setShowHistory(false);
      try { localStorage.setItem(LAST_KEY, id); } catch {}
    } catch { /* deleted underneath us — leave the current thread alone */ }
  };

  // Reopen wherever this role left off, and load the picker list.
  useEffect(() => {
    setMessages([]);
    setConvId(null);
    refreshHistory();
    let last = null;
    try { last = localStorage.getItem(LAST_KEY); } catch {}
    if (last) openConversation(last);
  }, [role]);

  // `block: 'nearest'` keeps the scroll inside the transcript card. With 'end'
  // the browser also walks up and scrolls the page itself, which is what made
  // the composer drift off the bottom of the window.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, busy]);

  const send = async (content) => {
    const body = (content ?? text).trim();
    if (!body || busy) return;
    const next = [...messages, { role: 'user', content: body }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const out = await api.chat(next.map((m) => ({ role: m.role, content: m.content })), role, convId);
      setMessages([...next, {
        role: 'assistant', content: out.reply, steps: out.steps,
        suggestions: out.suggestions, degraded: out.degraded, meta: out.meta,
      }]);
      if (out.conversationId) {
        setConvId(out.conversationId);
        try { localStorage.setItem(LAST_KEY, out.conversationId); } catch {}
      }
      refreshHistory();
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: `That failed: ${err.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const available = tools.data?.available;

  return (
    <Page
      title="Copilot"
      sub="Ask for anything in the workspace. It queries Postgres, runs the sourcing tools and reports what actually happened."
      right={<Badge tone={available ? 'green' : 'neutral'} dot>{available ? `graph8 agent · ${tools.data?.tools?.length ?? 0} tools` : 'needs GRAPH8_API_KEY'}</Badge>}
      fill
    >
      {!available && (
        <Callout tone="amber" icon="⚠">
          The copilot runs on a graph8 LLM skill, so it needs <span className="mono">GRAPH8_API_KEY</span> set.
          The rest of the app still works without it.
        </Callout>
      )}

      <div className="grid grid-side chat-grid">
        <div className="chat-main">
          <Card large className="chat-scroll">
            {messages.length === 0 && (
              <div className="col" style={{ gap: 14, padding: '18px 4px' }}>
                <div>
                  <div className="strong" style={{ fontSize: 16 }}>What do you need?</div>
                  <div className="faint sm" style={{ marginTop: 4 }}>
                    It can raise requirements, search graph8 for suppliers and buyers, run research, compare
                    quotes and query the database directly.
                  </div>
                </div>
                <div className="col" style={{ gap: 7 }}>
                  {STARTERS.map((s) => (
                    <button key={s} className="role-card" onClick={() => send(s)} disabled={busy || !available}>
                      <span className="sm muted">{s}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="col" style={{ gap: 16 }}>
              {convId && messages.length > 0 && (
                <div className="conv-resumed">
                  Continuing a saved conversation — anything you send carries on from here.
                  <button className="conv-resumed-new" onClick={newChat} disabled={busy}>Start fresh</button>
                </div>
              )}
              {messages.map((m, i) => (
                <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .22 }}>
                  {m.role === 'user' ? (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div style={{ background: 'var(--g8-grad)', color: '#fff', padding: '9px 14px', borderRadius: 16, maxWidth: '82%', fontSize: 13.5 }}>
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div>
                      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                        <Prov kind={m.error || m.degraded ? 'demo' : 'live'} label={m.error ? 'error' : 'graph8 copilot'} />
                        {m.meta?.costUsd != null && (
                          <span className="xs dim">{(m.meta.durationMs / 1000).toFixed(1)}s · ${m.meta.costUsd.toFixed(4)}</span>
                        )}
                      </div>
                      <div className="sm" style={{ lineHeight: 1.6 }}><Rich text={m.content} /></div>
                      <Steps steps={m.steps} />
                      {m.suggestions?.length > 0 && (
                        <div className="row wrap" style={{ gap: 7, marginTop: 11 }}>
                          {m.suggestions.map((s) => (
                            <button key={s} className="chip" style={{ cursor: 'pointer', border: '1px solid var(--line-2)' }}
                              onClick={() => send(s)} disabled={busy}>{s}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              ))}

              {busy && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="row" style={{ gap: 9 }}>
                  <span className="prov prov-live pulse">working</span>
                  <span className="sm faint">Thinking, and calling tools where it needs to…</span>
                </motion.div>
              )}
              <div ref={endRef} />
            </div>
          </Card>

          <Card className="chat-composer">
            <textarea
              className="textarea"
              style={{ minHeight: 72, fontSize: 14.5 }}
              placeholder={available ? 'Ask, or tell it what to do…' : 'Set GRAPH8_API_KEY to enable the copilot'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              disabled={busy || !available}
            />
            <div className="row-between mt">
              <div className="row" style={{ gap: 9 }}>
                <button className="btn btn-primary" onClick={() => send()} disabled={busy || !text.trim() || !available}>
                  {busy ? 'Working…' : 'Send'}
                </button>
                {messages.length > 0 && (
                  <button className="btn" onClick={newChat} disabled={busy}>New conversation</button>
                )}

              </div>
              <span className="xs dim">Enter to send · Shift+Enter for a new line</span>
            </div>
          </Card>
        </div>

        <div className="col chat-rail" style={{ gap: 14 }}>
          {history.length > 0 && (
            <Card>
              <div className="card-head" style={{ marginBottom: 10 }}>
                <div>
                  <div className="card-title">Conversations</div>
                  <div className="card-note">Pick one up where you left it</div>
                </div>
                <Prov kind="derived" label="postgres" />
              </div>
              <div className="conv-list">
                {(showHistory ? history : history.slice(0, 5)).map((h) => (
                  <div key={h.id} className={`conv-row ${h.id === convId ? 'current' : ''}`}>
                    <button className="conv-open" onClick={() => openConversation(h.id)} disabled={busy}>
                      <span className="conv-title">{h.title}</span>
                      <span className="conv-meta">
                        {h.id === convId ? 'open · ' : ''}{h.messageCount} message{h.messageCount === 1 ? '' : 's'} · {relTime(h.updatedAt)}
                      </span>
                    </button>
                    <button className="conv-del" aria-label="Delete conversation" disabled={busy}
                      onClick={async () => {
                        await api.deleteConversation(h.id).catch(() => {});
                        if (h.id === convId) { setMessages([]); setConvId(null); }
                        refreshHistory();
                      }}>×</button>
                  </div>
                ))}
              </div>
              <div className="row-between" style={{ marginTop: 10 }}>
                <button className="btn btn-sm" onClick={newChat}
                  disabled={busy || (!messages.length && !convId)}>New chat</button>
                {history.length > 5 && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setShowHistory((v) => !v)}>
                    {showHistory ? 'Show fewer' : `Show all ${history.length}`}
                  </button>
                )}
              </div>
            </Card>
          )}

          <Card>
            <div className="card-head">
              <div>
                <div className="card-title">What it can do</div>
                <div className="card-note">
                  {tools.data?.tools?.length || 0} real tools · same code paths as the UI
                </div>
              </div>
              <Prov kind="live" />
            </div>
            <Toolbox tools={tools.data?.tools} />
          </Card>

          <Callout icon="ℹ">
            Anything that contacts a supplier or records a decision is confirmed with you first. The agent
            reports what a tool actually returned — it never claims to have sent or ordered something.
          </Callout>

          <Card>
            <div className="card-title">Where the data lives</div>
            <div className="col xs faint mt" style={{ gap: 5 }}>
              <div>• Records in self-hosted Postgres — the agent queries it with real SQL</div>
              <div>• Supplier and buyer discovery from the graph8 index</div>
              <div>• Research from graph8's own skills, with web search</div>
              <div>• Email over the bundled SMTP server</div>
            </div>
            <div className="row mt" style={{ gap: 8 }}>
              <button className="btn btn-sm" onClick={() => navigate('/raise')}>Use the form instead</button>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
