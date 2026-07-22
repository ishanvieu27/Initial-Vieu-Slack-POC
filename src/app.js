import 'dotenv/config';
import bolt from '@slack/bolt';

import {
  loadConnections,
  connectionsByAccount,
  getConnection,
  getConnectionState,
  setConnectionState,
  isFresh,
  getIntro,
  setIntro,
  isActiveStage,
  findConnectionIdByThread,
  forgetIntroducerChannels,
  resetTouchedConnections,
} from './store.js';
import {
  connectionCard,
  alertHeader,
  alertFooter,
  requestIntroModal,
  declineNoteModal,
  requesterConfirmBlocks,
  alertResultCard,
  notOnSlackModal,
  emailDraftPlaceholderModal,
  emailDraftResultModal,
  understandThreadStarterBlocks,
  understandFollowupBlocks,
} from './blocks.js';
import {
  explainConnection,
  draftIntroRequest,
  searchConnections,
} from './vieu.js';
import {
  resolveIntroducer,
  getOrCreateIntroChannel,
  scheduleReminders,
  cancelReminders,
  approvalBlocks,
  approvalResolvedBlocks,
  threadBlocks,
  suggestedRequestBody,
  suggestedForwardBlurb,
  firstName,
  parseEmails,
} from './intros.js';
import { logMessage, logChannel, logScheduled, since as activitySince } from './activity.js';

const { App } = bolt;

// AE_SLACK_ID is now an optional fallback for local single-user testing.
// In multi-tester mode, each caller of /vieu-fire is their own AE — the DMs
// go to whoever invoked the command.
const AE_FALLBACK = process.env.AE_SLACK_ID || null;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Every card/message carries hyperlinked vieu.com URLs (target/introducer names,
// action buttons). Slack auto-unfurls those into big link-preview boxes unless
// told not to. Rather than passing unfurl_links/unfurl_media at each of the
// ~35 postMessage/update/scheduleMessage call sites (miss one, and a preview
// leaks back in), patch it once at the client boundary. The same boundary also
// logs every message/channel the bot creates, so `/vieu-reset` knows exactly
// what to clean up later without scanning Slack's history.
//
// Bolt hands listeners a WebClient pulled from a per-token pool (NOT app.client
// — that instance is only used for Bolt's own internal auth.test call), so we
// patch lazily via global middleware the first time we see each instance. The
// pool caches by token, so for this single-workspace app it's the same
// instance on every subsequent call — patched once, applied everywhere.
const patchedClients = new WeakSet();
function instrumentClient(client) {
  if (!client || patchedClients.has(client)) return;
  patchedClients.add(client);

  for (const method of ['postMessage', 'update', 'scheduleMessage']) {
    const original = client.chat[method].bind(client.chat);
    client.chat[method] = async (args) => {
      const res = await original({ unfurl_links: false, unfurl_media: false, ...args });
      if (method === 'postMessage' && res.ok) {
        logMessage(res.channel, res.ts).catch((e) => console.error('[activity]', e.message));
      } else if (method === 'scheduleMessage' && res.ok) {
        logScheduled(args.channel, res.scheduled_message_id).catch((e) => console.error('[activity]', e.message));
      }
      return res;
    };
  }

  const originalCreate = client.conversations.create.bind(client.conversations);
  client.conversations.create = async (args) => {
    const res = await originalCreate(args);
    if (res.ok) logChannel(res.channel.id).catch((e) => console.error('[activity]', e.message));
    return res;
  };
}
app.use(async ({ client, next }) => {
  instrumentClient(client);
  await next();
});

// Dedupe: DM top-level messages and app_mentions both fire in a bot DM.
// Also protects against Slack retries of slow events.
const seenMentions = new Set();
setInterval(() => seenMentions.clear(), 5 * 60 * 1000).unref();

// Re-render a connection message in place using its current state.
async function updateCard(client, connection, state) {
  if (!state.slack?.channel || !state.slack?.message_ts) return;
  await client.chat.update({
    channel: state.slack.channel,
    ts: state.slack.message_ts,
    text: `${connection.target_name} via ${connection.connector_name}`,
    blocks: connectionCard(connection, state),
  });
}

// /vieu-fire [account] — simulate the "net-new connections found" trigger.
// No arg → top 3 across all accounts. With arg → top 3 into that Account.
app.command('/vieu-fire', async ({ command, ack, client, respond }) => {
  await ack();
  const account = (command.text || '').trim();
  const caller = command.user_id;
  const all = await connectionsByAccount(account);
  if (all.length === 0) {
    await respond({
      text: account
        ? `No connections found for account \`${account}\`.`
        : `No connections loaded — is data/connections.csv populated?`,
      response_type: 'ephemeral',
    });
    return;
  }
  const top = all.slice(0, 3);

  await client.chat.postMessage({
    channel: caller,
    text: `${all.length} new connections${account ? ` into ${account}` : ''}`,
    blocks: alertHeader({ count: all.length, account }),
  });

  for (const [idx, conn] of top.entries()) {
    const rank = idx + 1;
    // Seed Slack state from CSV Status the first time we ever alert on this row.
    const fresh = await isFresh(conn.connection_id);
    const seededStatus = fresh ? conn.seeded_state : (await getConnectionState(conn.connection_id)).status;

    const res = await client.chat.postMessage({
      channel: caller,
      text: `${conn.target_name} via ${conn.introducer_name}`,
      blocks: connectionCard(conn, { status: seededStatus }, rank),
    });
    await setConnectionState(conn.connection_id, {
      status: seededStatus,
      slack: { channel: res.channel, message_ts: res.ts },
    });
  }

  if (all.length > 3) {
    await client.chat.postMessage({
      channel: caller,
      text: `See all ${all.length} in Vieu`,
      blocks: alertFooter({ total: all.length, account }),
    });
  }
});

// Capture the card's channel + ts from a button click so updateCard can target it.
function cardRefFromBody(body) {
  const channel = body.channel?.id || body.container?.channel_id;
  const message_ts = body.container?.message_ts || body.message?.ts;
  return channel && message_ts ? { channel, message_ts } : null;
}

// Button: Shortlist
app.action('shortlist', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  const ref = cardRefFromBody(body);
  const state = await setConnectionState(id, { status: 'shortlisted', ...(ref ? { slack: ref } : {}) });
  await updateCard(client, connection, state);
});

