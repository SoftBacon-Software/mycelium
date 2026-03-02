import { useEffect, useMemo } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function dayKey(dateStr: string): string {
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function BarChart({ data, color = 'bg-accent' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="flex items-end gap-1 h-32">
      {data.map((d) => (
        <div key={d.label} className="flex-1 flex flex-col items-center gap-1 min-w-0">
          <span className="text-[10px] text-text-muted font-mono tabular-nums">
            {d.value || ''}
          </span>
          <div
            className={`w-full rounded-t ${color} transition-all min-h-[2px]`}
            style={{ height: `${Math.max((d.value / max) * 100, 2)}%` }}
          />
          <span className="text-[10px] text-text-dim font-mono truncate w-full text-center">
            {d.label}
          </span>
        </div>
      ))}
    </div>
  )
}

function HorizontalBar({ items, color = 'bg-accent' }: { items: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(...items.map((d) => d.value), 1)
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-3">
          <span className="text-xs text-text-muted font-mono w-28 truncate shrink-0 text-right">
            {item.label}
          </span>
          <div className="flex-1 bg-surface-raised rounded-full h-4 overflow-hidden">
            <div
              className={`h-full rounded-full ${color} transition-all`}
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
          <span className="text-xs text-text font-mono tabular-nums w-8 text-right">
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function AnalyticsPage() {
  const { agents, events, tasks, messages, bugs, plans, droneJobs, loading, refresh } = useDashboardStore()

  useEffect(() => {
    refresh()
  }, [refresh])

  // Task completion by day (last 14 days)
  const tasksByDay = useMemo(() => {
    const days: Record<string, number> = {}
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      days[dayKey(d.toISOString())] = 0
    }
    const allDone = tasks.done || []
    allDone.forEach((t) => {
      if (t.updated_at) {
        const key = dayKey(t.updated_at)
        if (key in days) days[key]++
      }
    })
    return Object.entries(days).map(([key, value]) => ({
      label: formatDate(key),
      value,
    }))
  }, [tasks.done])

  // Events by day (last 14 days)
  const eventsByDay = useMemo(() => {
    const days: Record<string, number> = {}
    const now = new Date()
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      days[dayKey(d.toISOString())] = 0
    }
    events.forEach((e) => {
      const key = dayKey(e.created_at)
      if (key in days) days[key]++
    })
    return Object.entries(days).map(([key, value]) => ({
      label: formatDate(key),
      value,
    }))
  }, [events])

  // Agent activity: tasks per agent
  const tasksByAgent = useMemo(() => {
    const counts: Record<string, number> = {}
    const allTasks = [...tasks.open, ...tasks.in_progress, ...(tasks.review || []), ...(tasks.done || [])]
    allTasks.forEach((t) => {
      if (t.assignee) counts[t.assignee] = (counts[t.assignee] || 0) + 1
    })
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, value]) => ({ label, value }))
  }, [tasks])

  // Event type distribution
  const eventsByType = useMemo(() => {
    const counts: Record<string, number> = {}
    events.forEach((e) => {
      const category = e.type.split('_')[0]
      counts[category] = (counts[category] || 0) + 1
    })
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, value]) => ({ label, value }))
  }, [events])

  // Message volume by agent
  const messagesByAgent = useMemo(() => {
    const counts: Record<string, number> = {}
    messages.forEach((m) => {
      if (m.from_agent) counts[m.from_agent] = (counts[m.from_agent] || 0) + 1
    })
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, value]) => ({ label, value }))
  }, [messages])

  // Summary stats
  const onlineAgents = agents.filter((a) => a.status === 'online').length
  const completedTasks = (tasks.done || []).length
  const openBugs = bugs.filter((b) => b.status === 'open' || b.status === 'in_progress').length
  const activePlans = plans.filter((p) => p.status === 'active' || p.status === 'in_progress').length
  const pendingJobs = droneJobs.filter((j) => j.status === 'pending' || j.status === 'claimed').length
  const totalEvents = events.length

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">Analytics</h1>
          <p className="text-sm text-text-muted mt-0.5">Agent activity and platform metrics</p>
        </div>
        <button
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          className="text-xs text-text-muted hover:text-accent transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {[
          { label: 'Agents Online', value: `${onlineAgents}/${agents.length}`, color: 'text-green' },
          { label: 'Tasks Done', value: completedTasks, color: 'text-accent' },
          { label: 'Open Bugs', value: openBugs, color: 'text-red' },
          { label: 'Active Plans', value: activePlans, color: 'text-purple' },
          { label: 'Drone Jobs', value: pendingJobs, color: 'text-blue' },
          { label: 'Events', value: totalEvents, color: 'text-text-muted' },
        ].map((m) => (
          <div key={m.label} className="bg-surface rounded-lg p-3 text-center">
            <div className={`text-2xl font-bold font-mono ${m.color}`}>{m.value}</div>
            <div className="text-[10px] text-text-dim uppercase tracking-wider mt-1">{m.label}</div>
          </div>
        ))}
      </div>

      {/* Charts row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface rounded-lg p-4">
          <h2 className="text-sm font-semibold text-text-dim mb-4">Task Completions (14 days)</h2>
          <BarChart data={tasksByDay} color="bg-green" />
        </div>
        <div className="bg-surface rounded-lg p-4">
          <h2 className="text-sm font-semibold text-text-dim mb-4">Event Volume (14 days)</h2>
          <BarChart data={eventsByDay} color="bg-accent" />
        </div>
      </div>

      {/* Charts row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface rounded-lg p-4">
          <h2 className="text-sm font-semibold text-text-dim mb-4">Tasks by Agent</h2>
          {tasksByAgent.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">No task data</p>
          ) : (
            <HorizontalBar items={tasksByAgent} color="bg-accent" />
          )}
        </div>
        <div className="bg-surface rounded-lg p-4">
          <h2 className="text-sm font-semibold text-text-dim mb-4">Messages by Agent</h2>
          {messagesByAgent.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">No message data</p>
          ) : (
            <HorizontalBar items={messagesByAgent} color="bg-blue" />
          )}
        </div>
      </div>

      {/* Event distribution */}
      <div className="bg-surface rounded-lg p-4">
        <h2 className="text-sm font-semibold text-text-dim mb-4">Event Types</h2>
        {eventsByType.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-8">No event data</p>
        ) : (
          <HorizontalBar items={eventsByType} color="bg-purple" />
        )}
      </div>
    </div>
  )
}
