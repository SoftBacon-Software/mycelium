// Typed API endpoint functions

import { apiGet, apiPost, apiPut, apiDelete, setToken, getToken } from './client';
import type {
  Overview,
  AdminOps,
  Event,
  Task,
  Message,
  TeamChat,
  Plan,
  PlanStep,
  PlanStepComment,
  Bug,
  Asset,
  Organization,
  Operator,
  ConfigEntry,
  Vote,
  Approval,
  ContextEntry,
  Concept,
  Channel,
  ChannelMember,
  ChannelMessage,
  DroneJob,
  ThreadSummary,
  WebhookDelivery,
  Plugin,
  Feedback,
  FeedbackSummary,
  InboxItem,
  InboxCountResponse,
} from './types';

// Auth

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; user: any }> {
  const res = await apiPost<{ token: string; user: any }>('/studio/login', { username, password });
  setToken(res.token);
  return res;
}

export function logout(): void {
  setToken(null);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}

// Overview

export function fetchOverview(): Promise<Overview> {
  return apiGet<Overview>('/admin/overview');
}

// Events

export function fetchEvents(params?: { since?: string; limit?: number; search?: string; type?: string; agent?: string }): Promise<Event[]> {
  const q = new URLSearchParams()
  if (params?.since) q.set('since', params.since)
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.search) q.set('search', params.search)
  if (params?.type) q.set('type', params.type)
  if (params?.agent) q.set('agent', params.agent)
  const qs = q.toString()
  return apiGet<Event[]>(`/events${qs ? '?' + qs : ''}`)
}

// Admin Ops

export function fetchAdminOps(): Promise<AdminOps> {
  return apiGet<AdminOps>('/admin/ops');
}

// Tasks

export function createTask(data: Partial<Task>): Promise<Task> {
  return apiPost<Task>('/tasks', data);
}

export function updateTask(id: string, data: Partial<Task>): Promise<Task> {
  return apiPut<Task>(`/tasks/${id}`, data);
}

// Messages

export function sendMessage(data: Partial<Message>): Promise<Message> {
  return apiPost<Message>('/messages', data);
}

// Threads

export function fetchThreads(limit = 50): Promise<ThreadSummary[]> {
  return apiGet<ThreadSummary[]>(`/messages/threads?limit=${limit}`);
}

export function fetchThreadMessages(threadId: string): Promise<Message[]> {
  return apiGet<Message[]>(`/messages?thread=${encodeURIComponent(threadId)}`);
}

// Team Chat

export function sendTeamChat(
  content: string,
  userId: string,
  userType: string,
  displayName: string,
): Promise<TeamChat> {
  return apiPost<TeamChat>('/team-chat', {
    content,
    user_id: userId,
    user_type: userType,
    display_name: displayName,
  });
}

// Plans

export function fetchPlan(id: string): Promise<Plan> {
  return apiGet<Plan>(`/plans/${id}`);
}

export function createPlan(data: Partial<Plan>): Promise<Plan> {
  return apiPost<Plan>('/plans', data);
}

export function updatePlan(id: string, data: Partial<Plan>): Promise<Plan> {
  return apiPut<Plan>(`/plans/${id}`, data);
}

export function updatePlanStep(
  planId: string,
  stepId: string,
  data: Partial<PlanStep>,
): Promise<PlanStep> {
  return apiPut<PlanStep>(`/plans/${planId}/steps/${stepId}`, data);
}

export function addPlanStepComment(
  planId: string,
  stepId: string,
  data: { content: string; author?: string },
): Promise<PlanStepComment> {
  return apiPost<PlanStepComment>(`/plans/${planId}/steps/${stepId}/comments`, data);
}

// Alias for backward compat
export function addStepComment(
  planId: string,
  stepId: string,
  content: string,
  author?: string,
): Promise<PlanStepComment> {
  return addPlanStepComment(planId, stepId, { content, author });
}

