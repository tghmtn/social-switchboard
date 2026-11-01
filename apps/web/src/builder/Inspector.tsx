import type {
  Action,
  Button,
  ConditionRule,
  FlowNode,
  MessagePart,
  NodeOf,
} from '@social-switchboard/flow';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Field, Select, TextArea } from '../ui';
import { newId, STEP_META } from './steps';

// Forms for each step type. Every edit calls onChange with a whole new step; the editor saves it.

type Props<T extends FlowNode['type']> = { step: NodeOf<T>; onChange: (s: NodeOf<T>) => void };
type Ctx = { fieldKeys: string[]; flows: { id: string; name: string }[]; currentFlowId: string };

const num = (v: string, fallback: number) =>
  Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Group({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <fieldset className="grid gap-3 border-t-2 border-line pt-4">
      <legend className="sr-only">{title}</legend>
      <div className="flex items-center justify-between gap-2">
        <span className="text-label uppercase text-muted" aria-hidden="true">
          {title}
        </span>
        {action}
      </div>
      {children}
    </fieldset>
  );
}

function Remove({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className="linkbtn text-[13px] text-danger"
      onClick={onClick}
      aria-label={label}
    >
      Remove
    </button>
  );
}

function FieldKeyInput({
  label,
  value,
  onChange,
  keys,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  keys: string[];
  hint?: string;
}) {
  return (
    <>
      <Field
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
        list="field-keys"
        hint={hint}
        placeholder="e.g. interest"
      />
      <datalist id="field-keys">
        {keys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
    </>
  );
}

export function Inspector({
  step,
  onChange,
  onDelete,
  ctx,
}: {
  step: FlowNode;
  onChange: (s: FlowNode) => void;
  onDelete: () => void;
  ctx: Ctx;
}) {
  const meta = STEP_META[step.type];
  let body: ReactNode = null;
  switch (step.type) {
    case 'message':
      body = <MessageForm step={step} onChange={onChange} ctx={ctx} />;
      break;
    case 'ask':
      body = <AskForm step={step} onChange={onChange} ctx={ctx} />;
      break;
    case 'condition':
      body = <ConditionForm step={step} onChange={onChange} ctx={ctx} />;
      break;
    case 'action':
      body = <ActionForm step={step} onChange={onChange} ctx={ctx} />;
      break;
    case 'delay':
      body = <DelayForm step={step} onChange={onChange} />;
      break;
    case 'split':
      body = <SplitForm step={step} onChange={onChange} />;
      break;
    case 'goto_flow':
      body = (
        <Select
          label="Continue in"
          value={step.data.flowId}
          onChange={(e) => onChange({ ...step, data: { flowId: e.target.value } })}
        >
          <option value="choose" disabled>
            Choose a flow…
          </option>
          {ctx.flows
            .filter((f) => f.id !== ctx.currentFlowId)
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
        </Select>
      );
      break;
    case 'handoff':
      body = (
        <>
          <p className="text-[14px] text-muted">
            The flow ends here and automation pauses for this contact until someone resumes it from
            their contact page.
          </p>
          <TextArea
            label="Note for the team (optional)"
            value={step.data.note ?? ''}
            maxLength={500}
            onChange={(e) => onChange({ ...step, data: { note: e.target.value } })}
          />
        </>
      );
      break;
    case 'start':
      break;
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{meta.label}</h2>
        {step.type !== 'start' && (
          <button type="button" className="btn btn-sm" onClick={onDelete}>
            Delete step
          </button>
        )}
      </div>
      {body}
    </div>
  );
}

function MessageForm({ step, onChange, ctx }: Props<'message'> & { ctx: Ctx }) {
  const d = step.data;
  const set = (data: Partial<typeof d>) => onChange({ ...step, data: { ...d, ...data } });
  const setPart = (i: number, p: MessagePart) =>
    set({ parts: d.parts.map((x, j) => (j === i ? p : x)) });
  const setButton = (i: number, b: Button) =>
    set({ buttons: d.buttons.map((x, j) => (j === i ? b : x)) });

  return (
    <>
      <Group title="Content">
        {d.parts.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: these items have no id and every input is controlled
          <div key={`${i}-${p.type}`} className="grid gap-2 border-2 border-line p-3">
            <div className="flex items-center justify-between">
              <span className="text-label uppercase text-muted">
                Part {i + 1} · {p.type}
              </span>
              {d.parts.length > 1 && (
                <Remove
                  label={`Remove ${p.type}`}
                  onClick={() => set({ parts: d.parts.filter((_, j) => j !== i) })}
                />
              )}
            </div>
            {p.type === 'text' && (
              <TextArea
                label="Text"
                value={p.text}
                rows={4}
                maxLength={2000}
                onChange={(e) => setPart(i, { ...p, text: e.target.value })}
                hint="Use {{first_name | there}} to personalize."
              />
            )}
            {p.type === 'image' && (
              <Field
                label="Image URL"
                value={p.url}
                onChange={(e) => setPart(i, { ...p, url: e.target.value })}
                placeholder="https://…"
              />
            )}
            {p.type === 'file' && (
              <>
                <Field
                  label="File URL (PDF)"
                  value={p.url}
                  onChange={(e) => setPart(i, { ...p, url: e.target.value })}
                  placeholder="https://…/guide.pdf"
                  hint={
                    d.buttons.length >= 3
                      ? 'On Instagram a direct link to a PDF arrives as a document. The buttons are full, so any other link arrives as plain text.'
                      : 'On Instagram a direct link to a PDF arrives as a document. In the first reply to a comment, files are always buttons.'
                  }
                />
                <FileLinkCheck
                  url={p.url}
                  name={p.name}
                  onName={(name) => setPart(i, { ...p, name })}
                  sameLinkButton={
                    d.buttons.find((b) => b.kind === 'url' && b.url.trim() === p.url.trim())?.label
                  }
                />
                <Field
                  label="File name"
                  value={p.name}
                  onChange={(e) => setPart(i, { ...p, name: e.target.value })}
                />
              </>
            )}
          </div>
        ))}
        {d.parts.length < 10 && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => set({ parts: [...d.parts, { type: 'text', text: 'More text' }] })}
            >
              + Text
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => set({ parts: [...d.parts, { type: 'image', url: 'https://' }] })}
            >
              + Image
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                set({ parts: [...d.parts, { type: 'file', url: 'https://', name: STARTER_NAME }] })
              }
            >
              + File
            </button>
          </div>
        )}
      </Group>

      <Group
        title={`Buttons (${d.buttons.length}/3)`}
        action={
          d.buttons.length < 3 && (
            <button
              type="button"
              className="linkbtn text-[13px]"
              onClick={() =>
                set({
                  buttons: [
                    ...d.buttons,
                    { id: newId('btn'), kind: 'url', label: 'Open link', url: 'https://' },
                  ],
                })
              }
            >
              + Add
            </button>
          )
        }
      >
        {d.buttons.map((b, i) => (
          <div key={b.id} className="grid gap-2 border-2 border-line p-3">
            <div className="flex justify-end">
              <Remove
                label={`Remove button ${b.label}`}
                onClick={() => set({ buttons: d.buttons.filter((_, j) => j !== i) })}
              />
            </div>
            <Field
              label="Label"
              value={b.label}
              maxLength={20}
              onChange={(e) => setButton(i, { ...b, label: e.target.value })}
              hint="Up to 20 characters"
            />
            <Select
              label="When tapped"
              value={b.kind}
              onChange={(e) =>
                setButton(
                  i,
                  e.target.value === 'url'
                    ? { id: b.id, kind: 'url', label: b.label, url: 'https://' }
                    : { id: b.id, kind: 'flow', label: b.label },
                )
              }
            >
              <option value="url">Open a link</option>
              <option value="flow">Continue the flow</option>
            </Select>
            {b.kind === 'url' && (
              <Field
                label="Link"
                value={b.url}
                onChange={(e) => setButton(i, { ...b, url: e.target.value })}
                hint="{{email}} etc. are filled in and encoded."
              />
            )}
          </div>
        ))}
      </Group>

      <Group
        title={`Quick replies (${d.quickReplies.length})`}
        action={
          d.quickReplies.length < 13 && (
            <button
              type="button"
              className="linkbtn text-[13px]"
              onClick={() =>
                set({
                  quickReplies: [
                    ...d.quickReplies,
                    { id: newId('qr'), label: `Option ${d.quickReplies.length + 1}` },
                  ],
                })
              }
            >
              + Add
            </button>
          )
        }
      >
        {d.quickReplies.length === 0 && (
          <p className="text-[13px] text-muted">
            Add quick replies to wait for a choice and branch on it.
          </p>
        )}
        {d.quickReplies.map((q, i) => (
          <div key={q.id} className="flex items-end gap-2">
            <Field
              label={`Reply ${i + 1}`}
              className="flex-1"
              value={q.label}
              maxLength={20}
              onChange={(e) =>
                set({
                  quickReplies: d.quickReplies.map((x, j) =>
                    j === i ? { ...q, label: e.target.value } : x,
                  ),
                })
              }
            />
            <div className="pb-3">
              <Remove
                label={`Remove reply ${q.label}`}
                onClick={() => set({ quickReplies: d.quickReplies.filter((_, j) => j !== i) })}
              />
            </div>
          </div>
        ))}
        {d.quickReplies.length > 0 && (
          <>
            <FieldKeyInput
              label="Save the reply to"
              value={d.saveReplyTo ?? ''}
              onChange={(v) => set({ saveReplyTo: v || undefined })}
              keys={ctx.fieldKeys}
              hint="Optional contact field"
            />
            <Field
              label="Wait for a reply up to (hours)"
              type="number"
              min={1}
              max={720}
              value={d.timeoutHours}
              onChange={(e) => set({ timeoutHours: num(e.target.value, d.timeoutHours) })}
            />
          </>
        )}
      </Group>
    </>
  );
}

