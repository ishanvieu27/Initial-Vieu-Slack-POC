// Local dev entrypoint — Socket Mode, no public URL needed. All the actual
// listener logic lives in handlers.js so it's shared verbatim with the
// Vercel HTTP-mode entrypoint at api/slack/events.js.
import 'dotenv/config';
import bolt from '@slack/bolt';
import { registerHandlers } from './handlers.js';

const { App } = bolt;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

registerHandlers(app);

(async () => {
  await app.start();
  console.log('⚡ Vieu Slack POC running (Socket Mode, local dev)');
})();
