// Block Kit builders for every message state in the journey.
// One connection = one message. The blocks change in place as status changes.

const VIEU_APP_URL = process.env.VIEU_APP_URL || 'https://app.vieu.com/connections';

export function alertHeader({ count, account }) {
  const scope = account ? `into *${account}*` : `across your accounts`;
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `🔔  *${count} new connection${count === 1 ? '' : 's'} found* ${scope}\nHere are the top ${Math.min(count, 3)} by Vieu Score:`,
      },
    },
    { type: 'divider' },
  ];
}

export function alertFooter({ total, account }) {
  if (total <= 3) return [];
  const q = account ? `?account=${encodeURIComponent(account)}` : '';
  return [
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `<${VIEU_APP_URL}${q}|See all ${total} in Vieu →>`,
        },
      ],
    },
  ];
}

// Card for a connection in its current status.
export function connectionCard(connection, state, rank) {
  const status = state?.status || 'not_started';
  switch (status) {
    case 'shortlisted':
      return shortlistedCard(connection, rank);
    case 'parked':
      return parkedCard(connection, rank);
    case 'in_progress':
      return inProgressCard(connection, rank);
    case 'completed':
      return completedCard(connection, rank);
    default:
      return notStartedCard(connection, rank);
  }
}

function isRealVieuUrl(url) {
  if (!url) return false;
  try {
    const h = new URL(url).host;
    return h === 'vieu.com' || h === 'www.vieu.com' || h === 'app.vieu.com';
  } catch { return false; }
}

function link(text, url) {
  return isRealVieuUrl(url) ? `<${url}|${text}>` : text;
}

function firstName(fullName) {
  return (fullName || '').split(' ')[0] || 'them';
}

const RANK_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

function formatSummary(raw) {
  if (!raw) return '';
  const sectionRe = /(Target title:|Connection strength:|Why this target:)/;
  const parts = raw.split(sectionRe).filter(Boolean);
  const sections = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const label = parts[i].trim();
    const content = (parts[i + 1] || '').replace(/\n+/g, ' ').trim();
    if (label && content) sections.push(`*${label}* ${content}`);
  }
  return sections.join('\n\n');
}

// Card body — target and introducer names are hyperlinked to their per-person Vieu URLs.
function headerLines(connection, rank) {
  const target = link(connection.target_name, connection.target_vieu_url);
  const introducer = link(connection.introducer_name, connection.introducer_vieu_url);
  const rankPrefix = rank != null ? `${RANK_EMOJI[rank - 1] || rank}  ` : '';
  const summary = formatSummary(connection.summary || connection.context || '');
  const summaryBlock = summary ? `\n\n${summary}` : '';
  return `${rankPrefix}*${target}* — ${connection.target_title}${connection.account ? `, ${connection.account}` : ''}\nvia *${introducer}*${summaryBlock}`;
}

// After every LLM answer in the Understand thread, re-offer the three primary
// actions so the user can act on the info without scrolling back.
export function understandFollowupBlocks(connection, replyText) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: replyText } },
    {
      type: 'actions',
      block_id: `followup_${connection.connection_id}_${Date.now()}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📌 Shortlist' },
          action_id: 'shortlist',
          value: connection.connection_id,
        },
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Request introduction' },
          action_id: 'request_intro',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not now' },
          action_id: 'park',
          value: connection.connection_id,
        },
      ],
    },
  ];
}

// Fresh top-level anchor for the Understand flow: connection block +
// tagged greeting + the three primary actions (no Understand — user is already in it).
export function understandThreadStarterBlocks(connection, userId) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: headerLines(connection) },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hey <@${userId}> — starting a thread here so we can dig into this one.\n\nAsk me anything: how close the relationship is, what to lead with, or what's new with *${connection.target_name}*. I'll answer right in this thread.`,
      },
    },
    {
      type: 'actions',
      block_id: `actions_${connection.connection_id}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '📌 Shortlist' },
          action_id: 'shortlist',
          value: connection.connection_id,
        },
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Request introduction' },
          action_id: 'request_intro',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not now' },
          action_id: 'park',
          value: connection.connection_id,
        },
      ],
    },
    { type: 'divider' },
  ];
}

function notStartedCard(connection, rank) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: headerLines(connection, rank) },
    },
    {
      type: 'actions',
      block_id: `actions_${connection.connection_id}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Request introduction' },
          action_id: 'request_intro',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '📌 Shortlist' },
          action_id: 'shortlist',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Understand connection' },
          action_id: 'understand',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Not now' },
          action_id: 'park',
          value: connection.connection_id,
        },
      ],
    },
    { type: 'divider' },
  ];
}

function shortlistedCard(connection, rank) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${headerLines(connection, rank)}\n\n📌 *Shortlisted*`,
      },
    },
    {
      type: 'actions',
      block_id: `actions_${connection.connection_id}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: {
            type: 'plain_text',
            text: `Request introduction to ${firstName(connection.introducer_name)} →`,
          },
          action_id: 'request_intro',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '💬 Understand connection' },
          action_id: 'understand',
          value: connection.connection_id,
        },
      ],
    },
    { type: 'divider' },
  ];
}

