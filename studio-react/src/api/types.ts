// Mycelium Dioverse API types

export interface Agent {
  id: string;
  name: string;
  game: string;
  status: string;
  working_on: string | null;
  last_heartbeat: string;
  avatar_url: string | null;
  capabilities: string[];
}

export interface Event {
  id: string;
  type: string;
  agent: string;
  game: string;
  description: string;
  created_at: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  game: string;
  status: string;
  priority: string;
  assignee: string | null;
  assigned_by: string | null;
  tags: string[];
  needs_approval: boolean;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Message {
  id: string;
  from_agent: string;
  to_agent: string;
  game: string;
  content: string;
  msg_type: string;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
  thread_id: string | null;
  project: string | null;
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
  value: unknown;
  updated_by: string;
  updated_at: string;
}

export interface ContextKey {
  namespace: string;
  key: string;
  updated_at: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  status: string;
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
  entity_type: string;
  entity_id: string;
  risk_tier: string;
  quorum_required: number;
  status: string;
  created_at: string;
  created_by: string;
  resolved_at: string | null;
  resolved_by: string | null;
  votes?: Vote[];
}

export interface Asset {
  id: string;
  name: string;
  type: string;
  prompt: string;
  status: string;
  game: string;
  requested_by: string;
  assigned_to: string | null;
  file_path: string | null;
  download_url: string | null;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | null;
}

export interface Bug {
  id: string;
  title: string;
  description: string;
  game: string;
  severity: string;
  status: string;
  category: string;
  assignee: string | null;
  filed_by: string;
  created_at: string;
  updated_at: string;
  notes: string | null;
}

export interface PlanStep {
  id: string;
  plan_id: string;
  step_number: number;
  title: string;
  description: string;
  status: string;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

export interface Plan {
  id: string;
  title: string;
  description: string;
  game: string;
  status: string;
  priority: string;
  owner: string;
  created_at: string;
  updated_at: string;
  steps?: PlanStep[];
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

export interface Overview {
  agents: Agent[];
  events: Event[];
  tasks: { open: Task[]; in_progress: Task[]; review: Task[]; done: Task[] };
  messages: Message[];
  team_chat: TeamChat[];
  context: ContextEntry[];
  context_keys: ContextKey[];
  projects: Project[];
  games: Project[];
  approval_queue: Task[];
  pending_approvals: Approval[];
  pending_requests: Message[];
  assets: Asset[];
  bugs: Bug[];
  bug_counts: { open: number; in_progress: number; resolved: number; closed: number };
  plans: Plan[];
  concepts: Concept[];
  operators: Operator[];
  instance_config: ConfigEntry[];
}
