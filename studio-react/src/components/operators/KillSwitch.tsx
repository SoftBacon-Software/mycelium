import { useState, useCallback } from 'react'
import { killSwitch } from '../../api/endpoints'
import { useDashboardStore } from '../../stores/dashboardStore'

export default function KillSwitch() {
  const instanceConfig = useDashboardStore((s) => s.instanceConfig)
  const refresh = useDashboardStore((s) => s.refresh)

  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const adminStatus = instanceConfig.find((c) => c.key === 'admin_status')
  const isFrozen = adminStatus?.value === 'frozen'

  const handleAction = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      await killSwitch(isFrozen ? 'unfreeze' : 'freeze')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kill switch action failed')
    } finally {
      setLoading(false)
      setConfirming(false)
    }
  }, [isFrozen, refresh])

  return (
    <div
      className={`rounded-lg p-6 transition-all duration-300 ${
        isFrozen
          ? 'bg-surface-raised border-2 border-red shadow-[0_0_30px_rgba(196,91,62,0.15)]'
          : 'bg-surface-raised border border-border'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-text">Emergency Kill Switch</h3>
        {isFrozen && (
          <span className="text-red font-bold text-lg tracking-wide animate-pulse">
            SYSTEM FROZEN
          </span>
        )}
      </div>

      <p className="text-text-dim text-sm mb-6">
        {isFrozen
          ? 'All automated agent operations are currently suspended. Agents will not process tasks or respond to requests until unfrozen.'
          : 'Freeze all automated agent operations. This will immediately halt all agent activity across the entire instance.'}
      </p>

      {/* Error */}
      {error && (
        <div className="mb-4 px-3 py-2 rounded-sm bg-red/10 border border-red/20 text-red text-sm">
          {error}
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirming ? (
        <div className="flex items-center gap-3 p-4 rounded bg-surface border border-border">
          <span className="text-text text-sm font-medium flex-1">
            {isFrozen
              ? 'Resume all agent operations?'
              : 'Freeze all agent operations? This will immediately stop all automated activity.'}
          </span>
          <button
            onClick={handleAction}
            disabled={loading}
            className={`px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isFrozen
                ? 'bg-green text-bg hover:bg-green/90'
                : 'bg-red text-text hover:bg-red/90'
            }`}
          >
            {loading
              ? isFrozen ? 'Unfreezing...' : 'Freezing...'
              : 'Yes, Confirm'}
          </button>
          <button
            onClick={() => setConfirming(false)}
            disabled={loading}
            className="px-4 py-2 rounded text-sm text-text-dim hover:text-text hover:bg-surface-raised transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className={`px-5 py-2.5 rounded font-semibold text-sm transition-colors ${
            isFrozen
              ? 'bg-green text-bg hover:bg-green/90'
              : 'bg-red text-text hover:bg-red/90'
          }`}
        >
          {isFrozen ? 'Unfreeze Operations' : 'Freeze All Operations'}
        </button>
      )}
    </div>
  )
}
