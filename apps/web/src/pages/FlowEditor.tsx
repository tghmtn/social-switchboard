import type { FlowGraph, FlowIssue, FlowNode, FlowNodeType } from '@social-switchboard/flow';
import { outputHandles } from '@social-switchboard/flow';
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  ApiError,
  api,
  type FieldDef,
  FLOW_CHANGED,
  type FlowDetail,
  type FlowSummary,
  useApi,
} from '../api';
import { Inspector } from '../builder/Inspector';
import { StepNode, type StepNodeType } from '../builder/StepNode';
import { ADDABLE, defaultStep, newId, STEP_META } from '../builder/steps';
import { TriggersEditor, triggerText } from '../builder/Triggers';
import { Icon } from '../components/Icon';
import { Simulator } from '../components/Simulator';
import { FormError } from '../ui';

const nodeTypes = { step: StepNode };
type SaveState =
  | { kind: 'saved' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; nodeId?: string };

const toRfNode = (step: FlowNode): StepNodeType => ({
  id: step.id,
  type: 'step',
  position: step.position,
  data: { step, issues: 0, invalid: false, triggers: [], flowName: () => undefined },
  deletable: step.type !== 'start',
});

function toGraph(nodes: StepNodeType[], edges: Edge[]): FlowGraph {
  return {
    nodes: nodes.map((n) => ({
      ...n.data.step,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle ?? 'next',
      target: e.target,
    })),
  };
}

export function FlowEditor() {
  const { id = '' } = useParams();
  const detail = useApi<FlowDetail>(`/flows/${id}`);
  const reload = detail.reload;
  const [version, setVersion] = useState(0);
  // The assistant changed this flow: load its new draft into a fresh canvas.
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<{ flowId?: string }>).detail?.flowId !== id) return;
      void reload().then(() => setVersion((v) => v + 1));
    };
    window.addEventListener(FLOW_CHANGED, changed);
    return () => window.removeEventListener(FLOW_CHANGED, changed);
  }, [id, reload]);
  if (detail.error) return <p className="p-8 font-bold text-danger">Couldn’t load this flow.</p>;
  if (!detail.data) return null;
  return (
    <ReactFlowProvider>
      <Editor key={`${id}:${version}`} detail={detail.data} reloadDetail={detail.reload} />
    </ReactFlowProvider>
  );
}

