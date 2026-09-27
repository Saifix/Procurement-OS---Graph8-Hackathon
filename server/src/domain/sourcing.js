/**
 * Sourcing logic: match suppliers to a requirement, draft RFQs, compare
 * quotations, and build a recommendation.
 *
 * Matching reads the requirement's real fields — material tag, category,
 * quantity, site country, required-by date. Change the material and a
 * different supplier set comes back; change the date and feasibility flips.
 * Nothing is keyed off a hardcoded scenario.
 *
 * A graph8 result is a POTENTIAL supplier. Capability, food-grade status,
 * certification, capacity and willingness to supply are never inferred here.
 */

const DAY = 86400000;

export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  if (Number.isNaN(then)) return null;
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((then - today) / DAY);
}

/**
 * Score a supplier against a requirement. Returns reasons for inclusion and,
 * importantly, what is NOT known — the spec requires missing information to be
 * visible rather than glossed over.
 */
export function matchSupplier(supplier, requirement, material) {
  const reasons = [];
  const unknowns = [];
  let score = 0;

  const tag = material?.materialTag;
  const tags = supplier.materialTags || [];

  if (tag && tags.includes(tag)) {
    score += 45;
    reasons.push(`Listed against the "${tag.replace(/_/g, ' ')}" material category.`);
  } else if (tags.includes(`${requirement.category}_general`) || tags.includes('packaging_general') && requirement.category === 'packaging' || tags.includes('ingredient_general') && requirement.category === 'ingredient') {
    score += 22;
    reasons.push(`Operates in the broader ${requirement.category} category, but not specifically this material.`);
  }

  if (supplier.source === 'directory') {
    score += 25;
    reasons.push(`Already in the supplier directory — status "${supplier.status}".`);
  } else if (supplier.source === 'graph8') {
    score += 8;
    reasons.push('Discovered through graph8 company search.');
    unknowns.push('Never traded with. Capability, certification and capacity are all unverified.');
  }

  const reqCountry = requirement.siteCountry;
  if (supplier.country && reqCountry && supplier.country === reqCountry) {
    score += 12;
    reasons.push(`Located in ${supplier.country}, the same country as ${requirement.siteName}.`);
  } else if (supplier.country) {
    reasons.push(`Located in ${supplier.country} — cross-border shipping to ${requirement.siteName}.`);
  }

  const c = supplier.contact || {};
  if (c.hasWorkEmail) {
    score += 10;
    reasons.push(`Reachable contact on file: ${c.firstName} ${c.lastName}, ${c.jobTitle}.`);
  } else {
    unknowns.push(`No work email for ${c.firstName || 'the listed contact'} — RFQ cannot be emailed without enrichment.`);
  }

  if (typeof c.confidenceScore === 'number') {
    score += Math.round((c.confidenceScore / 100) * 8);
    if (c.confidenceScore < 40) unknowns.push(`Contact confidence is only ${c.confidenceScore}/100 — verify the person before contacting.`);
  }

  // Things we deliberately never assume.
  unknowns.push('Food-grade / specification compliance not confirmed.');
  if (!supplier.status) unknowns.push('Not an approved vendor in this workspace.');

  return {
    supplierId: supplier.id,
    score: Math.min(100, score),
    reasons,
    unknowns,
  };
}

export function discoverSuppliers({ requirement, material, suppliers }) {
  const scored = suppliers
    .map((s) => ({ supplier: s, match: matchSupplier(s, requirement, material) }))
    .filter((r) => r.match.score > 0)
    .sort((a, b) => b.match.score - a.match.score);

  return {
    provenance: 'mixed',
    criteriaUsed: {
      material: requirement.materialName,
      materialTag: material?.materialTag || null,
      category: requirement.category,
      quantity: `${requirement.quantity} ${requirement.uom}`,
      site: requirement.siteName,
      siteCountry: requirement.siteCountry,
      requiredBy: requirement.requiredBy,
      specification: requirement.specification || null,
    },
    results: scored,
    counts: {
      total: scored.length,
      graph8: scored.filter((r) => r.supplier.source === 'graph8').length,
      directory: scored.filter((r) => r.supplier.source === 'directory').length,
      userAdded: scored.filter((r) => r.supplier.source === 'user_added').length,
    },
  };
}