// Button: Not now → Parked
app.action('park', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  const ref = cardRefFromBody(body);
  const state = await setConnectionState(id, { status: 'parked', ...(ref ? { slack: ref } : {}) });
  await updateCard(client, connection, state);
});

// Button: Understand connection → post a fresh top-level anchor message in the
// same channel with the connection block + tagged greeting + primary actions.
// Follow-up thread replies here route to explainConnection via the message handler.
app.action('understand', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  if (!connection) return;
  const state = await getConnectionState(id);
  const channel = body.channel?.id || body.container?.channel_id || state.slack?.channel;
  if (!channel) return;
  const userId = body.user.id;

  const posted = await client.chat.postMessage({
    channel,
    text: `Understand ${connection.target_name}`,
    blocks: understandThreadStarterBlocks(connection, userId),
  });

  await setConnectionState(id, {
    slack: { channel, message_ts: posted.ts },
  });
});

// Button: Request introduction. Resolve the introducer on Slack first.
//   - Not on Slack (or a guest/deactivated) → email fallback path.
//   - On Slack → open the compose modal to send an approval request.
app.action('request_intro', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  if (!connection) return;
  const requesterId = body.user.id;

  // Remember where the card lives so we can update it / notify later.
  const cardChannel = body.channel?.id || body.container?.channel_id;
  const cardTs = body.container?.message_ts || body.message?.ts;
  if (cardChannel && cardTs) {
    await setConnectionState(id, { slack: { channel: cardChannel, message_ts: cardTs } });
  }

  // Duplicate guard — first come, first served on this connection.
  const existing = await getIntro(id);
  if (existing && isActiveStage(existing.stage)) {
    await client.chat.postEphemeral({
      channel: cardChannel || requesterId,
      user: requesterId,
      text: `This intro to *${connection.target_name}* is already in progress${existing.requester_id ? ` (requested by <@${existing.requester_id}>)` : ''}.`,
    }).catch(() => {});
    return;
  }

  const resolved = await resolveIntroducer(client, connection);

  if (resolved.status === 'not_found' || resolved.status === 'inactive') {
    // Popup, not a DM wall of text: notice first, draft only if they opt in.
    await client.views.open({
      trigger_id: body.trigger_id,
      view: notOnSlackModal({ connection }),
    });
    return;
  }

  if (resolved.status === 'ambiguous') {
    // Multiple name matches — ask the requester to pick.
    await client.chat.postEphemeral({
      channel: cardChannel || requesterId,
      user: requesterId,
      text: `I found multiple people matching *${connection.introducer_name}*. Pick the right one:`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `Multiple matches for *${connection.introducer_name}* — which one?` },
        },
        {
          type: 'actions',
          elements: resolved.candidates.map((u) => ({
            type: 'button',
            text: { type: 'plain_text', text: (u.real_name || u.name || u.id).slice(0, 74) },
            action_id: `pick_introducer:${u.id}`,
            value: JSON.stringify({ id, introducerSlackId: u.id }),
          })),
        },
      ],
    }).catch(() => {});
    return;
  }

  // Found — open compose modal.
  await openComposeModal(client, {
    triggerId: body.trigger_id,
    connection,
    introducerSlackId: resolved.user.id,
    requesterId,
    cardChannel,
    cardTs,
  });
});

