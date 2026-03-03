import { useState, useCallback } from 'react'
import type { Task } from '../../api/types'
import { updateTask } from '../../api/endpoints'
import { useDashboardStore } from '../../stores/dashboardStore'
import { getSenderDisplay } from '../../utils/sender'
import Badge from '../shared/Badge'

interface TaskDetailProps {
  task: Task | null
  onClose: () => void
}

const statusFlow = ['open', 'in_progress', 'review', 'done'] as const

const statusColors: Record<string, string> = {
  open: 'bg-surface hover:bg-accent/20 text-text-dim hover:text-accent',
  in_progress: 'bg-surface hover:bg-blue/20 text-text-dim hover:text-blue',
  review: 'bg-surface hover:bg-purple/20 text-text-dim hover:text-purple',
  done: 'bg-surface hover:bg-green/20 text-text-dim hover:text-green',
}

const statusActiveColors: Record<string, string> = {
  open: 'bg-accent/20 text-accent ring-1 ring-accent/40',
  in_progress: 'bg-blue/20 text-blue ring-1 ring-blue/40',
  review: 'bg-purple/20 text-purple ring-1 ring-purple/40',
  done: 'bg-green/20 text-green ring-1 ring-green/40',
}

const statusLabels: Record<string, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
}

const priorityBadgeVariant: Record<string, 'red' | 'accent' | 'muted' | 'blue'> = {
  urgent: 'red',
  high: 'accent',
  normal: 'muted',
  low: 'blue',
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p } catch { /* ignore */ }
    return raw.split(',').map(s => s.trim()).filter(Boolean)
  }
  return []
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function TaskDetail({ task, onClose }: TaskDetailProps) {
  const refresh = useDashboardStore((s) => s.refresh)
  const [updating, setUpdating] = useState(false)
  const [comment, setComment] = useState('')

  const handleStatusChange = useCallback(async (newStatus: string) => {
    if (!task || newStatus === task.status || updating) return
    setUpdating(true)
    try {
      await updateTask(task.id, { status: newStatus })
      await refresh()
    } catch (err) {
      console.error('Failed to update task status:', err)
    } finally {
      setUpdating(false)
    }
  }, [task, updating, refresh])

  if (!task) return null

  const metadata = task.metadata as Record<string, unknown> | null
  const dependencies = metadata?.dependencies as string[] | undefined
  const comments = (metadata?.comments as Array<{ author: string; text: string; time: string }>) || []
  const project = metadata?.project as string | undefined

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-bg/60 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-lg bg-surface border-l border-border z-50 flex flex-col animate-in slide-in-from-right">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div className="min-w-0 flex-1 mr-3">
            <p className="text-xs text-text-muted font-mono mb-1">#{task.id}</p>
            <h2 className="text-lg font-semibold text-text leading-snug">{task.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors p-1 -mt-1 -mr-1 shrink-0"
            aria-label="Close"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {/* Description */}
          {task.description && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Description</h3>
              <p className="text-sm text-text-dim leading-relaxed whitespace-pre-wrap">{task.description}</p>
            </div>
          )}

          {/* Status buttons */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Status</h3>
            <div className="flex gap-2">
              {statusFlow.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => handleStatusChange(s)}
                  disabled={updating}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-all ${
                    task.status === s ? statusActiveColors[s] : statusColors[s]
                  } ${updating ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  {statusLabels[s]}
                </button>
              ))}
            </div>
          </div>

          {/* Metadata grid */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Details</h3>
            <div className="grid grid-cols-2 gap-3">
              <MetaField label="Priority">
                <Badge variant={priorityBadgeVariant[task.priority] || 'muted'}>
                  {task.priority}
                </Badge>
              </MetaField>
              <MetaField label="Assignee">
                <span className="text-sm text-text">{task.assignee ? getSenderDisplay(task.assignee) : 'Unassigned'}</span>
              </MetaField>
              <MetaField label="Project">
                <span className="text-sm text-text font-mono">{task.project_id}</span>
              </MetaField>
              {project && (
                <MetaField label="Project">
                  <span className="text-sm text-text">{project}</span>
                </MetaField>
              )}
              <MetaField label="Created">
                <span className="text-sm text-text-dim font-mono">{formatDate(task.created_at)}</span>
              </MetaField>
              {task.assigned_by && (
                <MetaField label="Assigned by">
                  <span className="text-sm text-text">{getSenderDisplay(task.assigned_by)}</span>
                </MetaField>
              )}
            </div>
          </div>

          {/* Source (branch / PR / repo) */}
          {(task.branch || task.pr_url || task.repo) && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Source</h3>
              <div className="space-y-1.5">
                {task.repo && (
                  <div className="text-sm text-text-dim font-mono">{task.repo}</div>
                )}
                {task.branch && (
                  <div className="text-sm text-text-dim">
                    <BranchIcon />
                    <span className="font-mono">{task.branch}</span>
                  </div>
                )}
                {task.pr_url && (
                  <div className="text-sm">
                    <a
                      href={task.pr_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent hover:text-accent-light transition-colors"
                    >
                      {formatPrUrl(task.pr_url)}
                      <ExternalLinkIcon />
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Tags */}
          {(() => {
            const tags = parseTags(task.tags)
            return tags.length > 0 ? (
              <div>
                <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Tags</h3>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="blue">{tag}</Badge>
                  ))}
                </div>
              </div>
            ) : null
          })()}

          {/* Dependencies */}
          {dependencies && dependencies.length > 0 && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Dependencies</h3>
              <ul className="space-y-1">
                {dependencies.map((dep) => (
                  <li key={dep} className="text-sm text-text-dim font-mono">#{dep}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Approval section */}
          {task.needs_approval && (
            <div className={`p-3 rounded ${task.approved_by ? 'bg-glow-green' : 'bg-glow-red'}`}>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Approval</h3>
              {task.approved_by ? (
                <div className="text-sm">
                  <span className="text-green font-medium">Approved</span>
                  <span className="text-text-muted"> by </span>
                  <span className="text-text-dim">{getSenderDisplay(task.approved_by)}</span>
                  {task.approved_at && (
                    <span className="text-text-muted font-mono text-xs ml-2">{formatDate(task.approved_at)}</span>
                  )}
                </div>
              ) : (
                <p className="text-sm text-red font-medium">Awaiting approval</p>
              )}
            </div>
          )}

          {/* Comments */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
              Comments {comments.length > 0 && `(${comments.length})`}
            </h3>
            {comments.length > 0 ? (
              <div className="space-y-3 mb-3">
                {comments.map((c, i) => (
                  <div key={i} className="bg-surface-raised rounded p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-text-dim">{c.author}</span>
                      <span className="text-xs text-text-muted font-mono">{c.time}</span>
                    </div>
                    <p className="text-sm text-text leading-relaxed">{c.text}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-text-muted mb-3">No comments yet.</p>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Add a comment..."
                className="flex-1 bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && comment.trim()) {
                    // Comment submission would go through updateTask metadata
                    setComment('')
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (comment.trim()) setComment('')
                }}
                className="bg-accent text-bg px-3 py-2 rounded text-sm font-medium hover:bg-accent-light transition-colors"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function formatPrUrl(url: string): string {
  const ghMatch = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (ghMatch) return `${ghMatch[1]}#${ghMatch[2]}`
  return url.replace(/^https?:\/\//, '').slice(0, 40)
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 inline-block mr-1 text-text-muted" fill="currentColor">
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  )
}

function ExternalLinkIcon() {
  return (
    <svg viewBox="0 0 12 12" className="w-3 h-3 inline-block ml-1 text-text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7 1h4v4M11 1L5.5 6.5M9 7v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H5" />
    </svg>
  )
}

function MetaField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-text-muted mb-0.5">{label}</p>
      {children}
    </div>
  )
}
