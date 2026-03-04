import { useEffect, useState, useCallback } from 'react'
import { Plus, Zap, Loader2, RefreshCw, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import ModalOverlay from '../components/modals/ModalOverlay'
import { timeAgo } from '../utils/time'
import { apiGet, apiPost } from '../api/client'

// ─── Types ────────────────────────────────────────────────────────────────────

interface RunnerSpawn {
  id: number
  status: 'pending' | 'claimed' | 'done' | 'failed'
  title: string
  tier: string
  model: string
  cwd: string
  max_turns: number
  work_context: Record<string, unknown>
  result: string
  requested_by: string
  runner_id: string
  created_at: string
  claimed_at: string | null
  done_at: string | null
}

// ─── Status config ─────────────────────────────────────────────────────────────

const statusConfig: Record<string, { label: string; color: string; dot: string; pulse: boolean }> = {
  pending: { label: 'Pending', color: 'text-yellow bg-yellow/10', dot: 'bg-yellow', pulse: true },
  claimed: { label: 'Running', color: 'text-blue bg-blue/10', dot: 'bg-blue', pulse: true },
  done:    { label: 'Done',    color: 'text-green bg-green/10', dot: 'bg-green', pulse: false },
  failed:  { label: 'Failed',  color: 'text-red bg-red/10',     dot: 'bg-red',   pulse: false },
}

const tierConfig: Record<string, { color: string; label: string }> = {
  main:  { color: 'text-accent bg-accent/10',     label: 'main' },
  admin: { color: 'text-purple bg-purple/10',     label: 'admin' },
  agent: { color: 'text-text-dim bg-surface-raised', label: 'agent' },
  drone: { color: 'text-text-muted bg-surface',   label: 'drone' },
}

// ─── Spawn Row ─────────────────────────────────────────────────────────────────

function SpawnRow({ spawn }: { spawn: RunnerSpawn }) {
  const [expanded, setExpanded] = useState(false)
  const status = statusConfig[spawn.status] ?? statusConfig.pending
  const tier = tierConfig[spawn.tier] ?? tierConfig.agent
  const hasContext = spawn.work_context && Object.keys(spawn.work_context).length > 0

  return (
    <div className="border border-border rounded-lg overflow-hidden transition-colors hover:border-border/60 bg-surface">
      {/* Main row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={() => (hasContext || spawn.result) && setExpanded(e => !e)}
      >
        {/* Status dot */}
        <div className="flex-shrink-0 relative">
          <div className={`w-2 h-2 rounded-full ${status.dot}`} />
          {status.pulse && (
            <div className={`absolute inset-0 rounded-full ${status.dot} opacity-40 animate-ping`} />
          )}
        </div>

        {/* Title */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-text font-medium truncate">{spawn.title}</span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${tier.color}`}>
              {tier.label}
            </span>
            {spawn.model && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-text-muted bg-surface-raised">
                {spawn.model.replace('claude-', '').replace('-latest', '')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5">
            <span className="text-[11px] text-text-muted">
              by {spawn.requested_by} · {timeAgo(spawn.created_at)}
            </span>
            {spawn.runner_id && (
              <span className="text-[11px] text-text-muted font-mono">
                {spawn.runner_id}
              </span>
            )}
          </div>
        </div>

        {/* Status badge */}
        <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${status.color}`}>
          {status.label}
        </span>

        {/* Expand chevron */}
        {(hasContext || spawn.result) && (
          <ChevronDown
            size={14}
            className={`text-text-muted flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border bg-surface-raised/40 px-4 py-3 space-y-3">
          {hasContext && (
            <div>
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-1">Work Context</div>
              <pre className="text-xs text-text-dim font-mono bg-surface rounded p-2 overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(spawn.work_context, null, 2)}
              </pre>
            </div>
          )}
          {spawn.result && (
            <div>
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-1">Result</div>
              <p className="text-xs text-text-dim">{spawn.result}</p>
            </div>
          )}
          {spawn.done_at && (
            <div className="text-[11px] text-text-muted">
              Completed {timeAgo(spawn.done_at)}
              {spawn.claimed_at && ` · started ${timeAgo(spawn.claimed_at)}`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Create Spawn Modal ────────────────────────────────────────────────────────

const TIERS = ['agent', 'admin', 'main', 'drone']
const MODELS = [
  { value: '', label: 'Runner default' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-6', label: 'Opus 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

function CreateSpawnModal({ isOpen, onClose, onCreated }: {
  isOpen: boolean
  onClose: () => void
  onCreated: () => void
}) {
  const [title, setTitle] = useState('')
  const [tier, setTier] = useState('agent')
  const [model, setModel] = useState('')
  const [maxTurns, setMaxTurns] = useState(50)
  const [context, setContext] = useState('')
  const [contextError, setContextError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setTitle(''); setTier('agent'); setModel(''); setMaxTurns(50); setContext(''); setContextError(null); setError(null)
  }

  function handleClose() { reset(); onClose() }

  function validateContext(val: string): boolean {
    if (!val.trim()) { setContextError(null); return true }
    try { JSON.parse(val); setContextError(null); return true }
    catch { setContextError('Invalid JSON'); return false }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    if (!validateContext(context)) return
    setSubmitting(true)
    setError(null)
    try {
      await apiPost('/admin/runner/spawns', {
        title: title.trim(),
        tier,
        model: model || undefined,
        max_turns: maxTurns,
        work_context: context.trim() ? JSON.parse(context) : {},
      })
      toast.success('Spawn request queued — runner picks it up within 30s')
      onCreated()
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create spawn')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={handleClose} title="Spawn Agent">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Task <span className="text-red">*</span></label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Audit authentication middleware for bugs"
            autoFocus
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
          />
        </div>

        {/* Tier + Model */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Tier</label>
            <select
              value={tier}
              onChange={e => setTier(e.target.value)}
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
            >
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Model</label>
            <select
              value={model}
              onChange={e => setModel(e.target.value)}
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
            >
              {MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
        </div>

        {/* Max turns */}
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">
            Max turns <span className="text-text-muted font-normal">({maxTurns})</span>
          </label>
          <input
            type="range"
            min={10} max={200} step={10}
            value={maxTurns}
            onChange={e => setMaxTurns(Number(e.target.value))}
            disabled={submitting}
            className="w-full accent-accent"
          />
          <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
            <span>10</span><span>100</span><span>200</span>
          </div>
        </div>

        {/* Work context */}
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">
            Work context <span className="text-text-muted font-normal">(JSON, optional)</span>
          </label>
          <textarea
            value={context}
            onChange={e => { setContext(e.target.value); validateContext(e.target.value) }}
            placeholder={'{\n  "bug_id": 42,\n  "focus": "auth middleware"\n}'}
            rows={4}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50 resize-none"
          />
          {contextError && <p className="text-xs text-red mt-1">{contextError}</p>}
        </div>

        {error && <p className="text-sm text-red bg-red/10 rounded px-3 py-2">{error}</p>}

        <div className="flex gap-2 justify-end pt-1">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="px-4 py-2 text-sm text-text-dim hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim() || !!contextError}
            className="flex items-center gap-2 px-4 py-2 bg-accent text-bg text-sm font-medium rounded hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            Spawn
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type FilterTab = 'all' | 'pending' | 'claimed' | 'done' | 'failed'

const TABS: { value: FilterTab; label: string }[] = [
  { value: 'all',     label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'claimed', label: 'Running' },
  { value: 'done',    label: 'Done' },
  { value: 'failed',  label: 'Failed' },
]

export default function SpawnsPage() {
  const [spawns, setSpawns] = useState<RunnerSpawn[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [filter, setFilter] = useState<FilterTab>('all')
  const [showCreate, setShowCreate] = useState(false)

  const fetchSpawns = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    else setRefreshing(true)
    try {
      const data = await apiGet<RunnerSpawn[]>('/admin/runner/spawns')
      setSpawns(Array.isArray(data) ? data : [])
    } catch (err) {
      if (!silent) toast.error('Failed to load spawns')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => { fetchSpawns() }, [fetchSpawns])

  // Auto-refresh every 15s when there are active spawns
  useEffect(() => {
    const hasActive = spawns.some(s => s.status === 'pending' || s.status === 'claimed')
    if (!hasActive) return
    const interval = setInterval(() => fetchSpawns(true), 15000)
    return () => clearInterval(interval)
  }, [spawns, fetchSpawns])

  const filtered = filter === 'all' ? spawns : spawns.filter(s => s.status === filter)

  const counts = spawns.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1
    return acc
  }, {} as Record<string, number>)

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text flex items-center gap-2">
            <Zap size={18} className="text-accent" />
            Spawns
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Request on-demand agent sessions. Runner picks them up within 30s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchSpawns(true)}
            disabled={refreshing}
            className="p-2 text-text-muted hover:text-text transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-bg text-sm font-medium rounded hover:bg-accent-light transition-colors"
          >
            <Plus size={15} />
            New spawn
          </button>
        </div>
      </div>

      {/* Stats row */}
      {spawns.length > 0 && (
        <div className="grid grid-cols-4 gap-3">
          {(['pending', 'claimed', 'done', 'failed'] as const).map(s => {
            const cfg = statusConfig[s]
            const count = counts[s] || 0
            return (
              <button
                key={s}
                onClick={() => setFilter(filter === s ? 'all' : s)}
                className={`text-left px-3 py-2.5 rounded-lg border transition-all ${
                  filter === s
                    ? 'border-accent/40 bg-accent/5'
                    : 'border-border bg-surface hover:border-border/60'
                }`}
              >
                <div className="text-xl font-semibold text-text">{count}</div>
                <div className={`text-xs mt-0.5 ${filter === s ? 'text-accent' : 'text-text-muted'}`}>
                  {cfg.label}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(tab => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={`px-3 py-2 text-sm transition-colors relative ${
              filter === tab.value
                ? 'text-accent'
                : 'text-text-muted hover:text-text-dim'
            }`}
          >
            {tab.label}
            {tab.value !== 'all' && counts[tab.value] ? (
              <span className="ml-1.5 text-[10px] bg-surface-raised text-text-muted rounded-full px-1.5 py-px">
                {counts[tab.value]}
              </span>
            ) : null}
            {filter === tab.value && (
              <div className="absolute bottom-0 left-0 right-0 h-px bg-accent" />
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading spawns…
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-12 h-12 rounded-full bg-surface-raised flex items-center justify-center mb-3">
            <Zap size={20} className="text-text-muted" />
          </div>
          <p className="text-sm text-text-dim">
            {filter === 'all' ? 'No spawns yet' : `No ${filter} spawns`}
          </p>
          {filter === 'all' && (
            <p className="text-xs text-text-muted mt-1">
              Request a new agent session to handle a focused task
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(spawn => (
            <SpawnRow key={spawn.id} spawn={spawn} />
          ))}
        </div>
      )}

      <CreateSpawnModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => fetchSpawns(true)}
      />
    </div>
  )
}
