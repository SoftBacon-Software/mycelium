import { useState } from 'react'
import type { PlanStep } from '../../api/types'
import Badge from '../shared/Badge'
import { getSenderDisplay } from '../../utils/sender'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatPrUrl(url: string): string {
  const ghMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (ghMatch) return `${ghMatch[1]}#${ghMatch[2]}`
  return url.replace(/^https?:\/\//, '').slice(0, 40)
}

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

export default function StepChecklist({ steps, planId: _planId, onStepUpdate }: StepChecklistProps) {
  void _planId
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
                  {getSenderDisplay(step.assignee)}
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
                    Assigned to <span className="text-text-dim">{getSenderDisplay(step.assignee)}</span>
                  </p>
                )}
                {(step.linked_task_id || step.linked_branch || step.linked_pr_url) && (
                  <div className="mt-2 pt-2 border-t border-border/50 space-y-1">
                    {step.linked_task_id && (
                      <p className="text-xs">
                        <Badge variant="blue">Task #{step.linked_task_id}</Badge>
                      </p>
                    )}
                    {step.linked_branch && (
                      <p className="text-xs text-text-dim">
                        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 inline-block mr-1 text-text-muted" fill="currentColor">
                          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                        </svg>
                        <span className="font-mono">{step.linked_branch}</span>
                      </p>
                    )}
                    {step.linked_pr_url && (
                      <p className="text-xs">
                        <a
                          href={step.linked_pr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:text-accent-light transition-colors"
                        >
                          {formatPrUrl(step.linked_pr_url)}
                          <svg viewBox="0 0 12 12" className="w-3 h-3 inline-block ml-1 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <path d="M7 1h4v4M11 1L5.5 6.5M9 7v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H5" />
                          </svg>
                        </a>
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
