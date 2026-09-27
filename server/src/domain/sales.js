/**
 * Sell side: place the product we manufacture with real buyers.
 *
 * The procurement side asks "who can supply this?". This asks "who buys this?"
 * — which is the question graph8's index was actually built for, so it is the
 * part of the product where graph8 does the most work:
 *
 *   discovery     graph8 contact index (harvested; live search when keyed)
 *   qualification graph8 LLM skill "Buyer Outreach Agent", with web search
 *   outreach      the same skill writes the email, per buyer
 *   CRM           qualified buyers are pushed into graph8 as a real list
 *   delivery      real SMTP through the bundled channel
 *
 * A graph8 result means the company exists and someone works there. It does
 * NOT mean they buy this product or want to hear from us, and nothing here
 * pretends otherwise.
 */

import { store } from '../store.js';
import { runSkill, SKILLS, isConfigured } from './graph8Skill.js';
import { sendRFQ, channelStatus, demoAddressFor } from './mail.js';

/** Channel overlap between what the product sells through and what this buyer is. */
export function matchBuyer(buyer, product) {
  const want = new Set(product.targetChannels || []);
  const have = buyer.channelTags || [];
  const hits = have.filter((t) => want.has(t));

  const reasons = [];
  let score = 0;

  if (hits.length) {
    score += 40 + (hits.length - 1) * 8;
    reasons.push(`Sells through ${hits.map((h) => h.replace(/_/g, ' ')).join(' and ')}, which is a target channel for ${product.name}.`);
  } else {
    reasons.push(`Channel (${have.map((h) => h.replace(/_/g, ' ')).join(', ') || 'unknown'}) is not a stated target for this product.`);
  }

  const c = buyer.contact || {};
  if (/buyer|category|merchandis|procurement|sourcing/i.test(c.jobTitle || '')) {
    score += 22;
    reasons.push(`${c.firstName} ${c.lastName} holds a buying title — ${c.jobTitle}.`);
  } else {
    reasons.push(`${c.jobTitle || 'Contact'} is not a buying role; expect a referral rather than a decision.`);
  }

  if (c.hasWorkEmail) score += 12;
  if (typeof c.confidenceScore === 'number') score += Math.round((c.confidenceScore / 100) * 16);

  const size = Number(String(buyer.employeeCount || '').match(/\d+/)?.[0] || 0);
  if (size >= 200) { score += 10; reasons.push(`${buyer.employeeCount} employees — enough scale to move meaningful volume.`); }

  const unknowns = ['Whether they currently stock a competing product is unknown.', 'No buying intent has been established — this is a cold approach.'];
  if (!c.hasWorkEmail) unknowns.push('No work email on file; outreach needs enrichment or another channel.');
  if ((c.confidenceScore ?? 0) < 45) unknowns.push(`Record confidence is only ${c.confidenceScore}/100 — verify the person before contacting.`);

  return { score: Math.min(100, score), reasons, unknowns, channelHits: hits };
}

/** Every channel tag present on the buyer records, for callers that need to
    offer or validate the list. */
export function availableChannels(buyers) {
  return [...new Set(buyers.flatMap((b) => b.channelTags || []))].sort();
}

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Match a free-text channel against a buyer.
 *
 * The tags on the graph8 records are specific — `grocery_wholesaler`,
 * `foodservice_distributor` — but a person (or an agent) types "wholesale",
 * "retail", "foodservice". An exact `includes()` on the tag array returns
 * nothing for every one of those, which reads as "no buyers exist" when in
 * fact the filter never had a chance. So match on word overlap across the
 * tags and the industry field, and treat a few plain-English words as
 * synonyms for the tag vocabulary.
 */
const CHANNEL_SYNONYMS = {
  retail: ['grocery_retail', 'regional_chain'],
  grocery: ['grocery_retail', 'grocery_wholesaler'],
  wholesale: ['grocery_wholesaler', 'cooperative'],
  wholesaler: ['grocery_wholesaler', 'cooperative'],
  distributor: ['foodservice_distributor', 'convenience_distributor', 'specialty_distributor'],
  foodservice: ['foodservice_distributor'],
  restaurant: ['foodservice_distributor'],
  convenience: ['convenience_distributor', 'convenience'],
  specialty: ['specialty_distributor'],
  manufacturer: ['co_manufacturer'],
  national: ['national'],
};

function channelMatches(buyer, channel, exactVocabulary) {
  const want = norm(channel);
  if (!want) return true;
  const tags = (buyer.channelTags || []).map(norm);
  if (tags.includes(want)) return true;

  // A caller who supplied a real tag meant that tag. Widening it would put a
  // grocery_retail chain into a grocery_wholesaler result on a shared word.
  if (exactVocabulary.has(want)) return false;

  const expanded = CHANNEL_SYNONYMS[want]?.map(norm) || [];
  if (expanded.some((e) => tags.includes(e))) return true;

  // Only now fall back to word overlap, so free text like "grocery wholesale"
  // or "foodservice" still lands somewhere sensible.
  const wantWords = want.split(' ').filter(Boolean);
  const haystack = [...tags, norm(buyer.industry)].join(' ');
  return wantWords.some((w) => w.length > 3 && haystack.includes(w.slice(0, Math.max(4, w.length - 2))));
}

