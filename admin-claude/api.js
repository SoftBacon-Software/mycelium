// HTTP client for the Mycelium API — admin-claude edition
// Based on dioverse-mcp/src/api.js pattern

import { MYCELIUM_API_URL, MYCELIUM_ADMIN_KEY } from './config.js';

function authHeaders() {
  return { 'X-Admin-Key': MYCELIUM_ADMIN_KEY };
}

async function request(method, path, body) {
  var url = MYCELIUM_API_URL + path;
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
