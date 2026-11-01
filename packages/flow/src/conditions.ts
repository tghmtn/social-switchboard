import type { ContactSnapshot } from './engine';
import type { ConditionRule, NodeOf } from './schema';
import { fieldText } from './template';
import { zonedParts } from './time';

export type ConditionContext = { contact: ContactSnapshot; now: Date; timeZone: string };

const lower = (s: string) => s.trim().toLowerCase();
const toNumber = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));

export function evaluateRule(
  rule: ConditionRule,
  { contact, now, timeZone }: ConditionContext,
): boolean {
  switch (rule.subject) {
    case 'tag': {
      const has = contact.tags.some((t) => lower(t) === lower(rule.tag));
      return rule.op === 'has' ? has : !has;
    }
    case 'field': {
      const value = fieldText(contact, rule.key);
      switch (rule.op) {
        case 'is_set':
          return value !== '';
        case 'is_not_set':
          return value === '';
        case 'equals':
          return lower(value) === lower(rule.value);
        case 'not_equals':
          return lower(value) !== lower(rule.value);
        case 'contains':
          return lower(value).includes(lower(rule.value));
        case 'not_contains':
          return !lower(value).includes(lower(rule.value));
        case 'greater_than':
          return toNumber(value) > toNumber(rule.value);
        case 'less_than':
          return toNumber(value) < toNumber(rule.value);
      }
      return false;
    }
    case 'channel':
      return rule.op === 'is' ? contact.channel === rule.value : contact.channel !== rule.value;
    case 'weekday':
      return rule.days.includes(zonedParts(now, timeZone).weekday);
    case 'hour': {
      const hour = zonedParts(now, timeZone).hour;
      return rule.from <= rule.to
        ? hour >= rule.from && hour < rule.to
        : hour >= rule.from || hour < rule.to;
    }
    case 'follows':
      return (contact.followsUs === true) === (rule.op === 'yes');
  }
}

type Case = NodeOf<'condition'>['data']['cases'][number];

export function evaluateCase(c: Case, ctx: ConditionContext): boolean {
  return c.match === 'all'
    ? c.rules.every((r) => evaluateRule(r, ctx))
    : c.rules.some((r) => evaluateRule(r, ctx));
}
