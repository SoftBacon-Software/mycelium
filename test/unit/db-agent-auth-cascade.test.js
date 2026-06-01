import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

// Admin-key auth wiring + cascade integrity for the PUBLIC repo.
//
// Two classes of invariant are guarded here, both of which are exactly where
// silent regressions hide (a prior overreach broke deleteProject by rewriting
// cascade/auth code that nothing pinned):
//
//   1. db.js cascade/return correctness — deleteAgent must remove EVERY row the
//      agent owns across 8 satellite tables (orphan-row prevention); deleteTask
//      must drop task_comments first then the task and report changes>0/false.
//      These run against the REAL exported db.js functions on a fresh temp DB.
//
//   2. isAdminKey auth wiring — the comparator must stay constant-time with a
//      length guard (a downgrade to === / == is a timing-side-channel auth
//      bypass), AND it must actually be invoked on the protected route helpers.
//      isAdminKey is a module-private helper (not exported), so the smoke test
//      that re-implements it locally proves nothing about the shipped code; we
//      pin BOTH the pure semantics AND the real source via static assertions so
//      a regression in routes/mycelium.js fails the suite.
//
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' (vitest.config.js) isolates this file's module state. initDB()
// writes only to the temp DATA_DIR — never the live mycelium.db.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = join(__dirname, '..', '..', 'server')

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-auth-cascade-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

// ----- raw seed helpers (satellite tables have no convenient exported creators) -----
// We use getDB() for tables whose exact columns no public creator covers, and the
// real exported functions (createAgent/createTask/updateTask/createMessage/
// addTaskComment) wherever they exist so the test exercises shipped code paths.

function seedBug(projectId, assignee) {
  return db
    .getDB()
    .prepare("INSERT INTO bugs (project_id, title, description, assignee) VALUES (?, ?, ?, ?) RETURNING id")
    .get(projectId, 'bug', 'desc', assignee).id
}
function seedDroneJob(requester, droneId) {
  return db
    .getDB()
    .prepare("INSERT INTO drone_jobs (title, requester, drone_id) VALUES (?, ?, ?) RETURNING id")
    .get('job', requester, droneId).id
}
function seedSavepoint(agentId) {
  return db
    .getDB()
    .prepare("INSERT INTO agent_savepoints (agent_id, heartbeat_at) VALUES (?, datetime('now')) RETURNING id")
    .get(agentId).id
}
function seedWebhook(agentId) {
  return db
    .getDB()
    .prepare("INSERT INTO webhooks (agent_id, url) VALUES (?, ?) RETURNING id")
    .get(agentId, 'https://example.test/hook').id
}
function seedMessageRead(messageId, agentId) {
  return db
    .getDB()
    .prepare("INSERT INTO message_reads (message_id, agent_id) VALUES (?, ?) RETURNING id")
    .get(messageId, agentId).id
}
function seedChannelMember(channelId, userId, userType) {
  return db
    .getDB()
    .prepare("INSERT INTO channel_members (channel_id, user_id, user_type) VALUES (?, ?, ?) RETURNING id")
    .get(channelId, userId, userType).id
}

function rowExists(table, id) {
  return !!db.getDB().prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)
}

