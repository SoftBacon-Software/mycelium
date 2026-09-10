#!/usr/bin/env node
// migrate-lessons-md.mjs — one-time (idempotent) migration of jarvis/squad/lessons.md
// into Mycelium lesson rows. F-mycelium/186, BRIEF-lab-alive-memory-program §1.
//
// Why this exists: the lab's lessons lived in lessons.md (58 `## <date> — <title>`
// entries), in auto-memory files, and in DONE messages — none of which a seat reads
// at the moment it matters. The directive: "each agent does better today because
// they remember the lessons and history of yesterday." A lesson only does that as a
// MEMORY ROW — embedded, searchable, recallable by class/repo/date with provenance.
// After migration lessons.md becomes a rendered VIEW of the store, never the store.
//
// Row shape (the §1 contract, enforced at POST /memory/index by the semantic-memory
// provenance gate):
//   source_type  'lesson'
//   source_id    'lessons-md:<date>:<slug-of-title>'  — idempotent: derived ONLY
//                from date+title, so re-running overwrites the same rows, never dupes
//   metadata     symptom, fix_or_rule, task_class ('migrated' — legacy entries predate
//                the scoreboard vocabulary; reclassify in a later pass), repo
//                ('jarvis' — the file's home; per-entry repos are a later pass),
//                actor ('squad'), origin ({lane_task: F-mycelium/186}), outcome
//                ('migrated'), evidence ('<file>#<heading>' — the file path + the
//                entry heading, exactly what the brief asks provenance to name),
//                learned_at (the **Date:** line, else the heading date)
//   content_text title + Symptom + Fix + Learned — the searchable text
//
// An entry is REFUSED (counted, never posted) when the route would refuse it or
// when there is nothing to learn: no derivable learned_at, or neither Symptom nor
// Fix. Refusals are listed with their reason — the migration is honest about what
// it left behind.
//
// Usage:
//   node tools/migrate-lessons-md.mjs <path/to/lessons.md> [--url URL] [--key KEY]
//                                     [--dry-run] [--allow-remote]
//
//   --url          platform base (default http://127.0.0.1:3002)
//   --key          admin key (default $MYCELIUM_API_KEY, then $ADMIN_KEY)
//   --dry-run      parse + report only; nothing is posted
//   --allow-remote permit a non-loopback --url. The default refuses it: this tool
//                  is run against a LOCAL server (the director runs the real
//                  migration after deploy) — a stray remote URL must be a loud,
//                  explicit act, never a typo.
//
// Exit codes: 0 = every entry parsed + indexed (or dry-run clean);
//             1 = any refusal or failed post; 2 = usage/env error.

const REQUIRED = ['actor', 'learned_at', 'evidence'];

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'untitled';
}

// Split the file into entry records. Three heading shapes exist in the real
// file (checked 2026-09-10):
//   primary:  ## 2026-09-09 — title here            (the §1 spec shape)
//   legacy:   ## 2026-07-03 19:10 | sal=8           (log-era; title = bold headline)
//   bare:     ## Pipeline ada→lucy: …               (date only via a **Date:** line)
function splitEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      if (cur) entries.push(cur);
      const heading = m[1].trim();
      const dash = /^(\d{4}-\d{2}-\d{2})\s+—\s+(.+)$/.exec(heading);
      const pipe = /^(\d{4}-\d{2}-\d{2})(?:\s+\d{2}:\d{2})?\s*\|\s*(.*)$/.exec(heading);
      cur = {
        heading,
        headingDate: dash ? dash[1] : (pipe ? pipe[1] : null),
        headingShape: dash ? 'dash' : (pipe ? 'pipe' : 'bare'),
        title: dash ? dash[2].trim() : heading,
        body: [],
      };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

