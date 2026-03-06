// Mycelium API types

export interface Agent {
  id: string;
  name: string;
  project_id: string;
  status: string;
  working_on: string | null;
  last_heartbeat: string;
  avatar_url: string | null;
  capabilities: string[];
  agent_type: string;
  llm_backend: string;
  llm_model: string;
}

export interface Event {
  id: string;
  type: string;
  agent: string;
  project_id: string;
  summary: string;
  data: string;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  project_id: string;
  status: string;
  priority: string;
  assignee: string | null;
  assigned_by: string | null;
  tags: string[];
  needs_approval: boolean;
  approved_by: string | null;
  approved_at: string | null;
  branch: string | null;
  pr_url: string | null;
  repo: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  id: string;
  from_agent: string;
  to_agent: string | null;
  project_id: string;
  content: string;
  msg_type: string;
  status: string;
  priority: 'urgent' | 'normal' | 'fyi';
  created_at: string;
  metadata: Record<string, unknown> | null;
  thread_id: string | null;
}

export interface TeamChat {
  id: string;
  user_id: string;
  user_type: string;
  display_name: string;
  content: string;
  created_at: string;
}

export interface ContextEntry {
  namespace: string;
  key: string;
  data: unknown;
  updated_by: string;
  updated_at: string;
}

export interface ContextKey {
  namespace: string;
  key: string;
  data: unknown;
  updated_by: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  plan: string;
  status: string;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  org_id: string;
  repo_url: string;
  type: string;
  status: string;
  created_at: string;
}

export interface Vote {
  id: string;
  approval_id: string;
  voter_id: string;
  voter_type: string;
  vote: string;
  reason: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  action_type: string;
  title: string;
  description?: string;
  risk_tier: string;
  required_approvals: number;
  current_approvals: number;
  status: string;
  created_at: string;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  executed_at: string | null;
  payload?: Record<string, unknown> | string;
  reason?: string;
  admin_notes?: string;
  votes?: Vote[];
}

