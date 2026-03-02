import { useState } from 'react'
import { createPlan } from '../../api/endpoints'
import { useDashboardStore } from '../../stores/dashboardStore'
import ModalOverlay from './ModalOverlay'

interface CreatePlanModalProps {
  isOpen: boolean
  onClose: () => void
}

const PROJECT_OPTIONS = ['willing-sacrifice', 'king-city', 'mycelium']
const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical']

export default function CreatePlanModal({ isOpen, onClose }: CreatePlanModalProps) {
  const refresh = useDashboardStore((s) => s.refresh)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('king-city')
  const [priority, setPriority] = useState('medium')
  const [owner, setOwner] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetForm() {
    setTitle('')
    setDescription('')
    setProjectId('king-city')
    setPriority('medium')
    setOwner('')
    setError(null)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return

    setSubmitting(true)
    setError(null)

    try {
      await createPlan({
        title: title.trim(),
        description: description.trim(),
        project_id: projectId,
        priority,
        owner: owner.trim() || undefined,
        status: 'active',
      })
      await refresh()
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create plan')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={handleClose} title="Create Plan">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {error}
          </div>
        )}

        {/* Title */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Plan title..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
            autoFocus
            required
          />
        </div>

        {/* Description */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Describe the plan..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
          />
        </div>

        {/* Project / Priority */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              Project
            </label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {PROJECT_OPTIONS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              Priority
            </label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              {PRIORITY_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Owner */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Owner
          </label>
          <input
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="agent-id or operator name"
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim()}
            className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Creating...' : 'Create Plan'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}
