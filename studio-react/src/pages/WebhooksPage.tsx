import { Fragment, useEffect, useState, useMemo, useCallback } from 'react'
import { fetchWebhookDeliveries } from '../api/endpoints'
import { timeAgo, formatFullTimestamp } from '../utils/time'
import type { WebhookDelivery } from '../api/types'
import Badge from '../components/shared/Badge'

const PAGE_SIZE = 50

function statusColor(code: number | null): string {
  if (code === null) return 'text-text-muted'
  if (code >= 200 && code < 300) return 'text-green'
  if (code >= 400) return 'text-red'
  return 'text-yellow'
}

function statusBg(code: number | null): string {
  if (code === null) return 'bg-text-muted/10'
  if (code >= 200 && code < 300) return 'bg-green/10'
  if (code >= 400) return 'bg-red/10'
  return 'bg-yellow/10'
}

function eventBadgeVariant(event: string): 'accent' | 'blue' | 'green' | 'muted' | 'purple' | 'red' {
  if (event.startsWith('task')) return 'accent'
  if (event.startsWith('message') || event.startsWith('request')) return 'green'
  if (event.startsWith('agent')) return 'purple'
  if (event.startsWith('bug')) return 'red'
  if (event.startsWith('plan')) return 'purple'
  if (event.startsWith('drone') || event.startsWith('channel')) return 'blue'
  return 'muted'
}

function formatJson(raw: string | null): string {
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export default function WebhooksPage() {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [loading, setLoading] = useState(true)
  const [eventFilter, setEventFilter] = useState<string>('')
  const [errorOnly, setErrorOnly] = useState(false)
  const [offset, setOffset] = useState(0)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchWebhookDeliveries({
        event: eventFilter || undefined,
        error_only: errorOnly || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      setDeliveries(data)
    } catch (err) {
      console.error('Failed to fetch webhook deliveries:', err)
      setDeliveries([])
    } finally {
      setLoading(false)
    }
  }, [eventFilter, errorOnly, offset])

  useEffect(() => {
    load()
  }, [load])

  // Collect unique event types for the filter dropdown
  const eventTypes = useMemo(() => {
    const set = new Set(deliveries.map((d) => d.event))
    return Array.from(set).sort()
  }, [deliveries])

  const handlePrev = () => setOffset(Math.max(0, offset - PAGE_SIZE))
  const handleNext = () => { if (deliveries.length === PAGE_SIZE) setOffset(offset + PAGE_SIZE) }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold text-text">Webhooks</h1>
          <p className="text-sm text-text-muted mt-0.5">Delivery log</p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs text-text-muted hover:text-accent transition-colors px-3 py-1.5 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={eventFilter}
          onChange={(e) => { setEventFilter(e.target.value); setOffset(0) }}
          className="bg-surface-raised text-text text-xs rounded px-2.5 py-1.5 border border-border focus:outline-none focus:ring-1 ring-accent"
        >
          <option value="">All events</option>
          {eventTypes.map((ev) => (
            <option key={ev} value={ev}>{ev.replace(/_/g, ' ')}</option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-text-dim cursor-pointer select-none">
          <input
            type="checkbox"
            checked={errorOnly}
            onChange={(e) => { setErrorOnly(e.target.checked); setOffset(0) }}
            className="rounded border-border accent-red"
          />
          Errors only
        </label>

        {(eventFilter || errorOnly) && (
          <button
            onClick={() => { setEventFilter(''); setErrorOnly(false); setOffset(0) }}
            className="text-xs text-text-muted hover:text-text transition-colors"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-surface rounded-lg flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface z-10">
            <tr className="text-xs text-text-muted border-b border-border">
              <th className="text-left py-2.5 px-3 font-medium">ID</th>
              <th className="text-left py-2.5 px-3 font-medium">Event</th>
              <th className="text-left py-2.5 px-3 font-medium">Agent</th>
              <th className="text-left py-2.5 px-3 font-medium">Status</th>
              <th className="text-left py-2.5 px-3 font-medium">Duration</th>
              <th className="text-left py-2.5 px-3 font-medium">Error</th>
              <th className="text-left py-2.5 px-3 font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {loading && deliveries.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-text-muted py-12 text-sm animate-pulse">
                  Loading deliveries...
                </td>
              </tr>
            )}
            {!loading && deliveries.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-text-muted py-12 text-sm">
                  No deliveries found
                </td>
              </tr>
            )}
            {deliveries.map((d) => (
              <Fragment key={d.id}>
                <tr
                  onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                  className="border-b border-border/50 cursor-pointer hover:bg-surface-raised/50 transition-colors"
                >
                  <td className="py-2.5 px-3 font-mono text-xs text-accent font-bold">#{d.id}</td>
                  <td className="py-2.5 px-3">
                    <Badge variant={eventBadgeVariant(d.event)}>{d.event.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-xs text-text-dim">{d.agent_id}</td>
                  <td className="py-2.5 px-3">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold ${statusColor(d.status_code)} ${statusBg(d.status_code)}`}>
                      {d.status_code ?? 'ERR'}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-xs text-text-muted font-mono">
                    {d.duration_ms !== null ? `${d.duration_ms}ms` : '-'}
                  </td>
                  <td className="py-2.5 px-3 text-xs text-red max-w-[200px] truncate">
                    {d.error ? d.error.slice(0, 60) + (d.error.length > 60 ? '...' : '') : ''}
                  </td>
                  <td className="py-2.5 px-3 text-xs text-text-muted whitespace-nowrap">{timeAgo(d.created_at)}</td>
                </tr>
                {expandedId === d.id && (
                  <tr key={`${d.id}-detail`} className="border-b border-border/50">
                    <td colSpan={7} className="px-3 py-3 bg-bg/50">
                      <div className="space-y-3">
                        {d.error && (
                          <div>
                            <span className="text-xs text-red font-medium">Error</span>
                            <pre className="mt-1 text-xs text-red/80 bg-red/5 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                              {d.error}
                            </pre>
                          </div>
                        )}
                        <div>
                          <span className="text-xs text-text-muted font-medium">Payload</span>
                          <pre className="mt-1 text-xs text-text-dim bg-bg rounded p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
                            {formatJson(d.payload)}
                          </pre>
                        </div>
                        {d.response_body && (
                          <div>
                            <span className="text-xs text-text-muted font-medium">Response</span>
                            <pre className="mt-1 text-xs text-text-dim bg-bg rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                              {formatJson(d.response_body)}
                            </pre>
                          </div>
                        )}
                        <div className="flex items-center gap-4 text-xs text-text-muted">
                          <span>Webhook ID: <span className="font-mono text-text-dim">{d.webhook_id}</span></span>
                          <span>Delivery ID: <span className="font-mono text-text-dim">{d.id}</span></span>
                          <span>{formatFullTimestamp(d.created_at)}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
        <span className="text-xs text-text-muted">
          Showing {deliveries.length > 0 ? offset + 1 : 0}–{offset + deliveries.length}
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrev}
            disabled={offset === 0}
            className="px-3 py-1 rounded text-xs font-medium bg-surface-raised text-text-dim hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Prev
          </button>
          <button
            onClick={handleNext}
            disabled={deliveries.length < PAGE_SIZE}
            className="px-3 py-1 rounded text-xs font-medium bg-surface-raised text-text-dim hover:text-text disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}