// Bugs

export function fileBug(data: Partial<Bug>): Promise<Bug> {
  return apiPost<Bug>('/bugs', data);
}

export function updateBug(id: string, data: Partial<Bug>): Promise<Bug> {
  return apiPut<Bug>(`/bugs/${id}`, data);
}

// Assets

export function createAsset(data: Partial<Asset>): Promise<Asset> {
  return apiPost<Asset>('/assets', data);
}

export function updateAsset(id: string, data: Partial<Asset>): Promise<Asset> {
  return apiPut<Asset>(`/assets/${id}`, data);
}

export function deleteAsset(id: string): Promise<void> {
  return apiDelete<void>(`/assets/${id}`);
}

export async function uploadAsset(id: string, file: File): Promise<Asset> {
  const formData = new FormData();
  formData.append('file', file);

  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api/mycelium/assets/${id}/upload`, {
    method: 'POST',
    headers,
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const { ApiError } = await import('./client');
    throw new ApiError(res.status, body || `Upload failed with status ${res.status}`);
  }

  return res.json() as Promise<Asset>;
}

// Organizations

export function fetchOrganizations(): Promise<Organization[]> {
  return apiGet<Organization[]>('/orgs');
}

export function createOrganization(data: { id: string; name: string; description?: string }): Promise<Organization> {
  return apiPost<Organization>('/orgs', data);
}

export function updateOrganization(id: string, data: Partial<Organization>): Promise<Organization> {
  return apiPut<Organization>(`/orgs/${id}`, data);
}

// Operators

export function fetchOperators(): Promise<Operator[]> {
  return apiGet<Operator[]>('/operators');
}

export function createOperator(data: Partial<Operator>): Promise<Operator> {
  return apiPost<Operator>('/operators', data);
}

export function updateOperator(id: string, data: Partial<Operator>): Promise<Operator> {
  return apiPut<Operator>(`/operators/${id}`, data);
}

export function deleteOperator(id: string): Promise<void> {
  return apiDelete<void>(`/operators/${id}`);
}

// Config

export function fetchConfig(): Promise<ConfigEntry[]> {
  return apiGet<ConfigEntry[]>('/admin/config');
}

export function updateConfig(key: string, value: unknown): Promise<ConfigEntry> {
  return apiPut<ConfigEntry>(`/admin/config/${encodeURIComponent(key)}`, { value });
}

// Kill Switch

export function killSwitch(action: 'freeze' | 'unfreeze'): Promise<any> {
  return apiPut('/admin/override', { action });
}

// Sleep Mode

export function getSleepStatus(): Promise<{
  sleep_mode: { active: boolean; directive?: string; priorities?: string[]; approval_policy?: string; started_at?: string; started_by?: string; auto_wake_at?: string | null };
  autonomous: boolean;
  available_operators: number;
  log: { tasks_completed?: any[]; steps_completed?: any[]; approvals_queued?: any[]; dispatches?: any[]; errors?: any[]; messages_sent?: number } | null;
}> {
  return apiGet('/admin/sleep');
}

export function setSleepMode(config: {
  action: 'on' | 'off';
  operator_id?: string;
  directive?: string;
  priorities?: string[];
  approval_policy?: 'queue_high' | 'block_all' | 'auto_all';
  auto_wake_at?: string | null;
}): Promise<any> {
  return apiPut('/admin/sleep', config);
}

export function setOperatorAvailability(id: string, availability: 'available' | 'away' | 'sleeping', message?: string): Promise<Operator> {
  return apiPut<Operator>(`/operators/${id}/availability`, { availability, message });
}

// Approvals

export function castVote(
  approvalId: string,
  vote: string,
  reason: string | null,
  voterId: string,
  voterType: string,
): Promise<Vote> {
  return apiPut<Vote>(`/approvals/${approvalId}/vote`, {
    vote,
    reason,
    voter_id: voterId,
    voter_type: voterType,
  });
}

export function resolveApproval(
  id: string,
  decision: string,
  resolvedBy: string,
): Promise<Approval> {
  return apiPut<Approval>(`/approvals/${id}`, {
    status: decision,
    decided_by: resolvedBy,
  });
}

// Requests

export function resolveRequest(id: string, response: string): Promise<Message> {
  return apiPut<Message>(`/requests/${id}`, { status: 'resolved', response });
}

// Context

export function fetchAllContextKeys(ns?: string): Promise<ContextEntry[]> {
  const path = ns
    ? `/context/keys/${encodeURIComponent(ns)}`
    : '/context/keys';
  return apiGet<ContextEntry[]>(path);
}

export function fetchContextKey(ns: string, key: string): Promise<ContextEntry> {
  return apiGet<ContextEntry>(
    `/context/keys/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
  );
}