/** Per-supplier RFQ. Built from the requirement's actual values. */
export function draftRFQ({ requirement, supplier, material, workspace }) {
  const c = supplier.contact || {};
  const days = daysUntil(requirement.requiredBy);

  const subject = `RFQ — ${requirement.materialName} · ${Number(requirement.quantity).toLocaleString()} ${requirement.uom} · required ${requirement.requiredBy}`;

  const specLine = requirement.specification
    ? `Specification: ${requirement.specification}`
    : 'Specification: to be confirmed — please state the grade you can supply.';

  const body = [
    `Dear ${c.firstName || 'Sir or Madam'},`,
    ``,
    `We are sourcing the following material for our ${requirement.siteName} and would like to request a quotation.`,
    ``,
    `Material: ${requirement.materialName}`,
    `Category: ${requirement.category}`,
    `Quantity: ${Number(requirement.quantity).toLocaleString()} ${requirement.uom}`,
    `Required by: ${requirement.requiredBy}${days !== null ? ` (${days} days from today)` : ''}`,
    `Delivery location: ${requirement.siteName}, ${requirement.siteCountry}`,
    specLine,
    ``,
    `Please confirm the following in your response:`,
    `  1. Unit price and currency`,
    `  2. Minimum order quantity`,
    `  3. Quantity available against the required-by date`,
    `  4. Lead time from purchase order`,
    `  5. Quote validity period`,
    `  6. Delivery terms (Incoterms) and payment terms`,
    `  7. Confirmation of specification compliance`,
    `  8. Applicable certifications and supporting documentation`,
    ``,
    requirement.priority === 'critical' || requirement.priority === 'urgent'
      ? `This requirement is marked ${requirement.priority}. An early indication of availability would be appreciated even if full pricing follows later.`
      : `A response within five working days would be appreciated.`,
    ``,
    `Kind regards,`,
    `Procurement — ${workspace.meta.workspaceName}`,
  ].join('\n');

  return {
    subject,
    body,
    requestedFields: [
      'unitPrice', 'currency', 'minimumOrderQty', 'availableQty', 'leadTimeDays',
      'validityDays', 'deliveryTerms', 'paymentTerms', 'specCompliance', 'certifications',
    ],
    toName: `${c.firstName || ''} ${c.lastName || ''}`.trim() || 'Unknown contact',
    toTitle: c.jobTitle || '',
    canEmail: Boolean(c.hasWorkEmail),
    cannotEmailReason: c.hasWorkEmail ? null : 'graph8 holds no work email for this contact. Enrichment (which consumes credits) or another channel would be required.',
  };
}

/**
 * Compare saved quotes. Missing values stay missing — the spec is explicit
 * that absent prices or terms must not be silently estimated.
 */
export function compareQuotes({ requirement, quotes, suppliers }) {
  const reqQty = Number(requirement.quantity);
  const daysToNeed = daysUntil(requirement.requiredBy);

  const rows = quotes.map((q) => {
    const supplier = suppliers.find((s) => s.id === q.supplierId);
    const hasPrice = q.unitPrice !== null && q.unitPrice !== undefined && q.unitPrice !== '';
    const unitPrice = hasPrice ? Number(q.unitPrice) : null;

    const qtyShortfall =
      q.availableQty !== null && q.availableQty !== undefined && q.availableQty !== ''
        ? Math.max(0, reqQty - Number(q.availableQty))
        : null;

    const extended = unitPrice !== null ? unitPrice * reqQty : null;
    const charges = q.additionalCharges ? Number(q.additionalCharges) : 0;
    const total = extended !== null ? extended + charges : null;

    let leadTimeOk = null;
    if (q.leadTimeDays !== null && q.leadTimeDays !== undefined && q.leadTimeDays !== '' && daysToNeed !== null) {
      leadTimeOk = Number(q.leadTimeDays) <= daysToNeed;
    }

    const moqOk =
      q.minimumOrderQty !== null && q.minimumOrderQty !== undefined && q.minimumOrderQty !== ''
        ? Number(q.minimumOrderQty) <= reqQty
        : null;

    const missing = [];
    if (!hasPrice) missing.push('unit price');
    if (q.leadTimeDays === null || q.leadTimeDays === undefined || q.leadTimeDays === '') missing.push('lead time');
    if (q.availableQty === null || q.availableQty === undefined || q.availableQty === '') missing.push('available quantity');
    if (!q.deliveryTerms) missing.push('delivery terms');
    if (!q.paymentTerms) missing.push('payment terms');
    if (!q.specCompliance) missing.push('specification confirmation');
    if (!q.certifications) missing.push('certifications');

    return {
      quoteId: q.id,
      supplierId: q.supplierId,
      supplierName: supplier?.company || q.supplierId,
      supplierSource: supplier?.source || 'unknown',
      provenance: q.provenance,
      unitPrice, currency: q.currency || 'USD',
      extended, charges, total,
      minimumOrderQty: q.minimumOrderQty ?? null,
      availableQty: q.availableQty ?? null,
      qtyShortfall,
      leadTimeDays: q.leadTimeDays ?? null,
      leadTimeOk,
      moqOk,
      validityDays: q.validityDays ?? null,
      deliveryTerms: q.deliveryTerms || null,
      paymentTerms: q.paymentTerms || null,
      specCompliance: q.specCompliance || null,
      certifications: q.certifications || null,
      missing,
      complete: missing.length === 0,
    };
  });

  const priced = rows.filter((r) => r.total !== null);
  const cheapest = priced.length ? priced.reduce((a, b) => (b.total < a.total ? b : a)) : null;
  const fastest = rows.filter((r) => r.leadTimeDays !== null);
  const quickest = fastest.length ? fastest.reduce((a, b) => (b.leadTimeDays < a.leadTimeDays ? b : a)) : null;

  return {
    provenance: 'derived',
    requirementQty: reqQty,
    daysToNeed,
    rows,
    cheapestQuoteId: cheapest?.quoteId || null,
    quickestQuoteId: quickest?.quoteId || null,
    pricedCount: priced.length,
    totalCount: rows.length,
  };
}