async function openComposeModal(client, { triggerId, connection, introducerSlackId, requesterId, cardChannel, cardTs }) {
  await client.views.open({
    trigger_id: triggerId,
    view: requestIntroModal({
      connection,
      draft: suggestedRequestBody({ connection }),
      forwardDraft: suggestedForwardBlurb({ connection }),
      meta: { introducerSlackId, cardChannel, cardTs },
    }),
  });
}

// Disambiguation button → proceed with the chosen introducer via a compose modal.
app.action(/^pick_introducer:/, async ({ ack, body, client, action }) => {
  await ack();
  const { id, introducerSlackId } = JSON.parse(action.value);
  const connection = await getConnection(id);
  if (!connection) return;
  const st = await getConnectionState(id);
  await openComposeModal(client, {
    triggerId: body.trigger_id,
    connection,
    introducerSlackId,
    requesterId: body.user.id,
    cardChannel: st.slack?.channel,
    cardTs: st.slack?.message_ts,
  });
});

// Compose modal submit → DM the introducer with Yes/No, confirm to requester.
app.view('submit_intro', async ({ ack, view, body, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  const id = meta.id;
  const blurb = view.state.values.draft_block.draft.value;
  const forwardBlurb = view.state.values.forward_block?.forward_draft?.value || '';
  const requesterId = body.user.id;
  const connection = await getConnection(id);
  if (!connection) return;

  // Attach the introducer id so message builders can @mention them.
  connection._introducer_slack_id = meta.introducerSlackId;

  // Open a DM channel with the introducer, then post the approval request.
  const im = await client.conversations.open({ users: meta.introducerSlackId });
  const dmChannel = im.channel.id;
  const posted = await client.chat.postMessage({
    channel: dmChannel,
    text: `Intro request: reach ${connection.target_name}`,
    blocks: approvalBlocks({ connection, requesterId, blurb }),
  });

  // Schedule two approval reminders to the introducer (cancelled on response).
  const reminders = await scheduleReminders(client, {
    channel: dmChannel,
    text: `Reminder: <@${requesterId}> is still hoping for an intro to ${connection.target_name}. A quick *Yes* or *No* above would help.`,
  });

  await setIntro(id, {
    stage: 'pending_approval',
    requester_id: requesterId,
    introducer_slack_id: meta.introducerSlackId,
    blurb,
    forward_blurb: forwardBlurb,
    cancelled: false,
    approval_dm: { channel: dmChannel, ts: posted.ts },
    card: { channel: meta.cardChannel, message_ts: meta.cardTs },
    reminders,
  });
  const state = await setConnectionState(id, {
    status: 'in_progress',
    slack: meta.cardChannel && meta.cardTs ? { channel: meta.cardChannel, message_ts: meta.cardTs } : undefined,
  });
  if (meta.cardChannel && meta.cardTs) await updateCard(client, connection, state);

  // Confirm to the requester with a Cancel option.
  await client.chat.postMessage({
    channel: requesterId,
    text: `The Vieu agent has contacted ${connection.introducer_name} for approval. We'll notify you when they respond.`,
    blocks: requesterConfirmBlocks({ connection }),
  });
});

// Legacy: kept for any cached modal state from a prior deploy.
app.view('confirm_email_fallback', async ({ ack, view, client }) => {
  const id = view.private_metadata;
  const connection = await getConnection(id);
  if (!connection) { await ack(); return; }

  await ack({ response_action: 'update', view: emailDraftPlaceholderModal({ connection }) });

  let draft = '';
  try {
    draft = await draftIntroRequest({ connection });
  } catch (err) {
    console.error('[confirm_email_fallback] draft failed:', err.message);
    draft = `Hey ${firstName(connection.introducer_name)} — would you be open to introducing me to ${connection.target_name}?`;
  }
  const emails = parseEmails(connection.introducer_email);
  await client.views.update({
    view_id: view.id,
    view: emailDraftResultModal({ connection, draft, emails }),
  });
});

app.view('ack_email_draft', async ({ ack }) => { await ack(); });
app.view('not_on_slack_choice', async ({ ack }) => { await ack(); });
app.view('ack_agent_sent', async ({ ack }) => { await ack(); });
app.action('noop_open_vieu', async ({ ack }) => { await ack(); });

// Not-on-Slack: "Send to intro agent" → open compose modal with two textboxes.
app.action('choose_intro_agent', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  if (!connection) return;

  const state = await getConnectionState(id);
  await client.views.update({
    view_id: body.view.id,
    view: requestIntroModal({
      connection,
      draft: suggestedRequestBody({ connection }),
      forwardDraft: suggestedForwardBlurb({ connection }),
      meta: {
        cardChannel: state.slack?.channel,
        cardTs: state.slack?.message_ts,
      },
      variant: 'agent',
    }),
  });
});

