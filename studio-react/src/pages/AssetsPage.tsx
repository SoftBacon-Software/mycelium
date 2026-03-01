import { useState, useMemo, useRef, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { updateAsset, deleteAsset, uploadAsset } from '../api/endpoints'
import type { Asset } from '../api/types'
import AssetCard from '../components/assets/AssetCard'
import Badge from '../components/shared/Badge'

type ViewMode = 'grid' | 'list'
type StatusFilter = 'all' | 'requested' | 'in_progress' | 'completed' | 'cancelled'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'requested', label: 'Requested' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const statusBadgeVariant: Record<string, 'accent' | 'blue' | 'green' | 'muted' | 'default'> = {
  requested: 'accent',
  in_progress: 'blue',
  completed: 'green',
  cancelled: 'muted',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// ─── Detail Modal ────────────────────────────────────────────────────────────

interface AssetDetailModalProps {
  asset: Asset
  onClose: () => void
  onUpload: (id: string, file: File) => void
  onDelete: (id: string) => void
  onStatusChange: (id: string, status: string) => void
}

function AssetDetailModal({ asset, onClose, onUpload, onDelete, onStatusChange }: AssetDetailModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      onUpload(asset.id, file)
      e.target.value = ''
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) onUpload(asset.id, file)
  }

  function handleDelete() {
    if (window.confirm(`Delete asset "${asset.name}"? This cannot be undone.`)) {
      onDelete(asset.id)
      onClose()
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-lg border border-border shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold text-text">{asset.name}</h2>
            <p className="text-text-muted text-xs mt-1">ID: {asset.id}</p>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors p-1 -m-1 text-lg font-mono"
            aria-label="Close modal"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Status + Type row */}
          <div className="flex items-center gap-3">
            <label className="text-text-muted text-xs uppercase tracking-wider w-20 shrink-0">Status</label>
            <select
              value={asset.status}
              onChange={(e) => onStatusChange(asset.id, e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2.5 py-1.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="requested">Requested</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <Badge variant={statusBadgeVariant[asset.status] || 'default'}>{asset.type}</Badge>
          </div>

          {/* Game + Requested by */}
          <div className="flex items-center gap-3">
            <label className="text-text-muted text-xs uppercase tracking-wider w-20 shrink-0">Game</label>
            <span className="text-text-dim text-sm">{asset.game || '--'}</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-text-muted text-xs uppercase tracking-wider w-20 shrink-0">Requested</label>
            <span className="text-text-dim text-sm">{asset.requested_by}</span>
          </div>
          {asset.assigned_to && (
            <div className="flex items-center gap-3">
              <label className="text-text-muted text-xs uppercase tracking-wider w-20 shrink-0">Assigned</label>
              <span className="text-blue text-sm">{asset.assigned_to}</span>
            </div>
          )}

          {/* Prompt */}
          <div>
            <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">Prompt</label>
            <p className="text-text text-sm leading-relaxed bg-surface-raised rounded-sm p-3 whitespace-pre-wrap">
              {asset.prompt || 'No prompt provided'}
            </p>
          </div>

          {/* File path */}
          {asset.file_path && (
            <div className="flex items-center gap-3">
              <label className="text-text-muted text-xs uppercase tracking-wider w-20 shrink-0">File</label>
              <span className="text-text-dim text-sm font-mono truncate">{asset.file_path}</span>
            </div>
          )}

          {/* Upload area */}
          <div
            className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
              dragging ? 'border-accent bg-accent/5' : 'border-border hover:border-text-muted'
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <p className="text-text-dim text-sm mb-2">
              Drag & drop a file here, or{' '}
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-accent underline underline-offset-2 hover:text-accent-light transition-colors"
              >
                browse
              </button>
            </p>
            <p className="text-text-muted text-xs">Uploads directly to the asset pipeline</p>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Download link */}
          {asset.download_url && (
            <a
              href={asset.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-sm font-medium bg-green/10 text-green hover:bg-green/20 transition-colors"
            >
              Download file
            </a>
          )}

          {/* Timestamps */}
          <div className="flex items-center gap-4 text-xs text-text-muted pt-2 border-t border-border">
            <span>Created {formatDate(asset.created_at)}</span>
            {asset.updated_at !== asset.created_at && (
              <span>Updated {formatDate(asset.updated_at)}</span>
            )}
          </div>

          {/* Metadata */}
          {asset.metadata && Object.keys(asset.metadata).length > 0 && (
            <div>
              <label className="text-text-muted text-xs uppercase tracking-wider block mb-1.5">Metadata</label>
              <pre className="text-text-dim text-xs bg-surface-raised rounded-sm p-3 overflow-x-auto font-mono">
                {JSON.stringify(asset.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-5 border-t border-border">
          <button
            onClick={handleDelete}
            className="px-3 py-1.5 rounded-sm text-sm text-red hover:bg-red/10 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-sm text-sm text-text-dim bg-surface-raised hover:bg-surface-raised/80 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function AssetsPage() {
  const assets = useDashboardStore((s) => s.assets)
  const refresh = useDashboardStore((s) => s.refresh)

  const [view, setView] = useState<ViewMode>('grid')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [gameFilter, setGameFilter] = useState<string>('all')
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null)

  // Unique game values
  const games = useMemo(() => {
    const set = new Set(assets.map((a) => a.game).filter(Boolean))
    return Array.from(set).sort()
  }, [assets])

  // Filtered assets
  const filtered = useMemo(() => {
    let result = assets
    if (statusFilter !== 'all') {
      result = result.filter((a) => a.status === statusFilter)
    }
    if (gameFilter !== 'all') {
      result = result.filter((a) => a.game === gameFilter)
    }
    return result.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  }, [assets, statusFilter, gameFilter])

  // Action handlers
  const handleUpload = useCallback(async (id: string, file: File) => {
    try {
      await uploadAsset(id, file)
      refresh()
    } catch (err) {
      console.error('Upload failed:', err)
    }
  }, [refresh])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteAsset(id)
      setSelectedAsset(null)
      refresh()
    } catch (err) {
      console.error('Delete failed:', err)
    }
  }, [refresh])

  const handleStatusChange = useCallback(async (id: string, status: string) => {
    try {
      await updateAsset(id, { status })
      refresh()
    } catch (err) {
      console.error('Status update failed:', err)
    }
  }, [refresh])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-text">Assets</h2>
          <span className="text-text-muted text-sm">({filtered.length})</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* View toggle */}
          <div className="flex rounded-sm overflow-hidden border border-border">
            <button
              onClick={() => setView('grid')}
              className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                view === 'grid' ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text-dim'
              }`}
            >
              Grid
            </button>
            <button
              onClick={() => setView('list')}
              className={`px-2.5 py-1 text-xs font-mono transition-colors ${
                view === 'list' ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text-dim'
              }`}
            >
              List
            </button>
          </div>

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="bg-surface-raised border border-border rounded-sm px-2.5 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          {/* Game filter */}
          {games.length > 0 && (
            <select
              value={gameFilter}
              onChange={(e) => setGameFilter(e.target.value)}
              className="bg-surface-raised border border-border rounded-sm px-2.5 py-1 text-xs text-text-dim focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All Games</option>
              {games.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* Empty state */}
      {filtered.length === 0 && (
        <div className="bg-surface rounded-lg p-12 text-center">
          <p className="text-text-muted text-sm">No assets match the current filters.</p>
        </div>
      )}

      {/* Grid View */}
      {view === 'grid' && filtered.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              onUpload={handleUpload}
              onDelete={handleDelete}
              onStatusChange={handleStatusChange}
              onClick={setSelectedAsset}
            />
          ))}
        </div>
      )}

      {/* List View */}
      {view === 'list' && filtered.length > 0 && (
        <div className="bg-surface rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Type</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Game</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Requested By</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Assigned To</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Created</th>
                <th className="px-4 py-3 text-xs font-medium text-text-muted uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((asset) => (
                <tr
                  key={asset.id}
                  className="hover:bg-surface-raised/50 cursor-pointer transition-colors"
                  onClick={() => setSelectedAsset(asset)}
                >
                  <td className="px-4 py-3">
                    <Badge variant={statusBadgeVariant[asset.status] || 'default'}>
                      {asset.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-text font-medium truncate max-w-[200px]">{asset.name}</td>
                  <td className="px-4 py-3 text-text-dim">{asset.type}</td>
                  <td className="px-4 py-3 text-text-dim">{asset.game || '--'}</td>
                  <td className="px-4 py-3 text-text-dim">{asset.requested_by}</td>
                  <td className="px-4 py-3 text-blue">{asset.assigned_to || '--'}</td>
                  <td className="px-4 py-3 text-text-muted text-xs">{formatDate(asset.created_at)}</td>
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                      {asset.status === 'requested' && (
                        <button
                          onClick={() => handleStatusChange(asset.id, 'in_progress')}
                          className="px-2 py-0.5 rounded-sm text-xs text-blue hover:bg-blue/10 transition-colors"
                        >
                          Assign
                        </button>
                      )}
                      {asset.status === 'completed' && asset.download_url && (
                        <a
                          href={asset.download_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2 py-0.5 rounded-sm text-xs text-green hover:bg-green/10 transition-colors"
                        >
                          DL
                        </a>
                      )}
                      <button
                        onClick={() => {
                          if (window.confirm(`Delete "${asset.name}"?`)) handleDelete(asset.id)
                        }}
                        className="px-2 py-0.5 rounded-sm text-xs text-red hover:bg-red/10 transition-colors"
                        title="Delete"
                      >
                        &times;
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Modal */}
      {selectedAsset && (
        <AssetDetailModal
          asset={selectedAsset}
          onClose={() => setSelectedAsset(null)}
          onUpload={handleUpload}
          onDelete={handleDelete}
          onStatusChange={handleStatusChange}
        />
      )}
    </div>
  )
}
