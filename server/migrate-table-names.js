// =============== Table Rename Migration: dv_* → clean names ===============
// Idempotent: only renames tables that still have the old dv_ prefix.
// Safe to run on every startup — already-renamed tables are skipped.

const TABLE_RENAMES = [
  // Core tables (43)
  ['dv_agents', 'agents'],
  ['dv_organizations', 'organizations'],
  ['dv_projects', 'projects'],
  ['dv_tasks', 'tasks'],
  ['dv_context', 'context'],
  ['dv_assets', 'assets'],
  ['dv_events', 'events'],
  ['dv_messages', 'messages'],
  ['dv_context_keys', 'context_keys'],
  ['dv_bugs', 'bugs'],
  ['dv_plans', 'plans'],
  ['dv_plan_steps', 'plan_steps'],
  ['dv_plan_step_comments', 'plan_step_comments'],
  ['dv_studio_users', 'studio_users'],
  ['dv_password_resets', 'password_resets'],
  ['dv_webhooks', 'webhooks'],
  ['dv_drone_jobs', 'drone_jobs'],
  ['dv_concepts', 'concepts'],
  ['dv_project_concepts', 'project_concepts'],
  ['dv_task_comments', 'task_comments'],
  ['dv_support_tickets', 'support_tickets'],
  ['dv_plugins', 'plugins'],
  ['dv_plugin_migrations', 'plugin_migrations'],
  ['dv_approvals', 'approvals'],
  ['dv_operators', 'operators'],
  ['dv_instance_config', 'instance_config'],
  ['dv_approval_votes', 'approval_votes'],
  ['dv_webhook_deliveries', 'webhook_deliveries'],
  ['dv_channels', 'channels'],
  ['dv_channel_members', 'channel_members'],
  ['dv_agent_savepoints', 'agent_savepoints'],
  ['dv_channel_reads', 'channel_reads'],
  ['dv_operator_inbox', 'operator_inbox'],
  ['dv_feedback', 'feedback'],
  ['dv_drone_profiles', 'drone_profiles'],
  ['dv_drone_profile_assignments', 'drone_profile_assignments'],
  ['dv_job_templates', 'job_templates'],
  ['dv_plugin_config', 'plugin_config'],
  ['dv_runner_spawns', 'runner_spawns'],
  ['dv_node_profiles', 'node_profiles'],
  ['dv_customer_instances', 'customer_instances'],
  ['dv_message_reads', 'message_reads'],
  ['dv_team_settings', 'team_settings'],

  // Plugin tables (24)
  ['dv_subscriptions', 'subscriptions'],
  ['dv_bip_drafts', 'bip_drafts'],
  ['dv_cost_entries', 'cost_entries'],
  ['dv_cost_daily', 'cost_daily'],
  ['dv_cost_alerts', 'cost_alerts'],
  ['dv_digest_reports', 'digest_reports'],
  ['dv_digest_metrics', 'digest_metrics'],
  ['dv_error_events', 'error_events'],
  ['dv_github_events', 'github_events'],
  ['dv_github_links', 'github_links'],
  ['dv_guardrail_rules', 'guardrail_rules'],
  ['dv_guardrail_violations', 'guardrail_violations'],
  ['dv_outreach_campaigns', 'outreach_campaigns'],
  ['dv_outreach_contacts', 'outreach_contacts'],
  ['dv_social_accounts', 'social_accounts'],
  ['dv_social_posts', 'social_posts'],
  ['dv_steam_assets', 'steam_assets'],
  ['dv_video_sessions', 'video_sessions'],
  ['dv_video_clips', 'video_clips'],
  ['dv_automation_rules', 'automation_rules'],
  ['dv_automation_log', 'automation_log'],
  ['dv_automation_templates', 'automation_templates'],
  ['dv_x_posts', 'x_posts'],
  ['dv_template_items', 'template_items'],
];

export default function migrateTableNames(db) {
  // Get all existing table names from the database
  var existingTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map(function (row) { return row.name; })
  );

  var renamed = 0;

  for (var [oldName, newName] of TABLE_RENAMES) {
    if (existingTables.has(oldName) && !existingTables.has(newName)) {
      db.exec('ALTER TABLE "' + oldName + '" RENAME TO "' + newName + '"');
      process.stdout.write('[migrate] renamed ' + oldName + ' -> ' + newName + '\n');
      renamed++;
    }
  }

  if (renamed > 0) {
    process.stdout.write('[migrate] table rename complete: ' + renamed + ' tables renamed\n');
  }
}
