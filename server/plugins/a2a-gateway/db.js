// A2A Gateway DB helpers

import crypto from 'crypto';

export default function createA2ADB(db) {
  return {
    // -- External Agents --
    addExternalAgent(url, card) {
      var name = card.name || url;
      var description = card.description || '';
      var capabilities = JSON.stringify(card.capabilities || []);
      var cardJson = JSON.stringify(card);
      var result = db.prepare(`
        INSERT INTO a2a_external_agents (agent_url, name, description, capabilities, agent_card)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_url) DO UPDATE SET
          name = excluded.name, description = excluded.description,
          capabilities = excluded.capabilities, agent_card = excluded.agent_card,
          last_discovered_at = datetime('now'), status = 'active'
        RETURNING id
      `).get(url, name, description, capabilities, cardJson);
      return result.id;
    },

    getExternalAgent(id) {
      var row = db.prepare('SELECT * FROM a2a_external_agents WHERE id = ?').get(id);
      if (row) {
        try { row.capabilities = JSON.parse(row.capabilities); } catch (e) { row.capabilities = []; }
        try { row.agent_card = JSON.parse(row.agent_card); } catch (e) { row.agent_card = {}; }
      }
      return row;
    },

    listExternalAgents(status) {
      var query = status
        ? 'SELECT * FROM a2a_external_agents WHERE status = ? ORDER BY last_discovered_at DESC'
        : 'SELECT * FROM a2a_external_agents ORDER BY last_discovered_at DESC';
      var rows = status ? db.prepare(query).all(status) : db.prepare(query).all();
      return rows.map(function (row) {
        try { row.capabilities = JSON.parse(row.capabilities); } catch (e) { row.capabilities = []; }
        try { row.agent_card = JSON.parse(row.agent_card); } catch (e) { row.agent_card = {}; }
        return row;
      });
    },

    removeExternalAgent(id) {
      db.prepare('DELETE FROM a2a_external_agents WHERE id = ?').run(id);
    },

    // -- Outbound Tasks --
    createOutboundTask(externalAgentId, myceliumAgentId, method, inputText) {
      var id = crypto.randomUUID();
      db.prepare(
        'INSERT INTO a2a_tasks (id, external_agent_id, mycelium_agent_id, method, input_text) VALUES (?, ?, ?, ?, ?)'
      ).run(id, externalAgentId, myceliumAgentId, method, inputText);
      return id;
    },

    getOutboundTask(id) {
      var row = db.prepare('SELECT * FROM a2a_tasks WHERE id = ?').get(id);
      if (row && row.result) {
        try { row.result = JSON.parse(row.result); } catch (e) {}
      }
      return row;
    },

    updateOutboundTask(id, fields) {
      var sets = [];
      var values = [];
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.result !== undefined) { sets.push('result = ?'); values.push(typeof fields.result === 'string' ? fields.result : JSON.stringify(fields.result)); }
      if (fields.mycelium_task_id !== undefined) { sets.push('mycelium_task_id = ?'); values.push(fields.mycelium_task_id); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE a2a_tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    listOutboundTasks(opts) {
      opts = opts || {};
      var where = ['1=1'];
      var params = [];
      if (opts.status) { where.push('status = ?'); params.push(opts.status); }
      if (opts.mycelium_agent_id) { where.push('mycelium_agent_id = ?'); params.push(opts.mycelium_agent_id); }
      var limit = Math.min(opts.limit || 50, 200);
      params.push(limit);
      return db.prepare('SELECT * FROM a2a_tasks WHERE ' + where.join(' AND ') + ' ORDER BY created_at DESC LIMIT ?').all(...params);
    },

    // -- Inbound Tasks --
    createInboundTask(callerUrl, targetAgentId, inputText) {
      var id = crypto.randomUUID();
      db.prepare(
        'INSERT INTO a2a_inbound_tasks (id, caller_url, target_agent_id, input_text) VALUES (?, ?, ?, ?)'
      ).run(id, callerUrl, targetAgentId, inputText);
      return id;
    },

    getInboundTask(id) {
      var row = db.prepare('SELECT * FROM a2a_inbound_tasks WHERE id = ?').get(id);
      if (row && row.result) {
        try { row.result = JSON.parse(row.result); } catch (e) {}
      }
      return row;
    },

    updateInboundTask(id, fields) {
      var sets = [];
      var values = [];
      if (fields.status !== undefined) { sets.push('status = ?'); values.push(fields.status); }
      if (fields.result !== undefined) { sets.push('result = ?'); values.push(typeof fields.result === 'string' ? fields.result : JSON.stringify(fields.result)); }
      if (fields.target_agent_id !== undefined) { sets.push('target_agent_id = ?'); values.push(fields.target_agent_id); }
      if (sets.length === 0) return;
      sets.push("updated_at = datetime('now')");
      values.push(id);
      db.prepare('UPDATE a2a_inbound_tasks SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    }
  };
}
