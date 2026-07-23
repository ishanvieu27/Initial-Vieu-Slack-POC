// Vercel entrypoint — HTTP mode. One endpoint handles Events, Interactivity,
// and Slash Commands: Bolt dispatches by payload shape, not by path, so all
// three Slack app config screens point at this same Request URL.
//
// We use HTTPReceiver (not ExpressReceiver) here because Vercel's Node.js
// serverless runtime buffers and parses the request body before handing it to
// user code. Slack's signature verification depends on hashing the exact raw
// bytes of the payload — a parsed/re-serialized body will not hash the same,
// producing spurious 401 "Signature mismatch" rejections. HTTPReceiver reads
// the raw request stream itself via its `requestListener`, sidestepping any
// intermediate body parser and matching what Slack actually signed.
//
// processBeforeResponse is FALSE here (Bolt's default): ack() fires the HTTP
// response back to Slack immediately, which is what Slack's 3-second budget
// for slash commands actually requires. Individual slow handlers wrap their
// post-ack work in deferWork() (see handlers.js) so Vercel keeps the function
// alive via waitUntil until the background work finishes — rather than
// forcing every handler to complete before the ack goes out.
import 'dotenv/config';
import bolt from '@slack/bolt';
import { waitUntil } from '@vercel/functions';
import { registerHandlers } from '../../src/handlers.js';

const { App, HTTPReceiver } = bolt;

const receiver = new HTTPReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/api/slack/events',
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

registerHandlers(app);

const originalListener = receiver.requestListener;
export default function handler(req, res) {
  console.log(`[vieu] ${req.method} ${req.url} | sig=${!!req.headers['x-slack-signature']} ts=${!!req.headers['x-slack-request-timestamp']} ct=${req.headers['content-type']}`);
  // Keep function alive for 30s so deferWork background tasks complete.
  // HTTPReceiver's fire-and-forget async IIFE means waitUntil inside
  // deferWork runs too late — Vercel freezes before it registers.
  waitUntil(new Promise(resolve => setTimeout(resolve, 30000)));
  return originalListener(req, res);
}

export const config = {
  api: {
    bodyParser: false,
  },
};