function Editor({
  detail,
  reloadDetail,
}: {
  detail: FlowDetail;
  reloadDetail: () => Promise<void>;
}) {
  const flowId = detail.flow.id;
  const flows = useApi<{ flows: FlowSummary[] }>('/flows');
  const fields = useApi<{ system: { key: string }[]; fields: FieldDef[] }>('/fields');
  const { screenToFlowPosition } = useReactFlow();
  const canvas = useRef<HTMLDivElement>(null);

  const [nodes, setNodes] = useState<StepNodeType[]>(() => detail.flow.draft.nodes.map(toRfNode));
  const [edges, setEdges] = useState<Edge[]>(() => detail.flow.draft.edges.map((e) => ({ ...e })));
  const [issues, setIssues] = useState<FlowIssue[]>(detail.issues);
  const [save, setSave] = useState<SaveState>({ kind: 'saved' });
  const [tab, setTab] = useState<'step' | 'test'>('step');
  const [name, setName] = useState(detail.flow.name);
  const [publishing, setPublishing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);
  const published = Boolean(detail.flow.publishedVersionId);
  const latest = detail.versions[0];
  const [unpublished, setUnpublished] = useState(
    !latest || new Date(detail.flow.updatedAt) > new Date(latest.createdAt),
  );

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const graphJson = useMemo(() => JSON.stringify(graph), [graph]);
  const savedJson = useRef(graphJson);
  const selected = nodes.find((n) => n.selected);

  const doSave = useCallback(
    async (json: string) => {
      setSave({ kind: 'saving' });
      try {
        const res = await api<{ issues: FlowIssue[] }>(
          `/flows/${flowId}/draft`,
          { graph: JSON.parse(json) },
          'PUT',
        );
        savedJson.current = json;
        setIssues(res.issues);
        setUnpublished(true);
        setSave({ kind: 'saved' });
      } catch (err) {
        if (err instanceof ApiError && err.issues.length > 0) {
          const issue = err.issues[0];
          const index = issue?.path[0] === 'nodes' ? Number(issue.path[1]) : Number.NaN;
          const step = Number.isNaN(index)
            ? undefined
            : (JSON.parse(json) as FlowGraph).nodes[index];
          setSave({
            kind: 'error',
            message: `${step ? `${STEP_META[step.type].label}: ` : ''}${issue?.message ?? 'Something isn’t valid.'}`,
            nodeId: step?.id,
          });
        } else
          setSave({
            kind: 'error',
            message: 'Couldn’t reach the server. Changes will save when it’s back.',
          });
      }
    },
    [flowId],
  );

  // Autosave shortly after the last change. Selection alone doesn't change the JSON, so it doesn't save.
  useEffect(() => {
    if (graphJson === savedJson.current) return;
    setSave({ kind: 'pending' });
    const t = setTimeout(() => void doSave(graphJson), 700);
    return () => clearTimeout(t);
  }, [graphJson, doSave]);

  const onNodesChange = useCallback((changes: NodeChange<StepNodeType>[]) => {
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((es) => applyEdgeChanges(changes, es)),
    [],
  );
  const onConnect = useCallback((c: Connection) => {
    // One connection per output: a new one replaces the old.
    setEdges((es) =>
      addEdge(
        { ...c, id: newId('e') },
        es.filter((e) => !(e.source === c.source && e.sourceHandle === c.sourceHandle)),
      ),
    );
  }, []);
  const isValidConnection = useCallback(
    (c: Connection | Edge) => nodes.find((n) => n.id === c.target)?.data.step.type !== 'start',
    [nodes],
  );

  function updateStep(step: FlowNode) {
    setNodes((ns) => ns.map((n) => (n.id === step.id ? { ...n, data: { ...n.data, step } } : n)));
    // Drop connections from outputs that no longer exist (a removed button, case or path).
    const handles = new Set(outputHandles(step));
    setEdges((es) =>
      es.filter((e) => e.source !== step.id || handles.has(e.sourceHandle ?? 'next')),
    );
  }

  function removeStep(nodeId: string) {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
  }

  function addStep(type: FlowNodeType) {
    setAdding(false);
    let position: { x: number; y: number };
    const from = selected;
    if (from) position = { x: from.position.x + 340, y: from.position.y };
    else {
      const r = canvas.current?.getBoundingClientRect();
      position = screenToFlowPosition({
        x: (r?.left ?? 0) + (r?.width ?? 600) / 2 - 130,
        y: (r?.top ?? 0) + (r?.height ?? 400) / 2 - 60,
      });
    }
    const step = defaultStep(type, position);
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { ...toRfNode(step), selected: true },
    ]);
    if (from) {
      // Chain it onto the selected step's first free output, so building forward is quick.
      const free = outputHandles(from.data.step).find(
        (h) => !edges.some((e) => e.source === from.id && e.sourceHandle === h),
      );
      if (free)
        setEdges((es) => [
          ...es,
          { id: newId('e'), source: from.id, sourceHandle: free, target: step.id },
        ]);
    }
    setTab('step');
  }

  async function publish() {
    setPublishing(true);
    setNotice(undefined);
    try {
      if (graphJson !== savedJson.current) await doSave(graphJson);
      const res = await api<{ version: { number: number } }>(`/flows/${flowId}/publish`, {});
      setUnpublished(false);
      setNotice(`Version ${res.version.number} is live.`);
      await reloadDetail();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'flow_has_errors')
        setNotice('Fix the steps marked “Fix” before publishing.');
      else setNotice('Publishing failed. Try again.');
    } finally {
      setPublishing(false);
    }
  }

  async function rename() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === detail.flow.name) return setName(detail.flow.name);
    await api(`/flows/${flowId}`, { name: trimmed }, 'PATCH');
  }

  // Decorate nodes with what the canvas needs to show: issue flags and trigger chips.
  const flowNames = useMemo(
    () => new Map(flows.data?.flows.map((f) => [f.id, f.name])),
    [flows.data],
  );
  const issueCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of issues)
      if (i.nodeId && i.severity === 'error') m.set(i.nodeId, (m.get(i.nodeId) ?? 0) + 1);
    return m;
  }, [issues]);
  const triggerChips = useMemo(
    () => detail.triggers.filter((t) => t.enabled).map((t) => triggerText(t.config)),
    [detail.triggers],
  );
  const viewNodes = useMemo(
    () =>
      nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          issues: issueCount.get(n.id) ?? 0,
          invalid: save.kind === 'error' && save.nodeId === n.id,
          triggers: n.data.step.type === 'start' ? triggerChips : [],
          flowName: (fid: string) => flowNames.get(fid),
        },
      })),
    [nodes, issueCount, save, triggerChips, flowNames],
  );

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const fieldKeys = [
    ...(fields.data?.system.map((f) => f.key) ?? []),
    ...(fields.data?.fields.map((f) => f.key) ?? []),
  ];
  const selectNode = (nodeId: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })));
    setTab('step');
  };

  return (
    <div className="flex min-h-[calc(100dvh-7.5rem)] flex-col min-[900px]:h-dvh">
      <header className="flex flex-wrap items-center gap-3 border-b-2 border-edge bg-surface px-4 py-3">
        <Link to="/flows" className="linkbtn">
          ← Flows
        </Link>
        <label htmlFor="flow-name" className="sr-only">
          Flow name
        </label>
        <input
          id="flow-name"
          className="input w-auto min-w-0 flex-1 border-transparent bg-transparent px-2 text-lg font-bold hover:border-line focus:border-edge sm:max-w-sm"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        {published ? (
          unpublished ? (
            <span className="chip chip-orange">Unpublished changes</span>
          ) : (
            <span className="chip chip-success">Live · v{latest?.number}</span>
          )
        ) : (
          <span className="chip">Draft</span>
        )}
        <span className="text-[13px] text-muted" aria-live="polite">
          {save.kind === 'saved' ? 'Saved' : save.kind === 'error' ? '' : 'Saving…'}
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm ml-auto"
          disabled={
            publishing || save.kind === 'error' || errors.length > 0 || (published && !unpublished)
          }
          onClick={publish}
        >
          {publishing ? 'Publishing…' : published ? 'Publish changes' : 'Publish'}
        </button>
      </header>
      {(save.kind === 'error' || notice) && (
        <div className="border-b-2 border-edge bg-surface px-4 py-2">
          {save.kind === 'error' ? (
            <FormError message={`Not saved. ${save.message}`} />
          ) : (
            <p className="text-[14px] font-bold">{notice}</p>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-rows-[60vh_auto] lg:grid-cols-[minmax(0,1fr)_380px] lg:grid-rows-1">
        <div ref={canvas} className="relative min-h-0">
          <ReactFlow
            nodes={viewNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            fitView
            fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
            minZoom={0.2}
            deleteKeyCode={['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={24} size={1.5} color="var(--sb-line)" />
            <Controls showInteractive={false} />
          </ReactFlow>

          <div className="absolute top-3 left-3 z-10 grid gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              aria-expanded={adding}
              onClick={() => setAdding((a) => !a)}
            >
              + Add step
            </button>
            {adding && (
              <div className="card grid w-64 gap-1 p-2" role="menu">
                {ADDABLE.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="menuitem"
                    className="flex items-start gap-2.5 px-2 py-2 text-left hover:bg-surface-2"
                    onClick={() => addStep(t)}
                  >
                    <Icon icon={STEP_META[t].icon} size={22} />
                    <span>
                      <span className="block text-sm font-bold">{STEP_META[t].label}</span>
                      <span className="block text-[12px] leading-snug text-muted">
                        {STEP_META[t].blurb}
                      </span>
                    </span>
                  </button>
                ))}
                {selected && (
                  <p className="px-2 pt-1 text-[12px] text-muted">
                    Connects after “{STEP_META[selected.data.step.type].label}”.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <aside
          className="min-h-0 overflow-y-auto border-t-2 border-edge bg-surface lg:border-t-0 lg:border-l-2"
          aria-label="Step details"
        >
          <div className="sticky top-0 z-10 flex border-b-2 border-edge bg-surface" role="tablist">
            {(['step', 'test'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`flex-1 px-4 py-2.5 text-sm font-bold ${tab === t ? 'bg-surface-2 shadow-[inset_0_-3px_0_var(--sb-primary)]' : 'hover:bg-surface-2'}`}
                onClick={() => setTab(t)}
              >
                {t === 'step' ? 'Edit' : 'Test chat'}
              </button>
            ))}
          </div>
          <div className="p-4">
            {tab === 'test' ? (
              <div className="h-[640px]">
                <Simulator flowId={flowId} showState={false} />
              </div>
            ) : selected?.data.step.type === 'start' ? (
              <TriggersEditor
                flowId={flowId}
                triggers={detail.triggers}
                published={published}
                onChange={() => void reloadDetail()}
              />
            ) : selected ? (
              <Inspector
                key={selected.id}
                step={selected.data.step}
                onChange={updateStep}
                onDelete={() => removeStep(selected.id)}
                ctx={{ fieldKeys, flows: flows.data?.flows ?? [], currentFlowId: flowId }}
              />
            ) : (
              <div className="grid gap-4">
                <p className="text-[15px] text-muted">
                  Select a step to edit it. Select <b>Start</b> to set the keywords that begin this
                  flow. Drag from an output on the right of a step to the next step to connect them.
                </p>
                {errors.length + warnings.length === 0 ? (
                  <p className="chip chip-success w-fit">No problems found</p>
                ) : (
                  <ul className="grid gap-2">
                    {[...errors, ...warnings].map((i) => (
                      <li key={`${i.code}-${i.nodeId ?? i.edgeId}`}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 border-2 border-line p-2.5 text-left text-[14px] hover:bg-surface-2"
                          onClick={() => i.nodeId && selectNode(i.nodeId)}
                        >
                          <span
                            className={`chip ${i.severity === 'error' ? 'chip-danger' : 'chip-orange'}`}
                          >
                            {i.severity === 'error' ? 'Fix' : 'Check'}
                          </span>
                          {i.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