function AskForm({ step, onChange, ctx }: Props<'ask'> & { ctx: Ctx }) {
  const d = step.data;
  const set = (data: Partial<typeof d>) => onChange({ ...step, data: { ...d, ...data } });
  return (
    <>
      <TextArea
        label="Question"
        value={d.question}
        rows={3}
        maxLength={2000}
        onChange={(e) => set({ question: e.target.value })}
      />
      <Select
        label="Expect"
        value={d.inputType}
        onChange={(e) => set({ inputType: e.target.value as typeof d.inputType })}
      >
        <option value="text">Any text</option>
        <option value="email">An email address</option>
        <option value="phone">A phone number</option>
        <option value="number">A number</option>
        <option value="url">A website</option>
      </Select>
      <FieldKeyInput
        label="Save the answer to"
        value={d.saveTo ?? ''}
        onChange={(v) => set({ saveTo: v || undefined })}
        keys={ctx.fieldKeys}
      />
      <TextArea
        label="If the answer doesn’t fit"
        value={d.retryMessage}
        rows={2}
        onChange={(e) => set({ retryMessage: e.target.value })}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Retries"
          type="number"
          min={0}
          max={5}
          value={d.maxRetries}
          onChange={(e) => set({ maxRetries: num(e.target.value, d.maxRetries) })}
        />
        <Field
          label="Wait up to (hours)"
          type="number"
          min={1}
          max={720}
          value={d.timeoutHours}
          onChange={(e) => set({ timeoutHours: num(e.target.value, d.timeoutHours) })}
        />
      </div>
    </>
  );
}

