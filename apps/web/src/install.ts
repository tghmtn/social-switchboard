import { useSyncExternalStore } from 'react';

// Adding Switchboard to the Home Screen. Chrome, Edge and Samsung Internet on Android offer
// their own install dialog (beforeinstallprompt), which a button can open. iPhones only add from
// the browser's own Share menu, so there we show the steps instead.

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let offered: InstallEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

/** Call before the app renders: browsers offer their install dialog once, early on. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Our own sheet asks; its button opens the browser's dialog.
    e.preventDefault();
    offered = e as InstallEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    offered = null;
    changed();
  });
}

export const isInstalled = () =>
  matchMedia('(display-mode: standalone)').matches ||
  Boolean((navigator as { standalone?: boolean }).standalone);

/**
 * How this device adds the app: the browser's own dialog, the steps for an iPhone (Safari or
 * Chrome there), "open it in your real browser first" for an app's built-in browser, a browser
 * menu on other Androids, or null once installed (or on a computer without the dialog).
 */
export type InstallWay = 'prompt' | 'ios-safari' | 'ios-chrome' | 'in-app' | 'android' | null;

export function installWay(): InstallWay {
  if (isInstalled()) return null;
  const ua = navigator.userAgent;
  // Instagram's, Facebook's and other apps' built-in browsers can't add to the Home Screen.
  if (/Instagram|FBAN|FBAV|FB_IAB|LinkedInApp|Snapchat|musical_ly|TikTok|\bLine\//.test(ua))
    return 'in-app';
  if (offered) return 'prompt';
  // iPads say they're Macs; their touch screen gives them away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (ios) return /CriOS|EdgiOS/.test(ua) ? 'ios-chrome' : 'ios-safari';
  if (/Android/.test(ua)) return 'android';
  return null;
}

export function useInstallWay() {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, installWay);
}

/** Opens the browser's own install dialog. True if they installed. */
export async function promptInstall() {
  const e = offered;
  if (!e) return false;
  offered = null;
  changed();
  await e.prompt();
  return (await e.userChoice).outcome === 'accepted';
}

const NUDGED = 'ss-install-nudge';

/** The one-time suggestion: only on a phone or tablet, and only once. */
export function shouldNudge() {
  if (!matchMedia('(pointer: coarse)').matches) return false;
  try {
    return localStorage.getItem(NUDGED) === null;
  } catch {
    return false;
  }
}

export function markNudged() {
  try {
    localStorage.setItem(NUDGED, 'shown');
  } catch {
    // Private browsing: it may ask again next time, which is fine.
  }
}
