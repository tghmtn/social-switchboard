import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt from node:crypto keeps the image free of native modules.
// Cost follows OWASP's scrypt guidance (N=2^17, r=8, p=1): ~128 MB and a few hundred ms per hash.
const PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const MAX_MEM = 256 * 1024 * 1024;

function derive(password: string, salt: Buffer, keyLength: number, opts: ScryptOptions) {
  return new Promise<Buffer>((done, fail) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, { ...opts, maxmem: MAX_MEM }, (err, key) =>
      err ? fail(err) : done(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, PARAMS);
  const { N, r, p } = PARAMS;
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await derive(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

// Verifying against this when the email is unknown keeps login timing the same
// whether or not an account exists.
let dummyHash: Promise<string> | undefined;
export function getDummyHash() {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  return dummyHash;
}
