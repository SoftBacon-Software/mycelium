import { useState, useEffect } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { updateConfig, createOperator, updateOperator, deleteOperator, fetchSubscriptionStatus } from '../api/endpoints'
import type { SubscriptionRecord } from '../api/endpoints'
import ConfigPanel from '../components/operators/ConfigPanel'
import KillSwitch from '../components/operators/KillSwitch'
import ModalOverlay from '../components/modals/ModalOverlay'
import type { Operator } from '../api/types'
import { toast } from 'sonner'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

// ─── Operator Form Modal ──────────────────────────────────────────────────────

interface OperatorFormProps {
  isOpen: boolean
  onClose: () => void
  operator?: Operator | null
}

const ROLE_OPTIONS = ['owner', 'admin', 'member', 'viewer']

function OperatorFormModal({ isOpen, onClose, operator }: OperatorFormProps) {
  const refresh = useDashboardStore((s) => s.refresh)
  const agents = useDashboardStore((s) => s.agents)
  const isEditing = !!operator

  const [id, setId] = useState(operator?.id ?? '')
  const [displayName, setDisplayName] = useState(operator?.display_name ?? '')
  const [role, setRole] = useState(operator?.role ?? 'member')
  const [responsibilities, setResponsibilities] = useState(operator?.responsibilities ?? '')
  const [email, setEmail] = useState(operator?.email ?? '')
  const [linkedAgents, setLinkedAgents] = useState<string[]>(operator?.linked_agents ?? [])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetAndClose() {
    setId('')
    setDisplayName('')
    setRole('member')
    setResponsibilities('')
    setEmail('')
    setLinkedAgents([])
    setError(null)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!id.trim() || !displayName.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const data: Partial<Operator> = {
        display_name: displayName.trim(),
        role,
        responsibilities: responsibilities.trim(),
        email: email.trim() || null,
        linked_agents: linkedAgents,
      }
      if (isEditing) {
        await updateOperator(operator!.id, data)
        toast.success('Operator updated')
      } else {
        await createOperator({ id: id.trim(), ...data })
        toast.success('Operator created')
      }
      await refresh()
      resetAndClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save operator')
    } finally {
      setSubmitting(false)
    }
  }

  function toggleAgent(agentId: string) {
    setLinkedAgents((prev) =>
      prev.includes(agentId) ? prev.filter((a) => a !== agentId) : [...prev, agentId],
    )
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={resetAndClose} title={isEditing ? 'Edit Operator' : 'Add Team Member'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {!isEditing && (
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">
              ID <span className="text-text-muted">(URL-friendly slug)</span>
            </label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              placeholder="jane-doe"
              autoFocus
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Display Name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            autoFocus={isEditing}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer disabled:opacity-50"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">
            Email <span className="text-text-muted">(optional)</span>
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">
            Responsibilities <span className="text-text-muted">(optional)</span>
          </label>
          <textarea
            value={responsibilities}
            onChange={(e) => setResponsibilities(e.target.value)}
            placeholder="What does this person oversee?"
            rows={2}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none disabled:opacity-50"
          />
        </div>

        {/* Linked agents */}
        {agents.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1.5">Linked Agents</label>
            <div className="flex flex-wrap gap-2">
              {agents.map((a) => {
                const selected = linkedAgents.includes(a.id)
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => toggleAgent(a.id)}
                    disabled={submitting}
                    className={`px-2.5 py-1 rounded-full text-xs font-mono transition-colors ${
                      selected
                        ? 'bg-accent/20 text-accent border border-accent/40'
                        : 'bg-surface-raised text-text-muted border border-border hover:text-text-dim'
                    } disabled:opacity-50`}
                  >
                    {a.id}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {error && <p className="text-red text-xs">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={resetAndClose}
            className="px-4 py-2 rounded text-sm text-text-dim hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !id.trim() || !displayName.trim()}
            className="px-5 py-2 rounded text-sm font-semibold bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Add Member'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ─── Operator Card ────────────────────────────────────────────────────────────

function OperatorCard({ operator, onEdit, onDelete }: { operator: Operator; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="bg-surface-raised rounded-lg p-4 flex flex-col gap-3 border border-border/50 hover:border-border transition-colors group">
      {/* Header: name + role */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-text truncate">{operator.display_name}</h3>
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full font-medium">
            {operator.role}
          </span>
          <div className="hidden group-hover:flex items-center gap-1">
            <button
              onClick={onEdit}
              className="text-text-muted hover:text-accent transition-colors p-0.5"
              title="Edit"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8.5 2.5l3 3M2 9l6-6 3 3-6 6H2V9z" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              onClick={onDelete}
              className="text-text-muted hover:text-red transition-colors p-0.5"
              title="Delete"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4v7.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V4" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ID */}
      <p className="text-text-muted font-mono text-sm leading-none">{operator.id}</p>

      {/* Responsibilities */}
      {operator.responsibilities && (
        <p className="text-text-dim text-sm leading-relaxed">{operator.responsibilities}</p>
      )}

      {/* Email */}
      {operator.email && (
        <p className="text-text-muted text-sm">{operator.email}</p>
      )}

      {/* Linked agents */}
      {Array.isArray(operator.linked_agents) && operator.linked_agents.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {operator.linked_agents.map((agentId, i) => (
            <span
              key={agentId}
              className={`text-xs px-2 py-0.5 rounded-full bg-surface font-mono ${
                i % 2 === 0 ? 'text-green' : 'text-blue'
              }`}
            >
              {agentId}
            </span>
          ))}
        </div>
      )}

      {/* Created date */}
      <p className="text-text-muted text-xs mt-auto pt-1">
        Joined {formatDate(operator.created_at)}
      </p>
    </div>
  )
}

// ─── Subscription Status Badge ────────────────────────────────────────────────

const subStatusColors: Record<string, string> = {
  active: 'bg-[#4ade80]/15 text-[#4ade80]',
  past_due: 'bg-[#fbbf24]/15 text-[#fbbf24]',
  canceled: 'bg-[#f87171]/15 text-[#f87171]',
  none: 'bg-[#6b7280]/15 text-[#6b7280]',
}

function SubscriptionBadge({ status }: { status: string }) {
  const cls = subStatusColors[status] || subStatusColors.none
  const label = status === 'none' ? 'no subscription' : status.replace(/_/g, ' ')
  return (
    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>
      {label}
    </span>
  )
}

// ─── Organizations Section ────────────────────────────────────────────────────

function OrganizationsSection() {
  const organizations = useDashboardStore((s) => s.organizations)
  const [subStatuses, setSubStatuses] = useState<Record<string, string>>({})

  useEffect(() => {
    if (organizations.length === 0) return
    // Fetch subscription status for each org
    organizations.forEach((org) => {
      fetchSubscriptionStatus(org.id)
        .then((sub: SubscriptionRecord) => {
          setSubStatuses((prev) => ({ ...prev, [org.id]: sub.status }))
        })
        .catch(() => {
          setSubStatuses((prev) => ({ ...prev, [org.id]: 'none' }))
        })
    })
  }, [organizations])

  if (organizations.length === 0) return null

  return (
    <section>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-text">Organizations</h2>
        <p className="text-text-muted text-sm mt-0.5">
          {organizations.length} organization{organizations.length !== 1 ? 's' : ''} registered
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {organizations.map((org) => (
          <div
            key={org.id}
            className="bg-surface-raised rounded-lg p-4 flex flex-col gap-2 border border-border/50"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-text truncate">{org.name}</h3>
              <SubscriptionBadge status={subStatuses[org.id] ?? 'none'} />
            </div>
            <p className="text-text-muted font-mono text-sm leading-none">{org.id}</p>
            {org.description && (
              <p className="text-text-dim text-sm leading-relaxed">{org.description}</p>
            )}
            <div className="flex items-center gap-3 text-xs text-text-muted mt-auto pt-1">
              <span>Plan: <span className="text-text-dim font-medium">{org.plan || 'free'}</span></span>
              <span>Status: <span className="text-text-dim font-medium">{org.status || 'active'}</span></span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function OperatorsPage() {
  const operators = useDashboardStore((s) => s.operators)
  const instanceConfig = useDashboardStore((s) => s.instanceConfig)
  const loading = useDashboardStore((s) => s.loading)
  const error = useDashboardStore((s) => s.error)
  const refresh = useDashboardStore((s) => s.refresh)

  const [showForm, setShowForm] = useState(false)
  const [editingOp, setEditingOp] = useState<Operator | null>(null)

  async function handleConfigSave(key: string, value: string) {
    await updateConfig(key, value)
    await refresh()
  }

  async function handleDelete(op: Operator) {
    if (!confirm(`Delete operator "${op.display_name}"?`)) return
    try {
      await deleteOperator(op.id)
      toast.success('Operator deleted')
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete operator')
    }
  }

  // Loading state
  if (loading && operators.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-3" />
          <p className="text-text-dim text-sm">Loading operators...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error && operators.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-red text-sm mb-3">Failed to load operator data</p>
        <p className="text-text-muted text-xs mb-4">{error}</p>
        <button
          onClick={refresh}
          className="px-4 py-2 rounded text-sm bg-surface-raised text-text-dim hover:text-text transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Section 1: Team Members */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Team Members</h2>
            <p className="text-text-muted text-sm mt-0.5">
              {operators.length} operator{operators.length !== 1 ? 's' : ''} registered
            </p>
          </div>
          <button
            onClick={() => { setEditingOp(null); setShowForm(true) }}
            className="px-4 py-2 rounded text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors"
          >
            + Add Member
          </button>
        </div>
        {operators.length === 0 ? (
          <div className="bg-surface rounded-lg p-8 text-center">
            <p className="text-text-muted text-sm">No team members registered yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {operators.map((op) => (
              <OperatorCard
                key={op.id}
                operator={op}
                onEdit={() => { setEditingOp(op); setShowForm(true) }}
                onDelete={() => handleDelete(op)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Organizations */}
      <OrganizationsSection />

      {/* Section 3: Instance Config */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-text">Instance Configuration</h2>
          <p className="text-text-muted text-sm mt-0.5">
            Click any value to edit inline. Changes are saved on blur or Enter.
          </p>
        </div>
        <ConfigPanel configs={instanceConfig} onSave={handleConfigSave} />
      </section>

      {/* Section 4: Kill Switch */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-text">Emergency Controls</h2>
          <p className="text-text-muted text-sm mt-0.5">
            System-wide operational overrides.
          </p>
        </div>
        <KillSwitch />
      </section>

      {/* Modal */}
      {showForm && (
        <OperatorFormModal
          isOpen={showForm}
          onClose={() => { setShowForm(false); setEditingOp(null) }}
          operator={editingOp}
        />
      )}
    </div>
  )
}
