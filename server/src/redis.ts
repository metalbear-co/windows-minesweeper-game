import { Redis } from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// Singleton client -- shared across the whole server process.
let _client: Redis | null = null;

export function getRedis(): Redis {
  if (!_client) {
    _client = new Redis(REDIS_URL, {
      // Fail fast on startup rather than silently queueing forever.
      lazyConnect: false,
      maxRetriesPerRequest: 3,
    });
    _client.on("error", (err: Error) => {
      console.error("Redis error:", err.message);
    });
  }
  return _client;
}

export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}
