import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { api } from '../lib/api.js';
import { Page, Card, CardHead, Badge, Callout, Prov, StockSpark, useAsync, Skeleton, fmt } from '../components/ui.jsx';

export default function Analytics({ workspace }) {
  const bomMaterials = workspace.materials;
  const [materialId, setMaterialId] = useState(bomMaterials[0]?.id || '');
  const [scenarioId, setScenarioId] = useState('ps_up8');
  const [months, setMonths] = useState(1);

  const { data, loading, error } = useAsync(
    () => api.forwardBuy({ materialId, scenarioId, months }),
    [materialId, scenarioId, months]
  );

  return (
    <Page
      title="Forward buying"
      sub="Compare buying now, buying later, or splitting the order. Every figure below moves with the material, scenario and deferral window you choose."
    >
      <Card flat>
        <div className="row wrap" style={{ gap: 14 }}>
          <div className="field" style={{ minWidth: 250 }}>
            <label className="label" htmlFor="m">Material</label>
            <select id="m" className="select" value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
              {bomMaterials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 215 }}>
            <label className="label" htmlFor="s">Price scenario</label>
            <select id="s" className="select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
              {workspace.priceScenarios.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label className="label" htmlFor="mo">Defer by</label>
            <select id="mo" className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              <option value={1}>1 month</option><option value={2}>2 months</option><option value={3}>3 months</option>
            </select>
          </div>
        </div>
      </Card>

      {loading && <Card className="mt"><Skeleton h={220} /></Card>}
      {error && <div className="mt"><Callout tone="red" icon="✕">{error.message}</Callout></div>}

      {data && !loading && (
        <>
          <div className="grid grid-side mt">
            <div className="col" style={{ gap: 16 }}>
              <Card large>
                <CardHead
                  title="Scenario comparison"
                  note={`${fmt.n(data.analysis.qty)} ${data.material.uom} · ${data.scenario.label}`}
                  right={<Prov kind="derived" />}
                />
                <div className="grid grid-3" style={{ gap: 14 }}>
                  {data.analysis.options.map((o, i) => {
                    const isRec = o.key === data.analysis.recommendedKey;
                    const isCheap = o.key === data.analysis.cheapestKey;
                    return (
                      <motion.div key={o.key}
                        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * .07 }}>
                        <Card flat style={{
                          background: isRec ? 'var(--green-soft)' : 'var(--surface-2)',
                          border: `1px solid ${isRec ? '#b6e6cc' : 'var(--line)'}`,
                          height: '100%',
                        }}>
                          <div className="row-between" style={{ marginBottom: 8 }}>
                            <span className="strong sm">{o.label}</span>
                            {isRec && <Badge tone="green" dot>recommended</Badge>}
                            {!isRec && isCheap && <Badge tone="amber">cheapest</Badge>}
                          </div>
                          <div className="stat-value" style={{ fontSize: 24 }}>{fmt.money(o.totalCost)}</div>
                          <div className="col xs faint mt" style={{ gap: 3 }}>
                            <div className="row-between"><span>Goods</span><span className="tnum">{fmt.money(o.goodsCost)}</span></div>
                            <div className="row-between"><span>Holding</span><span className="tnum">{fmt.money(o.holdingCost)}</span></div>
                          </div>
                          <div className="divider" style={{ margin: '11px 0' }} />
                          <div className="xs muted">{o.note}</div>
                          <div className="xs mt" style={{ color: o.stockoutRisk.startsWith('High') ? 'var(--red)' : 'var(--text-3)' }}>
                            {o.stockoutRisk}
                          </div>
                        </Card>
                      </motion.div>
                    );
                  })}
                </div>

                <div className="mt">
                  <Callout tone="green" icon="→"><strong>Recommendation.</strong> {data.analysis.rationale}</Callout>
                </div>
                <div className="mt">
                  <Callout tone="amber" icon="⚠">{data.analysis.caveat}</Callout>
                </div>
              </Card>
            </div>

            <div className="col" style={{ gap: 16 }}>
              <Card>
                <CardHead title="Price basis" right={<Prov kind={data.priceSource === 'quote' ? 'supplier_provided' : 'demo'} />} />
                <div className="stat-value" style={{ fontSize: 23 }}>
                  USD {data.analysis.unitPrice}<span className="faint" style={{ fontSize: 13, fontWeight: 400 }}>/{data.material.uom}</span>
                </div>
                <p className="xs faint mt">{data.priceSourceDetail}</p>
                <div className="divider" />
                <div className="kv"><span className="kv-k">Scenario change</span>
                  <span className="kv-v" style={{ color: data.scenario.changePct > 0 ? 'var(--red)' : data.scenario.changePct < 0 ? 'var(--green)' : undefined }}>
                    {data.scenario.changePct > 0 ? '+' : ''}{data.scenario.changePct}%
                  </span></div>
                <div className="kv"><span className="kv-k">Holding cost</span><span className="kv-v">{data.analysis.holdingCostPctPerMonth}% / month</span></div>
                <div className="kv"><span className="kv-k">Deferral</span><span className="kv-v">{data.analysis.monthsDeferred} month(s)</span></div>
              </Card>

              <Card>
                <CardHead title="Stock position" note={data.material.name} right={<Prov kind="derived" />} />
                <StockSpark series={data.projectionRow.series} safetyStock={data.projectionRow.safetyStock} />
                <div className="col mt" style={{ gap: 0 }}>
                  <div className="kv"><span className="kv-k">Available</span><span className="kv-v tnum">{fmt.n(data.projectionRow.available)} {data.material.uom}</span></div>
                  <div className="kv"><span className="kv-k">Days of cover</span><span className="kv-v tnum">{data.projectionRow.daysOfCover ?? '—'}</span></div>
                  <div className="kv"><span className="kv-k">Stockout day</span>
                    <span className="kv-v tnum" style={data.projectionRow.shortageDay !== null ? { color: 'var(--red)' } : undefined}>
                      {data.projectionRow.shortageDay ?? 'none in horizon'}
                    </span></div>
                  <div className="kv"><span className="kv-k">Order by day</span><span className="kv-v tnum">{data.projectionRow.orderByDay ?? '—'}</span></div>
                  <div className="kv"><span className="kv-k">Suggested qty</span><span className="kv-v tnum">{fmt.n(data.projectionRow.suggestedOrderQty)} {data.material.uom}</span></div>
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
