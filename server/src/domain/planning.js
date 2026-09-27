/**
 * Material planning maths.
 *
 * Nothing here is looked up or hardcoded — every number is computed from the
 * planning inputs the user can edit (production volume, horizon, on-hand
 * stock, reserved stock, expected receipts, BOM ratios, safety stock, lead
 * times). Change any input and the projection, shortage dates and reorder
 * recommendations move with it. That is the point of the demo.
 */

const round = (n, dp = 2) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Day-by-day stock projection for one material.
 *
 * Receipts land ON their expectedInDays boundary, so a receipt due day 19
 * is counted from day 19 onward. Stock is allowed to go negative — clamping
 * it would hide exactly the shortage we are trying to surface.
 */
export function projectMaterial({ material, bomLine, inventory, receipts, unitsPerDay, horizonDays }) {
  const perUnit = bomLine ? bomLine.qtyPerUnit : 0;
  const dailyConsumption = unitsPerDay * perUnit;

  const onHand = inventory?.onHand ?? 0;
  const reserved = inventory?.reserved ?? 0;
  const available = onHand - reserved;

  const matReceipts = (receipts || []).filter((r) => r.materialId === material.id);
  const incomingTotal = matReceipts.reduce((a, r) => a + r.qty, 0);

  const series = [];
  let shortageDay = null;
  let safetyBreachDay = null;

  for (let day = 0; day <= horizonDays; day++) {
    const consumed = dailyConsumption * day;
    const received = matReceipts
      .filter((r) => r.expectedInDays <= day)
      .reduce((a, r) => a + r.qty, 0);
    const projected = available - consumed + received;

    series.push({ day, projected: round(projected, 1), received });

    if (shortageDay === null && projected < 0) shortageDay = day;
    if (safetyBreachDay === null && projected < material.safetyStock) safetyBreachDay = day;
  }

  const daysOfCover = dailyConsumption > 0 ? available / dailyConsumption : null;
  const daysOfCoverWithReceipts =
    dailyConsumption > 0 ? (available + incomingTotal) / dailyConsumption : null;

  // How much is needed so the projection never dips below safety stock at any
  // point in the horizon. Deriving it from the deepest trough (rather than
  // from lead time alone) is what makes it correct when a receipt lands
  // mid-horizon: an inbound delivery can mask a later trough entirely.
  const minProjected = Math.min(...series.map((p) => p.projected));
  const deficit = material.safetyStock - minProjected;
  const suggestedOrderQty = deficit > 0 ? Math.ceil(deficit) : 0;

  // Order this many days from now and it should land just as safety stock is
  // hit. Deliberately NOT clamped at zero: a negative value means the order
  // was already due, which is the single most useful thing a planner can be
  // told. Clamping it to "day 0" would hide a late order as an on-time one.
  const orderByDay =
    safetyBreachDay === null ? null : safetyBreachDay - material.leadTimeDays;
  const orderOverdueByDays = orderByDay !== null && orderByDay < 0 ? Math.abs(orderByDay) : 0;

  let status = 'ok';
  if (shortageDay !== null && shortageDay <= horizonDays) status = 'shortage';
  else if (safetyBreachDay !== null && safetyBreachDay <= horizonDays) status = 'below_safety';

  return {
    materialId: material.id,
    materialName: material.name,
    uom: material.uom,
    category: material.category,
    perUnit,
    dailyConsumption: round(dailyConsumption, 3),
    onHand,
    reserved,
    available,
    incomingTotal,
    safetyStock: material.safetyStock,
    leadTimeDays: material.leadTimeDays,
    daysOfCover: daysOfCover === null ? null : round(daysOfCover, 1),
    daysOfCoverWithReceipts: daysOfCoverWithReceipts === null ? null : round(daysOfCoverWithReceipts, 1),
    shortageDay,
    safetyBreachDay,
    orderByDay,
    orderOverdueByDays,
    minProjected: round(minProjected, 1),
    suggestedOrderQty,
    status,
    series,
    receipts: matReceipts,
    explanation: buildExplanation({
      material, dailyConsumption, available, incomingTotal, minProjected,
      shortageDay, safetyBreachDay, orderByDay, suggestedOrderQty, horizonDays,
    }),
  };
}

function buildExplanation(a) {
  const lines = [];
  lines.push(
    `At ${Math.round(a.dailyConsumption).toLocaleString()} ${a.material.uom}/day the ${a.available.toLocaleString()} ${a.material.uom} available (on-hand minus reserved) covers ${a.dailyConsumption > 0 ? Math.floor(a.available / a.dailyConsumption) : '∞'} days.`
  );
  if (a.incomingTotal > 0) {
    lines.push(`${a.incomingTotal.toLocaleString()} ${a.material.uom} is already inbound and is credited against the projection.`);
  }
  if (a.safetyBreachDay !== null && a.safetyBreachDay <= a.horizonDays) {
    lines.push(`Projected stock drops below the ${a.material.safetyStock.toLocaleString()} ${a.material.uom} safety level on day ${a.safetyBreachDay}.`);
  }
  if (a.shortageDay !== null && a.shortageDay <= a.horizonDays) {
    lines.push(`Stock runs out entirely on day ${a.shortageDay}.`);
  } else {
    lines.push(`No full stockout inside the ${a.horizonDays}-day horizon.`);
  }
  if (a.orderByDay !== null) {
    lines.push(
      a.orderByDay < 0
        ? `With a ${a.material.leadTimeDays}-day lead time, the order was already due ${Math.abs(a.orderByDay)} days ago. Ordering now still leaves a gap.`
        : a.orderByDay === 0
          ? `With a ${a.material.leadTimeDays}-day lead time, this needs ordering today to arrive before the safety level is breached.`
          : `With a ${a.material.leadTimeDays}-day lead time, an order placed within ${a.orderByDay} days should arrive before the safety level is breached.`
    );
  }
  if (a.suggestedOrderQty > 0) {
    lines.push(`Projection bottoms out at ${Math.round(a.minProjected).toLocaleString()} ${a.material.uom}. Ordering ${a.suggestedOrderQty.toLocaleString()} ${a.material.uom} lifts that trough back to the ${a.material.safetyStock.toLocaleString()} safety level.`);
  } else {
    lines.push(`Projection stays at or above safety stock throughout, so no order is suggested.`);
  }
  return lines;
}

