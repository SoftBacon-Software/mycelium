// The squad's landing tool (jarvis squad/landing.py) posts kind=landed on
// POST /workflows/:id/events after it merges a run's work into its trunk.
// 2026-09-13: the platform 400'd it ("kind must be one of: …") — wf#575/577
// landed with no landed event on the record. This pins the kind.
import { test, expect } from 'vitest'
import { EVENT_KINDS } from '../../server/plugins/workflows/db.js'

test('workflow event kinds accept a squad landing', () => {
  expect(EVENT_KINDS).toContain('landed')
  expect(EVENT_KINDS).toContain('completed')
})
