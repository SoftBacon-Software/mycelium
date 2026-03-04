import { useEffect, useState, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import {
  enablePlugin, disablePlugin,
  fetchPlugin, fetchPluginConfig, savePluginConfig,
} from '../api/endpoints'
import type { Plugin, PluginConfigField } from '../api/types'
import { toast } from 'sonner'

// ─── Marketplace registry stub ────────────────────────────────────────────────
interface MarketplacePlugin {
  name: string
  display_name: string
  description: string
  author: string
  version: string
  trusted: boolean
  repo_url: string
}

// Static stub — will be replaced by registry.json fetch once the repo is live
const MARKETPLACE_STUBS: MarketplacePlugin[] = [
  {
    name: 'slack-notifier',
    display_name: 'Slack Notifier',
    description: 'Posts agent events to a Slack channel via webhook. Highly configurable — choose which event types get notified.',
    author: 'SoftBacon Software',
    version: '1.0.0',
    trusted: true,
    repo_url: 'https://github.com/SoftBacon-Software/mycelium-plugins',
  },
  {
    name: 'webhook-forwarder',
    display_name: 'Webhook Forwarder',
    description: 'Forwards all platform events to an external HTTP endpoint with HMAC request signing for security.',
    author: 'SoftBacon Software',
    version: '1.0.0',
    trusted: true,
    repo_url: 'https://github.com/SoftBacon-Software/mycelium-plugins',
  },
  {
    name: 'github-integration',
    display_name: 'GitHub Integration',
    description: 'Bridges Mycelium to GitHub. Creates issues from bugs, closes issues on task completion. Adds MCP tools: create/list/close issues.',
    author: 'SoftBacon Software',
    version: '1.0.0',
    trusted: true,
    repo_url: 'https://github.com/SoftBacon-Software/mycelium-plugins',
  },
]

// ─── Config field renderer ────────────────────────────────────────────────────
function ConfigField({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField
  value: string
  onChange: (val: string) => void
}) {
  const id = `cfg-${field.key}`

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start gap-3">
        <input
          id={id}
          type="checkbox"
          checked={value === 'true' || value === '1'}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
          className="mt-0.5 accent-accent"
        />
        <label htmlFor={id} className="flex flex-col gap-0.5 cursor-pointer">
          <span className="text-sm text-text">{field.label}</span>
          {field.description && (
            <span className="text-xs text-text-muted">{field.description}</span>
          )}
        </label>
      </div>
    )
  }

  if (field.type === 'select' && field.options) {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs font-medium text-text-muted">
          {field.label}
          {field.required && <span className="text-red ml-1">*</span>}
        </label>
        {field.description && (
          <p className="text-xs text-text-dim">{field.description}</p>
        )}
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-surface-raised border border-border rounded px-2.5 py-1.5 text-sm text-text focus:outline-none focus:border-accent"
        >
          <option value="">— select —</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'text') {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs font-medium text-text-muted">
          {field.label}
          {field.required && <span className="text-red ml-1">*</span>}
        </label>
        {field.description && (
          <p className="text-xs text-text-dim">{field.description}</p>
        )}
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          className="bg-surface-raised border border-border rounded px-2.5 py-1.5 text-sm text-text font-mono resize-none focus:outline-none focus:border-accent"
          placeholder={field.default ?? ''}
        />
      </div>
    )
  }

  // string | secret | number
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {field.label}
        {field.required && <span className="text-red ml-1">*</span>}
      </label>
      {field.description && (
        <p className="text-xs text-text-dim">{field.description}</p>
      )}
      <input
        id={id}
        type={field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.default ?? (field.type === 'secret' ? '••••••••' : '')}
        className="bg-surface-raised border border-border rounded px-2.5 py-1.5 text-sm text-text font-mono focus:outline-none focus:border-accent"
      />
    </div>
  )
}

