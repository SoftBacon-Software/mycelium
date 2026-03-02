import { useEffect, useState, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { createTask } from '../api/endpoints'
import { toast } from 'sonner'
import type { Task } from '../api/types'
import TaskCard from '../components/tasks/TaskCard'
import TaskDetail from '../components/tasks/TaskDetail'

type Column = 'open' | 'in_progress' | 'review' | 'done'

const columns: { key: Column; label: string; color: string }[] = [
  { key: 'open', label: 'Open', color: 'text-accent' },
  { key: 'in_progress', label: 'In Progress', color: 'text-blue' },
  { key: 'review', label: 'Review', color: 'text-purple' },
  { key: 'done', label: 'Done', color: 'text-green' },
]

export default function TasksPage() {
  const { tasks, loading, refresh } = useDashboardStore()
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [doneCollapsed, setDoneCollapsed] = useState(true)
  const [filterProject, setFilterProject] = useState('')
  const [filterAssignee, setFilterAssignee] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)

  useEffect(() => {
    refresh()
  }, [refresh])

  // Collect unique projects for the filter dropdown
  const allTasks = useMemo(() => [
    ...tasks.open,
    ...tasks.in_progress,
    ...tasks.review,
    ...tasks.done,
  ], [tasks])

  const projects = useMemo(() => {
    const set = new Set(allTasks.map((t) => t.project_id).filter(Boolean))
    return Array.from(set).sort()
  }, [allTasks])

  // Filter logic
  const filterTasks = useCallback((list: Task[]): Task[] => {
    return list.filter((t) => {
      if (filterProject && t.project_id !== filterProject) return false
      if (filterAssignee && !(t.assignee || '').toLowerCase().includes(filterAssignee.toLowerCase())) return false
      return true
    })
  }, [filterProject, filterAssignee])

  const filteredColumns = useMemo(() => ({
    open: filterTasks(tasks.open),
    in_progress: filterTasks(tasks.in_progress),
    review: filterTasks(tasks.review),
    done: filterTasks(tasks.done),
  }), [tasks, filterTasks])

  // When task data refreshes, update selectedTask if still open
  useEffect(() => {
    if (!selectedTask) return
    const found = allTasks.find((t) => t.id === selectedTask.id)
    if (found) setSelectedTask(found)
  }, [allTasks, selectedTask])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-text">Tasks</h1>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Filters */}
          <select
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
            className="bg-surface-raised border border-border rounded px-2.5 py-1.5 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer min-w-[120px]"
          >
            <option value="">All projects</option>
            {projects.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>

          <input
            type="text"
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            placeholder="Filter assignee..."
            className="bg-surface-raised border border-border rounded px-2.5 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 w-36"
          />

          {/* Create task button */}
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="bg-accent text-bg px-3 py-1.5 rounded text-sm font-medium hover:bg-accent-light transition-colors"
          >
            Create Task
          </button>
        </div>
      </div>

      {/* Kanban board */}
      <div className="flex gap-3 flex-1 min-h-0 overflow-x-auto pb-2">
        {columns.map((col) => {
          const colTasks = filteredColumns[col.key]
          const isDone = col.key === 'done'
          const isCollapsed = isDone && doneCollapsed

          return (
            <div
              key={col.key}
              className={`bg-surface rounded-lg p-3 flex flex-col min-w-[260px] ${
                isDone ? (isCollapsed ? 'max-w-[260px]' : 'flex-1') : 'flex-1'
              } transition-all`}
            >
              {/* Column header */}
              <button
                type="button"
                onClick={isDone ? () => setDoneCollapsed(!doneCollapsed) : undefined}
                className={`flex items-center justify-between mb-3 ${isDone ? 'cursor-pointer' : 'cursor-default'} group`}
              >
                <div className="flex items-center gap-2">
                  <h2 className={`text-sm font-semibold ${col.color}`}>
                    {col.label}
                  </h2>
                  <span className="bg-surface-raised text-text-muted text-xs font-mono px-1.5 py-0.5 rounded-full">
                    {colTasks.length}
                  </span>
                </div>
                {isDone && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    className={`text-text-muted transition-transform ${isCollapsed ? '' : 'rotate-180'}`}
                  >
                    <path d="M3 5l4 4 4-4" />
                  </svg>
                )}
              </button>

              {/* Cards */}
              {!isCollapsed && (
                <div className="flex-1 overflow-y-auto space-y-0 pr-0.5">
                  {colTasks.length === 0 && (
                    <p className="text-xs text-text-muted text-center py-6">No tasks</p>
                  )}
                  {colTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onClick={() => setSelectedTask(task)}
                    />
                  ))}
                </div>
              )}

              {isCollapsed && colTasks.length > 0 && (
                <p className="text-xs text-text-muted text-center py-4">
                  {colTasks.length} completed task{colTasks.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {/* Task detail panel */}
      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}

      {/* Create task modal */}
      {showCreateModal && (
        <CreateTaskModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false)
            refresh()
          }}
        />
      )}
    </div>
  )
}

// -- Create Task Modal --

interface CreateTaskModalProps {
  onClose: () => void
  onCreated: () => void
}

function CreateTaskModal({ onClose, onCreated }: CreateTaskModalProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [projectId, setProjectId] = useState('king-city')
  const [assignee, setAssignee] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return

    setSubmitting(true)
    setError(null)
    try {
      await createTask({
        title: title.trim(),
        description: description.trim(),
        priority,
        project_id: projectId,
        assignee: assignee.trim() || null,
        status: 'open',
      })
      toast.success('Task created')
      onCreated()
    } catch (err) {
      toast.error('Failed to create task')
      setError(err instanceof Error ? err.message : 'Failed to create task')
      setSubmitting(false)
    }
  }

  return (
    <>
      <div
        className="fixed inset-0 bg-bg/60 z-40"
        onClick={onClose}
        aria-hidden
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <form
          onSubmit={handleSubmit}
          className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-lg font-semibold text-text mb-4">Create Task</h2>

          {error && (
            <div className="bg-glow-red text-red text-sm rounded p-2 mb-3">{error}</div>
          )}

          <div className="space-y-3">
            <div>
              <label className="text-xs text-text-muted block mb-1">Title *</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
                placeholder="Task title"
                autoFocus
                required
              />
            </div>

            <div>
              <label className="text-xs text-text-muted block mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
                placeholder="Optional description..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted block mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer"
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-text-muted block mb-1">Project</label>
                <input
                  type="text"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
                  placeholder="king-city"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-text-muted block mb-1">Assignee</label>
              <input
                type="text"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40"
                placeholder="agent-id (optional)"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-dim hover:text-text transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim()}
              className="bg-accent text-bg px-4 py-2 rounded text-sm font-medium hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