// Agent compose modal submit → mark as pending_agent + confirm to requester.
app.view('submit_agent_intro', async ({ ack, view, body, client }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata);
  const id = meta.id;
  const blurb = view.state.values.draft_block.draft.value;
  const forwardBlurb = view.state.values.forward_block?.forward_draft?.value || '';
  const requesterId = body.user.id;
  const connection = await getConnection(id);
  if (!connection) return;

  await setIntro(id, {
    stage: 'pending_agent',
    requester_id: requesterId,
    introducer_slack_id: null,
    blurb,
    forward_blurb: forwardBlurb,
    cancelled: false,
    card: { channel: meta.cardChannel, message_ts: meta.cardTs },
  });
  const state = await setConnectionState(id, {
    status: 'in_progress',
    slack: meta.cardChannel && meta.cardTs ? { channel: meta.cardChannel, message_ts: meta.cardTs } : undefined,
  });
  if (meta.cardChannel && meta.cardTs) await updateCard(client, connection, state);

  await client.chat.postMessage({
    channel: requesterId,
    text: `Vieu's intro agent is emailing ${connection.introducer_name} about your intro to ${connection.target_name}. We'll notify you when there's a response.`,
    blocks: requesterConfirmBlocks({ connection }),
  });
});

// Not-on-Slack: "Generate copy & do it yourself" — LLM draft + forwardable in the modal.
app.action('choose_email_draft', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  if (!connection) return;

  await client.views.update({
    view_id: body.view.id,
    view: emailDraftPlaceholderModal({ connection }),
  });

  let draft = '';
  try {
    draft = await draftIntroRequest({ connection });
  } catch (err) {
    console.error('[choose_email_draft] draft failed:', err.message);
    draft = `Hey ${firstName(connection.introducer_name)} — would you be open to introducing me to ${connection.target_name}?`;
  }
  const forwardDraft = suggestedForwardBlurb({ connection });
  const emails = parseEmails(connection.introducer_email);
  await client.views.update({
    view_id: body.view.id,
    view: emailDraftResultModal({ connection, draft, forwardDraft, emails }),
  });
});

// Freeze the introducer's DM buttons so the answer can't be changed.
async function freezeApprovalDm(client, intro, connection, outcome) {
  if (!intro.approval_dm?.channel || !intro.approval_dm?.ts) return;
  await client.chat.update({
    channel: intro.approval_dm.channel,
    ts: intro.approval_dm.ts,
    text: `Intro request resolved`,
    blocks: approvalResolvedBlocks({ connection, requesterId: intro.requester_id, outcome }),
  }).catch(() => {});
}