// ─── Detail Panel ─────────────────────────────────────────────────────────────
function PluginDetailPanel({
  plugin,
  onClose,
  onToggle,
}: {
  plugin: Plugin
  onClose: () => void
  onToggle: (name: string, enabled: number) => void
}) {
  const [detail, setDetail] = useState<Plugin | null>(null)
  const [localConfig, setLocalConfig] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(true)

  // Load enriched plugin detail + current config
  useEffect(() => {
    let cancelled = false
    setLoadingDetail(true)

    Promise.all([
      fetchPlugin(plugin.name),
      fetchPluginConfig(plugin.name).catch(() => ({})),
    ]).then(([detail, cfg]) => {
      if (cancelled) return
      setDetail(detail)
      // Seed localConfig with defaults from schema, then overwrite with saved values
      const defaults: Record<string, string> = {}
      for (const field of detail.config_schema ?? []) {
        defaults[field.key] = field.default ?? ''
      }
      setLocalConfig({ ...defaults, ...cfg })
    }).catch((err) => {
      if (!cancelled) toast.error('Failed to load plugin details: ' + String(err))
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false)
    })

    return () => { cancelled = true }
  }, [plugin.name])

  // Escape key closes panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSaveConfig = async () => {
    setSaving(true)
    try {
      await savePluginConfig(plugin.name, localConfig)
      toast.success('Config saved')
      // Refresh config — re-fetch to get secrets masked back
      const fresh = await fetchPluginConfig(plugin.name).catch(() => ({}))
      setLocalConfig((prev) => ({ ...prev, ...fresh }))
    } catch (err) {
      toast.error('Failed to save config: ' + String(err))
    } finally {
      setSaving(false)
    }
  }

  const schema = detail?.config_schema ?? []
  const mcpTools = detail?.mcp_tools ?? []
  const hooks = detail?.hooks ?? []
  const gatedActions = detail?.gated_actions ?? []
  const hasConfig = schema.length > 0

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-bg/60 z-40"
        onClick={onClose}
        aria-hidden
      />

      {/* Slide-in panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-xl bg-surface border-l border-border z-50 flex flex-col animate-in slide-in-from-right">
        {/* Header */}
        <div className="flex items-start justify-between p-4 border-b border-border shrink-0">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-text">
                {plugin.display_name || plugin.name}
              </h2>
              <span className="text-[10px] font-mono text-text-muted bg-surface-raised px-1.5 py-0.5 rounded">
                v{plugin.version}
              </span>
              {detail?.type && detail.type !== 'legacy' && (
                <span className="text-[10px] font-mono text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                  {detail.type}
                </span>
              )}
            </div>
            {plugin.author && (
              <p className="text-[11px] text-text-muted">by {plugin.author}</p>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Enable/disable toggle */}
            <button
              type="button"
              onClick={() => onToggle(plugin.name, plugin.enabled)}
              className={`w-10 h-5 rounded-full transition-colors relative ${
                plugin.enabled ? 'bg-green' : 'bg-surface-raised'
              } cursor-pointer`}
              title={plugin.enabled ? 'Disable plugin' : 'Enable plugin'}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-text transition-transform ${
                  plugin.enabled ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>

            <button
              type="button"
              onClick={onClose}
              className="text-text-muted hover:text-text transition-colors p-1 -mr-1"
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loadingDetail ? (
            <div className="flex items-center justify-center h-32 text-text-muted text-sm">
              Loading…
            </div>
          ) : (
            <div className="px-5 py-4 flex flex-col gap-6">
              {/* Description */}
              {plugin.description && (
                <div>
                  <p className="text-sm text-text-dim leading-relaxed">{plugin.description}</p>
                </div>
              )}

              {/* Metadata strip */}
              <div className="flex flex-wrap gap-3 text-[11px] text-text-muted">
                {plugin.route_prefix && (
                  <span className="font-mono bg-surface-raised px-2 py-0.5 rounded">
                    Route: {plugin.route_prefix}
                  </span>
                )}
                <span className={plugin.enabled ? 'text-green' : 'text-text-muted'}>
                  {plugin.enabled ? '● Enabled' : '○ Disabled'}
                </span>
                <span>Installed {new Date(plugin.installed_at).toLocaleDateString()}</span>
              </div>

              {/* Config form */}
              {hasConfig && (
                <section className="flex flex-col gap-4">
                  <h3 className="text-xs font-semibold text-text uppercase tracking-wide">
                    Configuration
                  </h3>
                  <div className="flex flex-col gap-4">
                    {schema.map((field) => (
                      <ConfigField
                        key={field.key}
                        field={field}
                        value={localConfig[field.key] ?? ''}
                        onChange={(val) =>
                          setLocalConfig((prev) => ({ ...prev, [field.key]: val }))
                        }
                      />
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleSaveConfig}
                    disabled={saving}
                    className="self-start bg-accent text-white text-sm font-medium px-4 py-1.5 rounded hover:bg-accent/90 transition-colors disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save config'}
                  </button>
                </section>
              )}

              {/* No config schema — show note if plugin is enabled */}
              {!hasConfig && plugin.enabled ? (
                <p className="text-xs text-text-muted italic">This plugin has no configurable settings.</p>
              ) : null}

              {/* MCP Tools */}
              {mcpTools.length > 0 && (
                <section className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold text-text uppercase tracking-wide">
                    MCP Tools ({mcpTools.length})
                  </h3>
                  <div className="flex flex-col gap-2">
                    {mcpTools.map((tool) => (
                      <div key={tool.name} className="bg-surface-raised rounded p-3 flex flex-col gap-0.5">
                        <span className="text-xs font-mono text-accent">{tool.name}</span>
                        {tool.description && (
                          <span className="text-xs text-text-dim">{tool.description}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Event Hooks */}
              {hooks.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold text-text uppercase tracking-wide">
                    Event Hooks
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {hooks.map((hook) => (
                      <span
                        key={hook}
                        className="text-xs font-mono bg-surface-raised text-text-muted px-2 py-0.5 rounded"
                      >
                        {hook}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Gated Actions */}
              {gatedActions.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold text-text uppercase tracking-wide">
                    Gated Actions
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {gatedActions.map((action) => (
                      <span
                        key={action}
                        className="text-xs font-mono bg-yellow/10 text-yellow px-2 py-0.5 rounded"
                      >
                        {action}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Marketplace tab ──────────────────────────────────────────────────────────
function MarketplaceTab() {
  return (
    <div className="flex flex-col gap-4">
      {/* Coming-soon banner */}
      <div className="bg-accent/10 border border-accent/20 rounded-lg p-4 flex flex-col gap-1">
        <p className="text-sm font-medium text-text">
          🛒 Marketplace is coming soon
        </p>
        <p className="text-xs text-text-muted">
          Browse, install, and publish community plugins. Anyone + their Claude
          can build a plugin and publish it back to the registry.
        </p>
        <a
          href="https://github.com/SoftBacon-Software/mycelium-plugins"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-accent hover:underline mt-1 self-start"
        >
          github.com/SoftBacon-Software/mycelium-plugins →
        </a>
      </div>

      {/* Preview cards */}
      <p className="text-xs text-text-muted font-medium uppercase tracking-wide">
        Coming to the registry
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {MARKETPLACE_STUBS.map((mp) => (
          <div
            key={mp.name}
            className="bg-surface border border-border/60 rounded-lg p-4 flex flex-col gap-2 opacity-75"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <h3 className="text-sm font-semibold text-text">{mp.display_name}</h3>
                  {mp.trusted && (
                    <span className="text-[10px] bg-green/10 text-green px-1.5 py-0.5 rounded font-medium">
                      trusted
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-text-muted">by {mp.author} · v{mp.version}</span>
              </div>
              <button
                type="button"
                disabled
                className="shrink-0 text-xs bg-surface-raised text-text-muted px-3 py-1 rounded cursor-not-allowed"
                title="Marketplace install coming soon"
              >
                Install
              </button>
            </div>
            <p className="text-xs text-text-dim leading-relaxed">{mp.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main PluginsPage ─────────────────────────────────────────────────────────
export default function PluginsPage() {
  const { plugins, loading, refresh } = useDashboardStore()
  const [toggling, setToggling] = useState<string | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<Plugin | null>(null)
  const [activeTab, setActiveTab] = useState<'installed' | 'marketplace'>('installed')

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleToggle = useCallback(async (name: string, currentEnabled: number) => {
    setToggling(name)
    try {
      if (currentEnabled) {
        await disablePlugin(name)
        toast.success(`Disabled plugin: ${name}`)
      } else {
        await enablePlugin(name)
        toast.success(`Enabled plugin: ${name} (restart required)`)
      }
      await refresh()
      // Update selectedPlugin state if it's the one we toggled
      setSelectedPlugin((prev) =>
        prev?.name === name
          ? { ...prev, enabled: currentEnabled ? 0 : 1 }
          : prev
      )
    } catch (err) {
      toast.error(`Failed to toggle plugin: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setToggling(null)
    }
  }, [refresh])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-semibold text-text">Plugins</h1>

          {/* Tab switcher */}
          <div className="flex items-center gap-1 bg-surface-raised rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => setActiveTab('installed')}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                activeTab === 'installed'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-text-muted hover:text-text'
              }`}
            >
              Installed
              <span className="ml-1.5 text-text-muted text-[10px]">{plugins.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('marketplace')}
              className={`text-xs px-3 py-1 rounded transition-colors ${
                activeTab === 'marketplace'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-text-muted hover:text-text'
              }`}
            >
              Marketplace
              <span className="ml-1.5 text-[10px] bg-accent/20 text-accent px-1 py-0.5 rounded font-medium">
                soon
              </span>
            </button>
          </div>

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

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-2">
        {activeTab === 'marketplace' ? (
          <MarketplaceTab />
        ) : (
          <>
            {plugins.length === 0 && !loading && (
              <div className="flex-1 flex items-center justify-center h-32">
                <p className="text-text-muted text-sm">No plugins installed</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {plugins.map((plugin) => (
                <div
                  key={plugin.name}
                  onClick={() => setSelectedPlugin(plugin)}
                  className={`bg-surface border rounded-lg p-5 flex flex-col gap-3 transition-colors cursor-pointer hover:border-accent/40 ${
                    selectedPlugin?.name === plugin.name
                      ? 'border-accent/60'
                      : plugin.enabled
                        ? 'border-border'
                        : 'border-border/50 opacity-60'
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
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggle(plugin.name, plugin.enabled)
                      }}
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
                    <p className="text-xs text-text-dim leading-relaxed line-clamp-2">
                      {plugin.description}
                    </p>
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
                    <span className="ml-auto text-text-dim text-[10px]">click for details →</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Detail panel */}
      {selectedPlugin && (
        <PluginDetailPanel
          plugin={selectedPlugin}
          onClose={() => setSelectedPlugin(null)}
          onToggle={handleToggle}
        />
      )}
    </div>
  )
}
