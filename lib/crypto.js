import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';

function secret() {
  const raw = process.env.CARD_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'CARD_ENCRYPTION_KEY is missing or shorter than 32 characters. Set it in the Render ' +
        'project settings. Without it, card codes cannot be stored or read.',
    );
  }
  return raw;
}

let cachedKey = null;
function key() {
  if (!cachedKey) cachedKey = crypto.createHash('sha256').update(secret()).digest();
  return cachedKey;
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(stored) {
  if (!stored) return null;
  const parts = String(stored).split('.');
  if (parts.length !== 3) throw new Error('Stored value is not in the expected three-part form.');
  const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

export function keyedHash(value) {
  return crypto.createHmac('sha256', key()).update(String(value)).digest('hex');
}

export function normalizeCardCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

export function claimToken() {
  return crypto.randomBytes(24).toString('base64url');
}

export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function callerKey(req) {
  const header = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(header) ? header.join(',') : header || '').split(',');
  const ip = chain[chain.length - 1].trim();
  return keyedHash('caller:' + (ip || 'unknown'));
}

export function signSession(subject, ttlMinutes = 720) {
  const expires = Date.now() + ttlMinutes * 60_000;
  const payload = `${Buffer.from(String(subject), 'utf8').toString('base64url')}.${expires}`;
  return `${payload}.${keyedHash(payload)}`;
}

export function readSession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [encoded, expires, signature] = parts;
  if (!Number(expires) || Number(expires) < Date.now()) return null;
  if (!timingSafeEqual(signature, keyedHash(`${encoded}.${expires}`))) return null;
  const subject = Buffer.from(encoded, 'base64url').toString('utf8');
  return subject || null;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256Base64Url(value) {
  return crypto.createHash('sha256').update(String(value)).digest('base64url');
}
