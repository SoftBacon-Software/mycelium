import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { researchPress } from '../../server/plugins/marketing/outreach/lib/researcher.js';

// The outreach researcher extracts a `domain:` token from contact.notes
// (DB-controlled, user-settable) and fetches `https://<domain>`. These tests
// prove the ssrf-guard refuses private / link-local / metadata addresses at
// that call site and that NO outbound fetch is attempted for them.
//
// We use literal IP addresses (the guard's own seam — literal IPs are checked
// directly without DNS), mirroring how test/unit/ssrf-guard.test.js exercises
// the guard, so the suite is deterministic and network-free.

describe('outreach researcher SSRF guard (researchPress)', () => {
  let fetchSpy;

  beforeEach(() => {
    // researchPress calls the global fetch; spy so we can assert it is never
    // reached for blocked hosts (and so no real network call ever happens).
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('blocks the cloud metadata / link-local address 169.254.169.254', async () => {
    var result = await researchPress({ id: 1, type: 'press', notes: 'domain:169.254.169.254' });
    expect(result.error).toBe('SSRF blocked');
    expect(result.last_content).toBe('(research blocked)');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks a private RFC1918 address 192.168.1.1', async () => {
    var result = await researchPress({ id: 2, type: 'press', notes: 'domain:192.168.1.1' });
    expect(result.error).toBe('SSRF blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('blocks loopback 127.0.0.1', async () => {
    var result = await researchPress({ id: 3, type: 'press', notes: 'domain:127.0.0.1' });
    expect(result.error).toBe('SSRF blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns {} (no crash, no fetch) when notes carry no domain token', async () => {
    var result = await researchPress({ id: 4, type: 'press', notes: 'just some notes' });
    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
