// Introduction orchestration: resolving the introducer on Slack, managing the
// shared private channel, scheduling reminders, and building message text.
//
// Hard rules enforced here:
//   - The target is NEVER looked up or added to any channel.
//   - No vieu.com links appear in any Slack-facing message text.
//   - "Same org" = a full (non-guest, non-deleted) member of THIS workspace.

import { getIntroducerChannel, setIntroducerChannel } from './store.js';

// Reminder cadence — overridable for testing. Default 2 days; two reminders at T and 2T.
const REMINDER_SECS = Number(process.env.INTRO_REMINDER_SECS || 172800);

// ── text utilities ──

export function firstName(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || 'there';
}

// CSV email fields sometimes carry several known addresses for one person,
// comma-separated (e.g. a personal + two work + a company alias). Split and
// dedupe them cleanly instead of showing the raw joined string.
export function parseEmails(raw) {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((e) => e.trim()).filter(Boolean))];
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Strip markdown/vieu links and multi-line noise so message text stays clean.
export function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\(([^)]+)\)\[[^\]]+\]/g, '$1')     // (text)[url]
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // [text](url)
    .replace(/https?:\/\/\S*vieu\.com\S*/gi, '') // any stray vieu.com url
    .replace(/^\s*\d+\.\s*/gm, '')                // leading "1. "
    .replace(/\s+/g, ' ')
    .trim();
}

// Best short relationship insight for the introducer, from the CSV narrative fields.
function relationshipInsight(connection) {
  const raw =
    connection.connection_to_target ||
    connection.summary ||
    connection.connection_to_introducer ||
    '';
  const cleaned = cleanText(raw);
  return cleaned.length > 280 ? cleaned.slice(0, 277) + '…' : cleaned;
}

// ── introducer resolution ──
//
// Returns one of:
//   { status: 'found', user }
//   { status: 'ambiguous', candidates: [users] }
//   { status: 'not_found' }
//   { status: 'inactive' }   (found but deleted or a guest → treat as not on Slack)

let userListCache = { at: 0, users: [] };

async function allUsers(client) {
  if (Date.now() - userListCache.at < 5 * 60 * 1000 && userListCache.users.length) {
    return userListCache.users;
  }
  const users = [];
  let cursor;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    users.push(...(res.members || []));
    cursor = res.response_metadata?.next_cursor || '';
  } while (cursor);
  userListCache = { at: Date.now(), users };
  return users;
}

function isFullMember(u) {
  return u && !u.deleted && !u.is_bot && !u.is_restricted && !u.is_ultra_restricted;
}

function nameMatches(u, name) {
  const n = (name || '').toLowerCase().trim();
  if (!n) return false;
  const fields = [
    u.real_name,
    u.profile?.real_name,
    u.profile?.display_name,
    u.name,
  ].map((x) => (x || '').toLowerCase());
  return fields.some((f) => f === n || f.includes(n));
}

export async function resolveIntroducer(client, connection) {
  const email = connection.introducer_email;
  const name = connection.introducer_name;

  // 1) Email lookup — unambiguous when present.
  if (email) {
    try {
      const res = await client.users.lookupByEmail({ email });
      if (res.ok && res.user) {
        return isFullMember(res.user)
          ? { status: 'found', user: res.user }
          : { status: 'inactive', user: res.user };
      }
    } catch (err) {
      if (err?.data?.error && err.data.error !== 'users_not_found') {
        console.error('[intros] lookupByEmail error:', err.data.error);
      }
      // fall through to name search
    }
  }

  // 2) Name fallback.
  if (name) {
    const users = await allUsers(client);
    const matches = users.filter((u) => isFullMember(u) && nameMatches(u, name));
    if (matches.length === 1) return { status: 'found', user: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches.slice(0, 5) };
  }

  return { status: 'not_found' };
}

// ── shared private channel ──