// Introducer clicks "Yes, I can introduce".
app.action('intro_approve', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  const intro = await getIntro(id);
  if (!connection || !intro) return;

  // Guard: only answerable once, and only while pending.
  if (intro.stage !== 'pending_approval') {
    await freezeApprovalDm(client, intro, connection, 'yes');
    return;
  }
  await cancelReminders(client, intro.reminders);

  // If the requester already cancelled, tell the introducer and stop.
  if (intro.cancelled) {
    await freezeApprovalDm(client, intro, connection, 'yes');
    await client.chat.postMessage({
      channel: intro.approval_dm.channel,
      text: `Thanks ${firstName(connection.introducer_name)} — heads up, this request was cancelled by the requester, so no action needed.`,
    });
    return;
  }

  await freezeApprovalDm(client, intro, connection, 'yes');

  // Create / reuse the shared private channel; fall back to manual on failure.
  let channelId;
  try {
    channelId = await getOrCreateIntroChannel(client, {
      introducerSlackId: intro.introducer_slack_id,
      introducerName: connection.introducer_name,
      requesterId: intro.requester_id,
    });
  } catch (err) {
    console.error('[intro_approve] channel setup failed:', err?.data?.error || err.message);
    await client.chat.postMessage({
      channel: intro.requester_id,
      text: `${firstName(connection.introducer_name)} said yes! I couldn't auto-create the intro channel (Slack permissions). Please create a private channel and add ${connection.introducer_name} manually.`,
    });
    await setIntro(id, { stage: 'approved', channel_id: null });
    await markVisible(client, id, 'in_progress', connection);
    return;
  }

  // Post the per-target thread with a Mark-introduced button.
  connection._introducer_slack_id = intro.introducer_slack_id;
  const thread = await client.chat.postMessage({
    channel: channelId,
    text: `Intro to ${connection.target_name}`,
    blocks: threadBlocks({
      connection,
      requesterId: intro.requester_id,
      introducerId: intro.introducer_slack_id,
      blurb: intro.blurb,
      forwardBlurb: intro.forward_blurb,
    }),
  });

  // Completion reminders (to the thread), cancelled on Mark introduced.
  const compReminders = await scheduleReminders(client, {
    channel: channelId,
    text: `Reminder: has the intro to ${connection.target_name} happened yet? Tap *Mark as introduced* on the message above once it's done.`,
  });
  // scheduleMessage can't target a thread reliably; keep reminders at channel level.

  await setIntro(id, {
    stage: 'approved',
    channel_id: channelId,
    thread_ts: thread.ts,
    reminders: compReminders,
  });
  await markVisible(client, id, 'in_progress', connection);

  await client.chat.postMessage({
    channel: intro.requester_id,
    text: `🎉 ${firstName(connection.introducer_name)} is in — they'll make the intro to ${connection.target_name}. I've set up <#${channelId}> for it.`,
  });
});

// Introducer clicks "No" → optional reason modal.
app.action('intro_decline', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  const intro = await getIntro(id);
  if (!connection || !intro) return;
  if (intro.stage !== 'pending_approval') {
    await freezeApprovalDm(client, intro, connection, 'no');
    return;
  }
  await cancelReminders(client, intro.reminders);
  await freezeApprovalDm(client, intro, connection, 'no');

  if (intro.cancelled) {
    await client.chat.postMessage({
      channel: intro.approval_dm.channel,
      text: `Thanks ${firstName(connection.introducer_name)} — this one was already cancelled by the requester, so no worries.`,
    });
    return;
  }

  // Mark declined now; the note (if any) is appended on modal submit.
  await setIntro(id, { stage: 'declined' });
  await markVisible(client, id, 'parked', connection);

  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: declineNoteModal({ connectionId: id }),
    });
  } catch (err) {
    // If the modal can't open, still notify the requester without a note.
    await notifyDecline(client, id, connection, intro.requester_id, '');
  }
});

app.view('submit_decline_note', async ({ ack, view, client }) => {
  await ack();
  const id = view.private_metadata;
  const note = view.state.values.note_block?.note?.value || '';
  const connection = await getConnection(id);
  const intro = await getIntro(id);
  if (!connection || !intro) return;
  if (note) await setIntro(id, { decline_note: note });
  await notifyDecline(client, id, connection, intro.requester_id, note);
});

