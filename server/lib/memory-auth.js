// TRUST LAYER P0.1 (F-mycelium/250, PROGRAM-mycelium-trust-layer-2026-09-26) —
// the agent memory surface's studio-JWT gate.
//
// THE HOLE (research/2026-09-26-memory-safety-frontier/AUDIT.md): the plugin
// auth seam hands plugins checkAgentOrAdmin, which authenticates ANY valid
// studio JWT onto the agent-shaped /memory/* and /auto-memory/* routes — so a
// leaked OPERATOR browser token could read, overwrite and delete the lab's
// memory exactly like an agent key. Agent memory is a MACHINE surface: it
// takes an agent key (X-Agent-Key). Studio identities are the exception, not
// the door:
//   role 'admin'  — passes with the admin flag (benches, the MCP fork, the
//                   harness writers all ride the admin key path anyway; an
//                   admin JWT keeps its on-behind-of powers here too).
//   role 'agent'  — the granted exception: a studio identity minted FOR agent
//                   work authenticates WITHOUT the admin flag.
//   anything else — refused: 403 with a sentence naming the role and the door.
//
// THE FALLBACK is deliberate and documented: a plugin-test core (or an older
// host) whose pluginCore.auth carries no getStudioUser cannot run a JWT gate
// — there the guard IS checkAgentOrAdmin (today's behavior) rather than a
// load-time crash of every plugin suite. The real pluginCore always ships the
// decoder (routes/mycelium.js), and the P0 suite boots the real one.

export var AGENT_MEMORY_STUDIO_ROLES = ['admin', 'agent'];

export function memoryAgentGuard(auth) {
  if (!auth || typeof auth.getStudioUser !== 'function') {
    // No JWT decoder on the host core → no gate to run; keep today's behavior.
    if (auth && typeof auth.checkAgentOrAdmin === 'function') return auth.checkAgentOrAdmin;
    return function (req, res) {
      res.status(401).json({ error: 'Authentication required' });
      return null;
    };
  }
  return function checkMemoryAgent(req, res) {
    var user = auth.getStudioUser(req);
    if (user) {
      if (AGENT_MEMORY_STUDIO_ROLES.indexOf(user.role) === -1) {
        res.status(403).json({ error: "a studio token (role '" + (user.role || 'none') +
          "') is not an agent here — the agent memory surface takes an agent key " +
          '(X-Agent-Key); admin keeps access through its role, and role \'agent\' ' +
          'studio identities are the granted exception' });
        return null;
      }
      req._authIsAdmin = user.role === 'admin';
      return user.displayName || user.username;
    }
    // No studio token: the regular chain — admin key, then agent key.
    return auth.checkAgentOrAdmin(req, res);
  };
}
