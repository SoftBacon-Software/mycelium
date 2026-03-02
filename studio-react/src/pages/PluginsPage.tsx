import { useEffect, useState } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import { enablePlugin, disablePlugin } from '../api/endpoints'
import { toast } from 'sonner'

export default function PluginsPage() {
  const { plugins, loading, refresh } = useDashboardStore()
  const [toggling, setToggling] = useState<string | null>(null)

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleToggle = async (name: string, currentEnabled: number) => {
    setToggling(name)
    try {
      if (currentEnabled) {
        await disablePlugin(name)
        toast.success(`Disabled plugin: ${name}`)
      } else {
        await enablePlugin(name)
        toast.success(`Enabled plugin: ${name} (restart required)`)
      }
      refresh()
    } catch (err) {
      toast.error(`Failed to toggle plugin: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setToggling(null)
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-text">Plugins</h1>
          <span className="bg-surface-raised text-text-muted text-xs font-mono px-2 py-0.5 rounded-full">
            {plugins.length}
          </span>
          <button
            type="button"
            onClick={() => refresh()}
            disabled={loading}
            className="text-xs text-text-muted hover:text-accent transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {plugins.length === 0 && !loading && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-text-muted text-sm">No plugins installed</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 overflow-y-auto pb-2">
        {plugins.map((plugin) => (
          <div
            key={plugin.name}
            className={`bg-surface border rounded-lg p-5 flex flex-col gap-3 transition-colors ${
              plugin.enabled ? 'border-border' : 'border-border/50 opacity-60'
            }`}
          >
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold text-text truncate">
                    {plugin.display_name || plugin.name}
                  </h3>
                  <span className="text-[10px] font-mono text-text-muted bg-surface-raised px-1.5 py-0.5 rounded">
                    v{plugin.version}
                  </span>
                </div>
                {plugin.author && (
                  <p className="text-[11px] text-text-muted mt-0.5">by {plugin.author}</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => handleToggle(plugin.name, plugin.enabled)}
                disabled={toggling === plugin.name}
                className={`shrink-0 w-10 h-5 rounded-full transition-colors relative ${
                  plugin.enabled ? 'bg-green' : 'bg-surface-raised'
                } ${toggling === plugin.name ? 'opacity-50' : 'cursor-pointer'}`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-text transition-transform ${
                    plugin.enabled ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>

            {plugin.description && (
              <p className="text-xs text-text-dim leading-relaxed">{plugin.description}</p>
            )}

            <div className="flex items-center gap-3 text-[11px] text-text-muted mt-auto pt-2 border-t border-border/50">
              {plugin.route_prefix && (
                <span className="font-mono bg-surface-raised px-1.5 py-0.5 rounded">
                  {plugin.route_prefix}
                </span>
              )}
              {plugin.mcp_tool_count > 0 && (
                <span>{plugin.mcp_tool_count} MCP tools</span>
              )}
              <span className={plugin.enabled ? 'text-green' : 'text-text-muted'}>
                {plugin.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
