// Task 240 — the shared rate limiter (server/lib/rate-limit.js) at helper
// level: mechanics without booting the daemon.
//
//   - max+1 requests inside one window -> the (max+1)th is a 429 carrying
//     Retry-After plus the draft-6 RateLimit-* headers, with a JSON body that
//     names the limiter;
//   - each rateLimited() call is its OWN bucket — exhausting one route never
//     trips another;
//   - MYCELIUM_RATE_LIMIT=off disables the limiter per request (the operator
//     kill-switch), and re-enabling restores enforcement.
import { describe, test, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimited } from '../../server/lib/rate-limit.js';

function appWith(path, limiter) {
  var app = express();
  app.get(path, limiter, function (req, res) { res.json({ ok: true }); });
  return app;
}

afterEach(function () {
  delete process.env.MYCELIUM_RATE_LIMIT;
});

describe('rateLimited helper (task 240)', () => {
  test('max+1 requests in a window -> 429 with Retry-After + draft-6 headers + JSON body', async function () {
    var app = appWith('/limited', rateLimited('helper/max3', { windowMs: 60000, max: 3 }));
    for (var i = 0; i < 3; i++) {
      var ok = await request(app).get('/limited');
      expect(ok.status).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('3');
    }
    var blocked = await request(app).get('/limited');
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
    expect(blocked.body.error).toContain('helper/max3');
  });

  test('buckets are independent per limiter — exhausting one leaves another clean', async function () {
    var app = express();
    app.get('/a', rateLimited('helper/bucket-a', { windowMs: 60000, max: 1 }), function (req, res) { res.json({ ok: true }); });
    app.get('/b', rateLimited('helper/bucket-b', { windowMs: 60000, max: 1 }), function (req, res) { res.json({ ok: true }); });
    expect((await request(app).get('/a')).status).toBe(200);
    expect((await request(app).get('/a')).status).toBe(429);
    // bucket b never heard about a's traffic
    expect((await request(app).get('/b')).status).toBe(200);
  });

  test('MYCELIUM_RATE_LIMIT=off disables enforcement per request; unset restores it', async function () {
    var app = appWith('/switch', rateLimited('helper/switch', { windowMs: 60000, max: 2 }));
    expect((await request(app).get('/switch')).status).toBe(200);
    expect((await request(app).get('/switch')).status).toBe(200);
    expect((await request(app).get('/switch')).status).toBe(429);

    process.env.MYCELIUM_RATE_LIMIT = 'off';
    expect((await request(app).get('/switch')).status).toBe(200);
    expect((await request(app).get('/switch')).status).toBe(200);

    delete process.env.MYCELIUM_RATE_LIMIT;
    expect((await request(app).get('/switch')).status).toBe(429);
  });
});
