import type { FlowNode } from '@social-switchboard/flow';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import { Icon } from '../components/Icon';
import { handleLabels, STEP_META, summarize } from './steps';

export type StepData = {
  step: FlowNode;
  /** Wiring errors pointing at this step. */
  issues: number;
  /** The step can't be saved as is (e.g. an empty message). */
  invalid: boolean;
  /** Trigger summaries, shown on the start step. */
  triggers: string[];
  flowName: (id: string) => string | undefined;
};
export type StepNodeType = Node<StepData, 'step'>;

/** One step on the canvas: a square card with its outputs listed down the right edge. */
export const StepNode = memo(function StepNode({ data }: NodeProps<StepNodeType>) {
  const { step } = data;
  const meta = STEP_META[step.type];
  const outputs = handleLabels(step);
  const summary = summarize(step, data.flowName);
  const flagged = data.invalid || data.issues > 0;

  return (
    <div
      className={`flow-node w-[264px] border-2 bg-surface shadow-hard ${flagged ? 'border-danger' : 'border-edge'}`}
    >
      {step.type !== 'start' && (
        <Handle type="target" position={Position.Left} style={{ top: 22 }} />
      )}
      <div className="flex items-center gap-2 border-b-2 border-edge bg-surface-2 px-3 py-2">
        <Icon icon={meta.icon} size={20} />
        <span className="text-label uppercase">{meta.label}</span>
        {flagged && <span className="chip chip-danger ml-auto px-1.5 py-0">Fix</span>}
      </div>
      {step.type === 'start' ? (
        <div className="grid gap-1.5 px-3 py-2.5 text-[13px]">
          {data.triggers.length === 0 ? (
            <span className="text-muted">No triggers yet. Select this step to add a keyword.</span>
          ) : (
            data.triggers.map((t) => (
              <span key={t} className="chip chip-lime w-fit max-w-full truncate">
                {t}
              </span>
            ))
          )}
        </div>
      ) : (
        summary && (
          <p className="line-clamp-4 px-3 py-2.5 text-[14px] leading-snug whitespace-pre-line">
            {summary}
          </p>
        )
      )}
      {outputs.length > 0 && (
        <div className="border-t-2 border-line">
          {outputs.map((h) => (
            <div
              key={h.id}
              className="relative flex items-center justify-end px-3 py-1.5 text-right text-[12px] leading-tight font-bold"
            >
              <span className="line-clamp-2 pl-4">{h.label}</span>
              <Handle type="source" id={h.id} position={Position.Right} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
