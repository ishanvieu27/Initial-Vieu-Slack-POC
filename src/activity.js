// Append-only log of every message/channel/scheduled-reminder the bot has
// created on Slack. Backs `/vieu-reset` — the only way to know exactly what
// to delete/archive/cancel without scanning every channel via conversations.history.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTIVITY_PATH = path.join(__dirname, '..', 'data', 'activity.json');

// Demos happen within minutes/hours, not days — auto-prune anything older so
// the log doesn't grow unbounded across many POC sessions.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function read() {
  try {
    return JSON.parse(await readFile(ACTIVITY_PATH, 'utf8'));
  } catch {
    return { messages: [], channels: [], scheduled: [] };
  }
}

async function write(log) {
  await writeFile(ACTIVITY_PATH, JSON.stringify(log, null, 2));
}

function prune(list, now) {
  return list.filter((e) => now - e.at < MAX_AGE_MS);
}

export async function logMessage(channel, ts) {
  const log = await read();
  const now = Date.now();
  log.messages = prune(log.messages, now);
  log.messages.push({ channel, ts, at: now });
  await write(log);
}

export async function logChannel(channel) {
  const log = await read();
  const now = Date.now();
  log.channels = prune(log.channels, now);
  log.channels.push({ channel, at: now });
  await write(log);
}

export async function logScheduled(channel, id) {
  const log = await read();
  const now = Date.now();
  log.scheduled = prune(log.scheduled, now);
  log.scheduled.push({ channel, id, at: now });
  await write(log);
}

// Everything logged within the last N minutes.
export async function since(minutes) {
  const log = await read();
  const cutoff = Date.now() - minutes * 60 * 1000;
  return {
    messages: log.messages.filter((e) => e.at >= cutoff),
    channels: log.channels.filter((e) => e.at >= cutoff),
    scheduled: log.scheduled.filter((e) => e.at >= cutoff),
  };
}
