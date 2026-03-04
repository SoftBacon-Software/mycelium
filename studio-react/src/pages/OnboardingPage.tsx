import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createOrganization } from '../api/endpoints'
import { apiPost, apiPut } from '../api/client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WizardData {
  // Step 1 — Organization
  orgId: string
  orgName: string
  orgDescription: string

  // Step 2 — Project
  projectId: string
  projectName: string
  projectDescription: string
  projectType: string

  // Step 3 — Agent
  agentId: string
  agentName: string
  agentProject: string
  llmBackend: string
  llmModel: string
  generatedApiKey: string | null

  // Step 4 — Role Contract
  roleDescription: string
  roleResponsibilities: string
  roleConstraints: string
}

const INITIAL_DATA: WizardData = {
  orgId: '',
  orgName: '',
  orgDescription: '',
  projectId: '',
  projectName: '',
  projectDescription: '',
  projectType: 'software',
  agentId: '',
  agentName: '',
  agentProject: '',
  llmBackend: '',
  llmModel: '',
  generatedApiKey: null,
  roleDescription: '',
  roleResponsibilities: '',
  roleConstraints: '',
}

const STEPS = [
  { number: 1, label: 'Organization' },
  { number: 2, label: 'Project' },
  { number: 3, label: 'Agent' },
  { number: 4, label: 'Role Contract' },
]

const PROJECT_TYPES = [
  { value: 'software', label: 'Software' },
  { value: 'game', label: 'Game' },
  { value: 'film', label: 'Film' },
  { value: 'book', label: 'Book' },
  { value: 'other', label: 'Other' },
]

// ---------------------------------------------------------------------------
// Shared form components
// ---------------------------------------------------------------------------

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <label className="block mb-1">
      <span className="text-xs font-medium text-text-dim">{children}</span>
      {hint && <span className="text-xs text-text-muted ml-1.5">({hint})</span>}
    </label>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
    />
  )
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none disabled:opacity-50"
    />
  )
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer disabled:opacity-50"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

