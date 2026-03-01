// Typed API endpoint functions

import { apiGet, apiPost, apiPut, apiDelete, setToken, getToken } from './client';
import type {
  Overview,
  Task,
  Message,
  TeamChat,
  Plan,
  PlanStep,
  Bug,
  Asset,
  Operator,
  ConfigEntry,
  Vote,
  Approval,
  ContextEntry,
  Channel,
  ChannelMember,
  ChannelMessage,
  DroneJob,
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

  const res = await fetch(`/api/dioverse/assets/${id}/upload`, {
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

export function fetchContextKey(ns: string, key: string): Promise<ContextEntry> {
  return apiGet<ContextEntry>(
    `/context/keys/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
  );
}

export function updateContextKey(
  ns: string,
  key: string,
  value: unknown,
  updatedBy: string,
): Promise<ContextEntry> {
  return apiPut<ContextEntry>(
    `/context/keys/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`,
    { value, updated_by: updatedBy },
  );
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

export function fetchChannelMembers(id: number): Promise<ChannelMember[]> {
  return apiGet<ChannelMember[]>(`/channels/${id}/members`);
}

// Drone Jobs

export function createDroneJob(data: Partial<DroneJob>): Promise<DroneJob> {
  return apiPost<DroneJob>('/drones/jobs', data);
}

export function updateDroneJob(id: number, data: Partial<DroneJob>): Promise<DroneJob> {
  return apiPut<DroneJob>(`/drone-jobs/${id}`, data);
}

export function cancelDroneJob(id: number): Promise<DroneJob> {
  return apiPut<DroneJob>(`/drone-jobs/${id}`, { status: 'cancelled' });
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
