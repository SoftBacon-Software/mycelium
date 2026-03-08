import { useCallback, useEffect, useState } from 'react'
import { fetchWidgets } from '../../api/endpoints'
import type { Widget } from '../../api/endpoints'

// ─── Widget data types ──────────────────────────────────────────────────────

interface StatusData {
  items: { label: string; value: string; color?: string }[]
}

interface ProgressData {
  current: number
  total: number
  label?: string
  color?: string
}

interface ListData {
  items: { text: string; badge?: string; color?: string }[]
}

// ─── Parse widget data ─────────────────────────────────────────────────────

function parseData(data: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof data === 'string') {
    try { return JSON.parse(data) } catch { return {} }
  }
  return data || {}
}

// ─── Widget type renderers ──────────────────────────────────────────────────

function StatusWidget({ data }: { data: StatusData }) {
  if (!data.items?.length) return <p className="text-xs text-text-muted">No data</p>
  return (
    <div className="flex flex-col gap-2">
      {data.items.map((item, i) => (
        <div key={i} className="flex items-center justify-between">
          <span className="text-xs text-text-dim">{item.label}</span>
          <span className={`text-xs font-mono ${item.color === 'red' ? 'text-red' : item.color === 'green' ? 'text-green' : 'text-text'}`}>
            {item.value}
          </span>
        </div>
      ))}
    </div>
  )
}

function ProgressWidget({ data }: { data: ProgressData }) {
  const pct = data.total > 0 ? Math.min(100, (data.current / data.total) * 100) : 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-text-dim">{data.label || 'Progress'}</span>
        <span className="text-text-muted font-mono">{data.current}/{data.total}</span>
      </div>
      <div className="w-full h-2 rounded-full bg-surface-raised overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${pct}%`,
            backgroundColor: data.color === 'red' ? 'var(--color-red)' :
              data.color === 'blue' ? 'var(--color-blue)' :
              pct >= 100 ? 'var(--color-green)' : 'var(--color-accent)',
          }}
        />
      </div>
      <span className="text-[10px] text-text-muted text-right">{pct.toFixed(0)}%</span>
    </div>
  )
}

function ListWidget({ data }: { data: ListData }) {
  if (!data.items?.length) return <p className="text-xs text-text-muted">No items</p>
  return (
    <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
      {data.items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="w-1 h-1 rounded-full bg-text-muted/40 shrink-0" />
          <span className="text-text-dim flex-1">{item.text}</span>
          {item.badge && (
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
              item.color === 'green' ? 'bg-green/15 text-green' :
              item.color === 'red' ? 'bg-red/15 text-red' :
              'bg-surface-raised text-text-muted'
            }`}>
              {item.badge}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function GenericWidget({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className="text-[10px] text-text-muted overflow-auto max-h-32 whitespace-pre-wrap">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

// ─── Single Widget Card ─────────────────────────────────────────────────────

function WidgetCard({ widget }: { widget: Widget }) {
  const data = parseData(widget.data)

  return (
    <div className="p-4 bg-surface rounded-lg border border-border">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text">{widget.title}</h3>
        <span className="text-[10px] text-text-muted">{widget.agent_id}</span>
      </div>
      {widget.widget_type === 'status' && <StatusWidget data={data as unknown as StatusData} />}
      {widget.widget_type === 'progress' && <ProgressWidget data={data as unknown as ProgressData} />}
      {widget.widget_type === 'list' && <ListWidget data={data as unknown as ListData} />}
      {!['status', 'progress', 'list'].includes(widget.widget_type) && <GenericWidget data={data} />}
    </div>
  )
}

// ─── Widget Grid ────────────────────────────────────────────────────────────

export default function WidgetGrid({ projectId }: { projectId?: string }) {
  const [widgets, setWidgets] = useState<Widget[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const result = await fetchWidgets(projectId ? { project_id: projectId } : undefined)
      setWidgets(result)
    } catch {
      // silently fail — widgets are optional
    }
    setLoading(false)
  }, [projectId])

  useEffect(() => {
    load()
    // Refresh widgets every 30s
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [load])

  if (loading || widgets.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">Agent Widgets</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {widgets.map((w) => (
          <WidgetCard key={w.id} widget={w} />
        ))}
      </div>
    </div>
  )
}
