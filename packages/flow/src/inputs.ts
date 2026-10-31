export type InputType = 'text' | 'email' | 'phone' | 'number' | 'url';

/** Validates and normalizes a typed answer. Returns null when the answer isn't acceptable. */
export function parseInput(type: InputType, raw: string): string | number | null {
  const text = raw.trim();
  if (!text) return null;
  switch (type) {
    case 'text':
      return text.slice(0, 1000);
    case 'email': {
      const email = text.toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(email) && email.length <= 254 ? email : null;
    }
    case 'phone': {
      // Keep a leading + and the digits; accept the usual separators people type.
      if (!/^\+?[\d\s().-]+$/.test(text)) return null;
      const digits = text.replace(/\D/g, '');
      if (digits.length < 7 || digits.length > 15) return null;
      return text.startsWith('+') ? `+${digits}` : digits;
    }
    case 'number': {
      const n = Number(text.replace(/,/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    case 'url': {
      const candidate = /^https?:\/\//i.test(text) ? text : `https://${text}`;
      try {
        const url = new URL(candidate);
        return url.hostname.includes('.') ? url.toString() : null;
      } catch {
        return null;
      }
    }
  }
}
