// Slack Bridge plugin DB helpers

export default function createSlackDB(db) {
  return {
    createChannelMap(myceliumChannelId, slackChannelId, direction) {
      var r = db.prepare(
        'INSERT INTO dv_slack_channel_map (mycelium_channel_id, slack_channel_id, direction) VALUES (?, ?, ?) RETURNING id'
      ).get(myceliumChannelId || null, slackChannelId, direction || 'both');
      return r.id;
    },

    getChannelMap(id) {
      return db.prepare('SELECT * FROM dv_slack_channel_map WHERE id = ?').get(id) || null;
    },

    listChannelMaps() {
      return db.prepare('SELECT * FROM dv_slack_channel_map ORDER BY created_at DESC').all();
    },

    getMapByMycelium(myceliumChannelId) {
      return db.prepare(
        'SELECT * FROM dv_slack_channel_map WHERE mycelium_channel_id = ? AND enabled = 1'
      ).get(myceliumChannelId) || null;
    },

    getMapBySlack(slackChannelId) {
      return db.prepare(
        'SELECT * FROM dv_slack_channel_map WHERE slack_channel_id = ? AND enabled = 1'
      ).get(slackChannelId) || null;
    },

    updateChannelMap(id, fields) {
      var sets = [];
      var values = [];
      if (fields.direction !== undefined) { sets.push('direction = ?'); values.push(fields.direction); }
      if (fields.enabled !== undefined) { sets.push('enabled = ?'); values.push(fields.enabled ? 1 : 0); }
      if (fields.mycelium_channel_id !== undefined) { sets.push('mycelium_channel_id = ?'); values.push(fields.mycelium_channel_id); }
      if (fields.slack_channel_id !== undefined) { sets.push('slack_channel_id = ?'); values.push(fields.slack_channel_id); }
      if (sets.length === 0) return;
      values.push(id);
      db.prepare('UPDATE dv_slack_channel_map SET ' + sets.join(', ') + ' WHERE id = ?').run(...values);
    },

    deleteChannelMap(id) {
      db.prepare('DELETE FROM dv_slack_channel_map WHERE id = ?').run(id);
    },

    logMessage(direction, myceliumMsgId, slackTs, slackChannel, content, agentId) {
      var r = db.prepare(
        'INSERT INTO dv_slack_messages (direction, mycelium_msg_id, slack_ts, slack_channel, content, agent_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
      ).get(direction, myceliumMsgId || null, slackTs || '', slackChannel || '', content || '', agentId || '');
      return r.id;
    },

    listMessages(filters) {
      var where = ['1=1'];
      var params = [];
      if (filters.direction) { where.push('direction = ?'); params.push(filters.direction); }
      if (filters.slack_channel) { where.push('slack_channel = ?'); params.push(filters.slack_channel); }
      var limit = Math.min(filters.limit || 50, 200);
      params.push(limit);
      return db.prepare(
        'SELECT * FROM dv_slack_messages WHERE ' + where.join(' AND ') +
        ' ORDER BY created_at DESC LIMIT ?'
      ).all(...params);
    }
  };
}
