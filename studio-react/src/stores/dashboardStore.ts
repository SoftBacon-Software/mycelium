import { create } from 'zustand';
import { fetchOverview } from '../api/endpoints';
import type {
  Agent,
  Event,
  Task,
  Message,
  TeamChat,
  ContextEntry,
  ContextKey,
  Project,
  Approval,
  Asset,
  Bug,
  Plan,
  Concept,
  Operator,
  ConfigEntry,
} from '../api/types';

interface DashboardState {
  // Data
  agents: Agent[];
  events: Event[];
  tasks: { open: Task[]; in_progress: Task[]; review: Task[]; done: Task[] };
  messages: Message[];
  teamChat: TeamChat[];
  context: ContextEntry[];
  contextKeys: ContextKey[];
  projects: Project[];
  approvalQueue: Task[];
  pendingApprovals: Approval[];
  pendingRequests: Message[];
  assets: Asset[];
  bugs: Bug[];
  bugCounts: { open: number; in_progress: number; resolved: number; closed: number };
  plans: Plan[];
  concepts: Concept[];
  operators: Operator[];
  instanceConfig: ConfigEntry[];

  // UI state
  loading: boolean;
  error: string | null;
  lastRefresh: Date | null;

  // Actions
  refresh: () => Promise<void>;
  setError: (err: string | null) => void;
}

export const useDashboardStore = create<DashboardState>()((set) => ({
  // Data defaults
  agents: [],
  events: [],
  tasks: { open: [], in_progress: [], review: [], done: [] },
  messages: [],
  teamChat: [],
  context: [],
  contextKeys: [],
  projects: [],
  approvalQueue: [],
  pendingApprovals: [],
  pendingRequests: [],
  assets: [],
  bugs: [],
  bugCounts: { open: 0, in_progress: 0, resolved: 0, closed: 0 },
  plans: [],
  concepts: [],
  operators: [],
  instanceConfig: [],

  // UI state defaults
  loading: false,
  error: null,
  lastRefresh: null,

  // Actions
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const data = await fetchOverview();
      set({
        agents: data.agents,
        events: data.events,
        tasks: data.tasks,
        messages: data.messages,
        teamChat: data.team_chat,
        context: data.context,
        contextKeys: data.context_keys,
        projects: data.projects,
        approvalQueue: data.approval_queue,
        pendingApprovals: data.pending_approvals,
        pendingRequests: data.pending_requests,
        assets: data.assets,
        bugs: data.bugs,
        bugCounts: data.bug_counts,
        plans: data.plans,
        concepts: data.concepts,
        operators: data.operators,
        instanceConfig: data.instance_config,
        loading: false,
        lastRefresh: new Date(),
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch dashboard data',
      });
    }
  },

  setError: (err: string | null) => set({ error: err }),
}));