async function notifyDecline(client, id, connection, requesterId, note) {
  const notePart = note ? `\n\n_“${note}”_` : '';
  await client.chat.postMessage({
    channel: requesterId,
    text: `${connection.introducer_name} declined the intro to ${connection.target_name} for now.${notePart}\n\nYou can reach out to ${firstName(connection.introducer_name)} directly${connection.introducer_email ? ` or by email (${connection.introducer_email})` : ''} if you'd like.`,
  });
}

// "Mark as introduced" (requester or introducer) → completed.
app.action('intro_mark_done', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  const intro = await getIntro(id);
  if (!connection || !intro) return;
  if (intro.stage === 'introduced') return;

  await cancelReminders(client, intro.reminders);
  await setIntro(id, { stage: 'introduced' });
  await markVisible(client, id, 'completed', connection);

  if (intro.channel_id && intro.thread_ts) {
    await client.chat.postMessage({
      channel: intro.channel_id,
      thread_ts: intro.thread_ts,
      text: `🙌 Marked as introduced — nice one. Closing this out.`,
    }).catch(() => {});
  }
  if (intro.requester_id) {
    await client.chat.postMessage({
      channel: intro.requester_id,
      text: `🙌 Your intro to ${connection.target_name} is marked complete. Nice one.`,
    }).catch(() => {});
  }
});

// Requester cancels their request.
app.action('intro_cancel', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  const intro = await getIntro(id);
  if (!connection || !intro) return;
  if (intro.stage === 'introduced' || intro.stage === 'cancelled') return;

  await cancelReminders(client, intro.reminders);

  const alreadyAnswered = intro.stage === 'approved';
  await setIntro(id, { cancelled: true, stage: 'cancelled' });
  await markVisible(client, id, 'parked', connection);

  // If the introducer already approved, let them know it's no longer needed.
  if (alreadyAnswered && intro.channel_id && intro.thread_ts) {
    await client.chat.postMessage({
      channel: intro.channel_id,
      thread_ts: intro.thread_ts,
      text: `Heads up <@${intro.introducer_slack_id}> — the requester cancelled this one, so no intro needed anymore. Thanks!`,
    }).catch(() => {});
  }
  // If still pending, the Yes/No handlers detect `cancelled` and inform the introducer on click.

  await client.chat.postMessage({
    channel: intro.requester_id || body.user.id,
    text: `Got it — I've cancelled your intro request to ${connection.target_name}.`,
  }).catch(() => {});
});

// Helper: set the visible 5-state status and re-render the requester's card.
async function markVisible(client, id, status, connection) {
  const state = await setConnectionState(id, { status });
  await updateCard(client, connection, state);
}

// DM message handler.
//   - Thread reply under any connection card → explain-connection from CSV.
//   - Top-level DM (no thread) → search the CSV for matching connections.
// Shared: does this thread_ts point at a known connection anchor?
async function matchConnectionByThread(threadTs) {
  if (!threadTs) return null;
  const connections = await loadConnections();
  for (const c of connections) {
    const s = await getConnectionState(c.connection_id);
    if (s.slack?.message_ts === threadTs) return c;
  }
  return null;
}

async function answerInThread(client, { channel, threadTs, connection, text }) {
  const reply = await explainConnection({ connection, question: text, threadTs });
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: reply,
    blocks: understandFollowupBlocks(connection, reply),
  });
}

app.event('message', async ({ event, client }) => {
  if (event.subtype) return;
  if (event.channel_type !== 'im') return;
  if (event.bot_id || !event.user) return;
  // Optional single-user gate for local testing.
  if (AE_FALLBACK && event.user !== AE_FALLBACK) return;

  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;

  if (isThreadReply) {
    const eventKey = event.event_ts || event.ts;
    if (seenMentions.has(eventKey)) return;
    seenMentions.add(eventKey);

    const matched = await matchConnectionByThread(event.thread_ts);
    if (!matched) return;
    await answerInThread(client, {
      channel: event.channel,
      threadTs: event.thread_ts,
      connection: matched,
      text: event.text,
    });
    return;
  }

  // Top-level DM → run CSV search
  const eventKey = event.event_ts || event.ts;
  if (seenMentions.has(eventKey)) return;
  seenMentions.add(eventKey);

  const raw = (event.text || '')
    .replace(/<@[^>]+>/g, '')
    .replace(/^\s*alert\b/i, '')
    .trim();
  if (!raw) return;

  await client.chat.postMessage({
    channel: event.channel,
    text: `🔍 Searching Vieu for: _${raw}_ …`,
  });

  const { connections } = await searchConnections({ query: raw });

  if (connections.length === 0) {
    await client.chat.postMessage({
      channel: event.channel,
      text: `No connections found for _${raw}_.`,
    });
    return;
  }

  await client.chat.postMessage({
    channel: event.channel,
    text: `Found ${connections.length} connection${connections.length === 1 ? '' : 's'}:`,
  });
  for (const conn of connections) {
    await client.chat.postMessage({
      channel: event.channel,
      text: `${conn.target_name} via ${conn.connector_name}`,
      blocks: alertResultCard(conn),
    });
  }
});

