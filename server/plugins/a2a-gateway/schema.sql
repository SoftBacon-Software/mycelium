-- Plugin: a2a-gateway
-- Google A2A protocol support

-- External A2A agents we know about
CREATE TABLE IF NOT EXISTS a2a_external_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_url TEXT NOT NULL UNIQUE,
  name TEXT,
  description TEXT,
  capabilities TEXT NOT NULL DEFAULT '[]',
  agent_card TEXT NOT NULL DEFAULT '{}',
  last_discovered_at TEXT DEFAULT (datetime('now')),
  status TEXT DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_a2a_agents_status ON a2a_external_agents(status);

-- A2A outbound tasks (we sent to external agents)
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id TEXT PRIMARY KEY,
  external_agent_id INTEGER REFERENCES a2a_external_agents(id),
  mycelium_task_id INTEGER,
  mycelium_agent_id TEXT,
  method TEXT,
  input_text TEXT,
  status TEXT DEFAULT 'submitted',
  result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status ON a2a_tasks(status);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_agent ON a2a_tasks(mycelium_agent_id);

-- A2A inbound tasks (external agents calling us)
CREATE TABLE IF NOT EXISTS a2a_inbound_tasks (
  id TEXT PRIMARY KEY,
  caller_url TEXT,
  target_agent_id TEXT,
  input_text TEXT,
  status TEXT DEFAULT 'submitted',
  result TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_a2a_inbound_status ON a2a_inbound_tasks(status);
