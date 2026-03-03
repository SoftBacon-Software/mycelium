import { useState, useCallback, useMemo } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { useLiveStore } from '../stores/liveStore'
import { useAuthStore } from '../stores/authStore'
import { usePolling } from '../hooks/usePolling'
import { usePushNotifications } from '../hooks/usePushNotifications'
import { castVote, resolveApproval, killSwitch, sendDirective } from '../api/endpoints'
import { toast } from 'sonner'
import type { Approval } from '../api/types'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'now'
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm'
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h'
  return Math.floor(diff / 86400000) + 'd'
}

function safeVotes(raw: unknown): Array<{ vote: string }> {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) return p } catch { /* */ }
  }
  return []
}

const riskColors: Record<string, string> = {
  critical: 'bg-red/20 text-red',
  high: 'bg-red/15 text-red',
  medium: 'bg-accent/15 text-accent',
  low: 'bg-green/15 text-green',
}

const eventTypeColors: Record<string, string> = {
  task_completed: 'text-green',
  task_created: 'text-blue',
  bug_filed: 'text-red',
  approval_created: 'text-accent',
  approval_approved: 'text-green',
  approval_denied: 'text-red',
  agent_boot: 'text-blue',
  agent_heartbeat: 'text-text-muted',
  drone_job_failed: 'text-red',
  plan_completed: 'text-purple',
}