export function updateContextKey(
  ns: string,
  key: string,
  data: unknown,
): Promise<ContextEntry> {
  return apiPut<ContextEntry>(
    `/context/keys/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
    { data },
  );
}

export function deleteContextKey(ns: string, key: string): Promise<void> {
  return apiDelete<void>(
    `/context/keys/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
  );
}

// Concepts

export function createConcept(data: { name: string; type: string; description?: string; data?: unknown }): Promise<Concept> {
  return apiPost<Concept>('/concepts', data);
}

export function updateConcept(id: string, data: Partial<Concept>): Promise<Concept> {
  return apiPut<Concept>(`/concepts/${id}`, data);
}

export function deleteConcept(id: string): Promise<void> {
  return apiDelete<void>(`/concepts/${id}`);
}

export function linkConceptToProject(id: string, projectId: string): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>(`/concepts/${id}/link`, { project_id: projectId });
}

export function unlinkConceptFromProject(id: string, projectId: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/concepts/${id}/link/${encodeURIComponent(projectId)}`);
}

// Channels

export function fetchChannels(): Promise<Channel[]> {
  return apiGet<Channel[]>('/channels');
}

export function fetchChannelUnread(): Promise<Record<number, { name: string; slug: string; unread: number }>> {
  return apiGet<Record<number, { name: string; slug: string; unread: number }>>('/channels/unread');
}

export function fetchChannelMessages(id: number, limit = 50, offset = 0): Promise<ChannelMessage[]> {
  return apiGet<ChannelMessage[]>(`/channels/${id}/messages?limit=${limit}&offset=${offset}`);
}

export function sendChannelMessage(id: number, content: string, metadata?: string): Promise<{ ok: boolean; id: number; channel_id: number }> {
  return apiPost<{ ok: boolean; id: number; channel_id: number }>(`/channels/${id}/messages`, { content, metadata });
}

export function markChannelRead(id: number, messageId?: number): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/channels/${id}/read`, messageId ? { message_id: messageId } : {});
}

export function createChannel(data: { name: string; slug: string; type?: string; description?: string }): Promise<{ id: number }> {
  return apiPost<{ id: number }>('/channels', data);
}

