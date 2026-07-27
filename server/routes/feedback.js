// Feedback routes — extracted verbatim from mycelium.js (god-file decomposition,
// 2026-07-03; see docs/specs/2026-07-03-god-file-decomposition.md).
//
// Handler bodies are UNCHANGED. Shared helpers arrive via `deps` (dependency
// injection); DB functions are imported directly. The route contract is identical
// to before extraction — enforced by test/refactor/route-manifest.mjs.
import {
  createFeedback, getFeedback, listFeedback, deleteFeedback, getFeedbackSummary,
} from '../db.js';

export function registerFeedbackRoutes(router, deps) {
  const {
    asyncHandler, checkAdmin, checkAgentOrAdmin, checkGuardrails,
    parseIntParam, apiError, emitEvent,
  } = deps;

  // GET /feedback/summary — aggregate stats
  router.get('/feedback/summary', asyncHandler(async function (req, res) {
    if (!checkAdmin(req, res)) return;
    var summary = getFeedbackSummary();
    res.json(summary);
  }));

  // GET /feedback — list with optional filters
  router.get('/feedback', asyncHandler(async function (req, res) {
    if (!checkAdmin(req, res)) return;
    var filters = {
      entity_type: req.query.entity_type || '',
      agent_id: req.query.agent_id || '',
      submitted_by: req.query.submitted_by || '',
      rating: req.query.rating || '',
      min_rating: req.query.min_rating || '',
      limit: parseIntParam(req.query.limit) || 50,
      offset: parseIntParam(req.query.offset) || 0,
    };
    // Clear empty strings so listFeedback ignores them
    Object.keys(filters).forEach(function (k) { if (filters[k] === '') delete filters[k]; });
    res.json(listFeedback(filters));
  }));

  // POST /feedback — submit feedback
  router.post('/feedback', asyncHandler(async function (req, res) {
    var who = checkAgentOrAdmin(req, res);
    if (!who) return;
    if (!checkGuardrails(req, res, 'feedback_submitted', { agent: who, entity_type: req.body.entity_type, agent_id: req.body.agent_id, rating: req.body.rating })) return;
    var { entity_type, entity_id, subject, rating, comment, agent_id } = req.body;
    if (!rating || rating < 1 || rating > 5) {
      return apiError(res, 400, 'rating must be 1-5');
    }
    var id = createFeedback(entity_type, entity_id, subject, rating, comment, who, agent_id || '');
    var record = getFeedback(id);
    emitEvent('feedback_submitted', who, '', JSON.stringify({ id, rating, entity_type, agent_id }));
    res.status(201).json(record);
  }));

  // DELETE /feedback/:id
  router.delete('/feedback/:id', asyncHandler(async function (req, res) {
    if (!checkAdmin(req, res)) return;
    var id = parseIntParam(req.params.id);
    if (!id) return apiError(res, 400, 'Invalid feedback id');
    var record = getFeedback(id);
    if (!record) return apiError(res, 404, 'Feedback not found');
    deleteFeedback(id);
    res.json({ ok: true });
  }));
}