const FIELD_OPS = [
  ['is_set', 'is set'],
  ['is_not_set', 'is empty'],
  ['equals', 'is'],
  ['not_equals', 'isn’t'],
  ['contains', 'contains'],
  ['not_contains', 'doesn’t contain'],
  ['greater_than', 'is more than'],
  ['less_than', 'is less than'],
] as const;

function defaultRule(subject: ConditionRule['subject']): ConditionRule {
  switch (subject) {
    case 'tag':
      return { subject, op: 'has', tag: 'lead' };
    case 'field':
      return { subject, key: 'email', op: 'is_set', value: '' };
    case 'channel':
      return { subject, op: 'is', value: 'instagram' };
    case 'weekday':
      return { subject, op: 'in', days: [1, 2, 3, 4, 5] };
    case 'hour':
      return { subject, op: 'between', from: 9, to: 17 };
  }
}

function RuleEditor({
  rule,
  onChange,
  keys,
}: {
  rule: ConditionRule;
  onChange: (r: ConditionRule) => void;
  keys: string[];
}) {
  return (
    <div className="grid gap-2">
      <Select
        label="Check"
        value={rule.subject}
        onChange={(e) => onChange(defaultRule(e.target.value as ConditionRule['subject']))}
      >
        <option value="tag">Tag</option>
        <option value="field">Field</option>
        <option value="channel">Channel</option>
        <option value="weekday">Day of week</option>
        <option value="hour">Time of day</option>
      </Select>
      {rule.subject === 'tag' && (
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Contact"
            value={rule.op}
            onChange={(e) => onChange({ ...rule, op: e.target.value as 'has' | 'not_has' })}
          >
            <option value="has">has tag</option>
            <option value="not_has">doesn’t have</option>
          </Select>
          <Field
            label="Tag"
            value={rule.tag}
            onChange={(e) => onChange({ ...rule, tag: e.target.value })}
          />
        </div>
      )}
      {rule.subject === 'field' && (
        <>
          <FieldKeyInput
            label="Field"
            value={rule.key}
            onChange={(v) => onChange({ ...rule, key: v })}
            keys={keys}
          />
          <div className="grid grid-cols-2 gap-2">
            <Select
              label="Test"
              value={rule.op}
              onChange={(e) => onChange({ ...rule, op: e.target.value as typeof rule.op })}
            >
              {FIELD_OPS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
            {rule.op !== 'is_set' && rule.op !== 'is_not_set' && (
              <Field
                label="Value"
                value={rule.value}
                onChange={(e) => onChange({ ...rule, value: e.target.value })}
              />
            )}
          </div>
        </>
      )}
      {rule.subject === 'channel' && (
        <div className="grid grid-cols-2 gap-2">
          <Select
            label="Channel"
            value={rule.op}
            onChange={(e) => onChange({ ...rule, op: e.target.value as 'is' | 'is_not' })}
          >
            <option value="is">is</option>
            <option value="is_not">isn’t</option>
          </Select>
          <Select
            label="Name"
            value={rule.value}
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
          >
            <option value="instagram">Instagram</option>
            <option value="simulator">Simulator</option>
          </Select>
        </div>
      )}
      {rule.subject === 'weekday' && (
        <DayPicker
          days={rule.days}
          onChange={(days) => days.length && onChange({ ...rule, days })}
        />
      )}
      {rule.subject === 'hour' && (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="From hour"
            type="number"
            min={0}
            max={23}
            value={rule.from}
            onChange={(e) => onChange({ ...rule, from: num(e.target.value, rule.from) })}
          />
          <Field
            label="Until hour"
            type="number"
            min={0}
            max={24}
            value={rule.to}
            onChange={(e) => onChange({ ...rule, to: num(e.target.value, rule.to) })}
          />
        </div>
      )}
    </div>
  );
}

function DayPicker({ days, onChange }: { days: number[]; onChange: (d: number[]) => void }) {
  return (
    <fieldset className="flex flex-wrap gap-1.5">
      <legend className="sr-only">Days</legend>
      {WEEKDAYS.map((name, d) => {
        const on = days.includes(d);
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            className={`chip cursor-pointer py-1 ${on ? 'chip-lime' : ''}`}
            onClick={() => onChange(on ? days.filter((x) => x !== d) : [...days, d].sort())}
          >
            {name}
          </button>
        );
      })}
    </fieldset>
  );
}

