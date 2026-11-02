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
import { ExitsEditor, StepOutline } from '../builder/StepOutline';
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
  if (detail.error)
    return <p className="p-8 font-bold text-danger">Couldn’t load this automation.</p>;
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
  const { screenToFlowPosition, fitView } = useReactFlow();
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
  // Phones (below 1024px): a list of steps by default, the canvas or the test chat on request,
  // and a step opens full screen.
  const [mode, setMode] = useState<'steps' | 'canvas' | 'test'>('steps');
  const [sheet, setSheet] = useState<string | null>(null);
  const [phoneAdding, setPhoneAdding] = useState(false);
  const isPhone = () => window.matchMedia('(max-width: 1023px)').matches;
  // The canvas was hidden, so it had no size to fit to: fit it once it shows and has measured.
  useEffect(() => {
    if (mode !== 'canvas') return;
    const fit = () => void fitView({ maxZoom: 1, padding: 0.15 });
    const timers = [100, 300].map((ms) => setTimeout(fit, ms));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [mode, fitView]);
  const published = Boolean(detail.flow.publishedVersionId);
  const latest = detail.versions[0];
  const [unpublished, setUnpublished] = useState(detail.hasUnpublishedChanges);

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

  /** Points one exit at a step (or nowhere), replacing what it pointed at. */
  function connectExit(source: string, handle: string, target: string | null) {
    setEdges((es) => [
      ...es.filter((e) => !(e.source === source && (e.sourceHandle ?? 'next') === handle)),
      ...(target ? [{ id: newId('e'), source, sourceHandle: handle, target }] : []),
    ]);
  }

  /** Phones: opens a step full screen (and selects it, so a new step chains after it). */
  function openStep(nodeId: string) {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })));
    setSheet(nodeId);
  }

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
    if (isPhone()) {
      setPhoneAdding(false);
      setSheet(step.id);
    }
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
    <div className="flex h-dvh flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b-2 border-edge bg-surface px-2 pt-[calc(0.375rem+env(safe-area-inset-top))] pb-1.5 sm:px-4 sm:py-3">
        <Link
          to="/automations"
          className="grid size-11 shrink-0 place-items-center text-[22px] font-bold text-ink no-underline sm:size-auto sm:text-[14px] sm:text-link sm:underline"
          aria-label="Back to automations"
        >
          <span aria-hidden className="sm:hidden">
            ←
          </span>
          <span className="hidden sm:inline">← Automations</span>
        </Link>
        <label htmlFor="flow-name" className="sr-only">
          Automation name
        </label>
        <input
          id="flow-name"
          className="input w-auto min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-[17px] font-bold hover:border-line focus:border-edge sm:max-w-sm sm:px-2 sm:text-lg"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <span className="order-last flex basis-full items-center gap-2 pl-12 sm:order-none sm:basis-auto sm:pl-0">
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
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm shrink-0 sm:ml-auto"
          disabled={
            publishing || save.kind === 'error' || errors.length > 0 || (published && !unpublished)
          }
          onClick={publish}
        >
          {publishing ? 'Publishing…' : published && unpublished ? 'Publish changes' : 'Publish'}
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

      {/* Phones: which view. */}
      <div className="flex border-b-2 border-edge bg-surface lg:hidden" role="tablist">
        {(
          [
            ['steps', 'Steps'],
            ['canvas', 'Canvas'],
            ['test', 'Test chat'],
          ] as const
        ).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`flex-1 px-3 py-2.5 text-sm font-bold ${mode === m ? 'bg-surface-2 shadow-[inset_0_-3px_0_var(--sb-primary)]' : 'text-muted'}`}
            onClick={() => setMode(m)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_380px]">
        {mode === 'steps' && (
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:hidden">
            <StepOutline
              nodes={nodes}
              edges={edges}
              issues={issueCount}
              flowName={(fid) => flowNames.get(fid)}
              triggers={triggerChips}
              onOpen={openStep}
            />
            {errors.length + warnings.length > 0 && (
              <p className="mt-3 text-[13px] text-muted">
                {errors.length ? `${errors.length} to fix before publishing. ` : ''}
                {warnings.length ? `${warnings.length} to check.` : ''} Steps marked Fix say why.
              </p>
            )}
          </div>
        )}
        {mode === 'test' && (
          <div className="min-h-0 flex-1 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden">
            <div className="h-full">
              <Simulator flowId={flowId} showState={false} />
            </div>
          </div>
        )}
        <div
          ref={canvas}
          // Phones: kept laid out (but transparent) behind the other views, so its steps are
          // measured and it can fit them the moment it shows.
          className={`relative min-h-0 flex-1 ${mode === 'canvas' ? '' : 'max-lg:pointer-events-none max-lg:absolute max-lg:inset-0 max-lg:opacity-0'}`}
        >
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
            onNodeClick={(_, node) => {
              if (isPhone()) setSheet(node.id);
            }}
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
          className="hidden min-h-0 overflow-y-auto border-edge bg-surface lg:block lg:border-l-2"
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
              <div className="grid gap-4">
                <Inspector
                  key={selected.id}
                  step={selected.data.step}
                  onChange={updateStep}
                  onDelete={() => removeStep(selected.id)}
                  ctx={{ fieldKeys, flows: flows.data?.flows ?? [], currentFlowId: flowId }}
                />
                <ExitsEditor
                  step={selected.data.step}
                  nodes={nodes}
                  edges={edges}
                  onConnect={(h, t) => connectExit(selected.id, h, t)}
                />
              </div>
            ) : (
              <div className="grid gap-4">
                <p className="text-[15px] text-muted">
                  Select a step to edit it. Select <b>Start</b> to set the keywords that begin this
                  automation. Drag from an output on the right of a step to the next step to connect
                  them.
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

      {/* Phones: add a step (after the one last opened). */}
      {mode === 'steps' && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-edge bg-surface px-3 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] lg:hidden">
          {phoneAdding && (
            <div className="mb-2 grid max-h-[55dvh] gap-1 overflow-y-auto" role="menu">
              {selected && (
                <p className="px-1 text-[13px] text-muted">
                  Connects after “{STEP_META[selected.data.step.type].label}”.
                </p>
              )}
              {ADDABLE.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="menuitem"
                  className="sheet-row"
                  onClick={() => addStep(t)}
                >
                  <Icon icon={STEP_META[t].icon} size={24} />
                  <span className="grid text-left leading-tight">
                    <span className="font-bold">{STEP_META[t].label}</span>
                    <span className="text-[13px] text-muted">{STEP_META[t].blurb}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className={`btn w-full ${phoneAdding ? '' : 'btn-primary'}`}
            aria-expanded={phoneAdding}
            onClick={() => setPhoneAdding((a) => !a)}
          >
            {phoneAdding ? 'Cancel' : '+ Add step'}
          </button>
        </div>
      )}

      {sheet &&
        (() => {
          const node = nodes.find((n) => n.id === sheet);
          if (!node) return null;
          const meta = STEP_META[node.data.step.type];
          return (
            <div
              className="sheet fixed inset-0 z-40 flex flex-col bg-bg lg:hidden"
              role="dialog"
              aria-modal="true"
              aria-label={meta.label}
            >
              <div className="flex items-center gap-2 border-b-2 border-edge bg-surface px-2 pt-[calc(0.375rem+env(safe-area-inset-top))] pb-1.5">
                <button
                  type="button"
                  className="grid size-11 place-items-center text-[22px] font-bold"
                  aria-label="Back to the steps"
                  onClick={() => setSheet(null)}
                >
                  ←
                </button>
                <Icon icon={meta.icon} size={22} />
                <span className="flex-1 truncate font-bold">{meta.label}</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => setSheet(null)}
                >
                  Done
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto bg-surface px-4 pt-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                {node.data.step.type === 'start' ? (
                  <TriggersEditor
                    flowId={flowId}
                    triggers={detail.triggers}
                    published={published}
                    onChange={() => void reloadDetail()}
                  />
                ) : (
                  <div className="grid gap-4">
                    <Inspector
                      key={node.id}
                      step={node.data.step}
                      onChange={updateStep}
                      onDelete={() => {
                        removeStep(node.id);
                        setSheet(null);
                      }}
                      ctx={{ fieldKeys, flows: flows.data?.flows ?? [], currentFlowId: flowId }}
                    />
                  </div>
                )}
                <div className="mt-4">
                  <ExitsEditor
                    step={node.data.step}
                    nodes={nodes}
                    edges={edges}
                    onConnect={(h, t) => connectExit(node.id, h, t)}
                  />
                </div>
                <button
                  type="button"
                  className="btn mt-5 w-full"
                  onClick={() => {
                    setSheet(null);
                    setMode('steps');
                    setPhoneAdding(true);
                  }}
                >
                  + Add a step after this one
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
