import { createHmac, timingSafeEqual } from 'node:crypto';

// Meta signs callbacks (like data-deletion requests) as "<signature>.<payload>", both
// base64url, where signature = HMAC-SHA256(payload, app secret).
// https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback

export type SignedRequest = {
  algorithm: string;
  user_id?: string;
  issued_at?: number;
  [key: string]: unknown;
};

export function parseSignedRequest(signed: string, appSecret: string): SignedRequest | null {
  const [encodedSig, payload] = signed.split('.', 2);
  if (!encodedSig || !payload) return null;
  const expected = createHmac('sha256', appSecret).update(payload).digest();
  const actual = Buffer.from(encodedSig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedRequest;
    return data.algorithm?.toUpperCase() === 'HMAC-SHA256' ? data : null;
  } catch {
    return null;
  }
}

/** Builds a signed request the way Meta does. Used by tests and local tooling. */
export function signRequest(data: object, appSecret: string) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = createHmac('sha256', appSecret).update(payload).digest('base64url');
  return `${sig}.${payload}`;
}

export function parseSignedRequestAny(signed: string, secrets: string[]): SignedRequest | null {
  for (const secret of secrets) {
    const data = parseSignedRequest(signed, secret);
    if (data) return data;
  }
  return null;
}
