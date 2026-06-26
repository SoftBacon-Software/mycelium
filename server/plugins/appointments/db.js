export default function createAppointmentsDB(db) {
  const stmtUpsert = db.prepare(`
    INSERT INTO appointments (role, model_id, engine, host, flag_overrides, capability, updated_at)
    VALUES (@role, @model_id, @engine, @host, @flag_overrides, @capability, datetime('now'))
    ON CONFLICT(role) DO UPDATE SET
      model_id      = excluded.model_id,
      engine        = excluded.engine,
      host          = excluded.host,
      flag_overrides = excluded.flag_overrides,
      capability    = excluded.capability,
      updated_at    = datetime('now')
  `);

  const stmtGetAll = db.prepare(`SELECT * FROM appointments ORDER BY role ASC`);
  const stmtGet    = db.prepare(`SELECT * FROM appointments WHERE role = ?`);
  const stmtDelete = db.prepare(`DELETE FROM appointments WHERE role = ?`);

  function parseRow(row) {
    if (!row) return null;
    return {
      role: row.role,
      model_id: row.model_id,
      engine: row.engine,
      host: row.host,
      flag_overrides: JSON.parse(row.flag_overrides || '{}'),
      capability: JSON.parse(row.capability || '{}'),
      updated_at: row.updated_at,
    };
  }

  function upsertAppointment(role, {
    model_id,
    engine,
    host,
    flag_overrides = {},
    capability = {},
  }) {
    stmtUpsert.run({
      role,
      model_id,
      engine,
      host,
      flag_overrides: JSON.stringify(flag_overrides),
      capability: JSON.stringify(capability),
    });
    return parseRow(stmtGet.get(role));
  }

  function getAppointments() {
    return stmtGetAll.all().map(parseRow);
  }

  function getAppointment(role) {
    return parseRow(stmtGet.get(role));
  }

  function deleteAppointment(role) {
    const info = stmtDelete.run(role);
    return { ok: info.changes > 0, changes: info.changes };
  }

  return { upsertAppointment, getAppointments, getAppointment, deleteAppointment };
}