describe('deleteAgent cascade integrity', () => {
  test('removes the agent and every owned satellite row across all 8 tables', () => {
    const agentId = 'victim-agent'
    const project = 'cascade-victim-proj'
    db.createAgent(agentId, 'Victim', project, 'hash-victim', '[]')

    // 1. tasks where assignee = agentId
    const taskAssigned = db.createTask('assigned to victim', '', project, 'requester', 'normal', '[]')
    db.updateTask(taskAssigned, { assignee: agentId })

    // 2. messages where from_agent = agentId OR to_agent = agentId
    const msgFrom = db.createMessage(agentId, 'someone', null, project, 'from victim', '{}', 'message', null, 'normal')
    const msgTo = db.createMessage('someone', agentId, null, project, 'to victim', '{}', 'message', null, 'normal')

    // 3. bugs where assignee = agentId
    const bug = seedBug(project, agentId)

    // 4. drone_jobs where requester = agentId OR drone_id = agentId
    const jobRequested = seedDroneJob(agentId, 'other-drone')
    const jobDrone = seedDroneJob('other-requester', agentId)

    // 5. agent_savepoints where agent_id = agentId
    const savepoint = seedSavepoint(agentId)

    // 6. webhooks where agent_id = agentId
    const webhook = seedWebhook(agentId)

    // 7. message_reads where agent_id = agentId
    const msgRead = seedMessageRead(msgFrom, agentId)

    // 8. channel_members where user_id = agentId AND user_type = 'agent'
    const chan = db.createChannel('cascade-chan', 'cascade-chan', 'general', null, null, '', 'admin')
    const channelMember = seedChannelMember(chan, agentId, 'agent')

    // Pre-conditions: everything is present.
    expect(db.getAgent(agentId)).toBeTruthy()
    expect(rowExists('tasks', taskAssigned)).toBe(true)
    expect(rowExists('messages', msgFrom)).toBe(true)
    expect(rowExists('messages', msgTo)).toBe(true)
    expect(rowExists('bugs', bug)).toBe(true)
    expect(rowExists('drone_jobs', jobRequested)).toBe(true)
    expect(rowExists('drone_jobs', jobDrone)).toBe(true)
    expect(rowExists('agent_savepoints', savepoint)).toBe(true)
    expect(rowExists('webhooks', webhook)).toBe(true)
    expect(rowExists('message_reads', msgRead)).toBe(true)
    expect(rowExists('channel_members', channelMember)).toBe(true)

    db.deleteAgent(agentId)

    // Post-conditions: the agent and ALL owned rows are gone (no orphans).
    expect(db.getAgent(agentId)).toBeFalsy()
    expect(rowExists('tasks', taskAssigned)).toBe(false)
    expect(rowExists('messages', msgFrom)).toBe(false)
    expect(rowExists('messages', msgTo)).toBe(false)
    expect(rowExists('bugs', bug)).toBe(false)
    expect(rowExists('drone_jobs', jobRequested)).toBe(false)
    expect(rowExists('drone_jobs', jobDrone)).toBe(false)
    expect(rowExists('agent_savepoints', savepoint)).toBe(false)
    expect(rowExists('webhooks', webhook)).toBe(false)
    expect(rowExists('message_reads', msgRead)).toBe(false)
    expect(rowExists('channel_members', channelMember)).toBe(false)
  })

  test('does NOT delete rows owned by other agents (scoped, not table-wide)', () => {
    const victim = 'scope-victim'
    const survivor = 'scope-survivor'
    const project = 'cascade-scope-proj'
    db.createAgent(victim, 'Victim', project, 'hash-scope-victim', '[]')
    db.createAgent(survivor, 'Survivor', project, 'hash-scope-survivor', '[]')

    // Survivor-owned rows in every cascaded table.
    const sTask = db.createTask('survivor task', '', project, 'requester', 'normal', '[]')
    db.updateTask(sTask, { assignee: survivor })
    const sMsg = db.createMessage(survivor, 'peer', null, project, 'survivor msg', '{}', 'message', null, 'normal')
    const sBug = seedBug(project, survivor)
    const sJob = seedDroneJob(survivor, 'survivor-drone')
    const sSavepoint = seedSavepoint(survivor)
    const sWebhook = seedWebhook(survivor)
    const sRead = seedMessageRead(sMsg, survivor)
    const sChan = db.createChannel('scope-chan', 'scope-chan', 'general', null, null, '', 'admin')
    const sMember = seedChannelMember(sChan, survivor, 'agent')

    // Victim has one row of each so deleteAgent has work to do.
    const vTask = db.createTask('victim task', '', project, 'requester', 'normal', '[]')
    db.updateTask(vTask, { assignee: victim })
    seedBug(project, victim)

    db.deleteAgent(victim)

    // Survivor and all its rows are untouched.
    expect(db.getAgent(survivor)).toBeTruthy()
    expect(rowExists('tasks', sTask)).toBe(true)
    expect(rowExists('messages', sMsg)).toBe(true)
    expect(rowExists('bugs', sBug)).toBe(true)
    expect(rowExists('drone_jobs', sJob)).toBe(true)
    expect(rowExists('agent_savepoints', sSavepoint)).toBe(true)
    expect(rowExists('webhooks', sWebhook)).toBe(true)
    expect(rowExists('message_reads', sRead)).toBe(true)
    expect(rowExists('channel_members', sMember)).toBe(true)
    // Victim's task is gone.
    expect(rowExists('tasks', vTask)).toBe(false)
  })

  test('channel_members cascade is user_type-scoped: an operator sharing the id survives', () => {
    // deleteAgent deletes channel_members WHERE user_id = ? AND user_type = 'agent'.
    // A non-agent member that happens to share the literal id must NOT be removed.
    const sharedId = 'shared-identity'
    db.createAgent(sharedId, 'AgentSide', 'cm-proj', 'hash-shared', '[]')
    const chanA = db.createChannel('cm-chan-a', 'cm-chan-a', 'general', null, null, '', 'admin')
    const chanB = db.createChannel('cm-chan-b', 'cm-chan-b', 'general', null, null, '', 'admin')
    const agentMember = seedChannelMember(chanA, sharedId, 'agent')
    const operatorMember = seedChannelMember(chanB, sharedId, 'operator')

    db.deleteAgent(sharedId)

    expect(rowExists('channel_members', agentMember)).toBe(false)
    expect(rowExists('channel_members', operatorMember)).toBe(true)
  })

  test('deleting an agent with no satellite rows still removes the agent and does not throw', () => {
    const lonely = 'lonely-agent'
    db.createAgent(lonely, 'Lonely', 'lonely-proj', 'hash-lonely', '[]')
    expect(db.getAgent(lonely)).toBeTruthy()
    expect(() => db.deleteAgent(lonely)).not.toThrow()
    expect(db.getAgent(lonely)).toBeFalsy()
  })

  test('deleting a nonexistent agent is a harmless no-op', () => {
    expect(() => db.deleteAgent('no-such-agent-id')).not.toThrow()
  })
})

