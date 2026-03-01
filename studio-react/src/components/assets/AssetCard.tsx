import { useRef } from 'react'
import type { Asset } from '../../api/types'
import Badge from '../shared/Badge'

interface AssetCardProps {
  asset: Asset
  onUpload: (id: string, file: File) => void
  onDelete: (id: string) => void
  onStatusChange: (id: string, status: string) => void
  onClick?: (asset: Asset) => void
}

const statusStrip: Record<string, string> = {
  requested: 'bg-accent',
  in_progress: 'bg-blue',
  completed: 'bg-green',
  cancelled: 'bg-text-muted',
}

const statusBadgeVariant: Record<string, 'accent' | 'blue' | 'green' | 'muted'> = {
  requested: 'accent',
  in_progress: 'blue',
  completed: 'green',
  cancelled: 'muted',
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function AssetCard({ asset, onUpload, onDelete, onStatusChange, onClick }: AssetCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      onUpload(asset.id, file)
      e.target.value = ''
    }
  }

  function handleDelete() {
    if (window.confirm(`Delete asset "${asset.name}"? This cannot be undone.`)) {
      onDelete(asset.id)
    }
  }

  return (
    <div
      className="bg-surface-raised rounded-lg overflow-hidden flex flex-col cursor-pointer hover:ring-1 hover:ring-border transition-all"
      onClick={() => onClick?.(asset)}
    >
      {/* Status strip */}
      <div className={`h-1 w-full ${statusStrip[asset.status] || 'bg-text-muted'}`} />

      <div className="p-4 flex flex-col gap-2.5 flex-1">
        {/* Name + type */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-text text-sm leading-tight truncate">{asset.name}</h3>
          <Badge variant={statusBadgeVariant[asset.status] || 'muted'} className="shrink-0">
            {asset.type}
          </Badge>
        </div>

        {/* Prompt */}
        {asset.prompt && (
          <p className="text-text-dim text-sm leading-relaxed line-clamp-3">{asset.prompt}</p>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-text-muted mt-auto">
          {asset.game && (
            <Badge variant="default">{asset.game}</Badge>
          )}
          <span>by {asset.requested_by}</span>
        </div>

        {/* Assigned to */}
        {asset.assigned_to && (
          <p className="text-xs text-blue">
            Assigned to {asset.assigned_to}
          </p>
        )}

        {/* Timestamps */}
        <div className="text-xs text-text-muted flex items-center gap-3">
          <span title="Created">{formatDate(asset.created_at)}</span>
          {asset.updated_at !== asset.created_at && (
            <span title="Updated">upd. {formatDate(asset.updated_at)}</span>
          )}
        </div>

        {/* Actions */}
        <div
          className="flex items-center gap-2 pt-1 border-t border-border mt-1"
          onClick={(e) => e.stopPropagation()}
        >
          {asset.status === 'requested' && (
            <button
              onClick={() => onStatusChange(asset.id, 'in_progress')}
              className="px-2.5 py-1 rounded-sm text-xs font-medium bg-blue/10 text-blue hover:bg-blue/20 transition-colors"
            >
              Assign
            </button>
          )}

          {asset.status === 'in_progress' && (
            <>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1 rounded-sm text-xs font-medium bg-green/10 text-green hover:bg-green/20 transition-colors"
              >
                Upload
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
              />
              <button
                onClick={() => onStatusChange(asset.id, 'cancelled')}
                className="px-2.5 py-1 rounded-sm text-xs font-medium bg-surface text-text-muted hover:text-text-dim transition-colors"
              >
                Cancel
              </button>
            </>
          )}

          {asset.status === 'completed' && asset.download_url && (
            <a
              href={asset.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 rounded-sm text-xs font-medium bg-green/10 text-green hover:bg-green/20 transition-colors"
            >
              Download
            </a>
          )}

          <button
            onClick={handleDelete}
            className="ml-auto px-2 py-1 rounded-sm text-xs text-red hover:bg-red/10 transition-colors"
            title="Delete asset"
          >
            &times;
          </button>
        </div>
      </div>
    </div>
  )
}