function parkedCard(connection, rank) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `~*${connection.target_name}* — ${connection.target_title}, ${connection.account}~\n_Parked · still in Vieu if you change your mind_`,
      },
    },
    { type: 'divider' },
  ];
}

function inProgressCard(connection, rank) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${headerLines(connection, rank)}\n\n🟡 *In progress* — ask sent to ${firstName(connection.introducer_name)}. I'll let you know the moment they reply.`,
      },
    },
    { type: 'divider' },
  ];
}

function completedCard(connection, rank) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${headerLines(connection, rank)}\n\n✅ *Completed* — you're connected with ${connection.target_name}. Nice one.`,
      },
    },
    { type: 'divider' },
  ];
}

// Result card for @vieu alert — all 4 buttons are URL buttons pointing at Vieu.
// No status transitions; clicking any button opens the Vieu app.
export function alertResultCard(connection) {
  // Only ever hyperlink URLs that are actually real Vieu URLs. If a field is
  // missing, render plain bold text — never invent a fallback URL.
  const isReal = (u) => {
    if (!u) return false;
    try {
      const h = new URL(u).host;
      return h === 'vieu.com' || h === 'www.vieu.com' || h === 'app.vieu.com';
    } catch { return false; }
  };
  const linkOrBold = (text, url) =>
    isReal(url) ? `<${url}|${text}>` : text;

  const connectionUrl = isReal(connection.connection_vieu_url) ? connection.connection_vieu_url : null;
  const summary = connection.summary || connection.context || '';
  const introducerName = connection.introducer_name || connection.connector_name || '';

  const targetLink = linkOrBold(connection.target_name, connection.target_vieu_url || connectionUrl);
  const introducerLink = linkOrBold(introducerName, connection.introducer_vieu_url || connectionUrl);
  const accountText = connection.account || connection.target_company;
  const targetLine = `*${targetLink}* — ${connection.target_title}${accountText ? `, ${accountText}` : ''}`;
  const viaLine = introducerName ? `\nvia *${introducerLink}*` : '';
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${targetLine}${viaLine}${summary ? `\n${summary}` : ''}`,
      },
    },
  ];

  // Request introduction is interactive (Slack-first flow); the rest fall back
  // to opening Vieu when a real Connection URL exists.
  const elements = [
    {
      type: 'button',
      style: 'primary',
      text: { type: 'plain_text', text: 'Request introduction' },
      action_id: 'request_intro',
      value: connection.connection_id,
    },
    {
      // Interactive — opens a thread here in Slack, not a URL.
      type: 'button',
      text: { type: 'plain_text', text: '💬 Understand connection' },
      action_id: 'search_understand',
      value: connection.connection_id,
    },
  ];
  if (connectionUrl) {
    elements.push(
      {
        type: 'button',
        text: { type: 'plain_text', text: '📌 Shortlist' },
        url: connectionUrl,
        action_id: 'alert_url_shortlist',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Not now' },
        url: connectionUrl,
        action_id: 'alert_url_park',
      }
    );
  }
  blocks.push({ type: 'actions', elements });
  return blocks;
}

// Compose modal: the editable message that will be sent to the introducer on
// Slack. private_metadata carries connection_id + the requester's card location
// so we can update the card and thread notifications after submit.
export function requestIntroModal({ connection, draft, forwardDraft, meta, variant = 'slack' }) {
  const isAgent = variant === 'agent';
  const introducerSlackId = meta?.introducerSlackId;
  const introducerFirst = firstName(connection.introducer_name);
  const targetFirst = firstName(connection.target_name);

  const introducerLabel = isAgent
    ? `*${connection.introducer_name}*${connection.introducer_email ? ` (${connection.introducer_email.split(',')[0].trim()})` : ''}`
    : (introducerSlackId ? `<@${introducerSlackId}>` : `*${connection.introducer_name}*`);

  const headerText = isAgent
    ? `*Route: Vieu intro agent (email)*\nIntroducer: ${introducerLabel} · Target: *${connection.target_name}*${connection.account ? ` at ${connection.account}` : ''}`
    : `*Recommended: via Slack*\nIntroducer: ${introducerLabel} · Target: *${connection.target_name}*${connection.account ? ` at ${connection.account}` : ''}`;

  const contextText = isAgent
    ? `Vieu's intro agent will email ${introducerFirst} on your behalf. If they accept, they'll get the forwardable message below to copy-paste to ${targetFirst}. You'll be notified here when there's a response.`
    : `Once you approve the copy below, Vieu will request ${introducerFirst} on Slack. If they accept, both messages are shared with them so they can copy-paste the forwardable to ${targetFirst}. A Slack thread is created for you both to coordinate.`;

  return {
    type: 'modal',
    callback_id: isAgent ? 'submit_agent_intro' : 'submit_intro',
    private_metadata: JSON.stringify({ id: connection.connection_id, ...(meta || {}) }),
    title: { type: 'plain_text', text: isAgent ? 'Send to intro agent' : 'Request introduction' },
    submit: { type: 'plain_text', text: isAgent ? 'Send to agent' : 'Send to ' + introducerFirst },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: headerText } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'draft_block',
        label: { type: 'plain_text', text: `Your note to ${introducerFirst}` },
        hint: { type: 'plain_text', text: `Why you want the intro — ${introducerFirst} reads this first.` },
        element: {
          type: 'plain_text_input',
          action_id: 'draft',
          multiline: true,
          initial_value: draft,
        },
      },
      {
        type: 'input',
        block_id: 'forward_block',
        label: { type: 'plain_text', text: `Forwardable message for ${introducerFirst} to send to ${targetFirst}` },
        hint: { type: 'plain_text', text: `${introducerFirst} can copy-paste this directly to ${targetFirst}.` },
        element: {
          type: 'plain_text_input',
          action_id: 'forward_draft',
          multiline: true,
          initial_value: forwardDraft || '',
        },
      },
    ],
  };
}

export function notOnSlackModal({ connection }) {
  return {
    type: 'modal',
    callback_id: 'not_on_slack_choice',
    private_metadata: connection.connection_id,
    title: { type: 'plain_text', text: 'Not on Slack' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${connection.introducer_name}* isn't on this Slack workspace.\nChoose how you'd like to proceed:`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Send to intro agent*\nVieu's agent will handle the outreach over email on your behalf.`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Send to agent' },
          style: 'primary',
          action_id: 'choose_intro_agent',
          value: connection.connection_id,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Generate copy & do it yourself*\nGet a draft you can send from your own email client.`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Generate draft' },
          action_id: 'choose_email_draft',
          value: connection.connection_id,
        },
      },
    ],
  };
}

// Step 2, placeholder shown immediately (view_submission must ack within 3s).
export function emailDraftPlaceholderModal({ connection }) {
  return {
    type: 'modal',
    callback_id: 'ack_email_draft',
    private_metadata: connection.connection_id,
    title: { type: 'plain_text', text: 'Email draft' },
    close: { type: 'plain_text', text: 'Close' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '_Generating your email draft…_' } },
    ],
  };
}

// Step 2, final: copyable draft + a proper "Open in Vieu" button (a modal
// button, not a message link — never unfurls, never spams the thread).
export function emailDraftResultModal({ connection, draft, forwardDraft, emails }) {
  const introducerFirst = firstName(connection.introducer_name);
  const targetFirst = firstName(connection.target_name);
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Two drafts for you to send to *${connection.introducer_name}*. Edit freely, then copy them into your email client.`,
      },
    },
  ];
  if (emails?.length) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Known email${emails.length > 1 ? 's' : ''}: ${emails.map((e) => `\`${e}\``).join('  ·  ')}` }],
    });
  }
  blocks.push({
    type: 'input',
    block_id: 'draft_block',
    label: { type: 'plain_text', text: `Your note to ${introducerFirst}` },
    hint: { type: 'plain_text', text: `Why you want the intro — ${introducerFirst} reads this first.` },
    element: {
      type: 'plain_text_input',
      action_id: 'draft',
      multiline: true,
      initial_value: draft,
    },
  });
  blocks.push({
    type: 'input',
    block_id: 'forward_block',
    label: { type: 'plain_text', text: `Forwardable message for ${introducerFirst} to send to ${targetFirst}` },
    hint: { type: 'plain_text', text: `${introducerFirst} can copy-paste this directly to ${targetFirst}.` },
    element: {
      type: 'plain_text_input',
      action_id: 'forward_draft',
      multiline: true,
      initial_value: forwardDraft || '',
    },
  });
  if (connection.connection_vieu_url) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Vieu →' },
          url: connection.connection_vieu_url,
          action_id: 'noop_open_vieu',
        },
      ],
    });
  }
  return {
    type: 'modal',
    callback_id: 'ack_email_draft',
    private_metadata: connection.connection_id,
    title: { type: 'plain_text', text: 'Email draft' },
    submit: { type: 'plain_text', text: 'Done' },
    close: { type: 'plain_text', text: 'Close' },
    blocks,
  };
}

// Modal for the introducer's optional decline reason.
export function declineNoteModal({ connectionId }) {
  return {
    type: 'modal',
    callback_id: 'submit_decline_note',
    private_metadata: connectionId,
    title: { type: 'plain_text', text: 'Decline introduction' },
    submit: { type: 'plain_text', text: 'Done' },
    close: { type: 'plain_text', text: 'Skip' },
    blocks: [
      {
        type: 'input',
        block_id: 'note_block',
        optional: true,
        label: { type: 'plain_text', text: 'Anything you want to share? (optional)' },
        element: {
          type: 'plain_text_input',
          action_id: 'note',
          multiline: true,
          placeholder: { type: 'plain_text', text: 'e.g. I don’t know them well enough to intro right now.' },
        },
      },
    ],
  };
}

// The requester's confirmation message, with a Cancel button.
export function requesterConfirmBlocks({ connection }) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `The Vieu agent has contacted *${connection.introducer_name}* for approval to intro you to *${connection.target_name}*. We'll notify you when they respond.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel request' },
          style: 'danger',
          action_id: 'intro_cancel',
          value: connection.connection_id,
        },
      ],
    },
  ];
}
