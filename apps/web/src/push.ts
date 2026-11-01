import { api } from './api';

// Switchboard's own notifications on this device (Web Push). public/sw.js shows them.

export const pushSupported = () =>
  'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** An iPhone or iPad in Safari: notifications only work once it's added to the Home Screen. */
export const needsInstall = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) &&
  !(navigator as { standalone?: boolean }).standalone &&
  !matchMedia('(display-mode: standalone)').matches;

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/** This device's subscription, if notifications are on here. */
export async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

const keyBytes = (base64url: string) => {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) => {
  if (!a || a.byteLength !== b.length) return false;
  const bytes = new Uint8Array(a);
  return bytes.every((x, i) => x === b[i]);
};

/**
 * Asks permission, subscribes this device and tells the server. Call it straight from a tap
 * (iPhones only ask then). Returns why it didn't work, if it didn't.
 */
export async function turnOnHere(vapidKey: string): Promise<string | undefined> {
  if (!pushSupported())
    return needsInstall()
      ? 'On iPhone, add Switchboard to your Home Screen first (Share → Add to Home Screen), then turn notifications on from there.'
      : 'This browser can’t show notifications.';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted')
    return permission === 'denied'
      ? 'Notifications are blocked for Switchboard. Allow them in this browser’s site settings (on iPhone: Settings → Notifications → Switchboard), then try again.'
      : 'Notifications weren’t allowed.';
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const key = keyBytes(vapidKey);
  let sub = await reg.pushManager.getSubscription();
  // One made with another install's key can't be reused.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await api('/settings/notifications/devices', { endpoint: json.endpoint, keys: json.keys });
}

/** Turns notifications off here: unsubscribes, and the server forgets this device. */
export async function turnOffHere(deviceId: string | undefined) {
  const sub = await currentSubscription();
  await sub?.unsubscribe();
  if (deviceId) await api(`/settings/notifications/devices/${deviceId}`, undefined, 'DELETE');
}

/** The unread count on the installed app's icon (where the device supports it). */
export function setAppBadge(n: number) {
  const nav = navigator as {
    setAppBadge?: (n: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (n > 0) void nav.setAppBadge?.(n).catch(() => {});
  else void nav.clearAppBadge?.().catch(() => {});
}
