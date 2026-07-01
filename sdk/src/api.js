// HTTP client for the Mycelium API — zero dependencies

export function createClient(opts) {
  // Sovereignty default: your own local instance, never a hosted third party (mycelium.fyi is deprecated)
  var apiUrl = opts.apiUrl || 'http://localhost:3002/api/mycelium'
  var apiKey = opts.apiKey
  var role = opts.role || 'agent'
  var agentId = opts.agentId || ''
  // Configurable request timeout. Every Mycelium endpoint is an immediate REST
  // call (GET /work/:agentId returns at once — it does NOT long-poll), so a
  // uniform default is safe and catches hung/dropped connections instead of
  // leaving the agent wedged on a fetch that never settles.
  var defaultTimeout = opts.timeout || 30000

  function headers() {
    var h = {}
    if (role === 'admin') {
      h['X-Admin-Key'] = apiKey
      if (agentId) h['X-Acting-As'] = agentId
    } else {
      h['X-Agent-Key'] = apiKey
    }
    return h
  }

  async function request(method, path, body) {
    var url = apiUrl + path
    var h = { ...headers() }
    var fetchOpts = { method, headers: h }
    if (body !== undefined) {
      h['Content-Type'] = 'application/json'
      fetchOpts.body = JSON.stringify(body)
    }
    // Abort a hung/dropped connection after the configured timeout instead of
    // pending forever. AbortSignal.timeout is available on Node >= 17.3
    // (this SDK requires >= 20).
    fetchOpts.signal = AbortSignal.timeout(defaultTimeout)
    var res = await fetch(url, fetchOpts)
    var text = await res.text()
    var data
    try { data = JSON.parse(text) } catch { data = text }
    if (!res.ok) {
      var msg = (data && data.error) || text || ('HTTP ' + res.status)
      var err = new Error(msg)
      err.status = res.status
      throw err
    }
    return data
  }

  return {
    get: function(path) { return request('GET', path) },
    post: function(path, body) { return request('POST', path, body) },
    put: function(path, body) { return request('PUT', path, body) },
    del: function(path) { return request('DELETE', path) }
  }
}
