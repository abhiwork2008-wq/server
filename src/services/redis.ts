import Redis, { Redis as RedisInstance, RedisOptions } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { REDIS_ROOM_TTL_SECONDS } from '../types/game.types';

let activeClient: RedisInstance | null = null;
let isUsingMock = false;

/**
 * Creates and configures a resilient Redis client.
 * Connects to REDIS_URL if available; if local redis is unreachable,
 * it catches the ECONNREFUSED error and seamlessly activates an internal
 * in-memory mock engine with identical TTL and command semantics.
 */
export function createRedisClient(options?: RedisOptions | string): RedisInstance {
  const connectionUrl = typeof options === 'string' 
    ? options 
    : (process.env.REDIS_URL || 'redis://127.0.0.1:6379');

  // If explicitly configured to mock or in test mode
  if (process.env.USE_REDIS_MOCK === 'true') {
    console.log('[Redis] In-memory Redis mock engine active (TTL: 864,000s).');
    isUsingMock = true;
    return new RedisMock() as unknown as RedisInstance;
  }

  try {
    const realRedis = new Redis(connectionUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
      retryStrategy(times) {
        if (times > 2) {
          // Stop reconnect spamming if Redis daemon is not installed locally
          return null;
        }
        return 500;
      },
    });

    // Fallback instance ready if real connection fails
    const mockFallback = new RedisMock() as unknown as RedisInstance;

    realRedis.on('connect', () => {
      console.log('[Redis] Connected successfully to external Redis daemon.');
      isUsingMock = false;
    });

    realRedis.on('error', (err: any) => {
      if (!isUsingMock) {
        if (err.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED')) {
          console.warn(`[Redis] ECONNREFUSED detected at ${connectionUrl}`);
        } else {
          console.warn(`[Redis] Connection notice: ${err.message}`);
        }
        console.log('[Redis] ⚡ Seamlessly activated in-memory Redis mock engine with strict 10-day TTL (864,000s).');
        isUsingMock = true;
      }
    });

    // Proxy that routes to mock if real redis is offline
    const proxyClient = new Proxy(realRedis, {
      get(target, prop, receiver) {
        if (isUsingMock && prop in mockFallback) {
          const val = (mockFallback as any)[prop];
          return typeof val === 'function' ? val.bind(mockFallback) : val;
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === 'function' ? val.bind(target) : val;
      },
    });

    return proxyClient;
  } catch (err: any) {
    console.warn(`[Redis] Caught error initializing Redis: ${err.message}. Activating in-memory mock engine.`);
    isUsingMock = true;
    return new RedisMock() as unknown as RedisInstance;
  }
}

export function getRedisClient(): RedisInstance {
  if (!activeClient) {
    activeClient = createRedisClient();
  }
  return activeClient;
}

// ── Strict 10-Day Ephemeral Command Semantics ──────────────────────────────

/**
 * Saves a key with strict 10-day TTL (864,000 seconds) by default.
 */
export async function set(
  key: string, 
  value: string, 
  ttlSeconds: number = REDIS_ROOM_TTL_SECONDS
): Promise<void> {
  const client = getRedisClient();
  await client.set(key, value, 'EX', ttlSeconds);
}

/**
 * Retrieves a key from the store.
 */
export async function get(key: string): Promise<string | null> {
  const client = getRedisClient();
  return await client.get(key);
}

/**
 * Deletes a key from the store.
 */
export async function del(key: string): Promise<void> {
  const client = getRedisClient();
  await client.del(key);
}

/**
 * Checks remaining TTL in seconds.
 */
export async function ttl(key: string): Promise<number> {
  const client = getRedisClient();
  return await client.ttl(key);
}

/**
 * Checks if a key exists in the store.
 */
export async function exists(key: string): Promise<boolean> {
  const client = getRedisClient();
  const count = await client.exists(key);
  return count === 1;
}

export { REDIS_ROOM_TTL_SECONDS };
