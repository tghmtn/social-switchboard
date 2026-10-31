// Spreadsheet apps treat cells starting with these as formulas; prefixing a quote neutralizes
// them (OWASP "CSV injection"). Contact data comes from strangers, so this matters.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvRow = (values: unknown[]) => `${values.map(csvCell).join(',')}\r\n`;
