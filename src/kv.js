// Single shared Redis client for state.json/activity.json/thread-memory/dedupe.
// Vercel's Redis integration (Upstash) injects env vars under one of two
// naming conventions depending on how the store was provisioned — check both
// so it works regardless of which flow was used in the dashboard.
import { Redis } from '@upstash/redis';

const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error(
    'Redis env vars not set (need KV_REST_API_URL/KV_REST_API_TOKEN or ' +
    'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN). Provision a Redis store ' +
    'in Vercel and link it to this project. For local dev: `vercel env pull .env`.'
  );
}

export const kv = new Redis({ url, token });
