import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Secrets at rest (Meta app secrets, Instagram tokens) are AES-256-GCM encrypted with a key
// derived from APP_SECRET. Adapted from OpenReply (MIT), lib/meta/oauth.ts; see THIRD_PARTY_NOTICES.md.

const VERSION = 'v1';

function keyFor(appSecret: string, purpose: string) {
  return Buffer.from(hkdfSync('sha256', appSecret, 'social-switchboard', purpose, 32));
}

export function encryptSecret(appSecret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(appSecret, 'secrets'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    data.toString('base64url'),
  ].join(':');
}

export function decryptSecret(appSecret: string, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(':');
  if (version !== VERSION || !iv || !tag || !data) throw new Error('unrecognized encrypted value');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFor(appSecret, 'secrets'),
    Buffer.from(iv, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** Short signed tokens (e.g. OAuth state) that expire. */
export function signToken(appSecret: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', keyFor(appSecret, 'tokens')).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken<T extends { ts: number }>(
  appSecret: string,
  token: string,
  maxAgeMs: number,
): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', keyFor(appSecret, 'tokens')).update(body).digest();
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    const age = Date.now() - data.ts;
    return typeof data.ts === 'number' && age >= 0 && age <= maxAgeMs ? data : null;
  } catch {
    return null;
  }
}
