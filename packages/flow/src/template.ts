import type { ContactSnapshot } from './engine';

// {{ first_name }} or {{ first_name | there }}: a contact field, with an optional fallback
// used when the field is empty. Unknown fields render as the fallback (or nothing).
const VARIABLE = /\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g;

export function fieldText(contact: ContactSnapshot, key: string): string {
  if (key === 'full_name') {
    return [fieldText(contact, 'first_name'), fieldText(contact, 'last_name')]
      .filter(Boolean)
      .join(' ');
  }
  const value = contact.fields[key];
  return value === null || value === undefined ? '' : String(value);
}

export function renderTemplate(
  template: string,
  contact: ContactSnapshot,
  encode?: (s: string) => string,
) {
  return template.replace(VARIABLE, (_, key: string, fallback?: string) => {
    const text = fieldText(contact, key) || fallback || '';
    return encode ? encode(text) : text;
  });
}

/** Variables inside a URL are percent-encoded so a value can't break the link. */
export const renderUrl = (template: string, contact: ContactSnapshot) =>
  renderTemplate(template, contact, encodeURIComponent);
