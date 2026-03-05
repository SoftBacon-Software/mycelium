// Build-in-Public event handlers
// Subscribes to agent events and drafts social content for operator approval.

import createBipDB from './db.js';

// Events that trigger BIP draft creation
var TRIGGER_EVENTS = [
  'task_completed',
  'plan_step_completed',
  'bug_fixed',
  'drone_job_completed'
];

// Templates for draft content by event type
function draftContent(eventType, eventData, instanceUrl) {
  var agent = eventData.agent || 'an agent';
  var summary = eventData.summary || '';
  var data = eventData.data || {};
  var url = instanceUrl || '';

  switch (eventType) {
    case 'task_completed': {
      var taskTitle = data.title || summary.replace(/completed task/i, '').trim();
      return {
        title: agent + ' shipped: ' + taskTitle,
        content: agent + ' just shipped: ' + taskTitle + '.' + (url ? '\n\nThe swarm is building itself. Watch it happen live at ' + url : '')
      };
    }
    case 'plan_step_completed': {
      var stepTitle = data.step_title || data.title || summary;
      var planTitle = data.plan_title || '';
      return {
        title: 'Plan milestone: ' + stepTitle,
        content: (planTitle ? 'Plan: ' + planTitle + '\n' : '') +
          'Step complete: ' + stepTitle + (url ? '\n\nAI agents coordinating in real time. Built on Mycelium. ' + url : '')
      };
    }
    case 'bug_fixed': {
      var bugTitle = data.title || summary;
      return {
        title: agent + ' fixed: ' + bugTitle,
        content: 'Bug squashed: ' + bugTitle + '\n\n' + agent + ' found it, filed it, fixed it — autonomously.' + (url ? ' This is what Mycelium does. ' + url : '')
      };
    }
    case 'drone_job_completed': {
      var jobTitle = data.title || summary;
      return {
        title: 'Compute job done: ' + jobTitle,
        content: 'Drone job completed: ' + jobTitle + (url ? '\n\nDistributed AI compute, coordinated by Mycelium. ' + url : '')
      };
    }
    default:
      return {
        title: summary || eventType,
        content: summary + (url ? '\n\n' + url : '')
      };
  }
}

export function registerHooks(core) {
  var db = createBipDB(core.db);

  for (var evtType of TRIGGER_EVENTS) {
    (function (eventType) {
      core.onEvent(eventType, function (eventData) {
        try {
          var instanceUrl = '';
          try { instanceUrl = core.db.prepare("SELECT value FROM dv_instance_config WHERE key = 'instance_url'").get()?.value || ''; } catch (e) { /* */ }
          var draft = draftContent(eventType, eventData, instanceUrl);

          // Create the draft
          var draftId = db.createDraft(
            eventType,
            eventData,
            draft.title,
            draft.content,
            ['twitter']
          );

          // Route to all operator inboxes for approval
          var inboxIds = core.inbox.createInboxItemForAllOperators(
            'bip_draft',
            'bip_draft',
            String(draftId),
            'Post draft: ' + draft.title,
            'Approve or reject this ' + eventType.replace(/_/g, ' ') + ' post',
            { draft_id: draftId, trigger_event: eventType, content_preview: draft.content.substring(0, 200) },
            'normal'
          );

          // Save inbox item ids to draft
          db.updateDraft(draftId, { inbox_item_id: inboxIds });

          core.emitEvent('bip_draft_created', '__system__', eventData.project_id,
            'BIP draft created: ' + draft.title,
            { draft_id: draftId, trigger_event: eventType });

          console.log('[bip] Draft #' + draftId + ' created from ' + eventType + ': ' + draft.title);
        } catch (e) {
          console.error('[bip] Error creating draft from ' + eventType + ':', e.message);
        }
      });
    })(evtType);
  }
}
