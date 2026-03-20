import { useState, useEffect, useCallback } from 'react'
import { apiGet, apiPost, getToken } from '../api/client'
import { toast } from 'sonner'

interface FileEntry {
  name: string
  type: 'file' | 'directory' | 'unknown'
  size: number
  modified: number
  ext?: string
  error?: string
}

interface BrowseResult {
  entries: FileEntry[]
  total: number
  path: string
  error?: string
}

interface SearchResult {
  results: (FileEntry & { path: string })[]
  query: string
  truncated?: boolean
  error?: string
}

interface DroneStatus {
  online: boolean
  drone_id?: string
  info?: {
    root_dir?: string
    disk?: { free_gb: number; total_gb: number; used_gb: number }
    os?: string
    version?: string
  }
  message?: string
}

function formatSize(bytes: number): string {
  if (!bytes) return '—'
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

function formatDate(ts: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function fileIcon(entry: FileEntry): string {
  if (entry.type === 'directory') return '\uD83D\uDCC1'
  const ext = entry.ext || ''
  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico'].includes(ext)) return '\uD83D\uDDBC\uFE0F'
  if (['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv'].includes(ext)) return '\uD83C\uDFA5'
  if (['.mp3', '.wav', '.flac', '.ogg', '.aac', '.m4a'].includes(ext)) return '\uD83C\uDFB5'
  if (['.pdf'].includes(ext)) return '\uD83D\uDCC4'
  if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(ext)) return '\uD83D\uDCE6'
  if (['.doc', '.docx', '.txt', '.rtf', '.md'].includes(ext)) return '\uD83D\uDCDD'
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return '\uD83D\uDCCA'
  if (['.ppt', '.pptx'].includes(ext)) return '\uD83D\uDCCA'
  if (['.gd', '.tscn', '.tres', '.godot'].includes(ext)) return '\uD83C\uDFAE'
  return '\uD83D\uDCC4'
}

export default function FileBrowserPage() {
  const [status, setStatus] = useState<DroneStatus | null>(null)
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<(FileEntry & { path: string })[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [totalEntries, setTotalEntries] = useState(0)

  const fetchStatus = useCallback(async () => {
    try {
      const s = await apiGet<DroneStatus>('/file-server/status')
      setStatus(s)
    } catch {
      setStatus({ online: false, message: 'Failed to check status' })
    }
  }, [])

  const browse = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    setSearchResults(null)
    try {
      const result = await apiPost<BrowseResult>('/file-server/browse', { path })
      if (result.error) {
        setError(result.error)
        setEntries([])
      } else {
        setEntries(result.entries || [])
        setTotalEntries(result.total || 0)
        setCurrentPath(result.path || path)
      }
    } catch (err: any) {
      setError(err.message || 'Failed to browse')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    browse('/')
  }, [fetchStatus, browse])

  function navigateTo(path: string) {
    setCurrentPath(path)
    browse(path)
  }

  function navigateToFolder(name: string) {
    const newPath = currentPath === '/' ? '/' + name : currentPath + '/' + name
    navigateTo(newPath)
  }

  function navigateUp() {
    if (currentPath === '/') return
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    navigateTo('/' + parts.join('/'))
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault()
    if (!searchQuery.trim()) {
      setSearchResults(null)
      return
    }
    setSearching(true)
    try {
      const result = await apiPost<SearchResult>('/file-server/search', {
        query: searchQuery.trim(),
        path: currentPath,
      })
      if (result.error) {
        toast.error(result.error)
      } else {
        setSearchResults(result.results || [])
        if (result.truncated) toast.info('Results truncated (500 max)')
      }
    } catch (err: any) {
      toast.error(err.message || 'Search failed')
    } finally {
      setSearching(false)
    }
  }

  function clearSearch() {
    setSearchQuery('')
    setSearchResults(null)
  }

  function triggerDownload(url: string, fileName: string) {
    const token = getToken()
    fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (!res.ok) {
          // Try to extract the actual error message from the JSON response
          try {
            const body = await res.json()
            throw new Error(body.error || `Download failed (${res.status})`)
          } catch (e) {
            if (e instanceof SyntaxError) throw new Error(`Download failed (${res.status})`)
            throw e
          }
        }
        return res.blob()
      })
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = blobUrl
        link.download = fileName
        link.click()
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000)
      })
      .catch((err) => toast.error(err.message))
  }

  function downloadFile(path: string) {
    if (!status?.online) { toast.error('File drone is offline'); return }
    const url = `/api/mycelium/file-server/download?path=${encodeURIComponent(path)}`
    const fileName = path.split('/').pop() || 'download'
    triggerDownload(url, fileName)
  }

  function downloadFolder(path: string) {
    if (!status?.online) { toast.error('File drone is offline'); return }
    const url = `/api/mycelium/file-server/download-folder?path=${encodeURIComponent(path)}`
    const folderName = (path.split('/').pop() || 'folder') + '.zip'
    toast.info('Zipping folder — this may take a moment for large folders...')
    triggerDownload(url, folderName)
  }

  // Build breadcrumb segments
  const pathSegments = currentPath.split('/').filter(Boolean)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text">File Browser</h1>
          {status?.online ? (
            <p className="text-sm text-text-dim">
              <span className="inline-block w-2 h-2 rounded-full bg-green mr-1.5" />
              {status.drone_id}
              {status.info?.root_dir && <span className="ml-2 text-text-muted">{status.info.root_dir}</span>}
              {status.info?.disk && (
                <span className="ml-2 text-text-muted">
                  {status.info.disk.free_gb} GB free / {status.info.disk.total_gb} GB
                </span>
              )}
            </p>
          ) : (
            <p className="text-sm text-red">
              <span className="inline-block w-2 h-2 rounded-full bg-red mr-1.5" />
              File drone offline
            </p>
          )}
        </div>

        {/* Search */}
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files... (e.g. *.pdf)"
            className="px-3 py-1.5 rounded-md bg-surface border border-border text-text text-sm w-56 focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            disabled={searching || !searchQuery.trim()}
            className="px-3 py-1.5 rounded-md bg-accent text-bg text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
          >
            {searching ? '...' : 'Search'}
          </button>
          {searchResults !== null && (
            <button
              type="button"
              onClick={clearSearch}
              className="px-3 py-1.5 rounded-md bg-surface border border-border text-text-dim text-sm hover:text-text"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-text-dim bg-surface/50 px-3 py-2 rounded-md border border-border/50">
        <button
          onClick={() => navigateTo('/')}
          className="hover:text-accent font-medium"
        >
          Root
        </button>
        {pathSegments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-text-muted">/</span>
            <button
              onClick={() => navigateTo('/' + pathSegments.slice(0, i + 1).join('/'))}
              className="hover:text-accent"
            >
              {seg}
            </button>
          </span>
        ))}
        {currentPath !== '/' && (
          <button
            onClick={navigateUp}
            className="ml-auto text-text-muted hover:text-accent text-xs"
          >
            Up
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-3 rounded-md bg-red/10 border border-red/30 text-red text-sm">
          {error}
        </div>
      )}

      {/* Search Results */}
      {searchResults !== null ? (
        <div className="space-y-1">
          <p className="text-sm text-text-dim mb-2">
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for "{searchQuery}" in {currentPath}
          </p>
          {searchResults.length === 0 ? (
            <p className="text-text-muted text-sm py-8 text-center">No files found.</p>
          ) : (
            <div className="border border-border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-surface/80">
                  <tr className="text-text-dim text-left">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium w-28">Size</th>
                    <th className="px-3 py-2 font-medium w-40 hidden sm:table-cell">Modified</th>
                    <th className="px-3 py-2 font-medium w-20">Path</th>
                    <th className="px-3 py-2 w-10" />
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((entry, i) => (
                    <tr key={i} className="border-t border-border/50 hover:bg-surface/40">
                      <td className="px-3 py-2 text-text">
                        <span className="mr-2">{fileIcon(entry)}</span>
                        {entry.name}
                      </td>
                      <td className="px-3 py-2 text-text-dim">{formatSize(entry.size)}</td>
                      <td className="px-3 py-2 text-text-muted hidden sm:table-cell">{formatDate(entry.modified)}</td>
                      <td className="px-3 py-2 text-text-muted text-xs truncate max-w-[200px]" title={entry.path}>{entry.path}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => downloadFile(entry.path)}
                          className="text-accent hover:text-accent/80 text-xs"
                          title="Download"
                        >
                          DL
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : loading ? (
        <div className="text-text-muted text-sm py-12 text-center">Loading...</div>
      ) : (
        /* Directory Listing */
        <div className="border border-border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-surface/80">
              <tr className="text-text-dim text-left">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium w-28">Size</th>
                <th className="px-3 py-2 font-medium w-44 hidden sm:table-cell">Modified</th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody>
              {currentPath !== '/' && (
                <tr
                  className="border-t border-border/50 hover:bg-surface/40 cursor-pointer"
                  onClick={navigateUp}
                >
                  <td className="px-3 py-2 text-text-dim" colSpan={4}>
                    <span className="mr-2">{'\uD83D\uDCC1'}</span> ..
                  </td>
                </tr>
              )}
              {entries.length === 0 && !error && (
                <tr>
                  <td className="px-3 py-8 text-center text-text-muted" colSpan={4}>
                    Empty directory
                  </td>
                </tr>
              )}
              {entries.map((entry, i) => (
                <tr
                  key={i}
                  className={`border-t border-border/50 hover:bg-surface/40 ${entry.type === 'directory' ? 'cursor-pointer' : ''}`}
                  onClick={entry.type === 'directory' ? () => navigateToFolder(entry.name) : undefined}
                >
                  <td className="px-3 py-2 text-text">
                    <span className="mr-2">{fileIcon(entry)}</span>
                    <span className={entry.type === 'directory' ? 'font-medium' : ''}>
                      {entry.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-text-dim">
                    {entry.type === 'directory' ? '—' : formatSize(entry.size)}
                  </td>
                  <td className="px-3 py-2 text-text-muted hidden sm:table-cell">
                    {formatDate(entry.modified)}
                  </td>
                  <td className="px-3 py-2">
                    {entry.type === 'file' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const filePath = currentPath === '/'
                            ? '/' + entry.name
                            : currentPath + '/' + entry.name
                          downloadFile(filePath)
                        }}
                        className="text-accent hover:text-accent/80 text-xs"
                        title="Download file"
                      >
                        DL
                      </button>
                    ) : entry.type === 'directory' ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const folderPath = currentPath === '/'
                            ? '/' + entry.name
                            : currentPath + '/' + entry.name
                          downloadFolder(folderPath)
                        }}
                        className="text-teal hover:text-teal/80 text-xs"
                        title="Download as ZIP"
                      >
                        ZIP
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {totalEntries > entries.length && (
            <div className="px-3 py-2 text-xs text-text-muted border-t border-border/50 bg-surface/30">
              Showing {entries.length} of {totalEntries} entries
            </div>
          )}
        </div>
      )}
    </div>
  )
}
