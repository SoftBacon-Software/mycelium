import { useState } from 'react'
import type { PlanStep } from '../../api/types'
import Badge from '../shared/Badge'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const statusConfig: Record<string, { variant: 'green' | 'blue' | 'muted' | 'default'; label: string }> = {
  pending: { variant: 'default', label: 'pending' },
  in_progress: { variant: 'blue', label: 'in progress' },
  done: { variant: 'green', label: 'done' },
  completed: { variant: 'green', label: 'done' },
  skipped: { variant: 'muted', label: 'skipped' },
}

// ─── Component ───────────────────────────────────────────────────────────────

interface StepChecklistProps {
  steps: PlanStep[]
  planId: string
  onStepUpdate: (stepId: string, data: Partial<PlanStep>) => void
}

export default function StepChecklist({ steps, planId, onStepUpdate }: StepChecklistProps) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null)
  const [updatingStep, setUpdatingStep] = useState<string | null>(null)

  const sorted = [...steps].sort((a, b) => a.step_number - b.step_number)

  async function handleToggle(step: PlanStep) {
    const isDone = step.status === 'done' || step.status === 'completed'
    const newStatus = isDone ? 'pending' : 'done'
    setUpdatingStep(step.id)
    try {
      await onStepUpdate(step.id, { status: newStatus })
    } finally {
      setUpdatingStep(null)
    }
  }

  function toggleExpand(stepId: string) {
    setExpandedStep((prev) => (prev === stepId ? null : stepId))
  }

  if (sorted.length === 0) {
    return (
      <div className="text-text-muted text-sm py-4 text-center">
        No steps defined for this plan.
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {sorted.map((step) => {
        const isDone = step.status === 'done' || step.status === 'completed'
        const isSkipped = step.status === 'skipped'
        const config = statusConfig[step.status] ?? statusConfig.pending
        const isExpanded = expandedStep === step.id
        const isUpdating = updatingStep === step.id

        return (
          <div key={step.id} className="group">
            {/* Step row */}
            <div
              className={`flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-surface/50 transition-colors ${
                isUpdating ? 'opacity-60 pointer-events-none' : ''
              }`}
            >
              {/* Checkbox */}
              <button
                onClick={() => handleToggle(step)}
                disabled={isSkipped || isUpdating}
                className={`w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${
                  isDone
                    ? 'bg-green/20 border-green text-green'
                    : isSkipped
                    ? 'bg-surface border-text-muted cursor-not-allowed'
                    : step.status === 'in_progress'
                    ? 'border-blue hover:bg-blue/10'
                    : 'border-text-muted hover:border-text-dim'
                }`}
                title={isDone ? 'Mark as pending' : 'Mark as done'}
              >
                {isDone && (
                  <svg
                    viewBox="0 0 12 12"
                    className="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M2 6l3 3 5-5" />
                  </svg>
                )}
                {isSkipped && (
                  <svg
                    viewBox="0 0 12 12"
                    className="w-3 h-3 text-text-muted"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M2 6h8" />
                  </svg>
                )}
              </button>

              {/* Step number */}
              <span className="text-text-muted text-xs font-mono w-5 text-right shrink-0">
                {step.step_number}
              </span>

              {/* Title */}
              <button
                onClick={() => step.description && toggleExpand(step.id)}
                className={`flex-1 text-left text-sm min-w-0 ${
                  isSkipped
                    ? 'text-text-muted line-through'
                    : isDone
                    ? 'text-text-dim'
                    : 'text-text'
                } ${step.description ? 'cursor-pointer hover:text-accent' : ''}`}
              >
                <span className="truncate block">{step.title}</span>
              </button>

              {/* Status badge (non-pending only) */}
              {step.status !== 'pending' && (
                <Badge variant={config.variant}>{config.label}</Badge>
              )}

              {/* Assignee */}
              {step.assignee && (
                <span className="text-text-muted text-xs shrink-0 hidden sm:inline">
                  {step.assignee}
                </span>
              )}

              {/* Expand indicator */}
              {step.description && (
                <svg
                  viewBox="0 0 12 12"
                  className={`w-3 h-3 text-text-muted shrink-0 transition-transform ${
                    isExpanded ? 'rotate-180' : ''
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M2 4l4 4 4-4" />
                </svg>
              )}
            </div>

            {/* Expanded description */}
            {isExpanded && step.description && (
              <div className="ml-11 mr-3 mb-2 px-3 py-2 bg-surface rounded-sm">
                <p className="text-text-dim text-xs leading-relaxed whitespace-pre-wrap">
                  {step.description}
                </p>
                {step.assignee && (
                  <p className="text-text-muted text-xs mt-1.5">
                    Assigned to <span className="text-text-dim">{step.assignee}</span>
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
