import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useLiveStore } from '../stores/liveStore'
import { createPlan, updatePlan, updatePlanStep, fetchPlan } from '../api/endpoints'
import { toast } from 'sonner'
import { formatDateTime } from '../utils/time'
import { getSenderDisplay } from '../utils/sender'
import type { Plan, PlanStep } from '../api/types'
import PlanCard from '../components/plans/PlanCard'
import StepChecklist from '../components/plans/StepChecklist'
import Badge from '../components/shared/Badge'

type StatusFilter = 'all' | 'active' | 'completed' | 'cancelled' | 'draft'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'draft', label: 'Draft' },
]

const priorityBadgeVariant: Record<string, 'red' | 'accent' | 'green' | 'muted' | 'default'> = {
  critical: 'red',
  high: 'red',
  medium: 'accent',
  low: 'green',
}

// ─── Create Plan Modal ───────────────────────────────────────────────────────

interface CreatePlanModalProps {
  onClose: () => void
  onCreated: () => void
}

function CreatePlanModal({ onClose, onCreated }: CreatePlanModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState('medium')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    setError(null)
    try {
      await createPlan({
        title: title.trim(),
        description: description.trim(),
        project_id: projectId.trim() || undefined,
        priority,
        status: 'active',
      })
      toast.success('Plan created')
      onCreated()
      onClose()
    } catch (err) {
      toast.error('Failed to create plan')
      setError(err instanceof Error ? err.message : 'Failed to create plan')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={handleSubmit}>
          <div className="flex items-center justify-between p-5 border-b border-border">
            <h2 className="text-lg font-semibold text-text">Create Plan</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-text-muted hover:text-text transition-colors p-1 -m-1 text-lg font-mono"
            >
              &times;
            </button>
          </div>

          <div className="p-5 space-y-4">
            {error && (
              <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
                {error}
              </div>
            )}

            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Plan title..."
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
              />
            </div>

            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                Description
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the plan..."
                rows={3}
                className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />
            </div>

            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                  Project
                </label>
                <input
                  type="text"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="project-id"
                  className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div className="flex-1">
                <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
                  Priority
                </label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 p-5 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!title.trim() || saving}
              className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Creating...' : 'Create Plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ─── Plan Detail Panel ───────────────────────────────────────────────────────

interface PlanDetailProps {
  plan: Plan
  onClose: () => void
  onStepUpdate: (planId: string, stepId: string, data: Partial<PlanStep>) => void
  onStatusChange: (planId: string, status: string) => void
  onRefresh: () => void
}

function PlanDetail({ plan, onClose, onStepUpdate, onStatusChange, onRefresh }: PlanDetailProps) {
  const steps = plan.steps ?? []
  const completedSteps = steps.filter(
    (s) => s.status === 'done' || s.status === 'completed',
  ).length
  const totalSteps = steps.length
  const progressPct = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0

  return (
    <div className="bg-surface rounded-lg border border-border overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="p-5 border-b border-border shrink-0">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-lg font-semibold text-text leading-snug">{plan.title}</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors p-1 -m-1 text-lg font-mono shrink-0"
          >
            &times;
          </button>
        </div>

        {plan.description && (
          <p className="text-text-dim text-sm leading-relaxed mb-3 whitespace-pre-wrap">
            {plan.description}
          </p>
        )}

        {/* Metadata */}
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-text-muted">Status:</span>
            <select
              value={plan.status}
              onChange={(e) => onStatusChange(plan.id, e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2 py-0.5 text-xs text-text focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="draft">Draft</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>

          <Badge variant={priorityBadgeVariant[plan.priority?.toLowerCase()] ?? 'default'}>
            {plan.priority || 'normal'}
          </Badge>

          {plan.owner && (
            <span className="text-text-muted">
              Owner: <span className="text-text-dim">{getSenderDisplay(plan.owner)}</span>
            </span>
          )}

          {plan.project_id && (
            <span className="text-text-muted">
              Project: <span className="text-text-dim">{plan.project_id}</span>
            </span>
          )}
        </div>

        {/* Timestamps */}
        <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
          <span>Created {formatDateTime(plan.created_at)}</span>
          {plan.updated_at !== plan.created_at && (
            <span>Updated {formatDateTime(plan.updated_at)}</span>
          )}
        </div>

        {/* Progress */}
        {totalSteps > 0 && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-text-muted mb-1">
              <span>Progress</span>
              <span className="tabular-nums">
                {completedSteps}/{totalSteps} steps ({Math.round(progressPct)}%)
              </span>
            </div>
            <div className="h-1.5 bg-surface-raised rounded-full overflow-hidden">
              <div
                className="h-full bg-green rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Steps */}
      <div className="flex-1 overflow-y-auto p-3">
        <h3 className="text-xs font-medium text-text-muted uppercase tracking-wider px-3 mb-2">
          Steps
        </h3>
        <StepChecklist
          steps={steps}
          planId={plan.id}
          onStepUpdate={(stepId, data) => onStepUpdate(plan.id, stepId, data)}
          onCommentAdded={onRefresh}
        />
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function PlansPage() {
  const plans = useDashboardStore((s) => s.plans)
  const refresh = useDashboardStore((s) => s.refresh)
  const liveEvents = useLiveStore((s) => s.events)

  // Auto-refresh when plan-related SSE events arrive
  const lastLiveRef = useRef(0)
  useEffect(() => {
    const planEvent = liveEvents.find(
      (e) => e.id > lastLiveRef.current && (e.type.startsWith('plan_') || e.type === 'plan_step_completed')
    )
    if (planEvent) {
      lastLiveRef.current = planEvent.id
      refresh()
    }
  }, [liveEvents, refresh])

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  // Unique projects
  const projects = useMemo(() => {
    const set = new Set(plans.map((p) => p.project_id).filter(Boolean))
    return Array.from(set).sort()
  }, [plans])

  // Filtered plans
  const filtered = useMemo(() => {
    let result = plans
    if (statusFilter !== 'all') {
      result = result.filter((p) => p.status === statusFilter)
    }
    if (projectFilter !== 'all') {
      result = result.filter((p) => p.project_id === projectFilter)
    }
    return result.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
  }, [plans, statusFilter, projectFilter])

  // Selected plan — fetch full plan (with steps) from API
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null)
  useEffect(() => {
    if (!selectedPlanId) {
      setSelectedPlan(null)
      return
    }
    let cancelled = false
    fetchPlan(selectedPlanId).then((plan) => {
      if (!cancelled) setSelectedPlan(plan)
    }).catch(() => {
      if (!cancelled) setSelectedPlan(null)
    })
    return () => { cancelled = true }
  }, [selectedPlanId, plans])

  // Handlers
  const handleStepUpdate = useCallback(
    async (planId: string, stepId: string, data: Partial<PlanStep>) => {
      try {
        await updatePlanStep(planId, stepId, data)
        toast.success('Step updated')
        await refresh()
        // Refetch full plan to update steps
        const updated = await fetchPlan(planId)
        setSelectedPlan(updated)
      } catch (err) {
        toast.error('Failed to update step')
        console.error('Failed to update step:', err)
      }
    },
    [refresh],
  )

  const handleStatusChange = useCallback(
    async (planId: string, status: string) => {
      try {
        await updatePlan(planId, { status })
        toast.success('Plan status updated')
        await refresh()
        // Refetch full plan
        const updated = await fetchPlan(planId)
        setSelectedPlan(updated)
      } catch (err) {
        toast.error('Failed to update plan')
        console.error('Failed to update plan status:', err)
      }
    },
    [refresh],
  )

  const handleRefreshPlan = useCallback(async () => {
    if (!selectedPlanId) return
    const updated = await fetchPlan(selectedPlanId)
    setSelectedPlan(updated)
  }, [selectedPlanId])

  const handleCreated = useCallback(async () => {
    await refresh()
  }, [refresh])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text">Plans</h2>
          <span className="text-text-muted text-sm">({filtered.length})</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Status filter */}
          <div className="flex rounded-sm overflow-hidden border border-border">
            {STATUS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setStatusFilter(opt.value)}
                className={`px-3 py-1 text-xs font-medium transition-colors ${
                  statusFilter === opt.value
                    ? 'bg-surface-raised text-text'
                    : 'text-text-muted hover:text-text-dim'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Project filter */}
          {projects.length > 0 && (
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2.5 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All Projects</option>
              {projects.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}

          {/* Create button */}
          <button
            onClick={() => setShowCreate(true)}
            className="bg-accent text-bg rounded px-4 py-1.5 text-sm font-medium hover:bg-accent-light transition-colors"
          >
            Create Plan
          </button>
        </div>
      </div>

      {/* Content */}
      {filtered.length === 0 ? (
        <div className="bg-surface rounded-lg p-12 text-center">
          <p className="text-text-muted text-sm">No plans match the current filters.</p>
        </div>
      ) : (
        <div className={`flex gap-4 ${selectedPlan ? '' : ''}`}>
          {/* Plan list */}
          <div
            className={`grid gap-3 ${
              selectedPlan
                ? 'grid-cols-1 w-full lg:w-1/2 shrink-0'
                : 'grid-cols-1 md:grid-cols-2 w-full'
            }`}
          >
            {filtered.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                onClick={() =>
                  setSelectedPlanId((prev) => (prev === plan.id ? null : plan.id))
                }
                isSelected={plan.id === selectedPlanId}
              />
            ))}
          </div>

          {/* Detail panel */}
          {selectedPlan && (
            <div className="hidden lg:block w-1/2 sticky top-0 max-h-[calc(100dvh-10rem)]">
              <PlanDetail
                plan={selectedPlan}
                onClose={() => setSelectedPlanId(null)}
                onStepUpdate={handleStepUpdate}
                onStatusChange={handleStatusChange}
                onRefresh={handleRefreshPlan}
              />
            </div>
          )}
        </div>
      )}

      {/* Mobile detail overlay */}
      {selectedPlan && (
        <div className="lg:hidden fixed inset-0 z-40 bg-bg/80 backdrop-blur-sm flex items-end sm:items-center justify-center">
          <div
            className="bg-bg w-full sm:max-w-lg sm:rounded-lg max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <PlanDetail
              plan={selectedPlan}
              onClose={() => setSelectedPlanId(null)}
              onStepUpdate={handleStepUpdate}
              onStatusChange={handleStatusChange}
            />
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <CreatePlanModal
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  )
}
