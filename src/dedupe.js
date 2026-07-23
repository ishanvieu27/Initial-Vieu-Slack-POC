// Event dedupe for Slack retries (slow events get redelivered up to 3x) and
// for the same message firing both message.im and app_mention.
//
// On Socket Mode this was a plain in-memory Set — fine, since the process
// stays alive. On Vercel each invocation can be a fresh cold start with no
// memory of prior requests, so the same guard has to live somewhere shared:
// Vercel KV. `nx: true` makes the SET atomic — "only set if this key doesn't
// already exist" — so two concurrent deliveries of the same event can't both
// see it as new.
import { kv } from './kv.js';

const TTL_SECONDS = 5 * 60;

// Returns true if this is the first time we've seen `key` (caller should
// proceed); false if it's a duplicate (caller should skip).
export async function markSeen(key) {
  const res = await kv.set(`vieu:seen:${key}`, 1, { nx: true, ex: TTL_SECONDS });
  return res === 'OK' || res === true;
}
