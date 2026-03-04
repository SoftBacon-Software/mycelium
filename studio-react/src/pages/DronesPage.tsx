import { useEffect, useState, useMemo, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { cancelDroneJob, createDroneJob } from '../api/endpoints'
import { timeAgo } from '../utils/time'
import type { DroneJob } from '../api/types'
import ModalOverlay from '../components/modals/ModalOverlay'
import { toast } from 'sonner'

const statusColors: Record<string, string> = {
  pending: 'bg-yellow/20 text-yellow',
  claimed: 'bg-blue/20 text-blue',
  done: 'bg-green/20 text-green',
  failed: 'bg-red/20 text-red',
  cancelled: 'bg-text-muted/20 text-text-muted',
}

const statusDot: Record<string, string> = {
  online: 'bg-green',
  offline: 'bg-text-muted',
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  return Math.round(bytes / 1024) + ' KB'
}

// ─── Create Job Modal ─────────────────────────────────────────────────────────

function CreateJobModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const refresh = useDashboardStore((s) => s.refresh)
  const [title, setTitle] = useState('')
  const [command, setCommand] = useState('')
  const [requires, setRequires] = useState('')
  const [priority, setPriority] = useState(5)
  const [inputData, setInputData] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetAndClose() {
    setTitle(''); setCommand(''); setRequires(''); setPriority(5); setInputData(''); setError(null)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !command.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await createDroneJob({
        title: title.trim(),
        command: command.trim(),
        requires: requires.trim() || 'gpu',
        priority,
        input_data: inputData.trim() || '{}',
      })
      toast.success('Drone job queued')
      await refresh()
      resetAndClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={resetAndClose} title="Queue Drone Job">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Generate trailer thumbnails"
            autoFocus
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Command</label>
          <textarea
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="generate_thumbnails --input video.mp4 --count 5"
            rows={2}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none disabled:opacity-50"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Requires</label>
            <input
              type="text"
              value={requires}
              onChange={(e) => setRequires(e.target.value)}
              placeholder="gpu"
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Priority (1-10)</label>
            <input
              type="number"
              min={1}
              max={10}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">
            Input Data <span className="text-text-muted">(JSON, optional)</span>
          </label>
          <textarea
            value={inputData}
            onChange={(e) => setInputData(e.target.value)}
            placeholder='{"source": "video.mp4"}'
            rows={3}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text font-mono placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none disabled:opacity-50"
          />
        </div>

        {error && <p className="text-red text-xs">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={resetAndClose} className="px-4 py-2 rounded text-sm text-text-dim hover:text-text transition-colors">
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !title.trim() || !command.trim()}
            className="px-5 py-2 rounded text-sm font-semibold bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Queuing...' : 'Queue Job'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

type TabId = 'jobs' | 'drones' | 'artifacts'

export default function DronesPage() {
  const { drones, droneJobs, refresh } = useDashboardStore()
  const [activeTab, setActiveTab] = useState<TabId>('jobs')
  const [selectedJob, setSelectedJob] = useState<DroneJob | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [artifacts, setArtifacts] = useState<{ name: string; size: number; uploaded: string; url: string }[]>([])

  const [actionLoading, setActionLoading] = useState<number | null>(null)
  const [showCreateJob, setShowCreateJob] = useState(false)

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleCancel = useCallback(async (jobId: number) => {
    setActionLoading(jobId)
    try {
      await cancelDroneJob(jobId)
      await refresh()
    } catch (err) { console.error('Cancel failed:', err) }
    finally { setActionLoading(null) }
  }, [refresh])

  const handleRetry = useCallback(async (job: DroneJob) => {
    setActionLoading(job.id)
    try {
      await createDroneJob({
        title: job.title,
        command: job.command,
        requires: job.requires,
        priority: job.priority,
        input_data: job.input_data,
      })
      await refresh()
    } catch (err) { console.error('Retry failed:', err) }
    finally { setActionLoading(null) }
  }, [refresh])

  // Fetch artifacts separately (not in overview)
  useEffect(() => {
    if (activeTab === 'artifacts') {
      fetch('/api/mycelium/drones/artifacts', {
        headers: { Authorization: `Bearer ${localStorage.getItem('mycelium_token')}` },
      })
        .then((r) => r.json())
        .then((data) => { if (Array.isArray(data)) setArtifacts(data) })
        .catch(() => {})
    }
  }, [activeTab])

  const filteredJobs = useMemo(() => {
    if (statusFilter === 'all') return droneJobs
    return droneJobs.filter((j) => j.status === statusFilter)
  }, [droneJobs, statusFilter])

  const jobCounts = useMemo(() => {
    const c = { pending: 0, claimed: 0, done: 0, failed: 0, cancelled: 0 }
    droneJobs.forEach((j) => { if (j.status in c) c[j.status as keyof typeof c]++ })
    return c
  }, [droneJobs])

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'jobs', label: 'Job Queue', count: droneJobs.length },
    { id: 'drones', label: 'Workers', count: drones.length },
    { id: 'artifacts', label: 'Artifacts', count: artifacts.length },
  ]

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab bar */}
      <div className="flex items-center gap-1 mb-4 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={[
              'px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px',
              activeTab === tab.id
                ? 'border-accent text-accent'
                : 'border-transparent text-text-dim hover:text-text',
            ].join(' ')}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="ml-1.5 text-xs text-text-muted">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {/* Jobs tab */}
      {activeTab === 'jobs' && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* Status filter pills + create button */}
          <div className="flex items-center gap-2 mb-4">
            <button
              onClick={() => setShowCreateJob(true)}
              className="px-3 py-1 rounded-full text-xs font-medium bg-accent text-bg hover:bg-accent-light transition-colors mr-2"
            >
              + Queue Job
            </button>
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${statusFilter === 'all' ? 'bg-accent text-bg' : 'bg-surface-raised text-text-dim hover:text-text'}`}
            >
              All ({droneJobs.length})
            </button>
            {(['pending', 'claimed', 'done', 'failed'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${statusFilter === s ? 'bg-accent text-bg' : 'bg-surface-raised text-text-dim hover:text-text'}`}
              >
                {s} ({jobCounts[s]})
              </button>
            ))}
          </div>

          {/* Jobs list */}
          <div className="flex-1 overflow-y-auto space-y-2">
            {filteredJobs.length === 0 && (
              <div className="text-center text-text-muted py-12 text-sm">
                No {statusFilter === 'all' ? '' : statusFilter + ' '}jobs
              </div>
            )}
            {filteredJobs.map((job) => (
              <div
                key={job.id}
                onClick={() => setSelectedJob(selectedJob?.id === job.id ? null : job)}
                className="bg-surface rounded-lg p-4 border border-border cursor-pointer hover:bg-surface-raised transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-accent font-mono text-xs font-bold">#{job.id}</span>
                      <h3 className="text-sm font-semibold text-text truncate">{job.title}</h3>
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-text-muted">
                      {job.drone_id && <span>Worker: <span className="text-text-dim">{job.drone_id}</span></span>}
                      <span>Priority: {job.priority}</span>
                      <span>{timeAgo(job.created_at)}</span>
                      {job.started_at && <span>Started {timeAgo(job.started_at)}</span>}
                      {job.completed_at && <span>Completed {timeAgo(job.completed_at)}</span>}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-mono font-semibold shrink-0 ${statusColors[job.status] || ''}`}>
                    {job.status}
                  </span>
                </div>

                {/* Expanded detail */}
                {selectedJob?.id === job.id && (
                  <div className="mt-3 pt-3 border-t border-border space-y-2">
                    <div>
                      <span className="text-xs text-text-muted">Command:</span>
                      <pre className="mt-1 text-xs text-text-dim bg-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-all">
                        {job.command}
                      </pre>
                    </div>
                    {job.input_data && job.input_data !== '{}' && (
                      <div>
                        <span className="text-xs text-text-muted">Input Data:</span>
                        <pre className="mt-1 text-xs text-text-dim bg-bg rounded p-2 overflow-x-auto">
                          {(() => { try { return JSON.stringify(JSON.parse(job.input_data), null, 2) } catch { return job.input_data } })()}
                        </pre>
                      </div>
                    )}
                    {job.error && (
                      <div>
                        <span className="text-xs text-red">Error:</span>
                        <pre className="mt-1 text-xs text-red/80 bg-red/5 rounded p-2 overflow-x-auto whitespace-pre-wrap">
                          {job.error}
                        </pre>
                      </div>
                    )}
                    {job.result_data && job.result_data !== '{}' && (
                      <div>
                        <span className="text-xs text-text-muted">Result:</span>
                        <pre className="mt-1 text-xs text-text-dim bg-bg rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
                          {(() => { try { return JSON.stringify(JSON.parse(job.result_data), null, 2) } catch { return job.result_data } })()}
                        </pre>
                      </div>
                    )}
                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1">
                      {job.status === 'pending' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleCancel(job.id) }}
                          disabled={actionLoading === job.id}
                          className="px-3 py-1 rounded text-xs font-medium bg-red/10 text-red hover:bg-red/20 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === job.id ? '...' : 'Cancel'}
                        </button>
                      )}
                      {job.status === 'failed' && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRetry(job) }}
                          disabled={actionLoading === job.id}
                          className="px-3 py-1 rounded text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === job.id ? '...' : 'Retry'}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Workers tab */}
      {activeTab === 'drones' && (
        <div className="space-y-3">
          {drones.length === 0 && (
            <div className="text-center text-text-muted py-12 text-sm">No drone workers registered</div>
          )}
          {drones.map((drone) => {
            const caps = (() => { try { return JSON.parse(drone.capabilities as unknown as string) } catch { return drone.capabilities } })() as string[]
            return (
              <div key={drone.id} className="bg-surface rounded-lg p-4 border border-border">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot[drone.status] || 'bg-text-muted'}`} />
                      <h3 className="text-sm font-semibold text-text">{drone.name}</h3>
                      <span className="text-xs text-text-muted font-mono">{drone.id}</span>
                    </div>
                    {drone.working_on && (
                      <p className="mt-1 text-xs text-text-dim ml-4">{drone.working_on}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 ml-4">
                      {Array.isArray(caps) && caps.map((cap: string) => (
                        <span key={cap} className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-accent/15 text-accent">
                          {cap}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right text-xs text-text-muted">
                    <div>{drone.status}</div>
                    <div className="mt-0.5">Last seen {timeAgo(drone.last_heartbeat)}</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Artifacts tab */}
      {activeTab === 'artifacts' && (
        <div className="space-y-2">
          {artifacts.length === 0 && (
            <div className="text-center text-text-muted py-12 text-sm">No artifacts uploaded</div>
          )}
          {artifacts.map((a) => (
            <div key={a.name} className="bg-surface rounded-lg p-3 border border-border flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-mono text-text truncate">{a.name}</span>
                <span className="text-xs text-text-muted shrink-0">{formatSize(a.size)}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-xs text-text-muted">{timeAgo(a.uploaded)}</span>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-2.5 py-1 rounded text-xs font-mono text-accent hover:bg-accent/10 transition-colors"
                >
                  Download
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateJob && <CreateJobModal isOpen={showCreateJob} onClose={() => setShowCreateJob(false)} />}
    </div>
  )
}
