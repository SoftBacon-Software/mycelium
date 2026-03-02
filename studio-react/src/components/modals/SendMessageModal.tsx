import { useState } from 'react'
import { sendMessage, createTask } from '../../api/endpoints'
import { useDashboardStore } from '../../stores/dashboardStore'
import ModalOverlay from './ModalOverlay'

interface SendMessageModalProps {
  isOpen: boolean
  onClose: () => void
}

const PROJECT_OPTIONS = ['willing-sacrifice', 'king-city', 'mycelium']
const MSG_TYPES = ['message', 'request', 'directive']

export default function SendMessageModal({ isOpen, onClose }: SendMessageModalProps) {
  const refresh = useDashboardStore((s) => s.refresh)

  const [msgType, setMsgType] = useState('message')
  const [projectId, setProjectId] = useState('king-city')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [content, setContent] = useState('')
  const [autoCreateTask, setAutoCreateTask] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetForm() {
    setMsgType('message')
    setProjectId('king-city')
    setFrom('')
    setTo('')
    setContent('')
    setAutoCreateTask(false)
    setError(null)
  }

  function handleClose() {
    resetForm()
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!content.trim() || !from.trim() || !to.trim()) return

    setSubmitting(true)
    setError(null)

    try {
      await sendMessage({
        from_agent: from.trim(),
        to_agent: to.trim(),
        project_id: projectId,
        content: content.trim(),
        msg_type: msgType,
      })

      if (msgType === 'request' && autoCreateTask) {
        await createTask({
          title: content.trim().slice(0, 80),
          description: content.trim(),
          project_id: projectId,
          assignee: to.trim(),
          status: 'open',
          priority: 'normal',
        })
      }

      await refresh()
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={handleClose} title="Send Message">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
            {error}
          </div>
        )}

        {/* Type */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Type
          </label>
          <select
            value={msgType}
            onChange={(e) => setMsgType(e.target.value)}
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            {MSG_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {/* Project */}
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

        {/* From / To */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              From
            </label>
            <input
              type="text"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="agent-id"
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
              required
            />
          </div>
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
              To
            </label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="agent-id"
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
              required
            />
          </div>
        </div>

        {/* Content */}
        <div>
          <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">
            Content
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            placeholder="Message content..."
            className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
            required
          />
        </div>

        {/* Auto-create task checkbox (only for requests) */}
        {msgType === 'request' && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoCreateTask}
              onChange={(e) => setAutoCreateTask(e.target.checked)}
              className="w-4 h-4 rounded border-border bg-surface-raised text-accent focus:ring-accent/40 focus:ring-offset-0"
            />
            <span className="text-sm text-text-dim">
              Auto-create task for target agent
            </span>
          </label>
        )}

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
            disabled={submitting || !content.trim() || !from.trim() || !to.trim()}
            className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}