/** Runs the projection across the whole BOM for the current plan. */
export function projectAll(planning, product) {
  const { unitsPerDay, horizonDays, inventory, receipts, materials, bom } = planning;
  const bomLines = bom || product.bom;

  const rows = bomLines
    .map((line) => {
      const material = materials.find((m) => m.id === line.materialId);
      if (!material) return null;
      const inv = inventory.find((i) => i.materialId === line.materialId);
      return projectMaterial({ material, bomLine: line, inventory: inv, receipts, unitsPerDay, horizonDays });
    })
    .filter(Boolean);

  const order = { shortage: 0, below_safety: 1, ok: 2 };
  rows.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return (a.shortageDay ?? 9e9) - (b.shortageDay ?? 9e9);
  });

  return {
    provenance: 'derived',
    inputs: { unitsPerDay, horizonDays },
    totals: {
      materials: rows.length,
      shortages: rows.filter((r) => r.status === 'shortage').length,
      belowSafety: rows.filter((r) => r.status === 'below_safety').length,
      ok: rows.filter((r) => r.status === 'ok').length,
    },
    rows,
  };
}

/**
 * Buy-now vs buy-later vs split.
 *
 * `unitPrice` must come from a saved quote or an explicitly labelled
 * assumption — never invented. `changePct` is a user-chosen scenario, not a
 * forecast: graph8 discovery and signals say nothing about commodity prices.
 */
export function forwardBuy({ qty, unitPrice, priceSource, changePct, holdingCostPctPerMonth, monthsDeferred = 1, shortageDay, leadTimeDays }) {
  const buyNowGoods = qty * unitPrice;
  const laterPrice = unitPrice * (1 + changePct / 100);
  const buyLaterGoods = qty * laterPrice;

  // Buying early means carrying the stock for the deferral window.
  const holdNow = buyNowGoods * (holdingCostPctPerMonth / 100) * monthsDeferred;
  const holdLater = 0;

  const splitQty = qty / 2;
  const splitGoods = splitQty * unitPrice + splitQty * laterPrice;
  const splitHold = splitQty * unitPrice * (holdingCostPctPerMonth / 100) * monthsDeferred;

  // Deferring past (shortage − lead time) means the replenishment lands late.
  const deferDays = monthsDeferred * 30;
  const latestSafeOrderDay = shortageDay === null ? null : shortageDay - leadTimeDays;
  const laterRisksStockout = latestSafeOrderDay !== null && deferDays > latestSafeOrderDay;

  const options = [
    {
      key: 'now', label: 'Buy now',
      goodsCost: round(buyNowGoods), holdingCost: round(holdNow),
      totalCost: round(buyNowGoods + holdNow),
      stockoutRisk: 'Low — replenishment is ordered inside the safe window.',
      note: `Locks ${priceSource === 'quote' ? 'the quoted price' : 'the assumed price'} and carries ${monthsDeferred} month of holding cost.`,
    },
    {
      key: 'later', label: `Buy in ${monthsDeferred} month${monthsDeferred > 1 ? 's' : ''}`,
      goodsCost: round(buyLaterGoods), holdingCost: round(holdLater),
      totalCost: round(buyLaterGoods + holdLater),
      stockoutRisk: laterRisksStockout
        ? `High — deferring ${deferDays} days passes the day ${latestSafeOrderDay} latest safe order date for a ${leadTimeDays}-day lead time.`
        : 'Moderate — still inside the safe ordering window, but exposed to the price scenario.',
      note: `Avoids holding cost; exposed to a ${changePct > 0 ? '+' : ''}${changePct}% price move.`,
    },
    {
      key: 'split', label: 'Split 50 / 50',
      goodsCost: round(splitGoods), holdingCost: round(splitHold),
      totalCost: round(splitGoods + splitHold),
      stockoutRisk: 'Low — the first tranche covers the near-term window.',
      note: 'Halves both the price exposure and the holding cost.',
    },
  ];

  const cheapest = [...options].sort((a, b) => a.totalCost - b.totalCost)[0];
  const safe = options.filter((o) => !o.stockoutRisk.startsWith('High'));
  const recommended = safe.sort((a, b) => a.totalCost - b.totalCost)[0] || options[0];

  return {
    provenance: 'derived',
    qty,
    unitPrice,
    priceSource,
    changePct,
    holdingCostPctPerMonth,
    monthsDeferred,
    options,
    cheapestKey: cheapest.key,
    recommendedKey: recommended.key,
    rationale:
      recommended.key === cheapest.key
        ? `${recommended.label} is both the lowest total cost and inside the safe ordering window.`
        : `${cheapest.label} is cheaper on paper, but ${recommended.label} is recommended because the cheaper option risks a stockout. Continuity outranks the price difference of ${Math.abs(round(cheapest.totalCost - recommended.totalCost)).toLocaleString()} ${'USD'}.`,
    caveat:
      'Price scenarios are user-selected assumptions, not market forecasts. graph8 company discovery and business signals do not establish commodity prices.',
  };
}

export { round };
