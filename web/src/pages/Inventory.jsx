import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, CardHead, Badge, Callout, Prov, StockSpark, useAsync, Skeleton, fmt } from '../components/ui.jsx';

const todayPlus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export default function Inventory() {
  const navigate = useNavigate();
  const { data, loading, setData } = useAsync(() => api.planning(), []);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => { if (data && !draft) setDraft(structuredClone(data.planning)); }, [data, draft]);

  if (loading || !data || !draft) return <Page title="Inventory & planning"><Card><Skeleton h={280} /></Card></Page>;

  const { projection, product } = data;

  const apply = async () => {
    setBusy(true);
    try {
      const res = await api.savePlanning({
        unitsPerDay: draft.unitsPerDay,
        horizonDays: draft.horizonDays,
        inventory: draft.inventory,
        bom: draft.bom,
        materials: draft.materials,
      });
      setData({ ...data, planning: res.planning, projection: res.projection });
      setSavedAt(new Date());
    } finally { setBusy(false); }
  };

  const resetAll = async () => {
    setBusy(true);
    try {
      const res = await api.resetPlanning();
      setData({ ...data, planning: res.planning, projection: res.projection });
      setDraft(structuredClone(res.planning));
      setSavedAt(null);
    } finally { setBusy(false); }
  };

  const setInv = (materialId, key, value) =>
    setDraft({ ...draft, inventory: draft.inventory.map((i) => i.materialId === materialId ? { ...i, [key]: Number(value) } : i) });
  const setBom = (materialId, value) =>
    setDraft({ ...draft, bom: draft.bom.map((b) => b.materialId === materialId ? { ...b, qtyPerUnit: Number(value) } : b) });
  const setMat = (id, key, value) =>
    setDraft({ ...draft, materials: draft.materials.map((m) => m.id === id ? { ...m, [key]: Number(value) } : m) });

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.planning);

  const createRequirement = (row) => {
    const m = draft.materials.find((x) => x.id === row.materialId);
    const params = new URLSearchParams({
      materialId: row.materialId,
      quantity: String(row.suggestedOrderQty),
      requiredBy: todayPlus(Math.max(1, row.orderByDay ?? 7) + (m?.leadTimeDays || 14)),
      priority: row.status === 'shortage' ? 'urgent' : 'routine',
      title: `Replenishment — ${row.materialName}`,
      reason: `Projected ${row.status === 'shortage' ? `stockout on day ${row.shortageDay}` : `safety-stock breach on day ${row.safetyBreachDay}`} at ${fmt.n(draft.unitsPerDay)} units/day on the ${product.name} line.`,
      notes: `Auto-filled from the inventory projection. Suggested quantity covers lead time plus a 7-day review cycle.`,
    });
    navigate(`/raise?${params.toString()}`);
  };

  return (
    <Page
      title="Inventory & material planning"
      sub={`${product.name} line. Change any input below and every projection, shortage date and reorder quantity recalculates.`}
      right={<div className="row" style={{ gap: 8 }}>
        <button className="btn" onClick={resetAll} disabled={busy}>Reset to sample</button>
        <button className="btn btn-primary" onClick={apply} disabled={!dirty || busy}>
          {busy ? 'Recalculating…' : dirty ? 'Apply changes' : 'No changes'}
        </button>
      </div>}
    >
      <Callout tone="amber" icon="⚠">
        <strong>Illustrative data.</strong> {product.bomNote} Stock, consumption and lead times are sample
        values for demonstration — edit them freely.
      </Callout>

      {savedAt && (
        <div className="mt">
          <Callout tone="green" icon="✓">
            Recalculated at {savedAt.toLocaleTimeString()} — {projection.totals.shortages} stockout(s),{' '}
            {projection.totals.belowSafety} below safety stock across {projection.totals.materials} materials.
          </Callout>
        </div>
      )}

      <div className="grid grid-4 mt-lg">
        <Card>
          <div className="field">
            <label className="label" htmlFor="upd">Production volume</label>
            <input id="upd" type="number" min="0" className="input" value={draft.unitsPerDay}
              onChange={(e) => setDraft({ ...draft, unitsPerDay: Number(e.target.value) })} />
            <span className="hint">bottles per day</span>
          </div>
        </Card>
        <Card>
          <div className="field">
            <label className="label" htmlFor="hz">Planning horizon</label>
            <input id="hz" type="number" min="7" max="365" className="input" value={draft.horizonDays}
              onChange={(e) => setDraft({ ...draft, horizonDays: Number(e.target.value) })} />
            <span className="hint">days</span>
          </div>
        </Card>
        <Card><div className="stat-label">Materials at risk</div>
          <div className="stat-value" style={{ color: (projection.totals.shortages + projection.totals.belowSafety) ? 'var(--red)' : 'var(--green)' }}>
            {projection.totals.shortages + projection.totals.belowSafety}
          </div>
          <div className="stat-hint">of {projection.totals.materials} on the BOM</div>
        </Card>
        <Card><div className="stat-label">Line output</div>
          <div className="stat-value" style={{ fontSize: 21 }}>{fmt.n(data.planning.unitsPerDay)}</div>
          <div className="stat-hint">bottles/day currently applied — drives every line below</div>
        </Card>
      </div>

      <Card large className="mt-lg">
        <CardHead
          title="Projected stock position"
          note={`Bill of materials exploded over ${draft.horizonDays} days. Dashed line is safety stock.`}
          right={<Prov kind="derived" />}
        />

        <div className="col" style={{ gap: 0 }}>
          {projection.rows.map((row, i) => {
            const inv = draft.inventory.find((x) => x.materialId === row.materialId);
            const bom = draft.bom.find((x) => x.materialId === row.materialId);
            const mat = draft.materials.find((x) => x.id === row.materialId);
            return (
              <motion.div key={row.materialId}
                initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * .04, .35) }}
                style={{ padding: '18px 0', borderBottom: '1px solid var(--line)' }}>

                <div className="row-between" style={{ alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div className="row" style={{ gap: 9 }}>
                      <span className="strong">{row.materialName}</span>
                      <Badge tone={row.status === 'shortage' ? 'red' : row.status === 'below_safety' ? 'amber' : 'green'} dot>
                        {row.status === 'shortage' ? `stockout day ${row.shortageDay}` : row.status === 'below_safety' ? `below safety day ${row.safetyBreachDay}` : 'covered'}
                      </Badge>
                    </div>
                    <div className="xs faint" style={{ marginTop: 3 }}>
                      {fmt.n(row.dailyConsumption, 1)} {row.uom}/day · {row.daysOfCover ?? '—'} days cover
                      {row.incomingTotal > 0 ? ` · ${fmt.n(row.incomingTotal)} inbound` : ''}
                      {row.status !== 'ok' ? ` · ${fmt.orderBy(row.orderByDay)}` : ''}
                    </div>
                  </div>
                  {row.status !== 'ok' && (
                    <button className="btn btn-sm btn-primary" onClick={() => createRequirement(row)}>
                      Raise requirement for {fmt.n(row.suggestedOrderQty)} {row.uom}
                    </button>
                  )}
                </div>

                <div className="grid" style={{ gridTemplateColumns: 'minmax(0,260px) minmax(0,1fr)', gap: 20, alignItems: 'center' }}>
                  <StockSpark series={row.series} safetyStock={row.safetyStock} />

                  <div className="row wrap" style={{ gap: 10 }}>
                    <div className="field" style={{ width: 108 }}>
                      <label className="label xs">On hand</label>
                      <input type="number" className="input" value={inv?.onHand ?? 0}
                        onChange={(e) => setInv(row.materialId, 'onHand', e.target.value)} />
                    </div>
                    <div className="field" style={{ width: 100 }}>
                      <label className="label xs">Reserved</label>
                      <input type="number" className="input" value={inv?.reserved ?? 0}
                        onChange={(e) => setInv(row.materialId, 'reserved', e.target.value)} />
                    </div>
                    <div className="field" style={{ width: 108 }}>
                      <label className="label xs">Per bottle</label>
                      <input type="number" step="0.0001" className="input" value={bom?.qtyPerUnit ?? 0}
                        onChange={(e) => setBom(row.materialId, e.target.value)} />
                    </div>
                    <div className="field" style={{ width: 108 }}>
                      <label className="label xs">Safety stock</label>
                      <input type="number" className="input" value={mat?.safetyStock ?? 0}
                        onChange={(e) => setMat(row.materialId, 'safetyStock', e.target.value)} />
                    </div>
                    <div className="field" style={{ width: 96 }}>
                      <label className="label xs">Lead time</label>
                      <input type="number" className="input" value={mat?.leadTimeDays ?? 0}
                        onChange={(e) => setMat(row.materialId, 'leadTimeDays', e.target.value)} />
                    </div>
                  </div>
                </div>

                <details style={{ marginTop: 11 }}>
                  <summary className="sm" style={{ cursor: 'pointer', color: 'var(--accent)' }}>Why is this recommended?</summary>
                  <div className="col sm muted mt" style={{ gap: 5 }}>
                    {row.explanation.map((x, j) => <div key={j}>• {x}</div>)}
                  </div>
                </details>
              </motion.div>
            );
          })}
        </div>
      </Card>
    </Page>
  );
}