export function deleteChannel(id: number): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/channels/${id}`);
}

export function fetchChannelMembers(id: number): Promise<ChannelMember[]> {
  return apiGet<ChannelMember[]>(`/channels/${id}/members`);
}

// Drone Jobs

export function createDroneJob(data: Partial<DroneJob>): Promise<DroneJob> {
  return apiPost<DroneJob>('/drones/jobs', data);
}

export function updateDroneJob(id: number, data: Partial<DroneJob>): Promise<DroneJob> {
  return apiPut<DroneJob>(`/drones/jobs/${id}`, data);
}

export function cancelDroneJob(id: number): Promise<DroneJob> {
  return apiPut<DroneJob>(`/drones/jobs/${id}`, { status: 'cancelled' });
}

export function dismissDroneJob(id: number): Promise<DroneJob> {
  return apiPut<DroneJob>(`/drones/jobs/${id}`, { status: 'dismissed' });
}

// Webhook Deliveries

export function fetchWebhookDeliveries(params?: {
  event?: string; webhook_id?: number; error_only?: boolean; limit?: number; offset?: number
}): Promise<WebhookDelivery[]> {
  const q = new URLSearchParams()
  if (params?.event) q.set('event', params.event)
  if (params?.webhook_id) q.set('webhook_id', String(params.webhook_id))
  if (params?.error_only) q.set('error_only', 'true')
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.offset) q.set('offset', String(params.offset))
  const qs = q.toString()
  return apiGet<WebhookDelivery[]>('/webhooks/deliveries' + (qs ? '?' + qs : ''))
}

export function linkAssetsToJob(
  assetIds: string[],
  droneJobId: number,
  status?: string,
): Promise<{ ok: boolean; updated: number }> {
  return apiPut<{ ok: boolean; updated: number }>('/assets/link-job', {
    asset_ids: assetIds,
    drone_job_id: droneJobId,
    status,
  });
}

// Feedback

export function fetchFeedback(params?: {
  entity_type?: string; agent_id?: string; rating?: number; min_rating?: number; limit?: number; offset?: number
}): Promise<Feedback[]> {
  const q = new URLSearchParams()
  if (params?.entity_type) q.set('entity_type', params.entity_type)
  if (params?.agent_id) q.set('agent_id', params.agent_id)
  if (params?.rating) q.set('rating', String(params.rating))
  if (params?.min_rating) q.set('min_rating', String(params.min_rating))
  if (params?.limit) q.set('limit', String(params.limit))
  if (params?.offset) q.set('offset', String(params.offset))
  const qs = q.toString()
  return apiGet<Feedback[]>('/feedback' + (qs ? '?' + qs : ''))
}

export function fetchFeedbackSummary(): Promise<FeedbackSummary> {
  return apiGet<FeedbackSummary>('/feedback/summary')
}

export function submitFeedback(data: {
  entity_type?: string; entity_id?: string; subject?: string; rating: number; comment?: string; agent_id?: string
}): Promise<Feedback> {
  return apiPost<Feedback>('/feedback', data)
}

export function deleteFeedbackItem(id: string): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/feedback/${id}`)
}

// Plugins

export function fetchPlugins(): Promise<Plugin[]> {
  return apiGet<Plugin[]>('/plugins');
}

export function fetchPlugin(name: string): Promise<Plugin> {
  return apiGet<Plugin>(`/plugins/${encodeURIComponent(name)}`);
}

export function fetchPluginConfig(name: string): Promise<Record<string, string>> {
  return apiGet<Record<string, string>>(`/plugins/${encodeURIComponent(name)}/config`);
}

export function savePluginConfig(name: string, config: Record<string, string>): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/plugins/${encodeURIComponent(name)}/config`, config);
}

export function enablePlugin(name: string): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/plugins/${encodeURIComponent(name)}/enable`, {});
}

export function disablePlugin(name: string): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/plugins/${encodeURIComponent(name)}/disable`, {});
}

// Inbox

export function fetchInbox(status?: string): Promise<InboxItem[]> {
  const q = status ? `?status=${status}` : '';
  return apiGet<InboxItem[]>(`/inbox${q}`);
}

export function fetchInboxCount(): Promise<InboxCountResponse> {
  return apiGet<InboxCountResponse>('/inbox/count');
}

export function markInboxItemRead(id: number): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/inbox/${id}/read`, {});
}

export function markInboxItemActioned(id: number): Promise<{ ok: boolean }> {
  return apiPut<{ ok: boolean }>(`/inbox/${id}/action`, {});
}

export function dismissInboxItem(id: number): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>(`/inbox/${id}`);
}

export function fetchApiLimits(): Promise<{ cached: boolean; data: Record<string, unknown> }> {
  return apiGet('/admin/api-limits');
}
