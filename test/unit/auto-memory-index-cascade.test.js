// =============== AUTO-MEMORY -> SEARCH INDEX CASCADE ===============
// Bug #20. Removing a fact from am_facts used to leave its sm_embeddings row
// behind, so a deleted or superseded fact stayed fully searchable — embedded,
// ranking normally, with nothing to signal that its source no longer existed.
//
// This is the mirror of MEMORY-FAILURE-STATES §F4. §F4 was "written but not
// retrievable"; this was "deleted but still retrieved", which is worse: a
// correction workflow that deletes a wrong fact left the wrong fact in the index.
//
// Five paths remove a fact from CURRENT, and each one must also remove it from
// SEARCHABLE. A test per path, because they were all missing it independently.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import createAutoMemoryDB from '../../server/plugins/auto-memory/db.js';

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var PLUGINS = path.join(__dirname, '..', '..', 'server', 'plugins');

// Real schemas, not hand-rolled fixtures — a fixture that drifts from the shipped
// DDL would pass while production breaks.
function loadSchema(db, plugin) {
  db.exec(fs.readFileSync(path.join(PLUGINS, plugin, 'schema.sql'), 'utf8'));
}

// Mirrors indexFactInMemory() in auto-memory/routes.js: source_type 'memory',
// source_id the fact id as TEXT.
function indexFact(db, factId, text, chunkIndex) {
  db.prepare(
    "INSERT INTO sm_embeddings (source_type, source_id, chunk_index, content_text) VALUES ('memory', ?, ?, ?)"
  ).run(String(factId), chunkIndex || 0, text);
}

function indexedRows(db, factId) {
  return db.prepare(
    "SELECT COUNT(*) AS c FROM sm_embeddings WHERE source_type = 'memory' AND source_id = ?"
  ).get(String(factId)).c;
}

function agedFact(db, id, days) {
  db.prepare("UPDATE am_facts SET updated_at = datetime('now', '-' || ? || ' days') WHERE id = ?").run(days, id);
}

