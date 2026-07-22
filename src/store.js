import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_PATH = path.join(DATA_DIR, 'connections.csv');
const STATE_PATH = path.join(DATA_DIR, 'state.json');

let connectionsCache = null;

// Extract the pid= param from a Connection Vieu URL.
// e.g. https://vieu.com/connections#...&pid=COMP-...%7EPERS-...  →  "COMP-...~PERS-..."
export function extractPid(url) {
  if (!url) return null;
  const m = String(url).match(/[?&#][^#]*?pid=([^&]+)/);
  if (!m) return null;
  return decodeURIComponent(m[1]);
}

// Normalize CSV Status → Slack workflow state
export function normalizeStatus(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'not started' || s === 'new' || s === 'fresh') return 'not_started';
  if (s.includes('shortlist')) return 'shortlisted';
  if (s === 'parked' || s === 'not now' || s === 'declined' || s === 'passed') return 'parked';
  if (s.includes('progress') || s === 'sent' || s === 'awaiting' || s === 'requested') return 'in_progress';
  if (s === 'completed' || s === 'introduced' || s === 'done' || s === 'connected') return 'completed';
  return 'not_started';
}

function pickNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Take the first meaningful item from a multi-line "1. …\n2. …" field, strip the leading number.
function firstLine(text) {
  if (!text) return '';
  const first = String(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!first) return '';
  return first
    .replace(/^\d+\.\s*/, '')                    // drop leading "1. "
    .replace(/\(([^)]+)\)\[([^\]]+)\]/g, '$1')    // strip (text)[url] snippets — keep just the text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')    // strip standard [text](url) too
    .trim();
}

// Map one raw CSV row → canonical connection object used everywhere else.
// Row keys match the new schema headers exactly.
function normalizeRow(row) {
  const connectionVieuUrl = row['Connection Vieu URL'] || '';
  const pid = extractPid(connectionVieuUrl);
  // Stable id: prefer the PID; fall back to hash-y string if missing.
  const connection_id =
    pid ||
    `row-${(row['Introducer Name'] || '').replace(/\W+/g, '')}-${(row['Account Target'] || '').replace(/\W+/g, '')}`;

  return {
    connection_id,
    pid,

    // Account
    account: row['Account'] || '',
    account_linkedin: row['Account LinkedIn'] || '',

    // Target (the person the AE wants to reach)
    target_name: row['Account Target'] || '',
    target_title: row['Target Title'] || '',
    target_company: row['Account'] || '',
    target_linkedin: row['Target LinkedIn'] || '',
    target_email: row['Target Email'] || '',
    target_vieu_url: row['Target Vieu URL'] || '',
    target_seniority: row['Target Seniority'] || '',

    // Introducer (the AE's known contact who makes the intro)
    introducer_name: row['Introducer Name'] || '',
    introducer_linkedin: row['Introducer LinkedIn'] || '',
    introducer_email: row['Introducer Email'] || '',
    introducer_vieu_url: row['Introducer Vieu URL'] || '',

    // Intermediary (column present, data intentionally empty for now)
    intermediary_name: row['Intermediary Name'] || '',
    intermediary_linkedin: row['Intermediary LinkedIn'] || '',
    intermediary_email: row['Intermediary Email'] || '',
    intermediary_vieu_url: row['Intermediary Vieu URL'] || '',

    // Relationship narrative — compact `summary` for card display; raw fields
    // stay intact for the LLM prompt.
    summary:
      row['Summary'] ||
      firstLine(row['Connection to Target']) ||
      firstLine(row['Connection to Introducer']) ||
      '',
    email_copy: row['Email Copy'] || '',
    connection_to_introducer: row['Connection to Introducer'] || '',
    connection_to_intermediary: row['Connection to Intermediary'] || '',
    connection_to_target: row['Connection to Target'] || '',
    connection_to_account: row['Connection to Account'] || '',

    // Signals + scores
    buyer_alignment: pickNum(row['Buyer Alignment']),
    connection_strength: pickNum(row['Connection Strength']),
    strength_tenant_to_introducer: pickNum(row['Conn Strength: Tenant->Introducer']),
    strength_introducer_to_intermediary: pickNum(row['Conn Strength: Introducer->Intermediary']),
    strength_intermediary_to_target: pickNum(row['Conn Strength: Intermediary->Target']),
    strength_target_to_account: pickNum(row['Conn Strength: Target->Account']),
    vieu_score: pickNum(row['Vieu Score']) ?? 0,

    // Flags + metadata
    is_tracked: /^true|yes|1$/i.test(row['Is Tracked'] || ''),
    is_most_direct: /^true|yes|1$/i.test(row['Is Most Direct Connection'] || ''),
    priority: row['Priority'] || '',
    csv_status: row['Status'] || '',
    seeded_state: normalizeStatus(row['Status']),
    point_of_contact_email: row['Point of Contact Email'] || '',

    // Key URL (drives Understand + Request CTAs)
    connection_vieu_url: connectionVieuUrl,

    first_discovered: row['First discovered'] || '',
    last_updated: row['Last Updated'] || '',

    // Legacy alias used by older LLM prompt code — keep populated for compatibility
    context: row['Summary'] || row['Connection to Target'] || row['Connection to Introducer'] || '',
    connector_name: row['Introducer Name'] || '',
    connector_title: '',
    connector_company: '',
  };
}

