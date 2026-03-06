// HTTP client for the Mycelium API

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Read key from settings.json as ground truth — env vars from Claude Code can be stale
function resolveKey() {
  var envKey = process.env.MYCELIUM_API_KEY || '';
  try {
    var settingsPath = join(homedir(), '.claude', 'settings.json');
    var settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    var mcpEnv = settings.mcpServers && settings.mcpServers.mycelium && settings.mcpServers.mycelium.env;
    if (mcpEnv && mcpEnv.MYCELIUM_API_KEY) return mcpEnv.MYCELIUM_API_KEY;
  } catch {}
  return envKey;
}

const API_URL = process.env.MYCELIUM_API_URL || 'https://mycelium.fyi/api/mycelium';
const API_KEY = resolveKey();
const ROLE = process.env.MYCELIUM_ROLE || 'admin';
const AGENT_ID = process.env.MYCELIUM_AGENT_ID || '';

function authHeaders() {
  if (ROLE === 'admin') {
    var headers = { 'X-Admin-Key': API_KEY };
    // Identify who is using the admin key so actions aren't attributed to __system__
    if (AGENT_ID) headers['X-Acting-As'] = AGENT_ID;
    return headers;
  }
  return { 'X-Agent-Key': API_KEY };
}

async function request(method, path, body) {
  var url = API_URL + path;
  var headers = { ...authHeaders() };
  var opts = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  var res = await fetch(url, opts);
  var text = await res.text();
  var data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    var msg = (data && data.error) || text || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

export function apiGet(path) { return request('GET', path); }
export function apiPost(path, body) { return request('POST', path, body); }
export function apiPut(path, body) { return request('PUT', path, body); }
export function apiDelete(path) { return request('DELETE', path); }
export { API_URL, API_KEY, ROLE };
