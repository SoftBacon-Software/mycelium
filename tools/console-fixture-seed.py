#!/usr/bin/env python3
"""Seed a SCRATCH mycelium instance for console development shots (task 89).

Replays REAL rows from the live lab platform into a scratch db through the
platform's own write APIs — the console bakes nothing, and these fixtures are
documented, reproducible, and disposable. NEVER point this at a platform you
cannot wipe: it writes agents, workflows, lessons and events.

Usage:
  python3 tools/console-fixture-seed.py <live-url> <live-admin-key> \
         <scratch-url> <scratch-admin-key>

The scratch instance must be booted with its own DATA_DIR (e.g.
DATA_DIR=/tmp/k89-scratch-db) so the real store is never touched.
"""

import json
import subprocess
import sys


def call(base, key, path, body=None, method=None):
    """curl transport — bare Homebrew python3 cannot reach the LAN on this Mac;
    curl can (lane lesson, 2026-09-17)."""
    cmd = ['curl', '-s', '-m', '20', '-w', '\\n%{http_code}',
           '-H', 'X-Admin-Key: ' + key, '-H', 'Content-Type: application/json']
    if method:
        cmd += ['-X', method]
    if body is not None:
        cmd += ['-d', json.dumps(body)]
    cmd.append(base.rstrip('/') + '/api/mycelium' + path)
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    body_txt, _, code = out.rpartition('\n')
    try:
        return int(code), json.loads(body_txt or '{}')
    except ValueError:
        return 0, {}


def main():
    live_url, live_key, scratch_url, scratch_key = sys.argv[1:5]
    # optional 5th arg: comma list of sections to (re)run, e.g. "agents" —
    # lets a re-seed top up one section without duplicating the others
    wanted = set((sys.argv[5] if len(sys.argv) > 5 else
                  'studio,agents,workflows,lessons,events').split(','))
    ok = True

    # 1. a studio operator to sign in as
    if 'studio' in wanted:
        st, r = call(scratch_url, scratch_key, '/studio/users', {
            'username': 'operator', 'password': 'console-fixtures-2026',
            'display_name': 'Console Operator', 'role': 'admin'})
        print('studio user:', st, '' if st in (200, 409) else r)
        ok &= st in (200, 409)

    # 2. the roster — only agents that are REALLY online on the live platform
    #    get a heartbeat here (a heartbeat is liveness; replaying an offline
    #    agent as fresh would manufacture presence). The row must EXIST first:
    #    heartbeat is UPDATE-only and 200s with zero rows on an unknown id, so
    #    register via POST /admin/agents (409 = already there) before beating.
    if 'agents' in wanted:
        st, agents = call(live_url, live_key, '/agents')
        print('live roster:', st, len(agents))
        online = [a for a in agents if a.get('status') == 'online']
        made = 0
        for a in online:
            st, _ = call(scratch_url, scratch_key, '/admin/agents', {
                'id': a['id'], 'name': a.get('name') or a['id'],
                'project_id': a.get('project_id') or 'lab'})
            if st not in (200, 409):
                print('  agent register refused (', st, '):', a['id'])
            st, _ = call(scratch_url, scratch_key, '/agents/heartbeat', {
                'agent_id': a['id'], 'status': 'online',
                'working_on': a.get('working_on') or '',
                'llm_backend': a.get('llm_backend') or '',
                'llm_model': a.get('llm_model') or '',
                'runtime': a.get('runtime') or '',
            })
            ok &= st == 200
            made += st == 200
        print('agents replayed:', made, 'of', len(online))

    # 3. workflows — real names/shapes/specs, replayed through fire → claim →
    #    the row's own terminal status
    st, wf = call(live_url, live_key, '/workflows?limit=6')
    items = (wf.get('items') or [])[:6]
    made = 0
    for w in items:
        st, r = call(scratch_url, scratch_key, '/workflows', {
            'name': w.get('name'), 'shape': w.get('shape') or '', 'spec': w.get('spec') or {}})
        if st != 200:
            print('  wf replay refused (', st, ') for', w.get('name'), '— skipping')
            continue
        wid = r['workflow']['id']
        want = (w.get('status') or '').lower()
        if want in ('claimed', 'running', 'completed', 'failed'):
            call(scratch_url, scratch_key, f'/workflows/{wid}/claim',
                 {'runner_id': w.get('claimed_by') or 'runner'})
            if want in ('completed', 'failed'):
                call(scratch_url, scratch_key, f'/workflows/{wid}',
                     {'status': want, 'error': w.get('error') or None}, method='PUT')
        elif want == 'cancelled':
            call(scratch_url, scratch_key, f'/workflows/{wid}/cancel', {}, method='POST')
        made += 1
    print('workflows replayed:', made, 'of', len(items))

    # 4. lessons — verbatim rows with their provenance metadata
    st, les = call(live_url, live_key, '/memory/lessons?limit=8')
    rows = (les.get('results') or [])
    for l in rows:
        st, r = call(scratch_url, scratch_key, '/memory/index', {
            'source_type': 'lesson', 'source_id': l.get('source_id'),
            'content_text': l.get('content_text'),
            'namespace': l.get('namespace') or None,
            'metadata': l.get('metadata') or {}})
        if st != 200:
            print('  lesson replay refused (', st, '):', str(r)[:120])
        ok &= st == 200
    print('lessons replayed:', len(rows))

    # 5. events — real recent lab chatter so Lab Alive has a stream
    st, evs = call(live_url, live_key, '/events?limit=25')
    n = 0
    for e in (evs or []):
        if 'heartbeat' in str(e.get('type', '')).lower():
            continue
        st, _ = call(scratch_url, scratch_key, '/events', {
            'type': e.get('type'), 'summary': e.get('summary'), 'data': {}})
        n += st == 200
    print('events replayed:', n)

    # 6. verify every route the console uses, on the scratch instance
    st, login = call(scratch_url, scratch_key, '/studio/login',
                     {'username': 'operator', 'password': 'console-fixtures-2026'})
    tok = login.get('token', '')
    print('login:', st)
    checks = ['/agents', '/workflows?limit=1', '/memory/lessons?limit=1',
              '/messages?limit=1', '/events?limit=1']
    for path in checks:
        st, _ = call(scratch_url, scratch_key, path)
        print('GET', path, '->', st)
    st, _ = call(scratch_url, scratch_key, '/memory/search',
                 {'query': 'seat residency', 'limit': 3}, method='POST')
    print('POST /memory/search ->', st)

    print('SEED DONE ok=' + str(ok))


if __name__ == '__main__':
    main()
