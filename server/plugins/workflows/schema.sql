-- Plugin: workflows
-- Workflow intent records: a fired DAG of agent invocations + lifecycle events.
-- Spec: docs/specs/2026-06-09-workflow-intent-endpoint.md

CREATE TABLE IF NOT EXISTS workflows (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  shape        TEXT NOT NULL DEFAULT 'custom',     -- display label only (fanout|pipeline|repair|custom)
  spec         TEXT NOT NULL,                      -- JSON {invocations:[{id,agent,model,brief,deps}], params?:{}}
  project_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending|claimed|running|awaiting_approval|cancelling|completed|failed|cancelled
  risk         TEXT,                               -- green|yellow|red (runner-computed at claim)
  requested_by TEXT NOT NULL DEFAULT '',
  claimed_by   TEXT,
  error        TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  started_at   TEXT,
  finished_at  TEXT,
  approval_id  INTEGER                              -- the approval this workflow is paused on (awaiting_approval)
);

CREATE TABLE IF NOT EXISTS workflow_invocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id     INTEGER NOT NULL,
  inv_id          TEXT NOT NULL,                   -- DAG node id ("w0", "verify", "s1")
  agent_id        TEXT NOT NULL,
  model           TEXT NOT NULL DEFAULT '',
  brief           TEXT NOT NULL DEFAULT '',
  deps            TEXT NOT NULL DEFAULT '[]',      -- JSON [inv_id,...]
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|running|completed|failed|skipped
  result          TEXT,                            -- capped at 32000 chars, loud truncation marker
  transcript_path TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  UNIQUE(workflow_id, inv_id)
);

CREATE TABLE IF NOT EXISTS workflow_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  ts          TEXT DEFAULT (datetime('now')),
  kind        TEXT NOT NULL,   -- created|claimed|risk_assessed|wave_started|invocation_started|invocation_finished|invocation_failed|completed|failed|cancelled
  payload     TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_workflows_status   ON workflows(status);
CREATE INDEX IF NOT EXISTS idx_workflows_project  ON workflows(project_id);
CREATE INDEX IF NOT EXISTS idx_wf_inv_workflow    ON workflow_invocations(workflow_id);
CREATE INDEX IF NOT EXISTS idx_wf_events_workflow ON workflow_events(workflow_id);