describe('deleteTask comment cleanup + return value', () => {
  test('deletes task_comments first, then the task, and returns true', () => {
    const project = 'task-del-proj'
    const taskId = db.createTask('task to delete', '', project, 'requester', 'normal', '[]')
    const c1 = db.addTaskComment(taskId, 'm5Max', 'first comment')
    const c2 = db.addTaskComment(taskId, 'Lucy', 'second comment')

    expect(db.getTaskComments(taskId)).toHaveLength(2)
    expect(rowExists('task_comments', c1.id)).toBe(true)
    expect(rowExists('task_comments', c2.id)).toBe(true)

    const result = db.deleteTask(taskId)

    expect(result).toBe(true)
    expect(db.getTask(taskId)).toBeFalsy()
    // Comments are explicitly cleaned up (no orphaned task_comments rows).
    expect(rowExists('task_comments', c1.id)).toBe(false)
    expect(rowExists('task_comments', c2.id)).toBe(false)
    expect(db.getTaskComments(taskId)).toHaveLength(0)
  })

  test('returns true for a task with no comments', () => {
    const taskId = db.createTask('no-comment task', '', 'task-del-proj', 'requester', 'normal', '[]')
    expect(db.deleteTask(taskId)).toBe(true)
    expect(db.getTask(taskId)).toBeFalsy()
  })

  test('returns false when the task does not exist (changes === 0)', () => {
    expect(db.deleteTask(999999)).toBe(false)
  })

  test('does not delete comments belonging to OTHER tasks', () => {
    const project = 'task-del-scope-proj'
    const victimTask = db.createTask('victim task', '', project, 'requester', 'normal', '[]')
    const survivorTask = db.createTask('survivor task', '', project, 'requester', 'normal', '[]')
    const victimComment = db.addTaskComment(victimTask, 'm5Max', 'victim comment')
    const survivorComment = db.addTaskComment(survivorTask, 'm5Max', 'survivor comment')

    db.deleteTask(victimTask)

    expect(rowExists('task_comments', victimComment.id)).toBe(false)
    expect(rowExists('task_comments', survivorComment.id)).toBe(true)
    expect(db.getTask(survivorTask)).toBeTruthy()
  })

  test('deleteTaskComment returns true on a real comment, false on a missing one', () => {
    const taskId = db.createTask('comment-return task', '', 'task-del-proj', 'requester', 'normal', '[]')
    const comment = db.addTaskComment(taskId, 'm5Max', 'to be deleted')

    expect(db.deleteTaskComment(comment.id)).toBe(true)
    expect(rowExists('task_comments', comment.id)).toBe(false)
    // Second delete of the same id now misses.
    expect(db.deleteTaskComment(comment.id)).toBe(false)
    expect(db.deleteTaskComment(888888)).toBe(false)
    // The parent task is untouched by a comment-only delete.
    expect(db.getTask(taskId)).toBeTruthy()
  })
})