function ConditionForm({ step, onChange, ctx }: Props<'condition'> & { ctx: Ctx }) {
  const cases = step.data.cases;
  const setCases = (c: typeof cases) => onChange({ ...step, data: { cases: c } });
  return (
    <>
      <p className="text-[14px] text-muted">
        Cases are checked in order. The first one that matches wins; if none match, the flow goes
        down “Otherwise”.
      </p>
      {cases.map((c, ci) => (
        <Group
          key={c.id}
          title={`Case ${ci + 1}`}
          action={
            cases.length > 1 && (
              <Remove
                label={`Remove case ${ci + 1}`}
                onClick={() => setCases(cases.filter((_, j) => j !== ci))}
              />
            )
          }
        >
          <Select
            label="Match"
            value={c.match}
            onChange={(e) =>
              setCases(
                cases.map((x, j) =>
                  j === ci ? { ...c, match: e.target.value as 'all' | 'any' } : x,
                ),
              )
            }
          >
            <option value="all">All of these</option>
            <option value="any">Any of these</option>
          </Select>
          {c.rules.map((r, ri) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: these items have no id and every input is controlled
            <div key={`${c.id}-${ri}`} className="grid gap-2 border-2 border-line p-3">
              {c.rules.length > 1 && (
                <div className="flex justify-end">
                  <Remove
                    label="Remove rule"
                    onClick={() =>
                      setCases(
                        cases.map((x, j) =>
                          j === ci ? { ...c, rules: c.rules.filter((_, k) => k !== ri) } : x,
                        ),
                      )
                    }
                  />
                </div>
              )}
              <RuleEditor
                rule={r}
                keys={ctx.fieldKeys}
                onChange={(nr) =>
                  setCases(
                    cases.map((x, j) =>
                      j === ci ? { ...c, rules: c.rules.map((y, k) => (k === ri ? nr : y)) } : x,
                    ),
                  )
                }
              />
            </div>
          ))}
          {c.rules.length < 20 && (
            <button
              type="button"
              className="btn btn-sm w-fit"
              onClick={() =>
                setCases(
                  cases.map((x, j) =>
                    j === ci ? { ...c, rules: [...c.rules, defaultRule('tag')] } : x,
                  ),
                )
              }
            >
              + Rule
            </button>
          )}
        </Group>
      ))}
      {cases.length < 10 && (
        <button
          type="button"
          className="btn btn-sm w-fit"
          onClick={() =>
            setCases([...cases, { id: newId('case'), match: 'all', rules: [defaultRule('tag')] }])
          }
        >
          + Case
        </button>
      )}
    </>
  );
}