export function discoverBuyers({ product, buyers, channel }) {
  const scored = buyers
    .map((b) => ({ buyer: b, match: matchBuyer(b, product) }))
    .sort((a, b) => b.match.score - a.match.score);

  const vocabulary = new Set(availableChannels(buyers).map(norm));
  const filtered = channel ? scored.filter((r) => channelMatches(r.buyer, channel, vocabulary)) : scored;

  // A filter that matches nothing is a filter problem, not an empty index.
  // Return the full ranked list and say so, rather than reporting zero buyers.
  const fellBack = Boolean(channel) && filtered.length === 0;
  const rows = fellBack ? scored : filtered;

  return {
    provenance: 'graph8_live',
    criteria: {
      product: product.name,
      targetChannels: product.targetChannels,
      channelFilter: channel || null,
      channelMatched: !fellBack,
    },
    availableChannels: availableChannels(buyers),
    note: fellBack
      ? `No buyer carries a channel tag matching "${channel}". Showing all ${scored.length} buyers ranked by fit instead. Valid tags: ${availableChannels(buyers).join(', ')}.`
      : null,
    total: rows.length,
    results: rows,
  };
}

/**
 * Qualify a buyer and draft their email in one graph8 call.
 *
 * Combining the two saves a round trip and, more importantly, means the email
 * is written by the same pass that judged the fit — so the hook and the
 * verdict cannot contradict each other.
 */
export async function qualifyBuyer({ buyer, product }) {
  const c = buyer.contact || {};
  const { parsed, meta } = await runSkill({
    skillId: SKILLS.buyerOutreach.id,
    timeoutMs: 70_000,
    input: {
      product: product.name,
      pack: product.pack,
      productCategory: product.productCategory,
      capacity: product.capacity,
      leadTime: product.leadTime,
      certifications: product.certifications,
      pricing: product.pricing,
      differentiators: product.differentiators,
      company: buyer.company,
      industry: buyer.industry || '(blank on the record)',
      employeeCount: buyer.employeeCount || '(not recorded)',
      buyerLocation: [buyer.state, buyer.country].filter(Boolean).join(', ') || '(unknown)',
      contactName: `${c.firstName || ''} ${c.lastName || ''}`.trim() || '(none)',
      contactTitle: c.jobTitle || '(unknown)',
      confidence: String(c.confidenceScore ?? 0),
      hasEmail: c.hasWorkEmail ? 'yes' : 'no',
    },
  });
  return { ...parsed, buyerId: buyer.id, company: buyer.company, meta, provenance: 'graph8_live' };
}

/** Deterministic fallback so the sell side still works with no key. */
export function draftLocally({ buyer, product }) {
  const c = buyer.contact || {};
  const m = matchBuyer(buyer, product);
  const channel = (m.channelHits[0] || (buyer.channelTags || [])[0] || 'distribution').replace(/_/g, ' ');

  const body = [
    `Hi ${c.firstName || 'there'},`,
    ``,
    `You run ${channel} at ${buyer.company}, so this may be relevant: we manufacture ${product.name} in ${product.pack}, and we have capacity for ${product.capacity.split(',')[0]}.`,
    ``,
    `The part worth a look is the spec — ${product.differentiators.split(';')[0]}. We hold ${product.certifications}, and lead time is ${product.leadTime}.`,
    ``,
    `Would you want a sample pack and a price sheet sent over? No call needed unless the numbers work.`,
    ``,
    `— Sales, Nestlé Procurement Demo workspace`,
  ].join('\n');

  return {
    verdict: m.score >= 65 ? 'strong' : m.score >= 40 ? 'possible' : 'weak',
    score: m.score,
    channelFit: channel,
    reasons: m.reasons,
    risks: m.unknowns,
    hook: `${buyer.company} sells through ${channel}, a target channel for ${product.name}.`,
    subject: `${product.name} — ${product.pack.split(',')[0]} for ${buyer.company}`,
    body,
    followUp: 'If no reply in 7 days, send the price sheet unprompted and stop after that.',
    buyerId: buyer.id,
    company: buyer.company,
    provenance: 'derived',
    meta: { engine: 'local' },
  };
}

export async function qualifyOrDraft({ buyer, product }) {
  if (!isConfigured()) return draftLocally({ buyer, product });
  try {
    return await qualifyBuyer({ buyer, product });
  } catch (err) {
    return { ...draftLocally({ buyer, product }), fallbackReason: err.message };
  }
}

/** Sends the approved outreach through the same real SMTP channel as an RFQ. */
export async function sendOutreach({ campaignRow, buyer }) {
  const result = await sendRFQ({
    rfq: {
      id: campaignRow.id,
      requirementId: campaignRow.productId,
      subject: campaignRow.subject,
      body: campaignRow.body,
    },
    supplier: buyer,
  });
  return result;
}

export { channelStatus, demoAddressFor };
