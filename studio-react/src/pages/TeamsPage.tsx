import { useState, useEffect, useCallback } from 'react'
import { useDashboardStore } from '../stores/dashboardStore'
import {
  fetchTeams,
  fetchTeam,
  createTeam,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
} from '../api/endpoints'
import type { Team, TeamMember } from '../api/types'
import ModalOverlay from '../components/modals/ModalOverlay'
import { toast } from 'sonner'
import { ChevronDown, ChevronRight, Plus, Trash2, UserPlus } from 'lucide-react'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

const ROLE_COLORS: Record<string, string> = {
  lead: 'bg-accent/15 text-accent',
  member: 'bg-green/15 text-green',
  guest: 'bg-text-muted/15 text-text-muted',
}

// ---- Create / Edit Team Modal -----------------------------------------------

interface TeamFormProps {
  isOpen: boolean
  onClose: () => void
  team?: Team | null
  onSaved: () => void
}

function TeamFormModal({ isOpen, onClose, team, onSaved }: TeamFormProps) {
  const organizations = useDashboardStore((s) => s.organizations)
  const isEditing = !!team

  const [id, setId] = useState(team?.id ?? '')
  const [name, setName] = useState(team?.name ?? '')
  const [orgId, setOrgId] = useState(team?.org_id ?? (organizations[0]?.id || ''))
  const [description, setDescription] = useState(team?.description ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when team changes
  useEffect(() => {
    setId(team?.id ?? '')
    setName(team?.name ?? '')
    setOrgId(team?.org_id ?? (organizations[0]?.id || ''))
    setDescription(team?.description ?? '')
    setError(null)
  }, [team, organizations])

  function resetAndClose() {
    setId('')
    setName('')
    setOrgId(organizations[0]?.id || '')
    setDescription('')
    setError(null)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    if (!isEditing && !id.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      if (isEditing) {
        await updateTeam(team!.id, {
          name: name.trim(),
          description: description.trim(),
        })
        toast.success('Team updated')
      } else {
        await createTeam({
          id: id.trim(),
          name: name.trim(),
          org_id: orgId,
          description: description.trim() || undefined,
        })
        toast.success('Team created')
      }
      onSaved()
      resetAndClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save team')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ModalOverlay isOpen={isOpen} onClose={resetAndClose} title={isEditing ? 'Edit Team' : 'Create Team'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {!isEditing && (
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">
              ID <span className="text-text-muted">(URL-friendly slug)</span>
            </label>
            <input
              type="text"
              value={id}
              onChange={(e) => setId(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              placeholder="engineering-team"
              autoFocus
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Engineering"
            autoFocus={isEditing}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
          />
        </div>

        {!isEditing && (
          <div>
            <label className="block text-xs font-medium text-text-dim mb-1">Organization</label>
            <select
              value={orgId}
              onChange={(e) => setOrgId(e.target.value)}
              disabled={submitting}
              className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer disabled:opacity-50"
            >
              {organizations.map((org) => (
                <option key={org.id} value={org.id}>{org.name} ({org.id})</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">
            Description <span className="text-text-muted">(optional)</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this team work on?"
            rows={3}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 resize-none disabled:opacity-50"
          />
        </div>

        {error && <p className="text-red text-xs">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={resetAndClose}
            className="px-4 py-2 rounded text-sm text-text-dim hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim() || (!isEditing && !id.trim())}
            className="px-5 py-2 rounded text-sm font-semibold bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Team'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ---- Add Member Modal -------------------------------------------------------

interface AddMemberModalProps {
  isOpen: boolean
  onClose: () => void
  teamId: string
  onSaved: () => void
}

function AddMemberModal({ isOpen, onClose, teamId, onSaved }: AddMemberModalProps) {
  const agents = useDashboardStore((s) => s.agents)
  const operators = useDashboardStore((s) => s.operators)

  const [userId, setUserId] = useState('')
  const [userType, setUserType] = useState<'operator' | 'agent'>('operator')
  const [role, setRole] = useState<string>('member')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetAndClose() {
    setUserId('')
    setUserType('operator')
    setRole('member')
    setError(null)
    onClose()
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!userId.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      await addTeamMember(teamId, {
        user_id: userId.trim(),
        user_type: userType,
        role,
      })
      toast.success('Member added')
      onSaved()
      resetAndClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member')
    } finally {
      setSubmitting(false)
    }
  }

  const suggestions = userType === 'operator'
    ? operators.map((o) => ({ id: o.id, label: o.display_name }))
    : agents.map((a) => ({ id: a.id, label: a.name }))

  return (
    <ModalOverlay isOpen={isOpen} onClose={resetAndClose} title="Add Team Member">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Type</label>
          <div className="flex gap-2">
            {(['operator', 'agent'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => { setUserType(t); setUserId('') }}
                className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  userType === t
                    ? 'bg-accent/20 text-accent border border-accent/40'
                    : 'bg-surface-raised text-text-muted border border-border hover:text-text-dim'
                }`}
              >
                {t === 'operator' ? 'Operator (Person)' : 'Agent (AI)'}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">User ID</label>
          <input
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={userType === 'operator' ? 'greatness' : 'greatness-claude'}
            autoFocus
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent/40 disabled:opacity-50"
          />
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setUserId(s.id)}
                  className={`px-2 py-0.5 rounded-full text-xs font-mono transition-colors ${
                    userId === s.id
                      ? 'bg-accent/20 text-accent border border-accent/40'
                      : 'bg-surface-raised text-text-muted border border-border hover:text-text-dim'
                  }`}
                >
                  {s.id}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-text-dim mb-1">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={submitting}
            className="w-full bg-surface-raised border border-border rounded px-3 py-2 text-sm text-text-dim focus:outline-none focus:ring-1 focus:ring-accent/40 appearance-none cursor-pointer disabled:opacity-50"
          >
            <option value="lead">Lead</option>
            <option value="member">Member</option>
            <option value="guest">Guest</option>
          </select>
        </div>

        {error && <p className="text-red text-xs">{error}</p>}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={resetAndClose}
            className="px-4 py-2 rounded text-sm text-text-dim hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !userId.trim()}
            className="px-5 py-2 rounded text-sm font-semibold bg-accent text-bg hover:bg-accent-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Adding...' : 'Add Member'}
          </button>
        </div>
      </form>
    </ModalOverlay>
  )
}

// ---- Team Card (expandable) ------------------------------------------------

interface TeamCardProps {
  team: Team
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}

function TeamCard({ team, onEdit, onDelete, onRefresh }: TeamCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [members, setMembers] = useState<TeamMember[]>(team.members ?? [])
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)

  async function loadMembers(force = false) {
    if (!force && (members.length > 0 || loadingMembers)) return
    setLoadingMembers(true)
    try {
      const detail = await fetchTeam(team.id)
      setMembers(detail.members ?? [])
    } catch {
      toast.error('Failed to load team members')
    } finally {
      setLoadingMembers(false)
    }
  }

  function handleToggle() {
    const next = !expanded
    setExpanded(next)
    if (next) loadMembers()
  }

  async function handleRemoveMember(userId: string) {
    if (!confirm(`Remove "${userId}" from team "${team.name}"?`)) return
    try {
      await removeTeamMember(team.id, userId)
      toast.success('Member removed')
      setMembers((prev) => prev.filter((m) => m.user_id !== userId))
      onRefresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member')
    }
  }

  function handleMemberAdded() {
    setMembers([])
    loadMembers(true)
    onRefresh()
  }

  const memberCount = team.member_count ?? members.length

  return (
    <div className="bg-surface-raised rounded-lg border border-border/50 hover:border-border transition-colors group">
      {/* Main card content */}
      <div className="p-4 flex flex-col gap-3">
        {/* Header: name + actions */}
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold text-text truncate">{team.name}</h3>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-xs bg-accent/10 text-accent px-2 py-0.5 rounded-full font-medium font-mono">
              {team.org_id}
            </span>
            <div className="hidden group-hover:flex items-center gap-1">
              <button
                onClick={onEdit}
                className="text-text-muted hover:text-accent transition-colors p-0.5"
                title="Edit"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8.5 2.5l3 3M2 9l6-6 3 3-6 6H2V9z" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                onClick={onDelete}
                className="text-text-muted hover:text-red transition-colors p-0.5"
                title="Delete"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 4h8M5.5 4V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1M4.5 4v7.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1V4" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* ID */}
        <p className="text-text-muted font-mono text-sm leading-none">{team.id}</p>

        {/* Description */}
        {team.description && (
          <p className="text-text-dim text-sm leading-relaxed">{team.description}</p>
        )}

        {/* Footer: member count + date + expand toggle */}
        <div className="flex items-center justify-between mt-auto pt-1">
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span>{memberCount} member{memberCount !== 1 ? 's' : ''}</span>
            <span>Created {formatDate(team.created_at)}</span>
          </div>
          <button
            onClick={handleToggle}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-accent transition-colors"
          >
            {expanded ? (
              <>
                <ChevronDown size={14} />
                <span>Hide</span>
              </>
            ) : (
              <>
                <ChevronRight size={14} />
                <span>Members</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Expanded: members list */}
      {expanded && (
        <div className="border-t border-border/50 px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-text-dim uppercase tracking-wider">Members</span>
            <button
              onClick={() => setShowAddMember(true)}
              className="flex items-center gap-1 text-xs text-accent hover:text-accent-light transition-colors"
            >
              <UserPlus size={12} />
              <span>Add</span>
            </button>
          </div>

          {loadingMembers ? (
            <div className="flex items-center justify-center py-4">
              <div className="inline-block w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : members.length === 0 ? (
            <p className="text-text-muted text-xs py-2">No members yet.</p>
          ) : (
            <div className="space-y-1.5">
              {members.map((m) => (
                <div
                  key={`${m.user_id}-${m.user_type}`}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 rounded bg-surface hover:bg-surface/80 transition-colors"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-mono text-text truncate">{m.user_id}</span>
                    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLORS[m.role] || ROLE_COLORS.member}`}>
                      {m.role}
                    </span>
                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-surface-raised text-text-muted">
                      {m.user_type}
                    </span>
                    {m.is_primary === 1 && (
                      <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-accent/10 text-accent">
                        primary
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => handleRemoveMember(m.user_id)}
                    className="shrink-0 text-text-muted hover:text-red transition-colors p-0.5"
                    title="Remove member"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {showAddMember && (
            <AddMemberModal
              isOpen={showAddMember}
              onClose={() => setShowAddMember(false)}
              teamId={team.id}
              onSaved={handleMemberAdded}
            />
          )}
        </div>
      )}
    </div>
  )
}

// ---- Main Page --------------------------------------------------------------

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingTeam, setEditingTeam] = useState<Team | null>(null)

  const loadTeams = useCallback(async () => {
    try {
      const data = await fetchTeams()
      setTeams(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load teams')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTeams()
  }, [loadTeams])

  async function handleDelete(team: Team) {
    if (!confirm(`Delete team "${team.name}"? This will remove all member associations.`)) return
    try {
      await deleteTeam(team.id)
      toast.success('Team deleted')
      loadTeams()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete team')
    }
  }

  // Loading state
  if (loading && teams.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="inline-block w-6 h-6 border-2 border-accent/30 border-t-accent rounded-full animate-spin mb-3" />
          <p className="text-text-dim text-sm">Loading teams...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error && teams.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-8 text-center">
        <p className="text-red text-sm mb-3">Failed to load teams</p>
        <p className="text-text-muted text-xs mb-4">{error}</p>
        <button
          onClick={loadTeams}
          className="px-4 py-2 rounded text-sm bg-surface-raised text-text-dim hover:text-text transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-text">Teams</h2>
            <p className="text-text-muted text-sm mt-0.5">
              {teams.length} team{teams.length !== 1 ? 's' : ''} registered
            </p>
          </div>
          <button
            onClick={() => { setEditingTeam(null); setShowForm(true) }}
            className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium bg-accent text-bg hover:bg-accent-light transition-colors"
          >
            <Plus size={14} />
            Create Team
          </button>
        </div>

        {teams.length === 0 ? (
          <div className="bg-surface rounded-lg p-8 text-center">
            <p className="text-text-muted text-sm">No teams created yet.</p>
            <p className="text-text-muted text-xs mt-1">Create a team to organize operators and agents into working groups.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {teams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                onEdit={() => { setEditingTeam(team); setShowForm(true) }}
                onDelete={() => handleDelete(team)}
                onRefresh={loadTeams}
              />
            ))}
          </div>
        )}
      </section>

      {/* Create / Edit Modal */}
      {showForm && (
        <TeamFormModal
          isOpen={showForm}
          onClose={() => { setShowForm(false); setEditingTeam(null) }}
          team={editingTeam}
          onSaved={loadTeams}
        />
      )}
    </div>
  )
}