function defaultAction(type: Action['type']): Action {
  switch (type) {
    case 'add_tag':
    case 'remove_tag':
      return { type, tag: 'lead' };
    case 'set_field':
      return { type, key: 'status', value: '' };
    case 'clear_field':
      return { type, key: 'status' };
    case 'set_consent':
      return { type, channel: 'email', granted: true };
    case 'notify_team':
      return { type, message: '{{full_name | Someone}} needs attention' };
  }
}

function ActionForm({ step, onChange, ctx }: Props<'action'> & { ctx: Ctx }) {
  const actions = step.data.actions;
  const set = (a: Action[]) => onChange({ ...step, data: { actions: a } });
  const setAt = (i: number, a: Action) => set(actions.map((x, j) => (j === i ? a : x)));
  return (
    <>
      {actions.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: these items have no id and every input is controlled
        <div key={`${i}-${a.type}`} className="grid gap-2 border-2 border-line p-3">
          <div className="flex items-end gap-2">
            <Select
              label={`Action ${i + 1}`}
              className="flex-1"
              value={a.type}
              onChange={(e) => setAt(i, defaultAction(e.target.value as Action['type']))}
            >
              <option value="add_tag">Add a tag</option>
              <option value="remove_tag">Remove a tag</option>
              <option value="set_field">Set a field</option>
              <option value="clear_field">Clear a field</option>
              <option value="set_consent">Record consent</option>
              <option value="notify_team">Notify the team</option>
            </Select>
            {actions.length > 1 && (
              <div className="pb-3">
                <Remove
                  label={`Remove action ${i + 1}`}
                  onClick={() => set(actions.filter((_, j) => j !== i))}
                />
              </div>
            )}
          </div>
          {(a.type === 'add_tag' || a.type === 'remove_tag') && (
            <Field
              label="Tag"
              value={a.tag}
              onChange={(e) => setAt(i, { ...a, tag: e.target.value })}
            />
          )}
          {(a.type === 'set_field' || a.type === 'clear_field') && (
            <FieldKeyInput
              label="Field"
              value={a.key}
              onChange={(v) => setAt(i, { ...a, key: v })}
              keys={ctx.fieldKeys}
            />
          )}
          {a.type === 'set_field' && (
            <Field
              label="Value"
              value={a.value}
              onChange={(e) => setAt(i, { ...a, value: e.target.value })}
              hint="Can use {{variables}}"
            />
          )}
          {a.type === 'set_consent' && (
            <div className="grid grid-cols-2 gap-2">
              <Select
                label="Channel"
                value={a.channel}
                onChange={(e) => setAt(i, { ...a, channel: e.target.value as 'email' | 'sms' })}
              >
                <option value="email">Email</option>
                <option value="sms">SMS</option>
              </Select>
              <Select
                label="Consent"
                value={a.granted ? 'yes' : 'no'}
                onChange={(e) => setAt(i, { ...a, granted: e.target.value === 'yes' })}
              >
                <option value="yes">Opted in</option>
                <option value="no">Opted out</option>
              </Select>
            </div>
          )}
          {a.type === 'notify_team' && (
            <TextArea
              label="Message"
              value={a.message}
              rows={2}
              maxLength={500}
              onChange={(e) => setAt(i, { ...a, message: e.target.value })}
            />
          )}
        </div>
      ))}
      {actions.length < 20 && (
        <button
          type="button"
          className="btn btn-sm w-fit"
          onClick={() => set([...actions, defaultAction('add_tag')])}
        >
          + Action
        </button>
      )}
    </>
  );
}