export default function MobileCommandPage() {
  const agents = useDashboardStore((s) => s.agents)
  const pendingApprovals = useDashboardStore((s) => s.pendingApprovals)
  const instanceConfig = useDashboardStore((s) => s.instanceConfig)
  const events = useDashboardStore((s) => s.events)
  const refresh = useDashboardStore((s) => s.refresh)
  const user = useAuthStore((s) => s.user)
  const liveEvents = useLiveStore((s) => s.events)
  const { status: pushStatus, subscribe: pushSubscribe, unsubscribe: pushUnsubscribe } = usePushNotifications()

  usePolling(15000)

  const [directiveAgent, setDirectiveAgent] = useState('')
  const [directiveText, setDirectiveText] = useState('')
  const [sending, setSending] = useState(false)

  const isFrozen = useMemo(() => {
    const s = instanceConfig.find((c) => c.key === 'admin_status')
    return s?.value === 'frozen'
  }, [instanceConfig])

  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents])
  const pending = useMemo(() => pendingApprovals.filter((a) => a.status === 'pending'), [pendingApprovals])

  // Merge polled + live events, dedupe, sort newest first
  const recentEvents = useMemo(() => {
    const seen = new Set<string>()
    const all = [...liveEvents.map((e) => ({ ...e, id: String(e.id) })), ...events]
    return all.filter((e) => {
      if (seen.has(e.id)) return false
      seen.add(e.id)
      return true
    }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 15)
  }, [events, liveEvents])

  const handleVote = useCallback(async (approval: Approval, vote: 'approve' | 'deny') => {
    if (!user) return
    try {
      await castVote(approval.id, vote, null as any, user.username, 'operator')
      const existing = safeVotes(approval.votes)
      const total = existing.length + 1
      if (total >= approval.quorum_required) {
        const approves = existing.filter((v) => v.vote === 'approve').length + (vote === 'approve' ? 1 : 0)
        await resolveApproval(approval.id, approves > total / 2 ? 'approved' : 'rejected', user.username)
      }
      toast.success(vote === 'approve' ? 'Approved' : 'Denied')
      refresh()
    } catch (e) {
      toast.error('Vote failed')
    }
  }, [user, refresh])

  const handleKillSwitch = useCallback(async () => {
    try {
      await killSwitch(isFrozen ? 'unfreeze' : 'freeze')
      toast.success(isFrozen ? 'Unfrozen' : 'Frozen')
      refresh()
    } catch {
      toast.error('Kill switch failed')
    }
  }, [isFrozen, refresh])

  const handleDirective = useCallback(async () => {
    if (!directiveAgent || !directiveText.trim()) return
    setSending(true)
    try {
      await sendDirective(directiveAgent, directiveText.trim())
      toast.success('Directive sent')
      setDirectiveText('')
    } catch {
      toast.error('Failed to send')
    } finally {
      setSending(false)
    }
  }, [directiveAgent, directiveText])

  return (
    <div className="flex flex-col gap-4 p-4 pb-8">
      {/* Frozen banner */}
      {isFrozen && (
        <div className="px-3 py-2 rounded-lg bg-red/15 text-red text-sm font-mono font-bold text-center animate-pulse">
          NETWORK FROZEN
        </div>
      )}

      {/* Agent cards — horizontal scroll */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-2">
          Agents
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-4 px-4">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="shrink-0 w-36 p-3 rounded-lg bg-surface border border-border"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    agent.status === 'online' ? 'bg-green' : 'bg-text-muted'
                  }`}
                />
                <span className="text-xs font-semibold text-text truncate">
                  {agent.name}
                </span>
              </div>
              <span className="text-[10px] text-text-muted leading-tight line-clamp-2">
                {agent.working_on || (agent.status === 'online' ? 'Idle' : 'Offline')}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <section>
          <h2 className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-2">
            Approvals
            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-accent/15 text-accent">
              {pending.length}
            </span>
          </h2>
          <div className="flex flex-col gap-2">
            {pending.map((approval) => (
              <div
                key={approval.id}
                className="p-3 rounded-lg bg-surface border border-border"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${riskColors[approval.risk_tier] || 'bg-surface-raised text-text-dim'}`}>
                    {approval.risk_tier}
                  </span>
                  <span className="text-xs text-text-dim truncate flex-1">
                    {(approval as any).title || approval.entity_type}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {timeAgo(approval.created_at)}
                  </span>
                </div>
                {/* Quorum progress */}
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 h-1 rounded-full bg-surface-raised overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all"
                      style={{ width: `${(safeVotes(approval.votes).length / approval.quorum_required) * 100}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-text-muted font-mono">
                    {safeVotes(approval.votes).length}/{approval.quorum_required}
                  </span>
                </div>
                {/* Vote buttons */}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleVote(approval, 'approve')}
                    className="flex-1 py-2 rounded-lg bg-green/15 text-green text-sm font-semibold active:bg-green/25 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleVote(approval, 'deny')}
                    className="flex-1 py-2 rounded-lg bg-red/15 text-red text-sm font-semibold active:bg-red/25 transition-colors"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Kill switch */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-2">
          Kill Switch
        </h2>
        <button
          onClick={handleKillSwitch}
          className={`w-full py-3 rounded-lg text-sm font-bold font-mono transition-colors ${
            isFrozen
              ? 'bg-green/15 text-green active:bg-green/25'
              : 'bg-red/15 text-red active:bg-red/25'
          }`}
        >
          {isFrozen ? 'UNFREEZE NETWORK' : 'FREEZE NETWORK'}
        </button>
      </section>

      {/* Quick directive */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-2">
          Send Directive
        </h2>
        <div className="flex flex-col gap-2 p-3 rounded-lg bg-surface border border-border">
          <select
            value={directiveAgent}
            onChange={(e) => setDirectiveAgent(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm text-text"
          >
            <option value="">Select agent...</option>
            {onlineAgents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          <textarea
            value={directiveText}
            onChange={(e) => setDirectiveText(e.target.value)}
            placeholder="Directive content..."
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm text-text resize-none"
          />
          <button
            onClick={handleDirective}
            disabled={!directiveAgent || !directiveText.trim() || sending}
            className="w-full py-2 rounded-lg bg-accent/15 text-accent text-sm font-semibold disabled:opacity-40 active:bg-accent/25 transition-colors"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>
      </section>

      {/* Events feed */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-2">
          Recent Events
        </h2>
        <div className="flex flex-col gap-0.5">
          {recentEvents.map((event) => (
            <div
              key={event.id}
              className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-surface-raised/50"
            >
              <span className="text-[10px] text-text-muted font-mono w-8 shrink-0 pt-0.5">
                {timeAgo(event.created_at)}
              </span>
              <span className={`text-[10px] font-mono shrink-0 pt-0.5 ${eventTypeColors[event.type] || 'text-text-muted'}`}>
                {event.type.replace(/_/g, ' ')}
              </span>
              <span className="text-xs text-text-dim leading-snug flex-1 min-w-0 truncate">
                {event.summary}
              </span>
            </div>
          ))}
          {recentEvents.length === 0 && (
            <span className="text-xs text-text-muted py-2">No recent events</span>
          )}
        </div>
      </section>

      {/* Push notifications toggle */}
      <section>
        <h2 className="text-[10px] uppercase tracking-widest font-semibold text-text-muted mb-2">
          Notifications
        </h2>
        <div className="p-3 rounded-lg bg-surface border border-border">
          {pushStatus === 'unsupported' && (
            <p className="text-xs text-text-muted">
              Push notifications not supported. Add to Home Screen on iOS for push support.
            </p>
          )}
          {pushStatus === 'denied' && (
            <p className="text-xs text-red">
              Notifications blocked. Enable in browser/system settings.
            </p>
          )}
          {pushStatus === 'prompt' && (
            <button
              onClick={pushSubscribe}
              className="w-full py-2 rounded-lg bg-accent/15 text-accent text-sm font-semibold active:bg-accent/25 transition-colors"
            >
              Enable Push Notifications
            </button>
          )}
          {pushStatus === 'subscribed' && (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green" />
                <span className="text-xs text-text-dim">Push notifications active</span>
              </div>
              <button
                onClick={pushUnsubscribe}
                className="text-[10px] text-text-muted hover:text-red font-mono"
              >
                Disable
              </button>
            </div>
          )}
          {pushStatus === 'loading' && (
            <span className="text-xs text-text-muted">Checking...</span>
          )}
        </div>
      </section>

      {/* iOS install prompt */}
      {typeof navigator !== 'undefined' &&
        /iPhone|iPad/.test(navigator.userAgent) &&
        !window.matchMedia('(display-mode: standalone)').matches && (
        <section className="p-3 rounded-lg bg-accent/10 border border-accent/20">
          <p className="text-xs text-accent">
            For push notifications on iOS, tap the share button and "Add to Home Screen" to install Mycelium as an app.
          </p>
        </section>
      )}
    </div>
  )
}
