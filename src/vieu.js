import OpenAI from 'openai';
import { kv } from './kv.js';
import { loadConnections } from './store.js';

const openai = new OpenAI();

// Per-thread conversation memory. Was an in-memory Map — fine on Socket
// Mode's single long-lived process, but a fresh serverless invocation can
// start with an empty Map, silently forgetting the conversation mid-thread.
// KV with a TTL keeps it correct either way; threads older than the TTL
// naturally expire instead of accumulating forever.
const THREAD_TTL_SECONDS = 6 * 60 * 60; // 6 hours — generous for one demo session

async function getThreadMessages(key) {
  const messages = await kv.get(`vieu:thread:${key}`);
  return messages || [];
}

async function saveThreadMessages(key, messages) {
  await kv.set(`vieu:thread:${key}`, messages, { ex: THREAD_TTL_SECONDS });
}

// ── Search: purely local CSV, no LLM URL fabrication, no external calls ──

const STOP_WORDS = new Set([
  'find', 'search', 'connections', 'connection', 'to', 'at', 'in', 'with',
  'who', 'can', 'intro', 'introduce', 'introduction', 'me', 'the', 'for',
  'about', 'any', 'a', 'an', 'and', 'or', 'of', 'from', 'is', 'are', 'be',
  'help', 'get', 'net', 'new', 'warm', 'path', 'paths', 'someone', 'anyone',
  'people', 'person', 'my', 'our', 'us', 'that', 'this', 'them',
]);

