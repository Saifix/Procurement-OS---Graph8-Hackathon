/**
 * Agent task runner.
 *
 * Tasks are triggered by real user actions and record what they actually did:
 * the inputs they read, the sources they used, what they produced, and any
 * limitation they hit. A task that could not complete says so rather than
 * quietly returning nothing.
 */

import { store } from '../store.js';
import { discoverSuppliers, draftRFQ, compareQuotes, buildRecommendation } from './sourcing.js';
import { projectAll } from './planning.js';
import { runSkill, SKILLS, isConfigured } from './graph8Skill.js';

function createTask({ kind, title, requirementId = null, trigger }) {
  const task = {
    id: store.nextId('task', 'task'),
    kind,
    title,
    requirementId,
    trigger,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    inputs: {},
    steps: [],
    findings: [],
    sources: [],
    limitations: [],
    result: null,
    error: null,
  };
  store.state.agentTasks.unshift(task);
  store.persist();
  return task;
}

function step(task, text) {
  task.steps.push({ at: new Date().toISOString(), text });
}

function finish(task, { result = null, status = 'completed', error = null } = {}) {
  task.status = status;
  task.result = result;
  task.error = error;
  task.finishedAt = new Date().toISOString();
  store.persist();
  return task;
}

/** Workflow A — requirement to supplier shortlist. */
export function runSupplierDiscovery(requirement, { trigger }) {
  const task = createTask({
    kind: 'supplier_discovery',
    title: `Find suppliers for ${requirement.materialName}`,
    requirementId: requirement.id,
    trigger,
  });

  try {
    const material = store.material(requirement.materialId);
    task.inputs = {
      material: requirement.materialName,
      materialTag: material?.materialTag || null,
      category: requirement.category,
      quantity: `${requirement.quantity} ${requirement.uom}`,
      site: requirement.siteName,
      requiredBy: requirement.requiredBy,
      specification: requirement.specification || '(none given)',
      priority: requirement.priority,
    };
    step(task, `Read the submitted requirement: ${requirement.quantity} ${requirement.uom} of ${requirement.materialName} for ${requirement.siteName} by ${requirement.requiredBy}.`);

    const suppliers = store.allSuppliers();
    step(task, `Searched ${suppliers.length} supplier records across graph8 discovery, the supplier directory and user-added entries.`);

    const discovery = discoverSuppliers({ requirement, material, suppliers });

    task.sources.push({
      name: 'graph8 company & contact discovery',
      detail: `${discovery.counts.graph8} of ${discovery.counts.total} candidates came from live graph8 results.`,
      provenance: 'graph8_live',
    });
    task.sources.push({
      name: 'Supplier directory',
      detail: `${discovery.counts.directory} candidates are existing directory suppliers.`,
      provenance: 'demo',
    });

    discovery.results.slice(0, 5).forEach((r) => {
      task.findings.push(`${r.supplier.company} — match ${r.match.score}/100. ${r.match.reasons[0] || ''}`);
    });

    const noEmail = discovery.results.filter((r) => !r.supplier.contact?.hasWorkEmail).length;
    if (noEmail) {
      task.limitations.push(`${noEmail} candidate${noEmail > 1 ? 's have' : ' has'} no work email in graph8. An RFQ cannot be emailed to them without enrichment, which consumes credits.`);
    }
    task.limitations.push('graph8 confirms a company exists and who works there. It does not confirm that a company can supply this material, holds food-grade certification, or has capacity.');

    if (discovery.results.length === 0) {
      task.limitations.push(`No supplier in the workspace is tagged for "${material?.materialTag}". Add a supplier manually or widen the material category.`);
      return finish(task, { result: discovery, status: 'needs_attention' });
    }

    store.logActivity({
      type: 'agent',
      message: `Supplier discovery returned ${discovery.results.length} candidates for ${requirement.materialName}`,
      refId: requirement.id,
      provenance: 'live',
    });

    return finish(task, { result: discovery });
  } catch (err) {
    return finish(task, { status: 'failed', error: String(err.message || err) });
  }
}

