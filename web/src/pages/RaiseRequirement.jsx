import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, CardHead, Callout, Prov, Badge } from '../components/ui.jsx';

const todayPlus = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function RaiseRequirement({ role, workspace }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Arriving from a reorder recommendation pre-fills the material and quantity.
  const [form, setForm] = useState({
    title: params.get('title') || '',
    materialId: params.get('materialId') || workspace.materials[0]?.id || '',
    siteId: workspace.sites[0]?.id || '',
    quantity: params.get('quantity') || '',
    requiredBy: params.get('requiredBy') || todayPlus(30),
    priority: params.get('priority') || 'routine',
    specification: '',
    notes: params.get('notes') || '',
    targetPrice: '',
    reason: params.get('reason') || '',
    raisedBy: role,
  });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState(null);

  const material = workspace.materials.find((m) => m.id === form.materialId);
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    if (errors[k]) setErrors({ ...errors, [k]: undefined });
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setServerError(null);
    try {
      const { requirement } = await api.createRequirement(form);
      navigate(`/requirements/${requirement.id}?new=1`);
    } catch (err) {
      if (err.errors) setErrors(err.errors);
      else setServerError(err.message);
      setBusy(false);
    }
  };

  const err = (k) => errors[k];

  return (
    <Page
      title="Raise a requirement"
      sub="Submitting this creates a real record and starts supplier research against the values you enter. Change the material, quantity or date and the research changes with it."
    >
      <form onSubmit={submit}>
        <div className="grid grid-side">
          <Card large>
            <CardHead title="Requirement details" note="Fields marked with * are required" />

            <div className="col" style={{ gap: 16 }}>
              <div className="field">
                <label className="label" htmlFor="title">Request title *</label>
                <input id="title" className={`input ${err('title') ? 'input-err' : ''}`}
                  placeholder="e.g. Tomato paste top-up for Q4 ketchup run"
                  value={form.title} onChange={set('title')} />
                {err('title') && <span className="err-text">{err('title')}</span>}
              </div>

              <div className="grid grid-2" style={{ gap: 14 }}>
                <div className="field">
                  <label className="label" htmlFor="material">Material *</label>
                  <select id="material" className={`select ${err('materialId') ? 'input-err' : ''}`} value={form.materialId} onChange={set('materialId')}>
                    {workspace.materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  {material && (
                    <span className="hint">
                      Category: {material.category} · unit: {material.uom} · lead time {material.leadTimeDays} days
                    </span>
                  )}
                </div>

                <div className="field">
                  <label className="label" htmlFor="site">Plant / site *</label>
                  <select id="site" className={`select ${err('siteId') ? 'input-err' : ''}`} value={form.siteId} onChange={set('siteId')}>
                    {workspace.sites.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.country}</option>)}
                  </select>
                  {err('siteId') && <span className="err-text">{err('siteId')}</span>}
                </div>
              </div>

              <div className="grid grid-3" style={{ gap: 14 }}>
                <div className="field">
                  <label className="label" htmlFor="qty">Quantity * {material && <span className="dim">({material.uom})</span>}</label>
                  <input id="qty" type="number" min="1" className={`input ${err('quantity') ? 'input-err' : ''}`}
                    placeholder="0" value={form.quantity} onChange={set('quantity')} />
                  {err('quantity') && <span className="err-text">{err('quantity')}</span>}
                </div>

                <div className="field">
                  <label className="label" htmlFor="by">Required by *</label>
                  <input id="by" type="date" className={`input ${err('requiredBy') ? 'input-err' : ''}`}
                    value={form.requiredBy} onChange={set('requiredBy')} />
                  {err('requiredBy') && <span className="err-text">{err('requiredBy')}</span>}
                </div>

                <div className="field">
                  <label className="label" htmlFor="prio">Priority</label>
                  <select id="prio" className="select" value={form.priority} onChange={set('priority')}>
                    <option value="routine">Routine</option>
                    <option value="urgent">Urgent</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label className="label" htmlFor="spec">Specification / grade / quality requirements</label>
                <textarea id="spec" className="textarea" style={{ minHeight: 78 }}
                  placeholder="e.g. 28–30% Brix, hot break, food grade, HACCP certified supplier"
                  value={form.specification} onChange={set('specification')} />
                <span className="hint">Included verbatim in every RFQ. Leave blank and the RFQ asks the supplier to state what they can supply.</span>
              </div>

              <div className="field">
                <label className="label" htmlFor="reason">Reason for requirement *</label>
                <textarea id="reason" className={`textarea ${err('reason') ? 'input-err' : ''}`} style={{ minHeight: 68 }}
                  placeholder="Production or operational need this covers"
                  value={form.reason} onChange={set('reason')} />
                {err('reason') && <span className="err-text">{err('reason')}</span>}
              </div>

              <div className="grid grid-2" style={{ gap: 14 }}>
                <div className="field">
                  <label className="label" htmlFor="target">Estimated budget / target price <span className="dim">(optional)</span></label>
                  <input id="target" type="number" step="0.01" min="0" className="input"
                    placeholder="Per unit" value={form.targetPrice} onChange={set('targetPrice')} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="notes">Notes <span className="dim">(optional)</span></label>
                  <input id="notes" className="input" placeholder="Anything procurement should know"
                    value={form.notes} onChange={set('notes')} />
                </div>
              </div>

              {serverError && <Callout tone="red" icon="✕">{serverError}</Callout>}

              <div className="row" style={{ gap: 11 }}>
                <motion.button type="submit" className="btn btn-primary btn-lg" disabled={busy}
                  whileHover={{ scale: busy ? 1 : 1.01 }} whileTap={{ scale: busy ? 1 : .99 }}>
                  {busy ? 'Submitting…' : 'Submit requirement'}
                </motion.button>
                <span className="xs faint">Submitting starts supplier discovery immediately.</span>
              </div>
            </div>
          </Card>

          <div className="col" style={{ gap: 16 }}>
            <Card>
              <CardHead title="What happens on submit" right={<Prov kind="live" label="real workflow" />} />
              <ol className="col sm muted" style={{ gap: 9, paddingLeft: 17 }}>
                <li>The entry is validated and saved as a tracked record.</li>
                <li>A supplier-discovery agent task starts against <strong>these</strong> values.</li>
                <li>graph8 company and contact discovery runs alongside the internal supplier directory.</li>
                <li>You get a shortlist with reasons for inclusion and what is still unknown.</li>
                <li>Procurement reviews it before anything is sent to a supplier.</li>
              </ol>
            </Card>

            {material && (
              <Card>
                <CardHead title="Selected material" note="From the workspace catalogue" right={<Prov kind="demo" />} />
                <div className="col" style={{ gap: 0 }}>
                  <div className="kv"><span className="kv-k">Name</span><span className="kv-v">{material.name}</span></div>
                  <div className="kv"><span className="kv-k">Category</span><span className="kv-v">{material.category}</span></div>
                  <div className="kv"><span className="kv-k">Unit</span><span className="kv-v">{material.uom}</span></div>
                  <div className="kv"><span className="kv-k">Typical lead time</span><span className="kv-v">{material.leadTimeDays} days</span></div>
                  <div className="kv"><span className="kv-k">Safety stock</span><span className="kv-v">{material.safetyStock.toLocaleString()} {material.uom}</span></div>
                </div>
                {form.requiredBy && material && (
                  <div className="mt">
                    {(() => {
                      const days = Math.round((new Date(form.requiredBy) - new Date()) / 86400000);
                      return days < material.leadTimeDays ? (
                        <Callout tone="amber" icon="⚠">
                          Required in {days} days but the typical lead time is {material.leadTimeDays} days.
                          Expect suppliers to quote a date after your required-by.
                        </Callout>
                      ) : (
                        <Callout tone="green" icon="✓">
                          {days} days available against a {material.leadTimeDays}-day typical lead time.
                        </Callout>
                      );
                    })()}
                  </div>
                )}
              </Card>
            )}

            <Callout tone="amber" icon="⚠">
              Material catalogue, lead times and safety stock in this workspace are illustrative sample
              data, not Nestlé records.
            </Callout>
          </div>
        </div>
      </form>
    </Page>
  );
}
