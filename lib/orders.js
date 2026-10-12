export const SESSION_PRICE_CENTS = 700;

export const ORDER_KINDS = ['call', 'session'];

export function isOrderKind(value) {
  return ORDER_KINDS.includes(value);
}

export const PAYMENT_METHODS = {
  wise: { label: 'Wise', needsCode: false },
  amazon: { label: 'Amazon gift card', needsCode: true },
};

export function isPaymentMethod(value) {
  return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, value);
}

export const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

const REFERENCE_LENGTH = 10;

function group(bare) {
  return bare.length === REFERENCE_LENGTH ? `${bare.slice(0, 5)}-${bare.slice(5)}` : bare;
}

export function referenceCode(random) {
  let out = '';
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    out += REFERENCE_ALPHABET[random(REFERENCE_ALPHABET.length)];
  }
  return group(out);
}

export function normalizeReference(raw) {
  return group(
    String(raw || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ''),
  );
}

export function looksLikeReference(normalized) {
  return /^[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(normalized);
}

export const REJECT_REASONS = {
  not_received: 'No $7 payment arrived on Wise with this reference.',
  short: 'Less than $7 arrived for this order.',
  empty: 'The gift card has no balance on it.',
  used: 'The gift card was already used.',
  invalid: "The gift card code isn't a valid Amazon code. It may have been mistyped.",
  duplicate: 'This payment is already matched to a different order.',
};

export const MAX_SESSION_STARTS = 3;
export const SESSION_WINDOW_HOURS = 24;

export const SESSION_BUDGET_SECONDS = 35 * 60;

export const ASSUME_FULL_AFTER_SECONDS = 30 * 60;

export const UNREPORTED_AFTER_SECONDS = 60 * 60;

export const ABANDON_WITHIN_SECONDS = 120;

export function describeStatus(order) {
  if (!order) return 'unknown';
  if (order.status !== 'confirmed') return order.status;
  const first = order.first_started_at;
  const expired =
    first && Date.now() - new Date(first).getTime() > SESSION_WINDOW_HOURS * 3_600_000;
  if (expired || Number(order.session_starts || 0) >= MAX_SESSION_STARTS) return 'used';
  return 'confirmed';
}

export const OPENING_LINE =
  'What do you make of the recommendations? And would you like help following them through?';