export async function loadConnections() {
  if (connectionsCache) return connectionsCache;
  const raw = await readFile(CSV_PATH, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  connectionsCache = rows.map(normalizeRow).filter((c) => c.connection_id);
  return connectionsCache;
}

// Reset cache (used by tests when we swap CSV files on disk).
export function _resetCache() {
  connectionsCache = null;
}

// Top N connections into a given Account (case-insensitive), sorted by Vieu Score desc.
export async function connectionsByAccount(account, { limit = null } = {}) {
  const all = await loadConnections();
  const target = (account || '').trim().toLowerCase();
  const filtered = target
    ? all.filter((c) => c.account.toLowerCase() === target)
    : [...all];
  filtered.sort((a, b) => (b.vieu_score ?? 0) - (a.vieu_score ?? 0));
  return limit ? filtered.slice(0, limit) : filtered;
}

export async function listAccounts() {
  const all = await loadConnections();
  const set = new Set(all.map((c) => c.account).filter(Boolean));
  return [...set].sort();
}

export async function getConnection(id) {
  const all = await loadConnections();
  return all.find((c) => c.connection_id === id) || null;
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, 'utf8'));
  } catch {
    return { connections: {} };
  }
}

async function writeState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

export async function getConnectionState(id) {
  const state = await readState();
  return state.connections[id] || { status: 'not_started', slack: null };
}

export async function setConnectionState(id, patch) {
  const state = await readState();
  const prev = state.connections[id] || { status: 'not_started', slack: null };
  state.connections[id] = {
    ...prev,
    ...patch,
    slack: { ...(prev.slack || {}), ...(patch.slack || {}) },
    updated_at: new Date().toISOString(),
  };
  await writeState(state);
  return state.connections[id];
}

// True if we've never seen this connection before in state.json.
export async function isFresh(id) {
  const state = await readState();
  return !state.connections[id];
}

// ── Introduction lifecycle state ──
//
// The `intro` object holds everything the multi-step Slack intro flow needs.
// It lives on the connection entry but is kept separate from the 5 visible
// statuses so the richer stage machine can be reasoned about.
//
//   intro = {
//     stage: pending_approval | approved | declined | introduced | cancelled | introducer_gone,
//     requester_id, introducer_slack_id, channel_id, thread_ts,
//     approval_dm: { channel, ts },
//     card: { channel, message_ts },     // the requester's original card
//     blurb, decline_note, cancelled,
//     reminders: [{ channel, id }],
//     created_at, updated_at
//   }

export async function getIntro(id) {
  const state = await readState();
  return state.connections[id]?.intro || null;
}

export async function setIntro(id, patch) {
  const state = await readState();
  const conn = state.connections[id] || { status: 'not_started', slack: null };
  const prev = conn.intro || {};
  conn.intro = {
    ...prev,
    ...patch,
    created_at: prev.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  state.connections[id] = conn;
  await writeState(state);
  return conn.intro;
}

// An intro is "active" (blocks a duplicate request) while pending or in-flight.
export function isActiveStage(stage) {
  return stage === 'pending_approval' || stage === 'approved' || stage === 'pending_agent';
}

// Introducer → shared private channel map.
export async function getIntroducerChannel(slackId) {
  const state = await readState();
  return state.introducers?.[slackId] || null;
}

export async function setIntroducerChannel(slackId, data) {
  const state = await readState();
  if (!state.introducers) state.introducers = {};
  state.introducers[slackId] = { ...(state.introducers[slackId] || {}), ...data };
  await writeState(state);
  return state.introducers[slackId];
}

// Find which connection owns a given intro-channel thread (for Mark introduced).
export async function findConnectionIdByThread(threadTs) {
  const state = await readState();
  for (const [id, conn] of Object.entries(state.connections)) {
    if (conn.intro?.thread_ts === threadTs) return id;
  }
  return null;
}

// ── /vieu-reset support ──

// Drop introducer→channel mappings for channels that were archived, so the
// next request through that introducer creates a fresh one instead of trying
// to reuse an archived (or deleted) channel.
export async function forgetIntroducerChannels(channelIds) {
  const state = await readState();
  if (!state.introducers) return;
  for (const [slackId, rec] of Object.entries(state.introducers)) {
    if (channelIds.has(rec.channel_id)) delete state.introducers[slackId];
  }
  await writeState(state);
}

// Reset every connection touched (by `updated_at`) within the last N minutes
// back to a clean slate — status → not_started, intro state cleared. Returns
// the pre-reset { id, slack } pairs so the caller can decide whether to
// re-render that card (if its message survived) or just drop the stale ref
// (if the message was deleted as part of the same cleanup).
export async function resetTouchedConnections(minutes) {
  const state = await readState();
  const cutoff = Date.now() - minutes * 60 * 1000;
  const touched = [];
  for (const [id, conn] of Object.entries(state.connections)) {
    const updatedAt = conn.updated_at ? new Date(conn.updated_at).getTime() : 0;
    if (updatedAt < cutoff) continue;
    touched.push({ id, slack: conn.slack ? { ...conn.slack } : null });
    delete conn.intro;
    conn.status = 'not_started';
    conn.slack = conn.slack || null;
    conn.updated_at = new Date().toISOString();
  }
  await writeState(state);
  return touched;
}