function StepIndicator({ currentStep, completedSteps }: { currentStep: number; completedSteps: Set<number> }) {
  return (
    <div className="flex items-center justify-center mb-8">
      {STEPS.map((step, idx) => {
        const isCompleted = completedSteps.has(step.number)
        const isCurrent = step.number === currentStep

        return (
          <div key={step.number} className="flex items-center">
            {/* Circle */}
            <div className="flex flex-col items-center">
              <div
                className={`
                  w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold
                  transition-all duration-200
                  ${isCompleted
                    ? 'bg-green text-bg'
                    : isCurrent
                      ? 'bg-accent text-bg ring-2 ring-accent/30 ring-offset-2 ring-offset-surface'
                      : 'bg-surface-raised text-text-muted border border-border'
                  }
                `}
              >
                {isCompleted ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
                  </svg>
                ) : (
                  step.number
                )}
              </div>
              <span
                className={`text-xs mt-1.5 whitespace-nowrap ${
                  isCurrent ? 'text-accent font-medium' : isCompleted ? 'text-green' : 'text-text-muted'
                }`}
              >
                {step.label}
              </span>
            </div>

            {/* Connecting line */}
            {idx < STEPS.length - 1 && (
              <div
                className={`w-12 sm:w-20 h-px mx-2 mb-5 transition-colors ${
                  completedSteps.has(step.number) ? 'bg-green' : 'bg-border'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Context badge (shows data from prior steps)
// ---------------------------------------------------------------------------

function ContextBadge({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <span className="inline-flex items-center gap-1.5 bg-surface-raised border border-border rounded px-2.5 py-1 text-xs mr-2 mb-2">
      <span className="text-text-muted">{label}:</span>
      <span className="text-accent font-mono">{value}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function OnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(1)
  const [data, setData] = useState<WizardData>(INITIAL_DATA)
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(new Set())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)

  // Helper to update individual fields
  const update = <K extends keyof WizardData>(key: K, value: WizardData[K]) => {
    setData((prev) => ({ ...prev, [key]: value }))
  }

  const markComplete = (stepNum: number) => {
    setCompletedSteps((prev) => new Set(prev).add(stepNum))
  }

  // ------ Step 1: Create Organization ------
  const submitStep1 = async () => {
    if (!data.orgId.trim() || !data.orgName.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await createOrganization({
        id: data.orgId.trim(),
        name: data.orgName.trim(),
        description: data.orgDescription.trim() || undefined,
      })
      markComplete(1)
      setStep(2)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create organization')
    } finally {
      setSubmitting(false)
    }
  }

  // ------ Step 2: Create Project ------
  const submitStep2 = async () => {
    if (!data.projectId.trim() || !data.projectName.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await apiPost('/projects', {
        id: data.projectId.trim(),
        name: data.projectName.trim(),
        description: data.projectDescription.trim(),
        org_id: data.orgId.trim(),
        type: data.projectType,
      })
      // Pre-fill agent project dropdown
      update('agentProject', data.projectId.trim())
      markComplete(2)
      setStep(3)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create project')
    } finally {
      setSubmitting(false)
    }
  }

  // ------ Step 3: Register Agent ------
  const submitStep3 = async () => {
    if (!data.agentId.trim() || !data.agentName.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await apiPost<{ id: string; api_key: string; message: string }>('/admin/agents', {
        id: data.agentId.trim(),
        name: data.agentName.trim(),
        project_id: data.agentProject.trim(),
        llm_backend: data.llmBackend.trim(),
        llm_model: data.llmModel.trim(),
      })
      update('generatedApiKey', res.api_key)
      markComplete(3)
      setStep(4)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to register agent')
    } finally {
      setSubmitting(false)
    }
  }

  // ------ Step 4: Configure Role ------
  const submitStep4 = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const roleData = {
        description: data.roleDescription.trim(),
        responsibilities: data.roleResponsibilities
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        constraints: data.roleConstraints
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      }
      await apiPut(
        `/context/keys/roles/${encodeURIComponent(data.agentId.trim())}`,
        { data: roleData },
      )
      markComplete(4)
      setFinished(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role contract')
    } finally {
      setSubmitting(false)
    }
  }

  // ------ Copy to clipboard helpers ------
  const [copied, setCopied] = useState(false)
  const [copiedBlock, setCopiedBlock] = useState<string | null>(null)
  const copyKey = () => {
    if (data.generatedApiKey) {
      navigator.clipboard.writeText(data.generatedApiKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }
  const copyBlock = (id: string, text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedBlock(id)
    setTimeout(() => setCopiedBlock(null), 2000)
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  // Finished state
  if (finished) {
    const instanceUrl = window.location.origin
    const apiUrl = `${instanceUrl}/api/mycelium`

    const mcpConfig = JSON.stringify({
      mcpServers: {
        mycelium: {
          command: 'npx',
          args: ['-y', 'mycelium-mcp'],
          env: {
            MYCELIUM_API_URL: apiUrl,
            MYCELIUM_ROLE: 'agent',
            MYCELIUM_API_KEY: data.generatedApiKey ?? 'YOUR_API_KEY',
            MYCELIUM_AGENT_ID: data.agentId,
          },
        },
      },
    }, null, 2)

    const responsibilities = data.roleResponsibilities
      ? data.roleResponsibilities.split('\n').filter(Boolean).map(r => `- ${r}`).join('\n')
      : '- Execute tasks from the Mycelium task board\n- Report progress via heartbeats'

    const claudeMd = `# CLAUDE.md — ${data.agentName || data.agentId}

## Mycelium Network Agent

You are a Mycelium network agent. On every session start:

1. Call \`studio_boot\` — loads your tasks, messages, plans, and work queue
2. Work through your queue — claim the top item, do the work, mark it done
3. Send heartbeats as you work to keep the network updated

## Your Identity

- **Agent ID**: \`${data.agentId}\`
- **Project**: \`${data.projectId}\`
- **Instance**: ${apiUrl}

## Role

${data.roleDescription || 'Execute assigned tasks and coordinate via the Mycelium network.'}

## Responsibilities

${responsibilities}

## Rules

- Always check the task board before starting new work
- Use MCP tools for all network operations (do not use curl)
- Send \`studio_heartbeat\` with what you are working on
- Mark tasks complete when done, file bugs when you find them
- No deployments or external communications without human approval
`

    return (
      <div className="max-w-2xl mx-auto py-12 px-4">
        {/* Success header */}
        <div className="bg-surface border border-border rounded-lg p-8 text-center mb-6">
          <div className="w-16 h-16 rounded-full bg-green/20 flex items-center justify-center mx-auto mb-5">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green">
              <path d="M6 14.5L11.5 20L22 8" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-text mb-2">Your Mycelium network is ready!</h1>
          <p className="text-sm text-text-dim">
            <span className="font-mono text-accent">{data.orgId}</span> /
            <span className="font-mono text-accent"> {data.projectId}</span> /
            <span className="font-mono text-accent"> {data.agentId}</span> — configured and online.
          </p>
        </div>

        {/* API Key */}
        {data.generatedApiKey && (
          <div className="bg-surface border border-red/20 rounded-lg p-4 mb-4">
            <p className="text-xs font-semibold text-red mb-2">Save this API key — it cannot be shown again</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm font-mono text-accent bg-bg rounded px-3 py-2 break-all select-all">
                {data.generatedApiKey}
              </code>
              <button type="button" onClick={copyKey}
                className="shrink-0 text-xs bg-surface border border-border rounded px-3 py-2 text-text-dim hover:text-accent transition-colors">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {/* Bootstrap kit */}
        <div className="bg-surface border border-border rounded-lg p-6 mb-4">
          <h2 className="text-sm font-semibold text-text mb-1">Connect your agent to the network</h2>
          <p className="text-xs text-text-muted mb-4">
            Paste these into your project to make <span className="font-mono text-accent">{data.agentId}</span> Mycelium-aware.
            No Claude needed for setup — just copy these files.
          </p>

          {/* MCP config */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-text-dim">1. Add to <code className="font-mono bg-surface-raised px-1 py-0.5 rounded">~/.claude/settings.json</code> (MCP config)</span>
              <button type="button" onClick={() => copyBlock('mcp', mcpConfig)}
                className="text-xs text-text-muted hover:text-accent transition-colors px-2 py-0.5 rounded bg-surface-raised">
                {copiedBlock === 'mcp' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-bg border border-border rounded p-3 text-xs font-mono text-text-dim overflow-x-auto whitespace-pre-wrap break-all">{mcpConfig}</pre>
          </div>

          {/* CLAUDE.md */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-text-dim">2. Add to your project's <code className="font-mono bg-surface-raised px-1 py-0.5 rounded">CLAUDE.md</code></span>
              <button type="button" onClick={() => copyBlock('claude', claudeMd)}
                className="text-xs text-text-muted hover:text-accent transition-colors px-2 py-0.5 rounded bg-surface-raised">
                {copiedBlock === 'claude' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <pre className="bg-bg border border-border rounded p-3 text-xs font-mono text-text-dim overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">{claudeMd}</pre>
          </div>
        </div>

        {/* What's next */}
        <div className="bg-surface border border-border rounded-lg p-4 mb-6 text-sm text-text-muted space-y-1.5">
          <p className="text-text-dim font-medium text-xs mb-2">What happens next</p>
          <p>1. Paste the MCP config — this installs the Mycelium tools into Claude Code</p>
          <p>2. Paste the CLAUDE.md — this tells Claude to boot into the network on every session</p>
          <p>3. Open Claude Code in your project — it will call <code className="font-mono text-accent">studio_boot</code> automatically</p>
          <p>4. Create tasks from the dashboard — your agent will pick them up</p>
        </div>

        <button type="button" onClick={() => navigate('/')}
          className="w-full bg-accent text-bg px-6 py-2.5 rounded text-sm font-semibold hover:bg-accent-light transition-colors">
          Go to Dashboard
        </button>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-2xl font-bold text-text">Set Up Your Network</h1>
        <p className="text-sm text-text-dim mt-1">
          Walk through these steps to configure your Mycelium instance from scratch.
        </p>
      </div>

      {/* Step indicator */}
      <StepIndicator currentStep={step} completedSteps={completedSteps} />

      {/* Error display */}
      {error && (
        <div className="bg-glow-red border border-red/20 text-red text-sm rounded-lg px-4 py-3 mb-5 flex items-start gap-2">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 mt-0.5">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 5v3.5M8 10.5v.5" />
          </svg>
          <span>{error}</span>
        </div>
      )}

      {/* Card */}
      <div className="bg-surface border border-border rounded-lg p-6">

        {/* ===== Step 1: Create Organization ===== */}
        {step === 1 && (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-text">Create Organization</h2>
              <p className="text-sm text-text-muted mt-1">
                An organization groups your projects and agents together. Choose a URL-friendly slug as the ID.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <FieldLabel hint="URL-friendly slug">Organization ID</FieldLabel>
                <TextInput
                  value={data.orgId}
                  onChange={(v) => update('orgId', v.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                  placeholder="my-studio"
                  autoFocus
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel>Name</FieldLabel>
                <TextInput
                  value={data.orgName}
                  onChange={(v) => update('orgName', v)}
                  placeholder="My Studio"
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel hint="optional">Description</FieldLabel>
                <TextArea
                  value={data.orgDescription}
                  onChange={(v) => update('orgDescription', v)}
                  placeholder="What does this organization do?"
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="flex justify-end mt-6">
              <button
                type="button"
                onClick={submitStep1}
                disabled={submitting || !data.orgId.trim() || !data.orgName.trim()}
                className="bg-accent text-bg px-5 py-2 rounded text-sm font-semibold hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Creating...' : 'Create & Continue'}
              </button>
            </div>
          </>
        )}

        {/* ===== Step 2: Create Project ===== */}
        {step === 2 && (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-text">Create Project</h2>
              <p className="text-sm text-text-muted mt-1">
                Projects are the work being built on your network. Each project lives under your organization.
              </p>
              <div className="mt-3">
                <ContextBadge label="Org" value={data.orgId} />
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <FieldLabel hint="URL-friendly slug">Project ID</FieldLabel>
                <TextInput
                  value={data.projectId}
                  onChange={(v) => update('projectId', v.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                  placeholder="my-project"
                  autoFocus
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel>Name</FieldLabel>
                <TextInput
                  value={data.projectName}
                  onChange={(v) => update('projectName', v)}
                  placeholder="My Project"
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel hint="optional">Description</FieldLabel>
                <TextArea
                  value={data.projectDescription}
                  onChange={(v) => update('projectDescription', v)}
                  placeholder="What is this project about?"
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel>Type</FieldLabel>
                <Select
                  value={data.projectType}
                  onChange={(v) => update('projectType', v)}
                  options={PROJECT_TYPES}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <button
                type="button"
                onClick={() => { setStep(1); setError(null) }}
                className="text-sm text-text-dim hover:text-text transition-colors px-4 py-2"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submitStep2}
                disabled={submitting || !data.projectId.trim() || !data.projectName.trim()}
                className="bg-accent text-bg px-5 py-2 rounded text-sm font-semibold hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Creating...' : 'Create & Continue'}
              </button>
            </div>
          </>
        )}

        {/* ===== Step 3: Register Agent ===== */}
        {step === 3 && (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-text">Register Agent</h2>
              <p className="text-sm text-text-muted mt-1">
                Agents are Claude instances (or other LLMs) that build your projects. Register your first one here.
              </p>
              <div className="mt-3">
                <ContextBadge label="Org" value={data.orgId} />
                <ContextBadge label="Project" value={data.projectId} />
              </div>
            </div>

            <div className="bg-glow-accent border border-accent/10 rounded-lg px-4 py-3 mb-5 text-sm text-text-dim">
              <span className="font-medium text-accent">Note:</span> An API key will be generated for this agent.
              Save it — you cannot view it again after leaving this page.
            </div>

            <div className="space-y-4">
              <div>
                <FieldLabel hint="URL-friendly slug">Agent ID</FieldLabel>
                <TextInput
                  value={data.agentId}
                  onChange={(v) => update('agentId', v.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                  placeholder="my-agent"
                  autoFocus
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel>Agent Name</FieldLabel>
                <TextInput
                  value={data.agentName}
                  onChange={(v) => update('agentName', v)}
                  placeholder="My Agent"
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel>Project</FieldLabel>
                <Select
                  value={data.agentProject}
                  onChange={(v) => update('agentProject', v)}
                  options={[{ value: data.projectId, label: `${data.projectName} (${data.projectId})` }]}
                  disabled={submitting}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <FieldLabel hint="e.g. anthropic">LLM Backend</FieldLabel>
                  <TextInput
                    value={data.llmBackend}
                    onChange={(v) => update('llmBackend', v)}
                    placeholder="anthropic"
                    disabled={submitting}
                  />
                </div>
                <div>
                  <FieldLabel hint="e.g. claude-opus-4-6">LLM Model</FieldLabel>
                  <TextInput
                    value={data.llmModel}
                    onChange={(v) => update('llmModel', v)}
                    placeholder="claude-opus-4-6"
                    disabled={submitting}
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <button
                type="button"
                onClick={() => { setStep(2); setError(null) }}
                className="text-sm text-text-dim hover:text-text transition-colors px-4 py-2"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submitStep3}
                disabled={submitting || !data.agentId.trim() || !data.agentName.trim()}
                className="bg-accent text-bg px-5 py-2 rounded text-sm font-semibold hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Registering...' : 'Register Agent'}
              </button>
            </div>
          </>
        )}

        {/* ===== Step 4: Role Contract ===== */}
        {step === 4 && (
          <>
            <div className="mb-5">
              <h2 className="text-lg font-semibold text-text">Configure Role Contract</h2>
              <p className="text-sm text-text-muted mt-1">
                Define what your agent is responsible for, and what boundaries it should operate within.
              </p>
              <div className="mt-3">
                <ContextBadge label="Org" value={data.orgId} />
                <ContextBadge label="Project" value={data.projectId} />
                <ContextBadge label="Agent" value={data.agentId} />
              </div>
            </div>

            {/* Show the API key from step 3 if still on this page */}
            {data.generatedApiKey && (
              <div className="bg-surface-raised border border-border rounded-lg p-4 mb-5">
                <p className="text-xs text-text-muted mb-1.5">
                  Agent API Key — save this before proceeding
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm font-mono text-accent bg-bg rounded px-3 py-2 break-all select-all">
                    {data.generatedApiKey}
                  </code>
                  <button
                    type="button"
                    onClick={copyKey}
                    className="shrink-0 text-xs bg-surface border border-border rounded px-3 py-2 text-text-dim hover:text-accent transition-colors"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <FieldLabel>Description</FieldLabel>
                <TextArea
                  value={data.roleDescription}
                  onChange={(v) => update('roleDescription', v)}
                  placeholder="What is this agent's purpose? e.g. Full-stack developer responsible for the web dashboard"
                  rows={2}
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel hint="one per line">Responsibilities</FieldLabel>
                <TextArea
                  value={data.roleResponsibilities}
                  onChange={(v) => update('roleResponsibilities', v)}
                  placeholder={"Implement new features\nFix bugs and regressions\nWrite tests for critical paths"}
                  rows={4}
                  disabled={submitting}
                />
              </div>
              <div>
                <FieldLabel hint="one per line">Constraints</FieldLabel>
                <TextArea
                  value={data.roleConstraints}
                  onChange={(v) => update('roleConstraints', v)}
                  placeholder={"Never push directly to main\nAlways request approval for destructive actions\nStay within assigned project scope"}
                  rows={4}
                  disabled={submitting}
                />
              </div>
            </div>

            <div className="flex justify-between mt-6">
              <button
                type="button"
                onClick={() => { setStep(3); setError(null) }}
                className="text-sm text-text-dim hover:text-text transition-colors px-4 py-2"
              >
                Back
              </button>
              <button
                type="button"
                onClick={submitStep4}
                disabled={submitting}
                className="bg-accent text-bg px-5 py-2 rounded text-sm font-semibold hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Saving...' : 'Finish Setup'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Footer hint */}
      <p className="text-center text-xs text-text-muted mt-6">
        Step {step} of {STEPS.length}
        {step > 1 && ' — you can go back to edit previous steps'}
      </p>
    </div>
  )
}
