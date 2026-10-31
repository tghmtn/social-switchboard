// Light / dark / system preference. "system" leaves data-theme unset so the CSS follows the OS.
// index.html applies a saved choice before first paint; this module changes it at runtime.

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'ss-theme';

export function getTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked (private mode): the choice still applies for this visit.
  }
  const root = document.documentElement;
  root.classList.add('theme-switching');
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove('theme-switching')),
  );
}