/** Workflow B — shortlist to RFQ drafts. */
export function runRFQPreparation(requirement, supplierIds, { trigger }) {
  const task = createTask({
    kind: 'rfq_preparation',
    title: `Prepare RFQs for ${requirement.materialName}`,
    requirementId: requirement.id,
    trigger,
  });

  try {
    const material = store.material(requirement.materialId);
    task.inputs = { suppliers: supplierIds.length, material: requirement.materialName, quantity: `${requirement.quantity} ${requirement.uom}` };
    step(task, `Preparing a separate RFQ for each of ${supplierIds.length} shortlisted suppliers, using this requirement's own values.`);

    const created = [];
    supplierIds.forEach((sid) => {
      const supplier = store.supplier(sid);
      if (!supplier) return;
      const drafted = draftRFQ({ requirement, supplier, material, workspace: store.workspace });

      const rfq = {
        id: store.nextId('rfq', 'rfq'),
        requirementId: requirement.id,
        supplierId: sid,
        supplierName: supplier.company,
        subject: drafted.subject,
        body: drafted.body,
        requestedFields: drafted.requestedFields,
        toName: drafted.toName,
        toTitle: drafted.toTitle,
        canEmail: drafted.canEmail,
        cannotEmailReason: drafted.cannotEmailReason,
        approved: false,
        sendStatus: 'draft',
        sendDetail: null,
        createdAt: new Date().toISOString(),
      };
      store.state.rfqs.push(rfq);
      created.push(rfq.id);
      task.findings.push(`Drafted RFQ to ${supplier.company} (${drafted.toName})${drafted.canEmail ? '' : ' — no email address on file'}.`);
      if (!drafted.canEmail) task.limitations.push(`${supplier.company}: ${drafted.cannotEmailReason}`);
    });

    store.persist();
    store.logActivity({ type: 'agent', message: `Prepared ${created.length} RFQ draft(s) for ${requirement.materialName}`, refId: requirement.id });
    return finish(task, { result: { rfqIds: created } });
  } catch (err) {
    return finish(task, { status: 'failed', error: String(err.message || err) });
  }
}

/** Workflow C — quotations to a sourcing recommendation. */
export function runQuoteAnalysis(requirement, { trigger }) {
  const task = createTask({
    kind: 'quote_analysis',
    title: `Compare quotations for ${requirement.materialName}`,
    requirementId: requirement.id,
    trigger,
  });

  try {
    const quotes = store.quotesFor(requirement.id);
    const suppliers = store.allSuppliers();
    task.inputs = { quotes: quotes.length, requiredQty: `${requirement.quantity} ${requirement.uom}`, requiredBy: requirement.requiredBy };
    step(task, `Comparing ${quotes.length} saved quotation(s) against the requirement.`);

    const comparison = compareQuotes({ requirement, quotes, suppliers });
    const recommendation = buildRecommendation({ requirement, comparison, suppliers });

    comparison.rows.forEach((r) => {
      task.findings.push(
        r.total !== null
          ? `${r.supplierName}: ${r.currency} ${Math.round(r.total).toLocaleString()} total${r.leadTimeDays !== null ? `, ${r.leadTimeDays}-day lead time` : ''}.`
          : `${r.supplierName}: no price provided.`
      );
    });

    const incomplete = comparison.rows.filter((r) => !r.complete).length;
    if (incomplete) task.limitations.push(`${incomplete} quotation(s) have missing fields. Missing values are shown as "Not provided" and are never estimated.`);
    if (recommendation.status === 'insufficient_evidence') task.limitations.push(recommendation.headline);

    store.logActivity({ type: 'agent', message: `Quote analysis for ${requirement.materialName}: ${recommendation.headline}`, refId: requirement.id });
    return finish(task, { result: { comparison, recommendation } });
  } catch (err) {
    return finish(task, { status: 'failed', error: String(err.message || err) });
  }
}

/** Workflow D — inventory projection to reorder advice. */
export function runInventoryProjection({ trigger }) {
  const task = createTask({ kind: 'inventory_projection', title: 'Recalculate material cover and shortages', trigger });

  try {
    const planning = store.state.planning;
    const product = store.workspace.products[0];
    task.inputs = {
      unitsPerDay: planning.unitsPerDay,
      horizonDays: planning.horizonDays,
      materials: planning.bom.length,
    };
    step(task, `Exploded the ${product.name} BOM against ${planning.unitsPerDay.toLocaleString()} units/day over ${planning.horizonDays} days.`);

    const projection = projectAll(planning, product);

    projection.rows
      .filter((r) => r.status !== 'ok')
      .forEach((r) => {
        task.findings.push(
          r.status === 'shortage'
            ? `${r.materialName} runs out on day ${r.shortageDay}. Suggested order ${r.suggestedOrderQty.toLocaleString()} ${r.uom} by day ${r.orderByDay}.`
            : `${r.materialName} drops below safety stock on day ${r.safetyBreachDay}. Suggested order ${r.suggestedOrderQty.toLocaleString()} ${r.uom} by day ${r.orderByDay}.`
        );
      });

    if (projection.totals.shortages === 0 && projection.totals.belowSafety === 0) {
      task.findings.push(`No material falls below safety stock inside the ${planning.horizonDays}-day horizon at the current plan.`);
    }

    task.sources.push({ name: 'Workspace planning inputs', detail: 'Illustrative stock, BOM and production figures — all user-editable.', provenance: 'demo' });
    task.limitations.push('Inventory, recipe ratios and production volumes here are illustrative sample data, not Nestlé records.');

    return finish(task, { result: projection });
  } catch (err) {
    return finish(task, { status: 'failed', error: String(err.message || err) });
  }
}