/** Recommendation. Deliberately refuses to crown a winner without evidence. */
export function buildRecommendation({ requirement, comparison, suppliers }) {
  const { rows, cheapestQuoteId, daysToNeed } = comparison;
  const findings = [];
  const risks = [];
  const assumptions = [];

  if (rows.length === 0) {
    return {
      provenance: 'derived',
      status: 'insufficient_evidence',
      headline: 'No quotations recorded yet.',
      findings: ['No supplier has returned a quotation and none has been entered manually.'],
      risks: ['Nothing can be compared or recommended until at least one quotation exists.'],
      assumptions: [],
      recommendedQuoteId: null,
      requiredBeforeDecision: ['At least one quotation with a unit price and a lead time.'],
    };
  }

  const feasible = rows.filter((r) => r.leadTimeOk !== false && r.qtyShortfall !== null ? r.qtyShortfall === 0 : r.leadTimeOk !== false);
  const priced = rows.filter((r) => r.total !== null);

  rows.forEach((r) => {
    if (r.leadTimeOk === false) {
      risks.push(`${r.supplierName}: ${r.leadTimeDays}-day lead time misses the required-by date, which is ${daysToNeed} days away.`);
    }
    if (r.qtyShortfall > 0) {
      risks.push(`${r.supplierName}: can supply ${Number(r.availableQty).toLocaleString()} against a requirement of ${comparison.requirementQty.toLocaleString()} — short by ${r.qtyShortfall.toLocaleString()}.`);
    }
    if (r.moqOk === false) {
      risks.push(`${r.supplierName}: minimum order quantity of ${Number(r.minimumOrderQty).toLocaleString()} exceeds the required quantity.`);
    }
    if (r.missing.length) {
      risks.push(`${r.supplierName}: missing ${r.missing.join(', ')}.`);
    }
    if (r.supplierSource === 'graph8') {
      risks.push(`${r.supplierName} was discovered through graph8 and has no trading history or verified certification in this workspace.`);
    }
  });

  if (priced.length >= 2) {
    const sorted = [...priced].sort((a, b) => a.total - b.total);
    const spread = sorted[sorted.length - 1].total - sorted[0].total;
    findings.push(`${priced.length} priced quotations span ${sorted[0].currency} ${Math.round(sorted[0].total).toLocaleString()} to ${Math.round(sorted[sorted.length - 1].total).toLocaleString()} — a spread of ${Math.round(spread).toLocaleString()} on the same quantity.`);
  } else if (priced.length === 1) {
    findings.push(`Only one priced quotation is on file, so there is no competitive reference point.`);
  }

  const withLead = rows.filter((r) => r.leadTimeDays !== null);
  if (withLead.length) {
    const q = withLead.reduce((a, b) => (b.leadTimeDays < a.leadTimeDays ? b : a));
    findings.push(`Shortest quoted lead time is ${q.leadTimeDays} days from ${q.supplierName}.`);
  }

  assumptions.push(`Total cost is unit price × ${comparison.requirementQty.toLocaleString()} ${requirement.uom} plus any stated additional charges. Taxes and duties are excluded unless a supplier stated them.`);
  assumptions.push('Suppliers with missing fields are not penalised in cost terms — their gaps are listed as risks instead.');

  // A candidate must be priced, meet the date, and cover the quantity.
  const candidates = priced.filter(
    (r) => r.leadTimeOk !== false && (r.qtyShortfall === null || r.qtyShortfall === 0)
  );
  const best = candidates.length ? candidates.reduce((a, b) => (b.total < a.total ? b : a)) : null;

  const requiredBeforeDecision = [];
  rows.forEach((r) => {
    if (r.missing.includes('specification confirmation')) requiredBeforeDecision.push(`Written specification confirmation from ${r.supplierName}.`);
    if (r.missing.includes('certifications')) requiredBeforeDecision.push(`Certification documents from ${r.supplierName}.`);
  });

  let status = 'ready_for_review';
  let headline;
  if (!best) {
    status = 'insufficient_evidence';
    headline = 'No quotation currently satisfies price, lead time and quantity together.';
  } else if (requiredBeforeDecision.length) {
    status = 'conditional';
    headline = `${best.supplierName} is the strongest candidate on cost and feasibility, subject to outstanding documentation.`;
  } else {
    headline = `${best.supplierName} meets the date and quantity at the lowest total cost on file.`;
  }

  return {
    provenance: 'derived',
    status,
    headline,
    findings,
    risks: [...new Set(risks)],
    assumptions,
    recommendedQuoteId: best?.quoteId || null,
    recommendedSupplierId: best?.supplierId || null,
    cheapestQuoteId,
    requiredBeforeDecision: [...new Set(requiredBeforeDecision)],
    caveat:
      'This is a decision-support summary, not an approval. No supplier is described as approved, compliant or best without the evidence listed above, and a human records the decision.',
  };
}
