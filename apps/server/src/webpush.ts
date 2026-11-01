import { createECDH, hkdfSync } from 'node:crypto';
import webpush from 'web-push';

// Switchboard's own notifications (Web Push), to a browser or the app installed on a phone's home
// screen. The key pair that identifies this install to the push services (VAPID) comes from the
// app secret, so there's nothing to set up or store.

const keyCache = new Map<string, { publicKey: string; privateKey: string }>();

export function vapidKeys(appSecret: string) {
  const cached = keyCache.get(appSecret);
  if (cached) return cached;
  for (let i = 0; ; i++) {
    const priv = Buffer.from(hkdfSync('sha256', appSecret, 'social-switchboard', `vapid ${i}`, 32));
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(priv);
      const keys = {
        publicKey: ecdh.getPublicKey().toString('base64url'),
        privateKey: priv.toString('base64url'),
      };
      keyCache.set(appSecret, keys);
      return keys;
    } catch {
      // Outside the curve's range (about one in four billion): take the next one.
    }
  }
}

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushMessage = { title: string; body: string; url: string; tag?: string };

type Sender = (
  target: PushTarget,
  payload: string,
  options: { keys: { publicKey: string; privateKey: string }; subject: string; topic?: string },
) => Promise<void>;

let sender: Sender = async (target, payload, { keys, subject, topic }) => {
  await webpush.sendNotification(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    payload,
    {
      vapidDetails: { subject, ...keys },
      TTL: 12 * 3600,
      urgency: 'high',
      timeout: 10_000,
      ...(topic ? { topic } : {}),
    },
  );
};
/** Swappable for tests. */
export function setWebPushSender(s: Sender) {
  sender = s;
}

/** The push service says this device is gone (unsubscribed, app deleted): forget it. */
export const isGone = (err: unknown) => {
  const status = (err as { statusCode?: number }).statusCode;
  return status === 404 || status === 410;
};

/**
 * Sends one notification. `publicUrl` names who's sending (push services want a contact URL).
 * Pending notifications with the same tag replace each other while the device is offline.
 */
export function sendWebPush(
  appSecret: string,
  publicUrl: string,
  target: PushTarget,
  message: PushMessage,
) {
  // Push services take up to 32 URL-safe characters: a conversation's id without its dashes.
  const topic = message.tag?.replace(/[^A-Za-z0-9_]/g, '').slice(0, 32);
  return sender(target, JSON.stringify(message), {
    keys: vapidKeys(appSecret),
    subject: publicUrl.startsWith('https://') ? publicUrl : 'mailto:admin@localhost',
    topic: topic || undefined,
  });
}

/** A short name for a device, from its browser's user agent. */
export function deviceLabel(userAgent: string | undefined) {
  const ua = userAgent ?? '';
  const device = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'Browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : '';
  if (device === 'iPhone' || device === 'iPad') return device;
  return browser ? `${browser} on ${device === 'Mac' ? 'a Mac' : device}` : device;
}