describe('isAdminKey auth wiring', () => {
  // --- Part A: the pure comparator contract the route helper must satisfy. ---
  // isAdminKey is module-private (not exported), so we pin the INTENDED semantics
  // here and then verify (Part B) that the shipped source actually implements
  // them — the local replica alone proves nothing about production code.
  function isAdminKeyReplica(key, adminKey) {
    return (
      !!key &&
      !!adminKey &&
      key.length === adminKey.length &&
      crypto.timingSafeEqual(Buffer.from(key), Buffer.from(adminKey))
    )
  }

  const ADMIN_KEY = 'correct-horse-battery-staple-1234'

  test('accepts the exact admin key', () => {
    expect(isAdminKeyReplica(ADMIN_KEY, ADMIN_KEY)).toBe(true)
  })

  test('rejects a same-length but wrong key (constant-time path still says no)', () => {
    const wrong = 'X'.repeat(ADMIN_KEY.length)
    expect(wrong.length).toBe(ADMIN_KEY.length)
    expect(isAdminKeyReplica(wrong, ADMIN_KEY)).toBe(false)
  })

  test('rejects a different-length key WITHOUT calling timingSafeEqual (length guard)', () => {
    // timingSafeEqual throws on unequal buffer lengths; the guard must short-circuit.
    expect(() => isAdminKeyReplica(ADMIN_KEY + 'extra', ADMIN_KEY)).not.toThrow()
    expect(isAdminKeyReplica(ADMIN_KEY + 'extra', ADMIN_KEY)).toBe(false)
    expect(isAdminKeyReplica(ADMIN_KEY.slice(0, -1), ADMIN_KEY)).toBe(false)
  })

  test('rejects empty / undefined / null keys without throwing', () => {
    expect(isAdminKeyReplica('', ADMIN_KEY)).toBe(false)
    expect(isAdminKeyReplica(undefined, ADMIN_KEY)).toBe(false)
    expect(isAdminKeyReplica(null, ADMIN_KEY)).toBe(false)
  })

  test('rejects everything when no admin key is configured (empty/undefined ADMIN_KEY)', () => {
    expect(isAdminKeyReplica('anything', '')).toBe(false)
    expect(isAdminKeyReplica('anything', undefined)).toBe(false)
  })

  // --- Part B: the shipped source must implement that contract AND invoke it. ---
  // These static-source assertions are what actually guard the public repo: if a
  // future edit downgrades the comparator to === / == or stops calling isAdminKey
  // on a protected helper, the suite fails. (A prior overreach silently rewrote
  // auth/cascade code; nothing pinned it.)
  const routesSrc = readFileSync(join(SERVER_DIR, 'routes', 'mycelium.js'), 'utf8')
  const indexSrc = readFileSync(join(SERVER_DIR, 'index.js'), 'utf8')

  function isAdminKeyBody(src) {
    // Capture the body of `function isAdminKey(key) { ... }` (first match).
    const m = src.match(/function isAdminKey\s*\(\s*key\s*\)\s*\{([\s\S]*?)\n\}/)
    expect(m, 'isAdminKey definition not found').toBeTruthy()
    return m[1]
  }

  test('routes/mycelium.js isAdminKey uses constant-time compare + length guard', () => {
    const body = isAdminKeyBody(routesSrc)
    expect(body).toContain('crypto.timingSafeEqual')
    expect(body).toMatch(/\.length\s*===?\s*ADMIN_KEY\.length/)
    // Must not have been downgraded to a plain string equality check.
    expect(body).not.toMatch(/key\s*===?\s*ADMIN_KEY\b/)
  })

  test('index.js isAdminKey uses constant-time compare + length guard', () => {
    const body = isAdminKeyBody(indexSrc)
    expect(body).toContain('crypto.timingSafeEqual')
    expect(body).toMatch(/key\.length\s*===?\s*expected\.length/)
    expect(body).not.toMatch(/key\s*===?\s*expected\b(?!\.length)/)
  })

  test('protected route helpers actually invoke isAdminKey (not bypassed)', () => {
    // Pull each helper body and assert isAdminKey appears inside it. This is the
    // "is it actually invoked on protected routes" guarantee the smoke test lacked.
    for (const fn of ['checkAdmin', 'checkAdminOrOperator', 'checkAgentOrAdmin']) {
      const m = routesSrc.match(new RegExp(`function ${fn}\\s*\\(req, res\\)\\s*\\{([\\s\\S]*?)\\n\\}`))
      expect(m, `${fn} definition not found`).toBeTruthy()
      expect(m[1], `${fn} must call isAdminKey`).toContain('isAdminKey(')
    }
  })

  test('index.js voice auth invokes isAdminKey', () => {
    const m = indexSrc.match(/function checkVoiceAuth\s*\(req, res\)\s*\{([\s\S]*?)\n\}/)
    expect(m, 'checkVoiceAuth definition not found').toBeTruthy()
    expect(m[1]).toContain('isAdminKey(')
  })
})