// Capture a `**Label:**` section's text: from the label line until the next
// label line / heading. Multi-line bodies join with a space (the md hard-wraps).
function extractSection(bodyLines, labels) {
  const labelRe = new RegExp('^\\*\\*(' + labels.join('|') + ')[^*]*\\*\\*\\s*(.*)$');
  let capturing = false;
  const parts = [];
  for (const line of bodyLines) {
    const m = labelRe.exec(line.trim());
    if (m) {
      capturing = true;
      if (m[2]) parts.push(m[2]);
      continue;
    }
    if (!capturing) continue;
    if (/^\*\*[^*]+\*\*/.test(line.trim()) || /^##\s/.test(line)) break; // next section
    if (line.trim()) parts.push(line.trim());
  }
  return parts.join(' ').trim();
}

// The first bold segment of the body — the legacy shape's headline (the lesson
// statement itself, e.g. "**Output-gate false-nudge on recalled prior-work paths…**").
function boldHeadline(bodyLines) {
  for (const line of bodyLines) {
    const m = /^\*\*(.+?)(\*\*)?\s*$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return '';
}

// Legacy entries narrate the fix inside the prose ("FIX (m5Max — gate-critical
// file): …"). Take everything from the first FIX marker to the end of the body
// — lossy as structure, lossless as recall (the full body is in content_text).
function fixNarrative(bodyLines) {
  const body = bodyLines.join('\n');
  const m = /\bFIX(?:ED)?\b[^:.]{0,80}:\s*([\s\S]+)$/.exec(body);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// Parse → { rows, refused, byShape }. Rows are ready for POST /memory/index.
export function parseLessonsMd(text, { sourcePath = 'lessons.md', laneTask = 'F-mycelium/186-lessons-become-memory-rows' } = {}) {
  const rows = [];
  const refused = [];
  const byShape = { dash: 0, pipe: 0, bare: 0 };
  for (const e of splitEntries(text)) {
    let symptom = extractSection(e.body, ['Symptom']);
    let fix = extractSection(e.body, ['Fix', 'Rule']);
    const dm = /^\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/.exec(e.body.map((l) => l.trim()).find((l) => l.startsWith('**Date:')) || '');
    const learnedAt = dm ? dm[1] : e.headingDate;

    // Legacy fallbacks: a pipe/bare entry with no **Symptom:**/**Fix:** labels
    // still yields its lesson — the bold headline IS the symptom statement, the
    // FIX(...) narrative the fix. The full body rides in content_text either way.
    // For pipe headings the headline also becomes the TITLE (the heading itself
    // is log boilerplate — e.g. two different lessons both headed "2026-07-06 |
    // m5Max", which would otherwise collide on the date+title source_id).
    let title = e.title;
    if (e.headingShape !== 'dash' && !symptom && !fix) {
      const headline = boldHeadline(e.body);
      if (headline) {
        symptom = headline;
        if (e.headingShape === 'pipe') title = headline;
      }
      fix = fixNarrative(e.body);
    }

    function refuse(reason) {
      refused.push({ title: e.title, heading: e.heading, reason });
    }

    if (!learnedAt) { refuse('no learned_at (no **Date:** line and no date in the heading)'); continue; }
    if (!symptom && !fix) { refuse('nothing to learn (no **Symptom:** and no **Fix:** text)'); continue; }

    // Belt-and-braces: the same trio the route's provenance gate refuses on.
    const metadata = {
      symptom,
      fix_or_rule: fix,
      task_class: 'migrated',
      repo: 'jarvis',
      actor: 'squad',
      origin: { lane_task: laneTask },
      outcome: 'migrated',
      evidence: sourcePath + '#' + e.heading,
      learned_at: learnedAt,
    };
    const missing = REQUIRED.filter((f) => !metadata[f] || String(metadata[f]).trim().length === 0);
    if (missing.length > 0) { refuse('missing provenance: ' + missing.join(', ')); continue; }

    // Legacy shapes keep their FULL body in the searchable text (the structured
    // split is best-effort); the primary shape gets the clean §1 composition.
    const content = e.headingShape === 'dash'
      ? [title, symptom ? 'Symptom: ' + symptom : '', fix ? 'Fix: ' + fix : '', 'Learned: ' + learnedAt].filter(Boolean).join('\n\n')
      : [title, e.body.join('\n').trim(), 'Learned: ' + learnedAt].filter(Boolean).join('\n\n');

    rows.push({
      source_type: 'lesson',
      source_id: 'lessons-md:' + learnedAt + ':' + slugify(title),
      content_text: content,
      metadata,
    });
    byShape[e.headingShape]++;
  }
  return { rows, refused, byShape };
}

// Migrate a file through a post(row) transport. The CLI binds post() to fetch
// against POST /memory/index; tests bind the same contract to supertest so the
// COMPOSITION (parse → route gate → recall) is what is verified.
export async function migrateLessonsMd(filePath, { post, fsModule = null } = {}) {
  const fs = fsModule || await import('fs');
  const text = fs.readFileSync(filePath, 'utf8');
  const { rows, refused } = parseLessonsMd(text, { sourcePath: filePath });
  let indexed = 0;
  const failed = [];
  for (const row of rows) {
    try {
      await post(row);
      indexed++;
    } catch (err) {
      failed.push({ source_id: row.source_id, error: String(err.message || err) });
    }
  }
  return { parsed: rows.length, indexed, refused, failed, file: filePath };
}

// ---- CLI ----

function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const arg = (name, def = null) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
  };
  const flag = (name) => argv.includes('--' + name);

  if (!file || flag('help')) {
    console.error('usage: node tools/migrate-lessons-md.mjs <lessons.md> [--url URL] [--key KEY] [--dry-run] [--allow-remote]');
    process.exit(2);
  }
  const url = (arg('url') || 'http://127.0.0.1:3002').replace(/\/$/, '');
  const key = arg('key') || process.env.MYCELIUM_API_KEY || process.env.ADMIN_KEY;
  const dryRun = flag('dry-run');
  const allowRemote = flag('allow-remote');

  if (!isLoopback(url) && !allowRemote) {
    console.error('REFUSING non-loopback url ' + url + ' — this migration runs against a LOCAL server.');
    console.error('The director runs it against the deployed platform after review. Pass --allow-remote to override.');
    process.exit(2);
  }
  if (!dryRun && !key) {
    console.error('no admin key: pass --key or set MYCELIUM_API_KEY (or ADMIN_KEY), or use --dry-run');
    process.exit(2);
  }

  const report = await migrateLessonsMd(file, {
    post: dryRun
      ? async () => { /* dry-run: nothing leaves */ }
      : async (row) => {
          // the mycelium sub-router mounts at /api/mycelium; plugin routes at
          // /api/mycelium/memory/* (verified live: bare /memory/* 404s)
          const res = await fetch(url + '/api/mycelium/memory/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
            body: JSON.stringify(row),
          });
          if (!res.ok) {
            const body = await res.text();
            throw new Error('POST /memory/index -> ' + res.status + ': ' + body.slice(0, 200));
          }
        },
  });

  console.log('file:     ' + report.file);
  console.log('target:   ' + (dryRun ? '(dry-run — nothing posted)' : url));
  console.log('parsed:   ' + report.parsed + (report.byShape ? ' (dash-shape ' + report.byShape.dash + ', legacy ' + (report.byShape.pipe + report.byShape.bare) + ')' : ''));
  console.log('indexed:  ' + report.indexed);
  for (const r of report.refused) console.log('REFUSED:  "' + r.title + '" — ' + r.reason);
  for (const f of report.failed) console.log('FAILED:   ' + f.source_id + ' — ' + f.error);
  const bad = report.refused.length + report.failed.length;
  console.log('done: ' + report.indexed + ' indexed, ' + report.refused.length + ' refused, ' + report.failed.length + ' failed');
  process.exit(bad > 0 ? 1 : 0);
}

// imported as a module (the tests do exactly this) → no CLI side effects
if (process.argv[1] && (process.argv[1].endsWith('migrate-lessons-md.mjs'))) {
  main().catch((e) => {
    console.error('migration failed:', e.message);
    process.exit(2);
  });
}
