/**
 * Outbound RFQ delivery.
 *
 * The compose stack ships a real SMTP server (Mailpit) alongside the app, so
 * an RFQ is genuinely transmitted over SMTP and lands in a real inbox with a
 * real message id. "Sent" on screen means sent, not "a button was pressed".
 *
 * What it is NOT: delivery to the public internet. Mailpit accepts everything
 * and delivers nothing outward, which is exactly what you want when the
 * recipients are demo addresses standing in for suppliers. The app states this
 * once, in the inbox panel, rather than warning about it on every screen.
 *
 * Point DEMO_SMTP_URL at a real relay and the same code path delivers for real.
 */

import nodemailer from 'nodemailer';

let transport = null;
let transportError = null;

function smtpUrl() {
  return process.env.DEMO_SMTP_URL || '';
}

function getTransport() {
  if (transport || transportError) return transport;
  const url = smtpUrl();
  if (!url) return null;
  try {
    transport = nodemailer.createTransport(url, {
      // Mailpit speaks plain SMTP on 1025 with no auth or TLS.
      tls: { rejectUnauthorized: false },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
    });
  } catch (err) {
    transportError = err;
    return null;
  }
  return transport;
}

export function channelStatus() {
  const url = smtpUrl();
  return {
    configured: Boolean(url),
    host: url ? url.replace(/^smtps?:\/\//, '').split('@').pop() : null,
    inboxUrl: process.env.DEMO_INBOX_URL || null,
    fromAddress: process.env.DEMO_FROM_ADDRESS || 'procurement@nestle-demo.local',
    note: url
      ? 'RFQs are transmitted over SMTP to the demo mail server bundled with this stack. Real messages, real message ids, delivered to a demo inbox rather than the public internet.'
      : 'No SMTP channel configured. Set DEMO_SMTP_URL to enable delivery.',
  };
}

/** Supplier addresses are synthesised: graph8 masks real contact emails, and
    we would not send to a real business from a demo anyway. */
export function demoAddressFor(supplier) {
  const slug = (supplier.domain || supplier.company || 'supplier')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.[a-z.]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const person = supplier.contact?.firstName
    ? `${supplier.contact.firstName}.${supplier.contact.lastName || 'sales'}`.toLowerCase().replace(/[^a-z0-9.]/g, '')
    : 'sales';
  return `${person}@${slug}.supplier.demo`;
}

export async function sendRFQ({ rfq, supplier }) {
  const t = getTransport();
  const status = channelStatus();

  if (!t) {
    return {
      sendStatus: 'not_configured',
      sendDetail: status.note,
      messageId: null,
      to: null,
    };
  }

  const to = demoAddressFor(supplier);

  try {
    const info = await t.sendMail({
      from: `"Nestlé Procurement Demo" <${status.fromAddress}>`,
      to,
      subject: rfq.subject,
      text: rfq.body,
      headers: {
        'X-Procurement-Requirement': rfq.requirementId,
        'X-Procurement-RFQ': rfq.id,
        'X-Demo-Workspace': 'nestle-procurement-demo',
      },
    });

    return {
      sendStatus: 'sent',
      sendDetail: `Delivered over SMTP to ${to}. Message id ${info.messageId}.`,
      messageId: info.messageId,
      to,
      accepted: info.accepted || [],
    };
  } catch (err) {
    return {
      sendStatus: 'failed',
      sendDetail: `SMTP delivery failed: ${err.message}`,
      messageId: null,
      to,
    };
  }
}

/**
 * Demo supplier responder.
 *
 * Only ever used for suppliers that do not exist — the fictional directory
 * vendors. A graph8-discovered company is a real business, and inventing a
 * quotation in its name would be a lie regardless of where the mail lands.
 */
export function canAutoRespond(supplier) {
  return supplier?.source === 'directory';
}

/** Deterministic per-supplier pricing so a rerun of the demo behaves the same. */
function seededVariance(seed, spread) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ((h % 1000) / 1000 - 0.5) * 2 * spread;
}

