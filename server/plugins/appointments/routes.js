import { Router } from 'express';
import createAppointmentsDB from './db.js';

export default function (core) {
  const router = Router();
  const db = createAppointmentsDB(core.db);
  const { checkAgentOrAdmin } = core.auth;
  const { apiError } = core;

  router.get('/', (req, res) => {
    if (!checkAgentOrAdmin(req, res)) return;
    res.json({ appointments: db.getAppointments() });
  });

  router.put('/:role', (req, res) => {
    if (!checkAgentOrAdmin(req, res)) return;
    const { role } = req.params;
    const { model_id, engine, host, flag_overrides, capability } = req.body || {};
    if (!model_id || !engine || !host) {
      return apiError(res, 400, 'model_id, engine, and host are required');
    }
    const appointment = db.upsertAppointment(role, {
      model_id, engine, host, flag_overrides, capability,
    });
    res.json({ appointment });
  });

  router.delete('/:role', (req, res) => {
    if (!checkAgentOrAdmin(req, res)) return;
    res.json(db.deleteAppointment(req.params.role));
  });

  return router;
}
