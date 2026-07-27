// Spend routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-08; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  logAgentSpend, getAgentSpend, getSpendSummary,
} from '../db.js';

export function registerSpendRoutes(router, deps) {
  const {
    asyncHandler, checkAgentOrAdmin, checkGuardrails,
  } = deps;

  // ======== SPEND TRACKING ========

  router.post('/spend', asyncHandler(function (req, res) {
    var agentId = checkAgentOrAdmin(req, res);
    if (!agentId) return;
    if (!checkGuardrails(req, res, 'spend_logged', { agent: agentId, project_id: req.body.project_id, cost_usd: req.body.cost_usd })) return;
    var costUsd = parseFloat(req.body.cost_usd) || 0;
    if (costUsd < 0) return res.status(400).json({ error: 'cost_usd must be non-negative' });
    logAgentSpend(
      agentId,
      req.body.project_id || '',
      costUsd,
      req.body.source || '',
      req.body.description || '',
      req.body.model || '',
      parseInt(req.body.tokens_in) || 0,
      parseInt(req.body.tokens_out) || 0
    );
    res.json({ ok: true });
  }));

  router.get('/spend/:agentId', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var entries = getAgentSpend(req.params.agentId, {
      since: req.query.since,
      project_id: req.query.project_id,
      limit: parseInt(req.query.limit) || 50
    });
    res.json(entries);
  }));

  router.get('/spend', asyncHandler(function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    var summary = getSpendSummary({
      since: req.query.since,
      project_id: req.query.project_id
    });
    var total = summary.reduce(function (acc, r) { return acc + (r.total_cost || 0); }, 0);
    res.json({ total_cost_usd: Math.round(total * 10000) / 10000, breakdown: summary });
  }));
}