function DelayForm({ step, onChange }: Props<'delay'>) {
  const d = step.data;
  return (
    <>
      <Select
        label="Wait"
        value={d.mode}
        onChange={(e) =>
          onChange({
            ...step,
            data:
              e.target.value === 'duration'
                ? { mode: 'duration', amount: 1, unit: 'hours' }
                : { mode: 'until_time', time: '09:00', days: [] },
          })
        }
      >
        <option value="duration">For a while</option>
        <option value="until_time">Until a time of day</option>
      </Select>
      {d.mode === 'duration' ? (
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Amount"
            type="number"
            min={1}
            max={999}
            value={d.amount}
            onChange={(e) =>
              onChange({ ...step, data: { ...d, amount: num(e.target.value, d.amount) } })
            }
          />
          <Select
            label="Unit"
            value={d.unit}
            onChange={(e) =>
              onChange({ ...step, data: { ...d, unit: e.target.value as typeof d.unit } })
            }
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </Select>
        </div>
      ) : (
        <>
          <Field
            label="Time (workspace time zone)"
            type="time"
            value={d.time}
            onChange={(e) =>
              e.target.value && onChange({ ...step, data: { ...d, time: e.target.value } })
            }
          />
          <div className="grid gap-1.5">
            <span className="text-sm font-bold">Only on (none = any day)</span>
            <DayPicker
              days={d.days}
              onChange={(days) => onChange({ ...step, data: { ...d, days } })}
            />
          </div>
        </>
      )}
    </>
  );
}

function SplitForm({ step, onChange }: Props<'split'>) {
  const b = step.data.branches;
  const set = (branches: typeof b) => onChange({ ...step, data: { branches } });
  return (
    <>
      <p className="text-[14px] text-muted">
        Each person goes down one path at random, in proportion to the weights. Small samples won’t
        split perfectly evenly.
      </p>
      {b.map((x, i) => (
        <div key={x.id} className="grid grid-cols-[1fr_96px_auto] items-end gap-2">
          <Field
            label="Path"
            value={x.label}
            maxLength={40}
            onChange={(e) => set(b.map((y, j) => (j === i ? { ...x, label: e.target.value } : y)))}
          />
          <Field
            label="Weight"
            type="number"
            min={1}
            max={100}
            value={x.weight}
            onChange={(e) =>
              set(b.map((y, j) => (j === i ? { ...x, weight: num(e.target.value, x.weight) } : y)))
            }
          />
          <div className="pb-3">
            {b.length > 2 && (
              <Remove
                label={`Remove path ${x.label}`}
                onClick={() => set(b.filter((_, j) => j !== i))}
              />
            )}
          </div>
        </div>
      ))}
      {b.length < 5 && (
        <button
          type="button"
          className="btn btn-sm w-fit"
          onClick={() =>
            set([
              ...b,
              { id: newId('path'), label: String.fromCharCode(65 + b.length), weight: 50 },
            ])
          }
        >
          + Path
        </button>
      )}
    </>
  );
}

