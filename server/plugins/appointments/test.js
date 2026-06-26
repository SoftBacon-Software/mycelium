import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import createAppointmentsDB from './db.js';

const here = dirname(fileURLToPath(import.meta.url));

function makeDB() {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}

test('upsert returns parsed row; getAppointment returns parsed flag_overrides/capability', () => {
  const db = makeDB();
  const api = createAppointmentsDB(db);

  const created = api.upsertAppointment('coder', {
    model_id: 'gpt-4o',
    engine: 'openai',
    host: 'api.openai.com',
    flag_overrides: { streaming: true, temperature: 0.2 },
    capability: { tools: true, vision: false },
  });

  assert.equal(created.role, 'coder');
  assert.equal(created.model_id, 'gpt-4o');
  assert.equal(created.engine, 'openai');
  assert.equal(created.host, 'api.openai.com');
  assert.deepEqual(created.flag_overrides, { streaming: true, temperature: 0.2 });
  assert.deepEqual(created.capability, { tools: true, vision: false });
  assert.ok(typeof created.updated_at === 'string' && created.updated_at.length > 0);

  const got = api.getAppointment('coder');
  assert.equal(got.role, 'coder');
  assert.deepEqual(got.flag_overrides, { streaming: true, temperature: 0.2 });
  assert.deepEqual(got.capability, { tools: true, vision: false });
});

test('getAppointments includes upserted row', () => {
  const db = makeDB();
  const api = createAppointmentsDB(db);

  api.upsertAppointment('coder', {
    model_id: 'gpt-4o', engine: 'openai', host: 'api.openai.com',
    flag_overrides: { x: 1 }, capability: { y: 2 },
  });

  const all = api.getAppointments();
  assert.equal(all.length, 1);
  assert.equal(all[0].role, 'coder');
  assert.deepEqual(all[0].flag_overrides, { x: 1 });
  assert.deepEqual(all[0].capability, { y: 2 });
});

test('re-upsert with new model_id updates in place (still one row)', () => {
  const db = makeDB();
  const api = createAppointmentsDB(db);

  api.upsertAppointment('coder', {
    model_id: 'gpt-4o', engine: 'openai', host: 'api.openai.com',
    flag_overrides: {}, capability: {},
  });
  api.upsertAppointment('coder', {
    model_id: 'claude-3-5-sonnet', engine: 'anthropic', host: 'api.anthropic.com',
    flag_overrides: { beta: true }, capability: { tools: true },
  });

  const all = api.getAppointments();
  assert.equal(all.length, 1);

  const row = api.getAppointment('coder');
  assert.equal(row.model_id, 'claude-3-5-sonnet');
  assert.equal(row.engine, 'anthropic');
  assert.equal(row.host, 'api.anthropic.com');
  assert.deepEqual(row.flag_overrides, { beta: true });
  assert.deepEqual(row.capability, { tools: true });
});

test('deleteAppointment removes the row', () => {
  const db = makeDB();
  const api = createAppointmentsDB(db);

  api.upsertAppointment('coder', {
    model_id: 'gpt-4o', engine: 'openai', host: 'api.openai.com',
    flag_overrides: {}, capability: {},
  });

  const result = api.deleteAppointment('coder');
  assert.equal(result.ok, true);
  assert.equal(result.changes, 1);
  assert.equal(api.getAppointment('coder'), null);

  const second = api.deleteAppointment('coder');
  assert.equal(second.ok, false);
  assert.equal(second.changes, 0);
});

test('getAppointment on unknown role returns null', () => {
  const db = makeDB();
  const api = createAppointmentsDB(db);
  assert.equal(api.getAppointment('nope'), null);
});