export function buildDemoQuote({ requirement, supplier, material }) {
  const base = material?.unitCostAssumption || 1;
  const variance = seededVariance(supplier.id + requirement.materialId, 0.14);
  const unitPrice = Number((base * (1 + variance)).toFixed(4));

  const leadBase = material?.leadTimeDays || 21;
  const leadTimeDays = Math.max(5, Math.round(leadBase * (1 + seededVariance(supplier.id + 'lead', 0.3))));

  // An approved directory vendor quoting less than the requirement stalls the
  // whole workflow on a technicality, so coverage starts at full and varies
  // upward. Shortfall scenarios are still reachable by entering a quote by
  // hand, which is where that edge case belongs.
  const qty = Number(requirement.quantity);
  const availableQty = Math.round(qty * (1 + Math.abs(seededVariance(supplier.id + 'qty', 0.3))));

  return {
    supplierId: supplier.id,
    unitPrice,
    currency: 'USD',
    additionalCharges: Math.round(qty * unitPrice * 0.015),
    minimumOrderQty: Math.round(qty * 0.2),
    availableQty,
    leadTimeDays,
    validityDays: 30,
    deliveryTerms: supplier.country === requirement.siteCountry ? 'DDP plant' : 'CIF Karachi',
    paymentTerms: 'Net 30',
    specCompliance: requirement.specification
      ? `Confirmed against the stated specification: ${requirement.specification}`
      : 'Standard grade confirmed; no specification was stated in the RFQ.',
    certifications: 'HACCP, ISO 22000',
    notes: 'Received through the demo mail channel.',
    entryMode: 'demo_reply',
  };
}

export function replyBody({ requirement, supplier, quote }) {
  const c = supplier.contact || {};
  return [
    `Dear Procurement,`,
    ``,
    `Thank you for the enquiry regarding ${requirement.materialName}.`,
    ``,
    `We are pleased to quote as follows:`,
    ``,
    `  Unit price:        USD ${quote.unitPrice} per ${requirement.uom}`,
    `  Quantity available: ${quote.availableQty.toLocaleString()} ${requirement.uom}`,
    `  Minimum order:      ${quote.minimumOrderQty.toLocaleString()} ${requirement.uom}`,
    `  Lead time:          ${quote.leadTimeDays} days from purchase order`,
    `  Quote validity:     ${quote.validityDays} days`,
    `  Delivery terms:     ${quote.deliveryTerms}`,
    `  Payment terms:      ${quote.paymentTerms}`,
    `  Specification:      ${quote.specCompliance}`,
    `  Certifications:     ${quote.certifications}`,
    ``,
    `Please confirm the order quantity and required delivery window and we will`,
    `reserve production capacity accordingly.`,
    ``,
    `Kind regards,`,
    `${c.firstName || 'Sales'} ${c.lastName || 'Team'}`,
    `${c.jobTitle || 'Sales'}, ${supplier.company}`,
  ].join('\n');
}

/** Delivers the supplier's reply into the same demo inbox, so the round trip
    is visible end to end rather than appearing from nowhere. */
export async function sendDemoReply({ requirement, supplier, quote }) {
  const t = getTransport();
  if (!t) return { ok: false, detail: 'No SMTP channel configured.' };
  const status = channelStatus();
  try {
    const info = await t.sendMail({
      from: `"${supplier.contact?.firstName || 'Sales'} ${supplier.contact?.lastName || ''} (${supplier.company})" <${demoAddressFor(supplier)}>`,
      to: status.fromAddress,
      subject: `RE: ${requirement.materialName} — quotation from ${supplier.company}`,
      text: replyBody({ requirement, supplier, quote }),
      headers: {
        'X-Procurement-Requirement': requirement.id,
        'X-Demo-Reply': 'true',
      },
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}