type FileCheck =
  | { pdf: true; size?: number; name?: string }
  | {
      pdf: false;
      reason: 'not_https' | 'unreachable' | 'not_pdf' | 'too_big';
      type?: string;
      size?: number;
    };

const sizeText = (n?: number) =>
  !n
    ? ''
    : n < 1_048_576
      ? `${Math.max(1, Math.round(n / 1024))} KB`
      : `${(n / 1_048_576).toFixed(1)} MB`;
const kindOf = (type?: string) =>
  !type
    ? 'not a PDF'
    : type === 'text/html'
      ? 'a web page'
      : type.startsWith('image/')
        ? 'an image'
        : type.startsWith('video/')
          ? 'a video'
          : `a ${type} file`;

/** The name "+ File" starts with; replaced by the real one once the link turns out to be a PDF. */
const STARTER_NAME = 'Guide.pdf';

/**
 * How Instagram will send this file link, checked a moment after typing stops. A PDF document
 * shows under the file's own name, so the name field follows it unless someone typed their own.
 */
function FileLinkCheck({
  url,
  name,
  onName,
  sameLinkButton,
}: {
  url: string;
  name: string;
  onName: (name: string) => void;
  /** One of the message's own buttons opening this link: it stands in for the file's button. */
  sameLinkButton?: string;
}) {
  const [result, setResult] = useState<FileCheck | 'checking'>();
  // Read at answer time, so typing a name doesn't re-run the check.
  const nameRef = useRef(name);
  nameRef.current = name;
  const onNameRef = useRef(onName);
  onNameRef.current = onName;
  useEffect(() => {
    const link = url.trim();
    if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(link)) {
      setResult(undefined);
      return;
    }
    let cancelled = false;
    setResult('checking');
    const timer = setTimeout(async () => {
      try {
        const r = await api<FileCheck>('/instagram/check-file', { url: link });
        if (cancelled) return;
        setResult(r);
        if (r.pdf && r.name && (!nameRef.current.trim() || nameRef.current === STARTER_NAME))
          onNameRef.current(r.name);
      } catch {
        if (!cancelled) setResult(undefined);
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url]);

  if (!result) return null;
  if (result === 'checking') return <p className="text-[13px] text-muted">Checking the link…</p>;
  // Sentence case: file names keep their real capitals.
  const chip =
    'chip w-fit py-1 text-[13px] leading-snug tracking-normal normal-case whitespace-normal [overflow-wrap:anywhere]';
  if (result.pdf) {
    const real = result.name;
    return (
      <div className="grid gap-1.5">
        <p className={`${chip} chip-success`}>
          ✓ A PDF{result.size ? ` (${sizeText(result.size)})` : ''}: arrives on Instagram as a
          document{real ? ` called “${real}”` : ''}
        </p>
        {real && name !== real && (
          <p className="text-[13px] text-muted">
            Instagram shows the PDF’s own name, not “{name}”. The name here only labels the button
            in a reply to a comment. To change what people see, rename the file.{' '}
            <button type="button" className="linkbtn" onClick={() => onName(real)}>
              Use the file’s name
            </button>
          </p>
        )}
      </div>
    );
  }
  const why = {
    not_https: 'The link needs to start with https://',
    unreachable: 'Couldn’t open this link',
    not_pdf: `This link is ${kindOf(result.type)}, not a PDF`,
    too_big: `This PDF is ${sizeText(result.size)}, over Instagram’s 25 MB limit`,
  }[result.reason];
  // Same label the server puts on the button (Instagram stops at 20 characters).
  const label = Array.from(`📄 ${name.trim() || 'File'}`)
    .slice(0, 20)
    .join('');
  return (
    <p className={`${chip} chip-orange`}>
      {why}
      {sameLinkButton
        ? `. Your “${sameLinkButton}” button already opens it, so that’s what people get`
        : `, so it arrives as a button labeled “${label}”`}
    </p>
  );
}