/**
 * Deep supplier analysis, run by the graph8 "Supplier Fit Analyst" skill.
 *
 * This is the step where the app stops being a scoring formula. The skill has
 * web search, so it can establish what a company actually does — in testing it
 * correctly downgraded a high-scoring candidate from 68 to 18 after finding the
 * company was a fresh-produce repacker, not a paste manufacturer.
 *
 * Runs in the background because each supplier takes 15–25 seconds. Results
 * attach to the task and the discovery view picks them up.
 */
export async function runSupplierAnalysis(requirement, supplierIds, { trigger }) {
  const task = createTask({
    kind: 'supplier_analysis',
    title: `Research ${supplierIds.length} supplier${supplierIds.length === 1 ? '' : 's'} for ${requirement.materialName}`,
    requirementId: requirement.id,
    trigger,
  });

  if (!isConfigured()) {
    task.limitations.push('No GRAPH8_API_KEY is set, so the graph8 Supplier Fit Analyst could not be called. Discovery still ran on the built-in match scoring.');
    task.inputs = { suppliers: supplierIds.length, engine: 'local' };
    return finish(task, { status: 'needs_attention' });
  }

  task.inputs = { suppliers: supplierIds.length, engine: 'graph8', skill: SKILLS.supplierFit.name };
  step(task, `Handing ${supplierIds.length} candidate(s) to the graph8 "${SKILLS.supplierFit.name}" skill.`);
  task.sources.push({
    name: `graph8 LLM skill — ${SKILLS.supplierFit.name}`,
    detail: `${SKILLS.supplierFit.model}, hosted in your graph8 organisation.`,
    provenance: 'graph8_live',
  });

  const analyses = {};
  let totalCost = 0;
  let searches = 0;

  await Promise.all(
    supplierIds.map(async (sid) => {
      const supplier = store.supplier(sid);
      if (!supplier) return;
      try {
        const { parsed, meta } = await runSkill({
          skillId: SKILLS.supplierFit.id,
          timeoutMs: 70_000,
          input: {
            material: requirement.materialName,
            category: requirement.category,
            quantity: `${Number(requirement.quantity).toLocaleString()} ${requirement.uom}`,
            site: requirement.siteName,
            siteCountry: requirement.siteCountry,
            requiredBy: requirement.requiredBy,
            specification: requirement.specification || '(none stated by the buyer)',
            company: supplier.company,
            source: supplier.source === 'graph8' ? 'graph8 discovery result' : 'internal supplier directory',
            industry: supplier.industry || '(blank on the record)',
            employeeCount: supplier.employeeCount || '(not recorded)',
            supplierLocation: [supplier.state, supplier.country].filter(Boolean).join(', ') || '(unknown)',
            status: supplier.status || '(not a directory supplier)',
            contactName: `${supplier.contact?.firstName || ''} ${supplier.contact?.lastName || ''}`.trim() || '(none)',
            contactTitle: supplier.contact?.jobTitle || '(unknown)',
            hasEmail: supplier.contact?.hasWorkEmail ? 'yes' : 'no',
          },
        });

        analyses[sid] = { ...parsed, supplierId: sid, company: supplier.company, meta, provenance: 'graph8_live' };
        totalCost += meta.costUsd || 0;
        searches += meta.webSearches || 0;
        task.findings.push(`${supplier.company}: ${parsed.verdict} (${parsed.score}/100). ${parsed.oneLine || ''}`);
      } catch (err) {
        task.limitations.push(`${supplier.company}: analysis failed — ${err.message}`);
      }
    })
  );

  task.result = { analyses };
  if (searches) step(task, `The skill ran ${searches} web search(es) to establish what these companies actually do.`);
  if (totalCost) step(task, `Total cost $${totalCost.toFixed(4)}.`);

  const downgraded = Object.values(analyses).filter((a) => a.verdict === 'weak');
  if (downgraded.length) {
    task.limitations.push(`${downgraded.length} candidate(s) were judged weak on research despite scoring well on record matching. Read the verdicts before sending an RFQ.`);
  }

  store.logActivity({
    type: 'agent',
    message: `graph8 researched ${Object.keys(analyses).length} supplier(s) for ${requirement.id}`,
    refId: requirement.id,
    provenance: 'live',
  });

  return finish(task, { result: { analyses } });
}