function extractTerms(query) {
  return (query || '')
    .toLowerCase()
    .split(/[^\w]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

function scoreConnection(conn, terms) {
  const acct = (conn.account || '').toLowerCase();
  const target = (conn.target_name || '').toLowerCase();
  const title = (conn.target_title || '').toLowerCase();
  const seniority = (conn.target_seniority || '').toLowerCase();
  const introducer = (conn.introducer_name || '').toLowerCase();
  const summary = (conn.summary || '').toLowerCase();

  let score = 0;
  let matchedTerms = 0;
  for (const t of terms) {
    let hit = false;
    if (acct.includes(t)) { score += 50; hit = true; }
    if (target.includes(t)) { score += 60; hit = true; }
    if (title.includes(t)) { score += 30; hit = true; }
    if (seniority.includes(t)) { score += 25; hit = true; }
    if (introducer.includes(t)) { score += 15; hit = true; }
    if (summary.includes(t)) { score += 5; hit = true; }
    if (hit) matchedTerms++;
  }
  if (matchedTerms === 0) return 0;
  return score * matchedTerms + (conn.vieu_score ?? 0);
}

export async function searchConnectionsLocal(query, limit = 5) {
  const all = await loadConnections();
  const terms = extractTerms(query);
  if (terms.length === 0) {
    return [...all]
      .sort((a, b) => (b.vieu_score ?? 0) - (a.vieu_score ?? 0))
      .slice(0, limit);
  }
  const scored = all
    .map((c) => ({ conn: c, score: scoreConnection(c, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.conn);
}

// Public API used by app.js — signature preserved for compatibility.
export async function searchConnections({ query, limit = 5 } = {}) {
  const results = await searchConnectionsLocal(query, limit);
  return { connections: results };
}

// ── Understand connection: LLM answers from the full CSV row ──

// Dump the entire CSV-derived record as JSON for the LLM. This is *all* fields
// we normalized from the row, so the model has the complete picture.
function connectionAsJson(connection) {
  const clone = { ...connection };
  return JSON.stringify(clone, null, 2);
}

const EXPLAIN_SYSTEM_PROMPT = `You are Vieu's AI assistant embedded in Slack, helping an AE understand a specific warm connection.

You have been given a JSON object with EVERY field Vieu knows about this connection — the introducer, the target, the account, all four "Connection to X" narrative fields, LinkedIn profiles, emails, Vieu Score, Buyer Alignment, per-hop connection strengths, target seniority, priority, status, timestamps, and the pre-drafted email copy.

Your job:
- Answer questions grounded in that JSON. Do not invent facts that aren't in the data.
- Be concise — this is Slack. 2-4 sentences ideal.
- Be warm but direct. You're a colleague, not a chatbot.
- If the JSON doesn't contain the answer, say so plainly instead of guessing.

FORMATTING — Slack mrkdwn ONLY. This is critical:
- Bold: use single asterisks like *bold text*. NEVER use **bold** or __bold__ — Slack renders those literally.
- Italics: _text_ (single underscores).
- Links: <https://url|link text>. NEVER use [text](url) — Slack renders that literally.
- Bullets: "• item" or "- item".
- No headings (#), no tables, no code fences unless quoting data.
- Never paste vieu.com URLs — the user already has them on the card above.`;

// LLMs frequently emit standard Markdown even when told not to. Normalize to Slack mrkdwn.
function slackifyMarkdown(text) {
  if (!text) return text;
  return text
    // Drop any markdown link pointing to vieu.com — keep just the visible text.
    .replace(/\[([^\]]+)\]\(https?:\/\/(?:www\.|app\.)?vieu\.com\/[^)]*\)/g, '$1')
    // Drop any bare vieu.com URL.
    .replace(/https?:\/\/(?:www\.|app\.)?vieu\.com\/\S+/g, '')
    // Standard [text](url) → Slack <url|text> for any remaining links.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
    // Bold: **text** or __text__ → *text*
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    // Cleanup whitespace left over from stripped URLs.
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

export async function explainConnection({ connection, question, threadTs }) {
  const historyKey = threadTs || 'ephemeral';
  const messages = await getThreadMessages(historyKey);
  messages.push({ role: 'user', content: question });

  const systemMsg = `${EXPLAIN_SYSTEM_PROMPT}\n\nCONNECTION DATA (all fields):\n\`\`\`json\n${connectionAsJson(connection)}\n\`\`\``;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      messages: [{ role: 'system', content: systemMsg }, ...messages],
    });
    const raw = response.choices[0].message.content;
    const reply = slackifyMarkdown(raw);
    messages.push({ role: 'assistant', content: reply });
    if (messages.length > 20) messages.splice(0, messages.length - 20);
    await saveThreadMessages(historyKey, messages);
    return reply;
  } catch (err) {
    console.error('[LLM] explain failed:', err.message);
    // Not persisted — the failed turn never got saved, so history stays clean.
    return `Sorry, I hit an error. Here's what I know:\n\n*${connection.introducer_name || ''}* → *${connection.target_name}* (${connection.account || ''})\n${connection.summary || ''}\n\nVieu Score: *${connection.vieu_score ?? 'n/a'}*`;
  }
}

// ── Intro draft ──

export async function draftIntroRequest({ connection }) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 400,
      messages: [
        {
          role: 'system',
          content: `You write short, warm introduction requests from an AE to a connector, asking them to introduce the AE to a target contact. Keep it to 3-5 sentences. Be specific about the shared history. Casual professional tone — like a real person texting a colleague, not a sales template.`,
        },
        {
          role: 'user',
          content: `Write an intro request to ${connection.introducer_name || connection.connector_name} asking them to introduce me to ${connection.target_name} (${connection.target_title} at ${connection.account || connection.target_company}).

Context about their relationship: ${connection.summary || connection.connection_to_target || connection.context || 'no additional context'}`,
        },
      ],
    });
    return response.choices[0].message.content;
  } catch (err) {
    console.error('[LLM] Draft generation failed, using template:', err.message);
    return [
      `Hey ${(connection.introducer_name || connection.connector_name || 'there').split(' ')[0]} — quick ask.`,
      ``,
      `Would you be open to introducing me to ${connection.target_name} (${connection.target_title} at ${connection.account || connection.target_company})? ${connection.summary || connection.context || ''}`,
      ``,
      `Happy to send a forwardable blurb if it's easier. No pressure if the timing's off.`,
    ].join('\n');
  }
}
