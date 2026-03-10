import { useState, useEffect, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import {
  fetchAgentTemplates,
  createAgentTemplate,
  updateAgentTemplate,
  deleteAgentTemplate,
  applyAgentTemplate,
  type AgentTemplate,
} from '../api/endpoints'
import ModalOverlay from '../components/modals/ModalOverlay'
import { toast } from 'sonner'
import { Plus, Trash2, Play } from 'lucide-react'

// ---- Create / Edit Template Modal -------------------------------------------

interface TemplateFormProps {
  isOpen: boolean
  onClose: () => void
  template?: AgentTemplate | null
  onSaved: () => void
}

function TemplateFormModal({ isOpen, onClose, template, onSaved }: TemplateFormProps) {
  const isEditing = !!template

  const [id, setId] = useState(template?.id ?? '')
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [runtime, setRuntime] = useState(template?.runtime ?? '')
  const [llmBackend, setLlmBackend] = useState(template?.llm_backend ?? '')
  const [llmModel, setLlmModel] = useState(template?.llm_model ?? '')
  const [agentType, setAgentType] = useState(template?.agent_type ?? 'agent')
  const [capabilities, setCapabilities] = useState(template?.capabilities?.join(', ') ?? 'code, assets')
  const [projectId, setProjectId] = useState(template?.project_id ?? '')
  const [teamIds, setTeamIds] = useState(template?.team_ids?.join(', ') ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setId(template?.id ?? '')
    setName(template?.name ?? '')
    setDescription(template?.description ?? '')
    setRuntime(template?.runtime ?? '')
    setLlmBackend(template?.llm_backend ?? '')
    setLlmModel(template?.llm_model ?? '')
    setAgentType(template?.agent_type ?? 'agent')
    setCapabilities(template?.capabilities?.join(', ') ?? 'code, assets')
    setProjectId(template?.project_id ?? '')
    setTeamIds(template?.team_ids?.join(', ') ?? '')
    setError(null)
  }, [template])

  function resetAndClose() {
    setError(null)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (!isEditing && !id.trim()) return
    setSubmitting(true)
    setError(null)
    const caps = capabilities.split(',').map(s => s.trim()).filter(Boolean)
    const teams = teamIds.split(',').map(s => s.trim()).filter(Boolean)
    try {
      if (isEditing) {
        await updateAgentTemplate(template!.id, {
          name: name.trim(),
          description: description.trim(),
          runtime: runtime.trim(),
          llm_backend: llmBackend.trim(),
          llm_model: llmModel.trim(),
          agent_type: agentType.trim(),
          capabilities: caps,
          project_id: projectId.trim(),
          team_ids: teams,
        })
        toast.success('Template updated')
      } else {
        await createAgentTemplate({
          id: id.trim(),
          name: name.trim(),
          description: description.trim(),
          runtime: runtime.trim(),
          llm_backend: llmBackend.trim(),
          llm_model: llmModel.trim(),
          agent_type: agentType.trim(),
          capabilities: caps,
          project_id: projectId.trim(),
          team_ids: teams,
        })
        toast.success('Template created')
      }
      onSaved()
      resetAndClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save template')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls = 'w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50'

  return (
    <ModalOverlay isOpen={isOpen} onClose={resetAndClose} title={isEditing ? 'Edit Template' : 'Create Template'}>
      <form onSubmit={handleSubmit} className="space-y-3">
        {!isEditing && (
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">ID <span className="text-text-muted">(slug)</span></label>
            <input type="text" value={id} onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="claude-runner" autoFocus disabled={submitting} className={inputCls} />
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Runner Template" autoFocus={isEditing} disabled={submitting} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Description <span className="text-text-muted">(optional)</span></label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this template for?" rows={2} disabled={submitting} className={inputCls + ' resize-none'} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Runtime</label>
            <input type="text" value={runtime} onChange={(e) => setRuntime(e.target.value)} placeholder="claude-code" disabled={submitting} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Agent Type</label>
            <select value={agentType} onChange={(e) => setAgentType(e.target.value)} disabled={submitting} className={inputCls + ' appearance-none cursor-pointer'}>
              <option value="agent">agent</option>
              <option value="drone">drone</option>
              <option value="admin">admin</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">LLM Backend</label>
            <input type="text" value={llmBackend} onChange={(e) => setLlmBackend(e.target.value)} placeholder="anthropic" disabled={submitting} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">LLM Model</label>
            <input type="text" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="claude-sonnet-4-6" disabled={submitting} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Capabilities <span className="text-text-muted">(comma-separated)</span></label>
          <input type="text" value={capabilities} onChange={(e) => setCapabilities(e.target.value)} placeholder="code, assets, deploy" disabled={submitting} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Default Project</label>
            <input type="text" value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="mycelium" disabled={submitting} className={inputCls} />
          </div>
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Auto-join Teams <span className="text-text-muted">(comma-sep)</span></label>
            <input type="text" value={teamIds} onChange={(e) => setTeamIds(e.target.value)} placeholder="platform, dev" disabled={submitting} className={inputCls} />
          </div>
        </div>

        {error && <p className="text-red text-xs">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={resetAndClose} className="px-4 py-2 rounded text-sm text-text-dim hover:text-text transition-colors">Cancel</button>
          <button type="submit" disabled={submitting || !name.trim() || (!isEditing && !id.trim())} className="px-5 py-2 rounded text-sm font-semibold bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Template'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ---- Template Card ----------------------------------------------------------

interface TemplateCardProps {
  template: AgentTemplate
  agents: { id: string; name: string }[]
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}

function TemplateCard({ template, agents, onEdit, onDelete, onRefresh }: TemplateCardProps) {
  const [applyingTo, setApplyingTo] = useState('')

  async function handleApply() {
    if (!applyingTo) return
    try {
      await applyAgentTemplate(template.id, applyingTo)
      toast.success(`Template applied to ${applyingTo}`)
      setApplyingTo('')
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply template')
    }
  }

  return (
    <div className="bg-surface-raised rounded-lg border border-border/50 hover:border-border transition-colors group p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-text truncate">{template.name}</h3>
        <div className="hidden group-hover:flex items-center gap-1">
          <button onClick={onEdit} className="text-text-muted hover:text-accent transition-colors p-0.5" title="Edit">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M8.5 2.5l3 3M2 9l6-6 3 3-6 6H2V9z" strokeLinejoin="round" /></svg>
          </button>
          <button onClick={onDelete} className="text-text-muted hover:text-red transition-colors p-0.5" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* ID */}
      <p className="text-text-muted font-mono text-sm leading-none">{template.id}</p>

      {/* Description */}
      {template.description && <p className="text-text-dim text-sm leading-relaxed">{template.description}</p>}

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5">
        {template.runtime && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent font-medium">{template.runtime}</span>
        )}
        {template.llm_model && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green/15 text-green font-medium">{template.llm_model}</span>
        )}
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface text-text-muted">{template.agent_type}</span>
        {template.capabilities?.map(c => (
          <span key={c} className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface text-text-muted">{c}</span>
        ))}
      </div>

      {/* Apply to agent */}
      <div className="flex items-center gap-2 mt-auto pt-1 border-t border-border/30">
        <select
          value={applyingTo}
          onChange={(e) => setApplyingTo(e.target.value)}
          className="flex-1 bg-surface border border-border rounded px-2 py-1 text-xs text-text-dim appearance-none cursor-pointer"
        >
          <option value="">Apply to agent...</option>
          {agents.map(a => <option key={a.id} value={a.id}>{a.name} ({a.id})</option>)}
        </select>
        <button
          onClick={handleApply}
          disabled={!applyingTo}
          className="flex items-center gap-1 px-2 py-1 rounded text-xs text-accent hover:bg-accent/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Play size={10} />
          Apply
        </button>
      </div>
    </div>
  )
}

// ---- Main Page --------------------------------------------------------------

export default function AgentTemplatesPage() {
  const agents = useDashboardStore((s) => s.agents)
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<AgentTemplate | null>(null)

  const loadTemplates = useCallback(async () => {
    try {
      const data = await fetchAgentTemplates()
      setTemplates(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTemplates()
  }, [loadTemplates])

  async function handleDelete(t: AgentTemplate) {
    if (!confirm(`Delete template "${t.name}"?`)) return
    try {
      await deleteAgentTemplate(t.id)
      toast.success('Template deleted')
      loadTemplates()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete template')
    }
  }

  if (loading && templates.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-3" />
          <p className="text-text-dim text-sm">Loading templates...</p>
        </div>
      </div>
    )
  }

  if (error && templates.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-red text-sm mb-3">Failed to load templates</p>
        <p className="text-text-muted text-xs mb-4">{error}</p>
        <button onClick={loadTemplates} className="px-4 py-2 rounded text-sm bg-surface-raised text-text-dim hover:text-text transition-colors">Retry</button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Agent Templates</h2>
            <p className="text-text-muted text-sm mt-0.5">
              {templates.length} template{templates.length !== 1 ? 's' : ''} — reusable configs for agent registration
            </p>
          </div>
          <button
            onClick={() => { setEditingTemplate(null); setShowForm(true) }}
            className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors"
          >
            <Plus size={14} />
            Create Template
          </button>
        </div>

        {templates.length === 0 ? (
          <div className="bg-surface rounded-lg p-8 text-center">
            <p className="text-text-muted text-sm">No templates yet.</p>
            <p className="text-text-muted text-xs mt-1">Create a template to save reusable agent configurations.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {templates.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                agents={agents}
                onEdit={() => { setEditingTemplate(t); setShowForm(true) }}
                onDelete={() => handleDelete(t)}
                onRefresh={loadTemplates}
              />
            ))}
          </div>
        )}
      </section>

      {showForm && (
        <TemplateFormModal
          isOpen={showForm}
          onClose={() => { setShowForm(false); setEditingTemplate(null) }}
          template={editingTemplate}
          onSaved={loadTemplates}
        />
      )}
    </div>
  )
}
