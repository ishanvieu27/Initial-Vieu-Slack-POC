// Vercel entrypoint — HTTP mode. One endpoint handles Events, Interactivity,
// and Slash Commands: Bolt dispatches by payload shape, not by path, so all
// three Slack app config screens point at this same Request URL.
//
// processBeforeResponse: true is required on serverless — without it, Bolt
// sends the HTTP ack the moment a listener calls ack()/respond(), then keeps
// running the rest of the listener in the background. On a real server that
// background work finishes fine because the process stays alive; on Vercel
// the function can be frozen the instant the response goes out, silently
// killing anything still in flight (DM sends, state writes, etc.). This flag
// makes Bolt hold the HTTP response until the whole listener has finished,
// so nothing gets cut off mid-flight.
import 'dotenv/config';
import bolt from '@slack/bolt';
import { registerHandlers } from '../../src/handlers.js';

const { App, ExpressReceiver } = bolt;

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/api/slack/events',
  processBeforeResponse: true,
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

registerHandlers(app);

export default receiver.app;
