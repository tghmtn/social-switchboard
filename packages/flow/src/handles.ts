import type { FlowEdge, FlowGraph, FlowNode } from './schema';

/** The output handles a node exposes, i.e. the places an edge may leave from. */
export function outputHandles(node: FlowNode): string[] {
  switch (node.type) {
    case 'start':
    case 'action':
    case 'delay':
      return ['next'];
    case 'message': {
      const flowButtons = node.data.buttons.filter((b) => b.kind === 'flow').map((b) => b.id);
      return node.data.quickReplies.length > 0
        ? [...node.data.quickReplies.map((q) => q.id), 'other', 'timeout', ...flowButtons]
        : ['next', ...flowButtons];
    }
    case 'ask':
      return ['answered', 'failed', 'timeout'];
    case 'condition':
      return [...node.data.cases.map((c) => c.id), 'else'];
    case 'split':
      return node.data.branches.map((b) => b.id);
    case 'ai':
      return ['done', 'handoff', 'gave_up', 'timeout'];
    case 'goto_flow':
    case 'handoff':
      return [];
  }
}

export type GraphIndex = {
  node(id: string): FlowNode | undefined;
  /** Target node id of the edge leaving `nodeId` through `handle`, if one is connected. */
  next(nodeId: string, handle: string): string | undefined;
  start: FlowNode | undefined;
};

export function indexGraph(graph: FlowGraph): GraphIndex {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map<string, FlowEdge>();
  for (const e of graph.edges) edges.set(`${e.source}\u0000${e.sourceHandle}`, e);
  return {
    node: (id) => nodes.get(id),
    next: (nodeId, handle) => edges.get(`${nodeId}\u0000${handle}`)?.target,
    start: graph.nodes.find((n) => n.type === 'start'),
  };
}
