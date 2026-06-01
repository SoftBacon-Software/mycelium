import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the REAL db.js task-lifecycle functions against a fresh temp DB.
// db.js reads DATA_DIR at module-eval time, so set it before the dynamic import.
// pool:'forks' isolates this file's module state. initDB() writes only to the
// temp DATA_DIR — never the live mycelium.db.

let tmpDataDir
let db

beforeAll(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'myc-db-tasks-'))
  process.env.DATA_DIR = tmpDataDir
  db = await import('../../server/db.js')
  db.initDB()
})

afterAll(() => {
  if (tmpDataDir) rmSync(tmpDataDir, { recursive: true, force: true })
})

describe('task lifecycle via db.js', () => {
  test('createTask returns an id; getTask shows defaults', () => {
    const id = db.createTask('Wire up the cockpit', 'desc', '', 'm5Max', 'normal', '[]')
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)

    const task = db.getTask(id)
    expect(task).toBeTruthy()
    expect(task.title).toBe('Wire up the cockpit')
    // Defaults straight from schema.sql / createTask.
    expect(task.status).toBe('open')
    expect(task.needs_approval).toBe(0)
    expect(task.blocked_by).toBe('[]')
  })

  test('updateTask transitions status (open -> in_progress -> done) and sets assignee', () => {
    const id = db.createTask('Squad face topology', '', '', 'm5Max', 'normal', '[]')
    expect(db.getTask(id).status).toBe('open')

    db.updateTask(id, { status: 'in_progress', assignee: 'Lucy' })
    let task = db.getTask(id)
    expect(task.status).toBe('in_progress')
    expect(task.assignee).toBe('Lucy')

    db.updateTask(id, { status: 'done' })
    task = db.getTask(id)
    expect(task.status).toBe('done')
    // assignee persists across the transition.
    expect(task.assignee).toBe('Lucy')
  })

  test('listTasks filters by status and assignee', () => {
    // Distinct project_id keeps this test's rows out of other tests' filters.
    const project = 'velum-filter-test'
    const a = db.createTask('A', '', project, 'm5Max', 'normal', '[]')
    const b = db.createTask('B', '', project, 'm5Max', 'normal', '[]')
    const c = db.createTask('C', '', project, 'm5Max', 'normal', '[]')

    db.updateTask(a, { status: 'in_progress', assignee: 'Echo' })
    db.updateTask(b, { status: 'done', assignee: 'Echo' })
    db.updateTask(c, { status: 'in_progress', assignee: 'Ada' })

    // Filter by status within this project.
    const inProgress = db
      .listTasks({ project_id: project, status: 'in_progress' })
      .map((t) => t.id)
      .sort((x, y) => x - y)
    expect(inProgress).toEqual([a, c].sort((x, y) => x - y))

    // Filter by assignee within this project.
    const echoTasks = db
      .listTasks({ project_id: project, assignee: 'Echo' })
      .map((t) => t.id)
      .sort((x, y) => x - y)
    expect(echoTasks).toEqual([a, b].sort((x, y) => x - y))

    // Combined status + assignee filter.
    const echoDone = db
      .listTasks({ project_id: project, assignee: 'Echo', status: 'done' })
      .map((t) => t.id)
    expect(echoDone).toEqual([b])
  })
})
