import type { FlowNode } from '@social-switchboard/flow';
import type { Edge } from '@xyflow/react';
import { Icon } from '../components/Icon';
import type { StepNodeType } from './StepNode';
import { handleLabels, STEP_META, summarize } from './steps';

// The flow as a list, for phones: steps in the order a conversation meets them, each with where
// its exits lead. Connecting is picking from a list instead of dragging lines with a finger.

/** Steps in conversation order: from the start, following exits in order; loose steps last. */
export function orderSteps(nodes: StepNodeType[], edges: Edge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const order: StepNodeType[] = [];
  const start = nodes.find((n) => n.data.step.type === 'start');
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    seen.add(id);
    order.push(node);
    for (const h of handleLabels(node.data.step)) {
      const next = edges.find((e) => e.source === id && (e.sourceHandle ?? 'next') === h.id);
      if (next && !seen.has(next.target)) queue.push(next.target);
    }
  }
  return [...order, ...nodes.filter((n) => !seen.has(n.id))];
}

const stepTitle = (step: FlowNode) => STEP_META[step.type].label;

export function StepOutline({
  nodes,
  edges,
  issues,
  flowName,
  triggers,
  onOpen,
}: {
  nodes: StepNodeType[];
  edges: Edge[];
  issues: Map<string, number>;
  flowName: (id: string) => string | undefined;
  triggers: string[];
  onOpen: (id: string) => void;
}) {
  const ordered = orderSteps(nodes, edges);
  const numbers = new Map(ordered.map((n, i) => [n.id, i + 1]));
  // Loose steps: nothing leads to them.
  const targets = new Set(edges.map((e) => e.target));
  return (
    <ol className="grid gap-3">
      {ordered.map((n) => {
        const step = n.data.step;
        const meta = STEP_META[step.type];
        const exits = handleLabels(step);
        const loose = step.type !== 'start' && !targets.has(n.id);
        const summary =
          step.type === 'start'
            ? triggers.length
              ? triggers.join(' · ')
              : 'No triggers yet: tap to add one.'
            : summarize(step, flowName);
        return (
          <li key={n.id}>
            <button
              type="button"
              onClick={() => onOpen(n.id)}
              className={`grid w-full gap-2 border-2 bg-surface p-3 text-left shadow-hard-sm active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${issues.get(n.id) ? 'border-danger' : 'border-edge'}`}
            >
              <span className="flex items-center gap-2.5">
                <span className="grid size-7 shrink-0 place-items-center border-2 border-line text-[12px] font-bold text-muted tabular-nums">
                  {numbers.get(n.id)}
                </span>
                <Icon icon={meta.icon} size={22} />
                <span className="min-w-0 flex-1 truncate font-bold">{stepTitle(step)}</span>
                {issues.get(n.id) ? <span className="chip chip-danger">Fix</span> : null}
                {loose && <span className="chip chip-orange">Not connected</span>}
                <span className="text-muted" aria-hidden>
                  ›
                </span>
              </span>
              {summary && (
                <span className="line-clamp-3 text-[14px] whitespace-pre-line">{summary}</span>
              )}
              {exits.length > 0 && (
                <span className="grid gap-1 border-t-2 border-line pt-2 text-[13px]">
                  {exits.map((h) => {
                    const edge = edges.find(
                      (e) => e.source === n.id && (e.sourceHandle ?? 'next') === h.id,
                    );
                    const target = edge && nodes.find((x) => x.id === edge.target);
                    return (
                      <span key={h.id} className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0 text-muted">{h.label}</span>
                        <span className="text-muted" aria-hidden>
                          →
                        </span>
                        <span className={`truncate ${target ? 'font-bold' : 'text-muted'}`}>
                          {target
                            ? `${numbers.get(target.id)}. ${stepTitle(target.data.step)}`
                            : 'ends here'}
                        </span>
                      </span>
                    );
                  })}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Where each of a step's exits goes, picked from the flow's other steps. */
export function ExitsEditor({
  step,
  nodes,
  edges,
  onConnect,
}: {
  step: FlowNode;
  nodes: StepNodeType[];
  edges: Edge[];
  onConnect: (handle: string, target: string | null) => void;
}) {
  const exits = handleLabels(step);
  if (exits.length === 0) return null;
  const ordered = orderSteps(nodes, edges);
  const numbers = new Map(ordered.map((n, i) => [n.id, i + 1]));
  const options = ordered.filter((n) => n.id !== step.id && n.data.step.type !== 'start');
  return (
    <section className="grid gap-3 border-t-2 border-line pt-4" aria-label="Where it goes next">
      <h3 className="font-bold">Where it goes next</h3>
      {exits.map((h) => {
        const edge = edges.find((e) => e.source === step.id && (e.sourceHandle ?? 'next') === h.id);
        return (
          <label key={h.id} className="grid gap-1.5">
            <span className="text-sm font-bold">{h.label}</span>
            <select
              className="input"
              value={edge?.target ?? ''}
              onChange={(e) => onConnect(h.id, e.target.value || null)}
            >
              <option value="">Nothing: the flow ends here</option>
              {options.map((n) => (
                <option key={n.id} value={n.id}>
                  {numbers.get(n.id)}. {stepTitle(n.data.step)}
                  {n.data.step.type === 'message'
                    ? `: ${summarize(n.data.step, () => undefined)
                        .split('\n')[0]
                        ?.slice(0, 40)}`
                    : ''}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </section>
  );
}