describe('auto-memory removes facts from the search index (bug #20)', () => {
  var db, am;

  beforeEach(() => {
    db = new Database(':memory:');
    loadSchema(db, 'auto-memory');
    loadSchema(db, 'semantic-memory');
    am = createAutoMemoryDB(db);
  });

  it('deleteFact removes the fact row AND its index row', () => {
    var id = am.createFact('m5Max', null, 'pattern', 'a deletable fact', 0.9);
    indexFact(db, id, 'a deletable fact');
    expect(indexedRows(db, id)).toBe(1);

    var removed = am.deleteFact(id);

    expect(am.getFact(id)).toBeFalsy();
    expect(indexedRows(db, id)).toBe(0);
    expect(removed).toBe(1); // reported honestly, so the route can surface it
  });

  it('deleteFact removes EVERY chunk of a chunk-split fact', () => {
    var id = am.createFact('m5Max', null, 'pattern', 'a long fact', 0.9);
    indexFact(db, id, 'chunk zero', 0);
    indexFact(db, id, 'chunk one', 1);
    indexFact(db, id, 'chunk two', 2);
    expect(indexedRows(db, id)).toBe(3);

    expect(am.deleteFact(id)).toBe(3);
    expect(indexedRows(db, id)).toBe(0);
  });

  it('supersedeFact unindexes the OLD fact and leaves the replacement searchable', () => {
    var oldId = am.createFact('m5Max', null, 'decision', 'the panic was a RAM cliff', 0.8);
    var newId = am.createFact('m5Max', null, 'decision', 'the panic was a KV write storm', 0.9);
    indexFact(db, oldId, 'the panic was a RAM cliff');
    indexFact(db, newId, 'the panic was a KV write storm');

    am.supersedeFact(oldId, newId);

    // The superseded fact must stop competing with the fact that replaced it.
    expect(indexedRows(db, oldId)).toBe(0);
    expect(indexedRows(db, newId)).toBe(1);
    // The row itself survives in am_facts for provenance — only CURRENT changes.
    expect(db.prepare('SELECT superseded_by FROM am_facts WHERE id = ?').get(oldId).superseded_by).toBe(newId);
  });

  it('pruneLowConfidence unindexes the facts it decays away', () => {
    var doomed = am.createFact('m5Max', null, 'pattern', 'a shaky low-confidence claim', 0.1);
    var keep = am.createFact('m5Max', null, 'pattern', 'a solid claim', 0.95);
    agedFact(db, doomed, 30); // past the 7-day age guard
    agedFact(db, keep, 30);
    indexFact(db, doomed, 'a shaky low-confidence claim');
    indexFact(db, keep, 'a solid claim');

    var pruned = am.pruneLowConfidence(0.5);

    expect(pruned).toBe(1);
    // Decay-pruned facts are the ones the system judged least trustworthy —
    // leaving them searchable would rank exactly what it decided to retire.
    expect(indexedRows(db, doomed)).toBe(0);
    expect(indexedRows(db, keep)).toBe(1); // above threshold — untouched

    // Decay-prune SELF-supersedes (superseded_by = own id) rather than using the
    // old -1 sentinel, which violated the superseded_by -> am_facts(id) FK under
    // foreign_keys=ON and meant nothing was ever pruned in prod. Assert the
    // FK-safe form so a regression to a sentinel value fails here.
    var row = db.prepare('SELECT superseded_by, valid_to FROM am_facts WHERE id = ?').get(doomed);
    expect(row.superseded_by).toBe(doomed);
    expect(row.valid_to).toBeTruthy(); // validity interval closed
  });

  it('pruneLowConfidence leaves fresh facts alone (7-day age guard holds)', () => {
    var fresh = am.createFact('m5Max', null, 'pattern', 'new and unsure', 0.1);
    indexFact(db, fresh, 'new and unsure');

    // No row matches the age guard, so the UPDATE touches nothing and never
    // reaches the invalid sentinel — this path returns cleanly today.
    expect(am.pruneLowConfidence(0.5)).toBe(0);
    expect(indexedRows(db, fresh)).toBe(1); // not pruned, so must stay searchable
  });

  it('pruneOldSuperseded unindexes the rows it hard-deletes', () => {
    var oldId = am.createFact('m5Max', null, 'decision', 'stale superseded fact', 0.8);
    var newId = am.createFact('m5Max', null, 'decision', 'current fact', 0.9);
    am.supersedeFact(oldId, newId);
    // supersedeFact already unindexed it; re-index to prove the prune path alone works.
    indexFact(db, oldId, 'stale superseded fact');
    agedFact(db, oldId, 90);

    var pruned = am.pruneOldSuperseded('30 days');

    expect(pruned).toBe(1);
    expect(indexedRows(db, oldId)).toBe(0);
  });

  it('pruneExcessFacts unindexes the overflow it deletes', () => {
    var ids = [];
    for (var i = 0; i < 5; i++) {
      var id = am.createFact('m5Max', null, 'pattern', 'fact number ' + i, 0.8);
      indexFact(db, id, 'fact number ' + i);
      ids.push(id);
    }
    expect(am.pruneExcessFacts('m5Max', 2)).toBe(3);

    var remaining = ids.filter(function (id) { return indexedRows(db, id) > 0; });
    expect(remaining.length).toBe(2); // index count tracks the fact count
    var factCount = db.prepare("SELECT COUNT(*) AS c FROM am_facts WHERE agent_id = 'm5Max'").get().c;
    expect(factCount).toBe(2);
  });

  it('degrades quietly when semantic-memory is not loaded', () => {
    // A platform running auto-memory WITHOUT semantic-memory is a normal
    // deployment: sm_embeddings simply does not exist. Deleting a fact must
    // still work rather than throwing on the missing table.
    var bare = new Database(':memory:');
    loadSchema(bare, 'auto-memory');
    var bareAm = createAutoMemoryDB(bare);
    var id = bareAm.createFact('m5Max', null, 'pattern', 'no index here', 0.9);

    expect(function () { bareAm.deleteFact(id); }).not.toThrow();
    expect(bareAm.getFact(id)).toBeFalsy();
    expect(bareAm.deleteFact(id)).toBe(0); // nothing to unindex, reported as 0
  });
});
