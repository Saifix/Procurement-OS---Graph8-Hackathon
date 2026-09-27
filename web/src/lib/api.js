const BASE = '/api';

/**
 * Sent on every request. When the app is served through an ngrok free tunnel,
 * ngrok answers browser-agent requests with an HTML interstitial instead of
 * passing them through — which turns every API response into unparseable HTML
 * and breaks the whole UI silently. This header opts out of it. It is ignored
 * everywhere else, so it costs nothing to send always.
 */
const TUNNEL_HEADERS = { 'ngrok-skip-browser-warning': 'true' };

async function req(path, options = {}) {
  const res = await fetch(BASE + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...TUNNEL_HEADERS, ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${path}`);
    err.status = res.status;
    err.errors = data?.errors || null;
    throw err;
  }
  return data;
}

const qs = (params = {}) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => req('/health'),
  workspace: () => req('/workspace'),
  dashboard: () => req('/dashboard'),
  activity: () => req('/activity'),
  reset: () => req('/reset', { method: 'POST' }),

  channel: () => req('/channel'),
  engine: () => req('/engine'),
  systemSkills: () => req('/system-skills'),
  deepDive: (body) => req('/deep-dive', { method: 'POST', body }),
  getDeepDive: (entity, id, skill) => req(`/deep-dive${qs({ entity, id, skill })}`),
  analyses: (id) => req(`/requirements/${id}/analyses`),
  analyseSuppliers: (id, supplierIds) => req(`/requirements/${id}/analyse-suppliers`, { method: 'POST', body: { supplierIds } }),
  intake: (body) => req('/intake', { method: 'POST', body }),
  chatTools: () => req('/chat/tools'),
  chat: (messages, role, conversationId) =>
    req('/chat', { method: 'POST', body: { messages, role, conversationId } }),
  conversations: (role) => req(`/chat/conversations?role=${encodeURIComponent(role || '')}`),
  conversation: (id) => req(`/chat/conversations/${id}`),
  deleteConversation: (id) => req(`/chat/conversations/${id}`, { method: 'DELETE' }),

  requirements: (f) => req(`/requirements${qs(f)}`),
  requirement: (id) => req(`/requirements/${id}`),
  createRequirement: (body) => req('/requirements', { method: 'POST', body }),
  updateRequirement: (id, body) => req(`/requirements/${id}`, { method: 'PATCH', body }),

  discover: (id, trigger) => req(`/requirements/${id}/discover`, { method: 'POST', body: { trigger } }),
  discovery: (id) => req(`/requirements/${id}/discovery`),
  shortlist: (id, supplierId, reason) => req(`/requirements/${id}/shortlist`, { method: 'POST', body: { supplierId, reason } }),
  unshortlist: (id, supplierId) => req(`/requirements/${id}/shortlist/${supplierId}`, { method: 'DELETE' }),

  prepareRFQs: (id) => req(`/requirements/${id}/rfqs`, { method: 'POST', body: {} }),
  updateRFQ: (rfqId, body) => req(`/rfqs/${rfqId}`, { method: 'PATCH', body }),
  sendRFQ: (rfqId) => req(`/rfqs/${rfqId}/send`, { method: 'POST', body: {} }),

  addQuote: (id, body) => req(`/requirements/${id}/quotes`, { method: 'POST', body }),
  deleteQuote: (quoteId) => req(`/quotes/${quoteId}`, { method: 'DELETE' }),
  analyse: (id) => req(`/requirements/${id}/analyse`, { method: 'POST', body: {} }),

  decide: (id, body) => req(`/requirements/${id}/decision`, { method: 'POST', body }),

  planning: () => req('/planning'),
  savePlanning: (body) => req('/planning', { method: 'PUT', body }),
  resetPlanning: () => req('/planning/reset', { method: 'POST' }),

  forwardBuy: (f) => req(`/analytics/forward-buy${qs(f)}`),

  tasks: (f) => req(`/tasks${qs(f)}`),
  task: (id) => req(`/tasks/${id}`),
  retryTask: (id) => req(`/tasks/${id}/retry`, { method: 'POST', body: {} }),

  suppliers: (f) => req(`/suppliers${qs(f)}`),

  salesProducts: () => req('/sales/products'),
  salesBuyers: (f) => req(`/sales/buyers${qs(f)}`),
  salesQualify: (productId, buyerIds) => req('/sales/qualify', { method: 'POST', body: { productId, buyerIds } }),
  salesCampaigns: () => req('/sales/campaigns'),
  salesUpdateCampaign: (id, body) => req(`/sales/campaigns/${id}`, { method: 'PATCH', body }),
  salesSend: (id) => req(`/sales/campaigns/${id}/send`, { method: 'POST', body: {} }),
  salesStatus: () => req('/sales/status'),
  crmPush: (productId) => req('/sales/crm-push', { method: 'POST', body: { productId } }),
  crmPushes: () => req('/sales/crm-pushes'),
};