export interface Asset {
  id: string;
  name: string;
  type: string;
  prompt: string;
  status: string;
  project_id: string;
  requested_by: string;
  assigned_to: string | null;
  file_path: string | null;
  download_url: string | null;
  drone_job_id: number | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Bug {
  id: string;
  title: string;
  description: string;
  project_id: string;
  severity: string;
  status: string;
  category: string;
  assignee: string | null;
  filed_by: string;
  created_at: string;
  updated_at: string;
  notes: string | null;
}

export interface PlanStepComment {
  id: number;
  step_id: number;
  plan_id: number;
  author: string;
  content: string;
  created_at: string;
}

export interface PlanStep {
  id: string;
  plan_id: string;
  step_number: number;
  step_order?: number;
  title: string;
  description: string;
  status: string;
  assignee: string | null;
  linked_task_id: number | null;
  linked_branch: string | null;
  linked_pr_url: string | null;
  created_at: string;
  updated_at: string;
  comments?: PlanStepComment[];
}

export interface Plan {
  id: string;
  title: string;
  description: string;
  project_id: string;
  status: string;
  priority: string;
  owner: string;
  created_at: string;
  updated_at: string;
  steps?: PlanStep[];
  progress?: { total: number; completed: number; percent: number };
}

export interface Concept {
  id: string;
  name: string;
  type: string;
  description: string;
  data: unknown;
  created_at: string;
  updated_at: string;
  projects: string[];
}

export interface Operator {
  id: string;
  display_name: string;
  role: string;
  responsibilities: string;
  email: string | null;
  studio_user_id: string | null;
  created_at: string;
  linked_agents: string[];
}

export interface ConfigEntry {
  key: string;
  value: unknown;
  updated_by: string;
  updated_at: string;
}

export interface Channel {
  id: number;
  name: string;
  slug: string;
  type: 'general' | 'announcement' | 'dm' | string;
  linked_type: string | null;
  linked_id: string | null;
  description: string;
  created_by: string;
  status: 'active' | 'archived';
  created_at: string;
  members?: ChannelMember[];
  member_count?: number;
}

export interface ChannelMember {
  id: number;
  channel_id: number;
  user_id: string;
  user_type: string;
  role: 'member' | 'admin';
  joined_at: string;
}

export interface ChannelMessage {
  id: number;
  from_agent: string;
  to_agent: string | null;
  content: string;
  metadata: string;
  msg_type: string;
  status: string;
  created_at: string;
  channel_id: number;
}

export interface DroneJob {
  id: number;
  title: string;
  command: string;
  input_data: string;
  requires: string;
  requester: string;
  drone_id: string | null;
  status: 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';
  priority: number;
  result_url: string | null;
  result_data: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  workspace_repo: string | null;
  workspace_branch: string;
}

export interface ThreadSummary {
  thread_id: string;
  message_count: number;
  last_message_at: string;
  last_sender: string;
}

export interface DroneArtifact {
  name: string;
  size: number;
  uploaded: string;
  url: string;
}

export interface WebhookDelivery {
  id: number
  webhook_id: number
  event: string
  agent_id: string
  payload: string
  status_code: number | null
  response_body: string | null
  error: string | null
  duration_ms: number | null
  created_at: string
}

export interface AdminOps {
  pending_requests: Message[]
  unassigned_tasks: Task[]
  unassigned_bugs: Bug[]
  failed_drone_jobs: DroneJob[]
  pending_approvals: Approval[]
  stale_requests: Message[]
  open_prs: { number: number; title: string; url: string; author: string; created_at: string }[]
}


export interface PluginPage {
  path: string
  title: string
  icon?: string
  nav_section?: string  // 'pinned' | 'work' | 'communicate' | 'observe' | 'manage' | 'advanced'
}

export interface PluginMcpTool {
  name: string
  description: string
}

export interface Plugin {
  name: string
  display_name: string
  description: string
  version: string
  author: string
  enabled: number
  route_prefix: string
  mcp_tool_count: number
  installed_at: string
  updated_at: string
  // Enriched fields from detail endpoint
  type?: string
  config_schema?: PluginConfigField[]
  mcp_tools?: PluginMcpTool[]
  hooks?: string[]
  gated_actions?: string[]
  pages?: PluginPage[]
}

export interface PluginConfigField {
  key: string
  type: 'string' | 'secret' | 'boolean' | 'number' | 'select' | 'url' | 'text'
  label: string
  description?: string
  required?: boolean
  default?: string
  help?: string
  options?: string[]
  multiple?: boolean
}

export interface PluginTool {
  name: string
  description: string
  schema?: Record<string, { type: string; required?: boolean; description?: string }>
}

export interface PluginManifest {
  name: string
  display_name: string
  version: string
  type: 'hook' | 'worker' | 'drone_workflow' | string
  author: string
  description: string
  homepage?: string
  license?: string
  config: Record<string, PluginConfigField>
  tools: PluginTool[]
  events: string[]
  permissions: string[]
}

export interface Feedback {
  id: string
  entity_type: string
  entity_id: string
  subject: string
  rating: number
  comment: string
  submitted_by: string
  agent_id: string
  created_at: string
}

export interface FeedbackSummary {
  total: number
  avg_rating: number
  by_agent: { agent_id: string; count: number; avg_rating: number }[]
  by_type: { entity_type: string; count: number; avg_rating: number }[]
  rating_dist: { rating: number; count: number }[]
  recent: Feedback[]
}

export interface InboxCountResponse {
  count: number;
}

export interface Overview {
  agents: Agent[];
  events: Event[];
  tasks: { open: Task[]; in_progress: Task[]; review: Task[]; done: Task[] };
  messages: Message[];
  team_chat: TeamChat[];
  context: ContextEntry[];
  context_keys: ContextKey[];
  projects: Project[];
  approval_queue: Task[];
  pending_approvals: Approval[];
  pending_requests: Message[];
  assets: Asset[];
  bugs: Bug[];
  bug_counts: { open: number; in_progress: number; fixed: number; total: number };
  plans: Plan[];
  concepts: Concept[];
  organizations: Organization[];
  operators: Operator[];
  instance_config: ConfigEntry[];
  channels: Channel[];
  channel_counts: { total: number; active: number; archived: number };
  drones: Agent[];
  drone_jobs: DroneJob[];
  plugins: Plugin[];
  active_operators?: { id: number; username: string; display_name: string; last_seen: string }[];
}

export interface InboxItem {
  id: number;
  operator_id: string;
  type: 'message' | 'approval' | 'bip_draft' | 'mention' | 'feedback_request';
  entity_type: string;
  entity_id: string;
  title: string;
  summary: string;
  data: Record<string, any>;
  status: 'unread' | 'read' | 'actioned' | 'dismissed';
  priority: 'urgent' | 'normal' | 'low';
  created_at: string;
  read_at: string | null;
}

export interface BipDraft {
  id: number;
  trigger_event: string;
  trigger_data: Record<string, any>;
  title: string;
  content: string;
  platforms: string[];
  status: 'pending' | 'approved' | 'rejected' | 'published' | 'skipped';
  approval_id: number | null;
  inbox_item_id: number[];
  rejection_note: string;
  posted_at: string | null;
  post_ids: Record<string, any>;
  created_at: string;
  updated_at: string;
}

// ── Node Profiles & Calibration ──

export interface NodeProfile {
  id: string;
  layer: 'platform' | 'customer' | 'agent';
  node_type: string;
  rules: Record<string, unknown>;
  required_concepts: string[];
  mcp_config: Record<string, unknown>;
  tool_whitelist: string[];
  repo_list: string[];
  md_checkpoints: string[];
  md_blocklist: string[];
  created_at: string;
  updated_at: string;
}

export interface ProfileLayer {
  id: string;
  layer: string;
  node_type: string;
}

export interface ResolvedProfile {
  rules: Record<string, unknown>;
  required_concepts: string[];
  mcp_config: Record<string, unknown>;
  tool_whitelist: string[];
  repo_list: string[];
  md_checkpoints: string[];
  md_blocklist: string[];
  layers_applied: ProfileLayer[];
}

export interface DriftItem {
  level: 'info' | 'warning' | 'critical';
  rule: string;
  detail: string;
}

export interface CalibrationData {
  status: 'aligned' | 'drifted' | 'critical';
  profile_chain: ProfileLayer[];
  rules: Record<string, unknown>;
  drift: DriftItem[];
  md_checkpoints: string[];
  md_blocklist: string[];
  last_standup: string;
}