// /vieu-reply <connection_id> yes|no — simulate the introducer's response
app.command('/vieu-reply', async ({ command, ack, client, respond }) => {
  await ack();
  const [id, verdict] = (command.text || '').trim().split(/\s+/);
  if (!id || !['yes', 'no'].includes(verdict)) {
    await respond({
      text: 'Usage: `/vieu-reply <connection_id> yes|no`',
      response_type: 'ephemeral',
    });
    return;
  }
  const connection = await getConnection(id);
  if (!connection) {
    await respond({
      text: `No connection found with id \`${id}\`.`,
      response_type: 'ephemeral',
    });
    return;
  }
  const state = await getConnectionState(id);
  if (!state.slack?.channel || !state.slack?.message_ts) {
    await respond({
      text: `That connection has no Slack message yet — fire the alert first with \`/vieu-fire\`.`,
      response_type: 'ephemeral',
    });
    return;
  }

  if (verdict === 'yes') {
    await client.chat.postMessage({
      channel: state.slack.channel,
      thread_ts: state.slack.message_ts,
      text: `🎉 ${(connection.introducer_name || connection.connector_name || 'they').split(' ')[0]}'s in — they're making the intro to ${connection.target_name}. Hang tight.`,
    });
    const newState = await setConnectionState(id, { status: 'completed' });
    await updateCard(client, connection, newState);
    await client.chat.postMessage({
      channel: state.slack.channel,
      thread_ts: state.slack.message_ts,
      text: `🙌 You're connected — ${connection.target_name} replied. Nice one.`,
    });
  } else {
    await client.chat.postMessage({
      channel: state.slack.channel,
      thread_ts: state.slack.message_ts,
      text: `Heads up — ${(connection.introducer_name || connection.connector_name || 'they').split(' ')[0]} hasn't been able to make this intro. Want to try a different path into ${connection.account || connection.target_company}? I can surface the next best connector.`,
    });
  }
});

// /vieu-reset [minutes] — demo cleanup. Deletes every message the bot posted
// and archives every private channel it created within the window (default
// 60 min), cancels any reminders still pending, and resets local state for
// anything touched in that window back to "Not started".
//
// Hard Slack limits, surfaced in the reply:
//   - Bots can only DELETE messages they posted themselves — a human's reply
//     in a thread is untouched (Slack's API won't allow anything else).
//   - Bots can only ARCHIVE channels, never permanently delete them (that
//     requires an Enterprise Grid admin). Archived channels vanish from the
//     sidebar; nothing further happens on Slack's side without an admin.
app.command('/vieu-reset', async ({ command, ack, client, respond }) => {
  await ack();
  const minutes = Math.max(1, Number((command.text || '').trim()) || 60);

  const { messages, channels, scheduled } = await activitySince(minutes);

  let msgOk = 0, msgFail = 0;
  const deletedTsSet = new Set();
  for (const m of messages) {
    try {
      await client.chat.delete({ channel: m.channel, ts: m.ts });
      msgOk++;
      deletedTsSet.add(`${m.channel}:${m.ts}`);
    } catch (err) {
      msgFail++;
    }
  }

  let chOk = 0, chFail = 0;
  const archivedChannels = new Set();
  for (const c of channels) {
    try {
      await client.conversations.archive({ channel: c.channel });
      chOk++;
      archivedChannels.add(c.channel);
    } catch (err) {
      chFail++;
    }
  }
  if (archivedChannels.size) await forgetIntroducerChannels(archivedChannels);

  let schedOk = 0;
  for (const s of scheduled) {
    try {
      await client.chat.deleteScheduledMessage({ channel: s.channel, scheduled_message_id: s.id });
      schedOk++;
    } catch (err) {
      // Already fired or already gone — fine either way.
    }
  }

  // Reset local status/intro for anything touched in the window, and either
  // re-render the surviving card back to "Not started" or drop its stale ref
  // if that exact message was just deleted above.
  const touched = await resetTouchedConnections(minutes);
  for (const { id, slack } of touched) {
    if (!slack?.channel || !slack?.message_ts) continue;
    const wasDeleted = deletedTsSet.has(`${slack.channel}:${slack.message_ts}`);
    if (wasDeleted) continue;
    const connection = await getConnection(id);
    if (connection) await updateCard(client, connection, { status: 'not_started', slack });
  }

  const lines = [
    `🧹 *Cleanup for the last ${minutes} min*`,
    `• ${msgOk} message(s) deleted${msgFail ? ` (${msgFail} left as-is — likely already gone, or not posted by the bot)` : ''}`,
    `• ${chOk} private channel(s) archived${chFail ? ` (${chFail} failed)` : ''}`,
    `• ${schedOk} pending reminder(s) cancelled`,
    `• ${touched.length} connection(s) reset to *Not started*`,
  ];
  if (chOk > 0) {
    lines.push(
      '',
      '_Note: bots can only archive Slack channels, not permanently delete them — that needs an Enterprise Grid admin. Archived channels are gone from your sidebar; delete them for good later from Slack admin if you want._'
    );
  }
  await respond({ response_type: 'ephemeral', text: lines.join('\n') });
});

