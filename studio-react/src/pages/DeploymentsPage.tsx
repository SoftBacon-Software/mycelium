import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  fetchInstances, healthCheckInstance,
  fetchSupportTickets, updateSupportTicket,
  fetchDeployStatus, healthCheckAll, runChurnCheck,
} from '../api/endpoints'
import { timeAgo } from '../utils/time'
import type { CustomerInstance, SupportTicket, DeployInstance } from '../api/types'
import Badge from '../components/shared/Badge'
import { toast } from 'sonner'

/* ── Status colors ── */

const instanceStatusColors: Record<string, 'green' | 'accent' | 'red' | 'muted'> = {
  active: 'green',
  provisioning: 'accent',
  suspended: 'red',
  archived: 'muted',
  deleted: 'muted',
}

const healthColors: Record<string, string> = {
  healthy: 'text-green',
  unhealthy: 'text-red',
  unknown: 'text-text-muted',
}

const ticketStatusColors: Record<string, 'green' | 'accent' | 'red' | 'muted'> = {
  open: 'red',
  in_progress: 'accent',
  resolved: 'green',
  closed: 'muted',
}

const tierColors: Record<string, 'accent' | 'red'> = {
  L1: 'accent',
  L2: 'red',
}

/* ── Section wrapper ── */

function Section({ title, count, badge, children, actions }: {
  title: string
  count?: number
  badge?: 'red' | 'accent' | 'green' | 'muted'
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="bg-surface rounded-lg">
      <div className="flex items-center justify-between px-5 py-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-text-dim">{title}</h2>
          {count !== undefined && count > 0 && (
            <Badge variant={badge || 'muted'}>{count}</Badge>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

/* ── Instances Section ── */

function InstancesSection() {
  const [instances, setInstances] = useState<CustomerInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [checkingHealth, setCheckingHealth] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchInstances()
      setInstances(res.instances || [])
    } catch (err) {
      console.error('Failed to fetch instances:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return instances
    return instances.filter((i) => i.status === statusFilter)
  }, [instances, statusFilter])

  const handleHealthCheck = useCallback(async (id: number) => {
    setCheckingHealth(id)
    try {
      await healthCheckInstance(id)
      toast.success('Health check complete')
      await load()
    } catch (err) {
      toast.error('Health check failed')
    } finally {
      setCheckingHealth(null)
    }
  }, [load])

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const inst of instances) {
      counts[inst.status] = (counts[inst.status] || 0) + 1
    }
    return counts
  }, [instances])

  return (
    <Section
      title="Customer Instances"
      count={instances.length}
      badge="accent"
      actions={
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40"
          >
            <option value="all">All ({instances.length})</option>
            {Object.entries(statusCounts).map(([status, count]) => (
              <option key={status} value={status}>{status} ({count})</option>
            ))}
          </select>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors px-2 py-1 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      }
    >
      {loading && instances.length === 0 && (
        <div className="text-center text-text-muted py-8 text-sm animate-pulse">Loading instances...</div>
      )}
      {!loading && instances.length === 0 && (
        <div className="text-center text-text-muted py-8 text-sm">No customer instances yet.</div>
      )}
      {filtered.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted uppercase tracking-wider">
                <th className="pb-2 pr-4">Org</th>
                <th className="pb-2 pr-4">Domain</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Health</th>
                <th className="pb-2 pr-4">Version</th>
                <th className="pb-2 pr-4">Created</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {filtered.map((inst) => (
                <tr key={inst.id} className="hover:bg-surface-raised/50 transition-colors">
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-text text-xs">{inst.org_id}</span>
                    {inst.customer_email && (
                      <span className="block text-text-muted text-xs">{inst.customer_email}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    {inst.domain ? (
                      <a
                        href={`https://${inst.domain}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-teal text-xs hover:underline"
                      >
                        {inst.domain}
                      </a>
                    ) : (
                      <span className="text-text-muted text-xs">-</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Badge variant={instanceStatusColors[inst.status] || 'muted'}>{inst.status}</Badge>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className={`text-xs font-medium ${healthColors[inst.health_status] || 'text-text-muted'}`}>
                      {inst.health_status}
                    </span>
                    {inst.last_health_check && (
                      <span className="block text-text-muted text-[10px]">{timeAgo(inst.last_health_check)}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-text-dim text-xs">{inst.version || '-'}</span>
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="text-text-muted text-xs">{timeAgo(inst.created_at)}</span>
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => handleHealthCheck(inst.id)}
                      disabled={checkingHealth === inst.id}
                      className="px-2 py-0.5 rounded text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                    >
                      {checkingHealth === inst.id ? '...' : 'Check'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

/* ── Support Tickets Section ── */

function TicketsSection() {
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('open')
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchSupportTickets()
      setTickets(res.tickets || [])
    } catch (err) {
      console.error('Failed to fetch tickets:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return tickets
    return tickets.filter((t) => t.status === statusFilter)
  }, [tickets, statusFilter])

  const openCount = useMemo(() => tickets.filter((t) => t.status === 'open').length, [tickets])

  return (
    <>
      <Section
        title="Support Tickets"
        count={openCount}
        badge="red"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
            <button
              onClick={load}
              disabled={loading}
              className="text-xs text-text-muted hover:text-accent transition-colors px-2 py-1 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
            >
              {loading ? '...' : 'Refresh'}
            </button>
          </div>
        }
      >
        {loading && tickets.length === 0 && (
          <div className="text-center text-text-muted py-8 text-sm animate-pulse">Loading tickets...</div>
        )}
        {!loading && tickets.length === 0 && (
          <div className="text-center text-text-muted py-8 text-sm">No support tickets.</div>
        )}
        {filtered.length > 0 && (
          <div className="space-y-1">
            {filtered.map((ticket) => (
              <div
                key={ticket.id}
                onClick={() => setSelectedTicket(ticket)}
                className="flex items-center gap-2 py-2 px-3 rounded hover:bg-surface-raised/50 cursor-pointer text-sm transition-colors"
              >
                <span className="text-text-muted font-mono text-xs shrink-0">#{ticket.id}</span>
                <Badge variant={tierColors[ticket.tier] || 'muted'}>{ticket.tier}</Badge>
                <Badge variant={ticketStatusColors[ticket.status] || 'muted'}>{ticket.status}</Badge>
                <span className="text-text-dim truncate flex-1 min-w-0">{ticket.subject}</span>
                {ticket.assigned_agent && (
                  <span className="text-accent font-mono text-xs shrink-0">{ticket.assigned_agent}</span>
                )}
                {ticket.reporter_email && (
                  <span className="text-text-muted text-xs shrink-0 hidden sm:inline">{ticket.reporter_email}</span>
                )}
                <span className="text-text-muted text-xs font-mono shrink-0">{timeAgo(ticket.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Ticket Detail Panel */}
      {selectedTicket && (
        <TicketDetail
          ticket={selectedTicket}
          onClose={() => setSelectedTicket(null)}
          onUpdate={load}
        />
      )}
    </>
  )
}

/* ── Ticket Detail ── */

function TicketDetail({ ticket, onClose, onUpdate }: {
  ticket: SupportTicket
  onClose: () => void
  onUpdate: () => void
}) {
  const [draftResponse, setDraftResponse] = useState(ticket.draft_response || '')
  const [status, setStatus] = useState(ticket.status)
  const [saving, setSaving] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await updateSupportTicket(ticket.id, {
        status,
        draft_response: draftResponse.trim() || null,
      } as any)
      toast.success('Ticket updated')
      onUpdate()
      onClose()
    } catch (err) {
      toast.error('Failed to update ticket')
    } finally {
      setSaving(false)
    }
  }, [ticket.id, status, draftResponse, onUpdate, onClose])

  const handleApproveAndSend = useCallback(async () => {
    setSaving(true)
    try {
      await updateSupportTicket(ticket.id, {
        status: 'resolved',
        resolution: draftResponse.trim(),
        requires_approval: false,
      } as any)
      toast.success('Response approved and ticket resolved')
      onUpdate()
      onClose()
    } catch (err) {
      toast.error('Failed to approve response')
    } finally {
      setSaving(false)
    }
  }, [ticket.id, draftResponse, onUpdate, onClose])

  return (
    <>
      <div className="fixed inset-0 bg-bg/60 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-full sm:max-w-lg bg-surface border-l border-border z-50 flex flex-col animate-in slide-in-from-right">
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
          <div className="min-w-0 flex-1 mr-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs text-text-muted font-mono">#{ticket.id}</span>
              <Badge variant={tierColors[ticket.tier] || 'muted'}>{ticket.tier}</Badge>
              {ticket.requires_approval && (
                <Badge variant="red">Needs Approval</Badge>
              )}
            </div>
            <h2 className="text-lg font-semibold text-text leading-snug">{ticket.subject}</h2>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text transition-colors p-1 shrink-0">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Reporter + Meta */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <p className="text-xs text-text-muted mb-0.5">Reporter</p>
              <span className="text-text">{ticket.reporter_email || 'Unknown'}</span>
            </div>
            <div>
              <p className="text-xs text-text-muted mb-0.5">Assigned Agent</p>
              <span className="text-accent font-mono">{ticket.assigned_agent || 'Unassigned'}</span>
            </div>
            <div>
              <p className="text-xs text-text-muted mb-0.5">Category</p>
              <span className="text-text-dim">{ticket.category || '-'}</span>
            </div>
            <div>
              <p className="text-xs text-text-muted mb-0.5">Priority</p>
              <span className="text-text-dim">{ticket.priority}</span>
            </div>
          </div>

          {/* Description */}
          {ticket.description && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Description</h3>
              <p className="text-sm text-text-dim leading-relaxed whitespace-pre-wrap">{ticket.description}</p>
            </div>
          )}

          {/* Status */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Status</h3>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-3 py-1.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40"
            >
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>
          </div>

          {/* Draft Response */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">
              {ticket.requires_approval ? 'Agent Draft (needs your approval)' : 'Response Draft'}
            </h3>
            <textarea
              value={draftResponse}
              onChange={(e) => setDraftResponse(e.target.value)}
              rows={5}
              placeholder="Write response to customer..."
              className="w-full bg-surface-raised border border-border rounded-sm px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none"
            />
          </div>

          {/* Resolution */}
          {ticket.resolution && (
            <div>
              <h3 className="text-xs uppercase tracking-wider text-text-muted font-medium mb-2">Resolution</h3>
              <p className="text-sm text-green leading-relaxed">{ticket.resolution}</p>
            </div>
          )}

          {/* Timestamps */}
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span>Created {new Date(ticket.created_at).toLocaleString()}</span>
          </div>
        </div>

        {/* Footer actions */}
        <div className="p-4 border-t border-border flex items-center justify-end gap-2 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
          >
            Cancel
          </button>
          {ticket.requires_approval && draftResponse.trim() && (
            <button
              onClick={handleApproveAndSend}
              disabled={saving}
              className="px-4 py-1.5 rounded-sm text-sm font-medium bg-green/80 text-text hover:bg-green/90 transition-colors disabled:opacity-50"
            >
              {saving ? '...' : 'Approve & Send'}
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 rounded-sm text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Deploy Status Section ── */

function DeploySection() {
  const [instances, setInstances] = useState<DeployInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [runningChurn, setRunningChurn] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetchDeployStatus()
      setInstances(res.instances || [])
    } catch (err) {
      console.error('Failed to fetch deploy status:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleHealthCheckAll = useCallback(async () => {
    setChecking(true)
    try {
      const res = await healthCheckAll()
      const healthy = res.results?.filter((r) => r.healthy).length || 0
      const total = res.results?.length || 0
      toast.success(`Health check: ${healthy}/${total} healthy`)
      await load()
    } catch (err) {
      toast.error('Health check failed')
    } finally {
      setChecking(false)
    }
  }, [load])

  const handleChurnCheck = useCallback(async () => {
    setRunningChurn(true)
    try {
      const res = await runChurnCheck()
      const archived = res.results?.archived?.length || 0
      const deleted = res.results?.deleted?.length || 0
      toast.success(`Churn check: ${archived} archived, ${deleted} deleted`)
      await load()
    } catch (err) {
      toast.error('Churn check failed')
    } finally {
      setRunningChurn(false)
    }
  }, [load])

  const healthyCount = instances.filter((i) => i.health_status === 'healthy').length

  return (
    <Section
      title="Deploy Status"
      count={instances.length}
      badge={healthyCount === instances.length && instances.length > 0 ? 'green' : 'muted'}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={handleChurnCheck}
            disabled={runningChurn}
            className="text-xs text-text-muted hover:text-red transition-colors px-2 py-1 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
          >
            {runningChurn ? '...' : 'Run Churn Check'}
          </button>
          <button
            onClick={handleHealthCheckAll}
            disabled={checking}
            className="text-xs text-text-muted hover:text-green transition-colors px-2 py-1 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
          >
            {checking ? 'Checking...' : 'Health Check All'}
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors px-2 py-1 rounded bg-surface-raised hover:ring-1 ring-border disabled:opacity-50"
          >
            {loading ? '...' : 'Refresh'}
          </button>
        </div>
      }
    >
      {loading && instances.length === 0 && (
        <div className="text-center text-text-muted py-8 text-sm animate-pulse">Loading deploy status...</div>
      )}
      {!loading && instances.length === 0 && (
        <div className="text-center text-text-muted py-8 text-sm">
          No active instances to deploy to.
        </div>
      )}
      {instances.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {instances.map((inst) => (
            <div key={inst.id} className="bg-surface-raised rounded-lg p-4 border border-border/30">
              <div className="flex items-center justify-between mb-2">
                <span className="font-mono text-text text-xs">{inst.org_id}</span>
                <span className={`text-xs font-medium ${healthColors[inst.health_status] || 'text-text-muted'}`}>
                  {inst.health_status === 'healthy' ? '\u25CF' : inst.health_status === 'unhealthy' ? '\u25CF' : '\u25CB'}{' '}
                  {inst.health_status}
                </span>
              </div>
              {inst.domain && (
                <a
                  href={`https://${inst.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-teal text-xs hover:underline block mb-1"
                >
                  {inst.domain}
                </a>
              )}
              <div className="flex items-center justify-between text-xs text-text-muted mt-2">
                <span>v{inst.version || '?'}</span>
                {inst.last_health_check && <span>{timeAgo(inst.last_health_check)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

/* ── Main Page ── */

export default function DeploymentsPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-text">Deployments</h1>
        <p className="text-sm text-text-muted mt-0.5">Customer instances, support, and deploy operations</p>
      </div>

      <InstancesSection />
      <TicketsSection />
      <DeploySection />
    </div>
  )
}
