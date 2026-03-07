import { create } from 'zustand';
import { fetchOverview, fetchInboxCount } from '../api/endpoints';
import type {
  Agent,
  Event,
  Task,
  Message,
  TeamChat,
  ContextEntry,
  ContextKey,
  Project,
  Organization,
  Approval,
  Asset,
  Bug,
  Plan,
  Concept,
  Operator,
  ConfigEntry,
  Channel,
  DroneJob,
  Plugin,
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
  bugCounts: { open: number; in_progress: number; fixed: number; total: number };
  plans: Plan[];
  concepts: Concept[];
  operators: Operator[];
  instanceConfig: ConfigEntry[];
  channels: Channel[];
  channelCounts: { total: number; active: number; archived: number };
  drones: Agent[];
  droneJobs: DroneJob[];
  organizations: Organization[];
  plugins: Plugin[];
  inboxUnread: number;
  activeOperators: { id: number; username: string; display_name: string; last_seen: string }[];

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
  bugCounts: { open: 0, in_progress: 0, fixed: 0, total: 0 },
  plans: [],
  concepts: [],
  operators: [],
  instanceConfig: [],
  channels: [],
  channelCounts: { total: 0, active: 0, archived: 0 },
  drones: [],
  droneJobs: [],
  organizations: [],
  plugins: [],
  inboxUnread: 0,
  activeOperators: [],

  // UI state defaults — start true so first-boot detection waits for data
  loading: true,
  error: null,
  lastRefresh: null,

  // Actions
  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const [data, inboxData] = await Promise.all([
        fetchOverview(),
        fetchInboxCount().catch(() => ({ count: 0 })),
      ]);
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
        instanceConfig: data.instance_config || [],
        channels: data.channels || [],
        channelCounts: data.channel_counts || { total: 0, active: 0, archived: 0 },
        drones: data.drones || [],
        droneJobs: data.drone_jobs || [],
        organizations: data.organizations || [],
        plugins: data.plugins || [],
        activeOperators: data.active_operators || [],
        loading: false,
        inboxUnread: inboxData.count || 0,
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