// @vieu <query> — CSV search flow, results render with hyperlinked names and
// interactive "Understand connection" button. Any mention (with or without
// a leading "alert" keyword) counts as a query.
app.event('app_mention', async ({ event, client, context }) => {
  const eventKey = event.event_ts || event.ts;
  if (seenMentions.has(eventKey) || (context && Number(context.retryNum) > 0)) {
    console.log('[mention] skipping duplicate/retry', eventKey);
    return;
  }
  seenMentions.add(eventKey);

  const raw = (event.text || '')
    .replace(/<@[^>]+>/g, '')         // strip <@U123>, <@U123|name>, <@subteam^S123|team>
    .replace(/^\s*alert\b/i, '')       // optional leading "alert" keyword
    .trim();

  // Thread reply on a known connection anchor → explain, don't search.
  const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
  if (isThreadReply) {
    const matched = await matchConnectionByThread(event.thread_ts);
    if (matched) {
      await answerInThread(client, {
        channel: event.channel,
        threadTs: event.thread_ts,
        connection: matched,
        text: raw || event.text || '',
      });
      return;
    }
  }

  if (!raw) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `Try \`@vieu find connections to <person or company>\` and I'll search Vieu for warm paths.`,
    });
    return;
  }

  const query = raw;

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: `🔍 Searching Vieu for: _${query}_ …`,
  });

  const { connections } = await searchConnections({ query });

  if (connections.length === 0) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `No connections found for _${query}_.`,
    });
    return;
  }

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: `Found ${connections.length} connection${connections.length === 1 ? '' : 's'}:`,
  });

  for (const conn of connections) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `${conn.target_name} via ${conn.connector_name}`,
      blocks: alertResultCard(conn),
    });
  }
});

// URL buttons in alert results — Slack opens the URL; app just acks.
app.action('alert_url_shortlist', async ({ ack }) => { await ack(); });
app.action('alert_url_park', async ({ ack }) => { await ack(); });

// Understand button on search result cards → same fresh-anchor behavior as
// the /vieu-fire card Understand button.
app.action('search_understand', async ({ ack, body, client, action }) => {
  await ack();
  const id = action.value;
  const connection = await getConnection(id);
  if (!connection) return;
  const channel = body.channel?.id || body.container?.channel_id;
  if (!channel) {
    console.error('[search_understand] missing channel in body');
    return;
  }
  const userId = body.user.id;

  const posted = await client.chat.postMessage({
    channel,
    text: `Understand ${connection.target_name}`,
    blocks: understandThreadStarterBlocks(connection, userId),
  });

  await setConnectionState(id, {
    slack: { channel, message_ts: posted.ts },
  });
});

app.error(async (error) => {
  console.error('[Bolt error]', error);
});

(async () => {
  await app.start();
  console.log('⚡ Vieu Slack POC running');
})();
