import { outputHandles } from './handles';
import type { FlowGraph } from './schema';

export type FlowIssue = {
  severity: 'error' | 'warning';
  code:
    | 'no_start'
    | 'multiple_starts'
    | 'duplicate_id'
    | 'edge_unknown_node'
    | 'edge_unknown_handle'
    | 'edge_into_start'
    | 'handle_multiple_edges'
    | 'unreachable'
    | 'start_unconnected'
    | 'duplicate_label';
  message: string;
  nodeId?: string;
  edgeId?: string;
};

/**
 * Checks a structurally valid graph (already parsed by `flowGraph`) for wiring problems.
 * Errors block publishing; warnings are shown in the builder but don't.
 */
export function validateFlow(graph: FlowGraph): FlowIssue[] {
  const issues: FlowIssue[] = [];
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));

  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (starts.length === 0)
    issues.push({
      severity: 'error',
      code: 'no_start',
      message: 'The flow needs a starting step.',
    });
  for (const extra of starts.slice(1)) {
    issues.push({
      severity: 'error',
      code: 'multiple_starts',
      message: 'A flow can only have one starting step.',
      nodeId: extra.id,
    });
  }

  const seen = new Set<string>();
  for (const n of graph.nodes) {
    if (seen.has(n.id))
      issues.push({
        severity: 'error',
        code: 'duplicate_id',
        message: `Two steps share the id "${n.id}".`,
        nodeId: n.id,
      });
    seen.add(n.id);
    const handles = outputHandles(n);
    if (new Set(handles).size !== handles.length) {
      issues.push({
        severity: 'error',
        code: 'duplicate_id',
        message: 'Two buttons or branches in this step share an id.',
        nodeId: n.id,
      });
    }
    const labels =
      n.type === 'message' ? n.data.quickReplies.map((q) => q.label.toLowerCase()) : [];
    if (new Set(labels).size !== labels.length) {
      issues.push({
        severity: 'error',
        code: 'duplicate_label',
        message: 'Quick replies need different labels.',
        nodeId: n.id,
      });
    }
  }

  const used = new Set<string>();
  for (const e of graph.edges) {
    const source = nodes.get(e.source);
    const target = nodes.get(e.target);
    if (!source || !target) {
      issues.push({
        severity: 'error',
        code: 'edge_unknown_node',
        message: 'A connection points to a step that no longer exists.',
        edgeId: e.id,
      });
      continue;
    }
    if (target.type === 'start') {
      issues.push({
        severity: 'error',
        code: 'edge_into_start',
        message: 'Nothing can connect into the starting step.',
        edgeId: e.id,
        nodeId: target.id,
      });
    }
    if (!outputHandles(source).includes(e.sourceHandle)) {
      issues.push({
        severity: 'error',
        code: 'edge_unknown_handle',
        message: 'A connection leaves from a button or branch that no longer exists.',
        edgeId: e.id,
        nodeId: source.id,
      });
    }
    const key = `${e.source}\u0000${e.sourceHandle}`;
    if (used.has(key)) {
      issues.push({
        severity: 'error',
        code: 'handle_multiple_edges',
        message: 'Each button or branch can only connect to one next step.',
        edgeId: e.id,
        nodeId: source.id,
      });
    }
    used.add(key);
  }

  const start = starts[0];
  if (start) {
    if (!graph.edges.some((e) => e.source === start.id)) {
      issues.push({
        severity: 'warning',
        code: 'start_unconnected',
        message: 'The starting step isn’t connected to anything yet.',
        nodeId: start.id,
      });
    }
    const reachable = new Set([start.id]);
    const queue = [start.id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const e of graph.edges) {
        if (e.source === current && nodes.has(e.target) && !reachable.has(e.target)) {
          reachable.add(e.target);
          queue.push(e.target);
        }
      }
    }
    for (const n of graph.nodes) {
      if (!reachable.has(n.id)) {
        issues.push({
          severity: 'warning',
          code: 'unreachable',
          message: 'This step can’t be reached from the start.',
          nodeId: n.id,
        });
      }
    }
  }

  return issues;
}

export const hasErrors = (issues: FlowIssue[]) => issues.some((i) => i.severity === 'error');