async function withRetry(fn, { tries = 3, label = 'slack' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.data?.error;
      // Non-retryable "success-ish" states — treat as ok.
      if (code === 'already_in_channel' || code === 'name_taken') throw err;
      console.warn(`[intros] ${label} attempt ${i + 1} failed: ${code || err.message}`);
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// Get or create Jason's private channel and make sure the requester is a member.
// Throws if channel creation ultimately fails (caller falls back to manual).
export async function getOrCreateIntroChannel(client, { introducerSlackId, introducerName, requesterId }) {
  let record = await getIntroducerChannel(introducerSlackId);

  // Reuse existing channel if it's still usable.
  if (record?.channel_id) {
    try {
      const info = await client.conversations.info({ channel: record.channel_id });
      if (info.channel?.is_archived) {
        await client.conversations.unarchive({ channel: record.channel_id }).catch(() => {});
      }
      await ensureMembers(client, record.channel_id, [introducerSlackId, requesterId]);
      return record.channel_id;
    } catch (err) {
      console.warn('[intros] stored channel unusable, recreating:', err?.data?.error || err.message);
    }
  }

  // Create fresh private channel.
  const base = `vieu-intro-${slugify(firstName(introducerName))}-network-connections`;
  let channelId = null;
  for (const candidate of [base, `${base}-${introducerSlackId.slice(-4).toLowerCase()}`]) {
    try {
      const res = await withRetry(
        () => client.conversations.create({ name: candidate.slice(0, 80), is_private: true }),
        { label: 'conversations.create' }
      );
      channelId = res.channel.id;
      break;
    } catch (err) {
      if (err?.data?.error === 'name_taken') continue;
      throw err;
    }
  }
  if (!channelId) throw new Error('Could not create a private channel (name conflicts).');

  await ensureMembers(client, channelId, [introducerSlackId, requesterId]);
  await setIntroducerChannel(introducerSlackId, { channel_id: channelId, name: introducerName });
  return channelId;
}

async function ensureMembers(client, channel, userIds) {
  const users = [...new Set(userIds.filter(Boolean))].join(',');
  if (!users) return;
  try {
    await withRetry(() => client.conversations.invite({ channel, users }), {
      label: 'conversations.invite',
    });
  } catch (err) {
    const code = err?.data?.error;
    if (code === 'already_in_channel' || code === 'cant_invite_self') return;
    throw err;
  }
}

// ── reminders (server-side scheduled messages, cancellable) ──

// Schedule two nudges (at T and 2T). Returns [{channel, id}] for later cancel.
export async function scheduleReminders(client, { channel, text }) {
  const out = [];
  for (const mult of [1, 2]) {
    const post_at = Math.floor(Date.now() / 1000) + REMINDER_SECS * mult;
    try {
      const res = await client.chat.scheduleMessage({ channel, post_at, text });
      if (res.scheduled_message_id) out.push({ channel, id: res.scheduled_message_id });
    } catch (err) {
      console.warn('[intros] scheduleMessage failed:', err?.data?.error || err.message);
    }
  }
  return out;
}

export async function cancelReminders(client, reminders) {
  for (const r of reminders || []) {
    try {
      await client.chat.deleteScheduledMessage({ channel: r.channel, scheduled_message_id: r.id });
    } catch (err) {
      // Already fired or already deleted — ignore.
    }
  }
}

// ── message builders (all vieu-link-free) ──

export function approvalBlocks({ connection, requesterId, blurb }) {
  const insight = relationshipInsight(connection);
  const lines = [
    `Hey <@${connection._introducer_slack_id}> — <@${requesterId}> asked for a warm intro through you.`,
    ``,
    `*Who they'd like to reach:* ${connection.target_name}${connection.target_title ? ` — ${connection.target_title}` : ''}${connection.account ? ` at ${connection.account}` : ''}`,
  ];
  if (insight) lines.push(`*How you're connected:* ${insight}`);
  if (blurb) lines.push(`*Their note:* ${cleanText(blurb)}`);
  lines.push('', 'Can you broker this introduction?');

  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Yes, I can introduce' },
          action_id: 'intro_approve',
          value: connection.connection_id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'No' },
          action_id: 'intro_decline',
          value: connection.connection_id,
        },
      ],
    },
  ];
}

// The Jason DM once he has answered — buttons removed, outcome frozen.
export function approvalResolvedBlocks({ connection, requesterId, outcome }) {
  const verb = outcome === 'yes' ? 'You agreed to make' : 'You declined';
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Intro request from <@${requesterId}> to reach *${connection.target_name}*.\n_${verb} this introduction._`,
      },
    },
  ];
}

export function threadBlocks({ connection, requesterId, introducerId, blurb, forwardBlurb }) {
  const introducerTag = introducerId ? `<@${introducerId}>` : `*${connection.introducer_name}*`;
  const headerLines = [
    `${introducerTag} · <@${requesterId}>`,
    '',
    `*Intro to ${connection.target_name}*${connection.target_title ? ` — ${connection.target_title}` : ''}${connection.account ? ` at ${connection.account}` : ''}`,
  ];

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: headerLines.join('\n') } },
  ];

  if (blurb) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📝 *Requester's ask* (context for ${firstName(connection.introducer_name)})\n>${cleanText(blurb).replace(/\n/g, '\n>')}`,
      },
    });
  }

  if (forwardBlurb) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `✉️ *Forwardable message to send to ${connection.target_name}* — ${firstName(connection.introducer_name)}, copy & send this:\n\`\`\`${cleanText(forwardBlurb)}\`\`\``,
      },
    });
  }

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: '✅ Mark as introduced' },
        action_id: 'intro_mark_done',
        value: connection.connection_id,
      },
    ],
  });

  return blocks;
}

// Suggested editable message body for the compose modal (no CTA/buttons — we add those).
export function suggestedRequestBody({ connection }) {
  const insight = relationshipInsight(connection);
  const parts = [
    `I'd love a warm intro to ${connection.target_name}${connection.target_title ? `, ${connection.target_title}` : ''}${connection.account ? ` at ${connection.account}` : ''}.`,
  ];
  if (insight) parts.push(`You two are connected: ${insight}`);
  parts.push(`Would you be open to making the introduction? Happy to send a forwardable blurb.`);
  return parts.join('\n\n');
}

// A ready-to-send message the introducer can copy-paste to the target.
// Written in the introducer's voice, addressed to the target.
export function suggestedForwardBlurb({ connection }) {
  const insight = relationshipInsight(connection);
  const targetFirst = firstName(connection.target_name);
  const parts = [
    `Hi ${targetFirst},`,
    '',
    `I'd like to introduce you to a contact of mine who's been keen to connect with you${connection.account ? ` at ${connection.account}` : ''}.`,
  ];
  if (insight) parts.push(`Context: ${insight}`);
  parts.push(`They'll reach out directly to follow up — happy to vouch that a quick chat is worth your time.`);
  parts.push('', `Best,\n${firstName(connection.introducer_name)}`);
  return parts.join('\n');
}
