import { Redis as RedisInstance } from 'ioredis';
import { 
  RoomState, 
  SerializedRoomState, 
  Player, 
  RoomStatus,
  REDIS_ROOM_TTL_SECONDS 
} from '../types/game.types';
import { getRedisClient } from './redis';

const ROOM_KEY_PREFIX = 'room:';

export function serializeRoomState(room: RoomState): string {
  const serialized: SerializedRoomState = {
    roomId: room.roomId,
    hostId: room.hostId,
    status: room.status,
    config: room.config,
    players: Object.fromEntries(room.players),
    createdAt: room.createdAt,
    startedAt: room.startedAt,
  };
  return JSON.stringify(serialized);
}

export function deserializeRoomState(jsonString: string): RoomState {
  const parsed = JSON.parse(jsonString) as SerializedRoomState;
  
  const playersMap = new Map<string, Player>(
    Object.entries(parsed.players || {})
  );

  return {
    roomId: parsed.roomId,
    hostId: parsed.hostId,
    status: parsed.status,
    config: parsed.config,
    players: playersMap,
    createdAt: parsed.createdAt,
    startedAt: parsed.startedAt,
  };
}

/**
 * Resilient Ephemeral Room Store:
 * Connects to Redis with strict 10-day TTL (864,000s).
 * Maintains an internal memory backup in case Redis is completely unreachable.
 */
export class RedisRoomStore {
  private redis: RedisInstance;
  private memoryBackup = new Map<string, { data: string; expiresAt: number }>();

  constructor(redisClient?: RedisInstance) {
    this.redis = redisClient ?? getRedisClient();
  }

  private getRoomKey(roomId: string): string {
    return `${ROOM_KEY_PREFIX}${roomId.trim().toUpperCase()}`;
  }

  /**
   * Saves or updates a RoomState with strict 10-day TTL (864000 seconds).
   */
  async saveRoom(room: RoomState): Promise<void> {
    const key = this.getRoomKey(room.roomId);
    const serializedData = serializeRoomState(room);

    // Save in memory backup with 10-day TTL
    this.memoryBackup.set(key, {
      data: serializedData,
      expiresAt: Date.now() + REDIS_ROOM_TTL_SECONDS * 1000,
    });

    try {
      await this.redis.set(key, serializedData, 'EX', REDIS_ROOM_TTL_SECONDS);
    } catch (err: any) {
      console.warn(`[RoomStore] Notice: Redis set returned ${err.message}. Maintained in-memory.`);
    }
  }

  /**
   * Retrieves RoomState from Redis (or memory backup).
   */
  async getRoom(roomId: string): Promise<RoomState | null> {
    const key = this.getRoomKey(roomId);
    
    try {
      const data = await this.redis.get(key);
      if (data) {
        return deserializeRoomState(data);
      }
    } catch (err: any) {
      // Fall through to memory backup
    }

    // Check memory backup
    const backup = this.memoryBackup.get(key);
    if (backup && backup.expiresAt > Date.now()) {
      return deserializeRoomState(backup.data);
    } else if (backup) {
      this.memoryBackup.delete(key);
    }

    return null;
  }

  /**
   * Checks remaining TTL in seconds for a given room.
   */
  async getRoomTTL(roomId: string): Promise<number> {
    const key = this.getRoomKey(roomId);
    try {
      const ttl = await this.redis.ttl(key);
      if (ttl > 0) return ttl;
    } catch {
      // Ignore
    }

    const backup = this.memoryBackup.get(key);
    if (backup) {
      const remainingMs = backup.expiresAt - Date.now();
      return Math.max(0, Math.floor(remainingMs / 1000));
    }
    return -2;
  }

  /**
   * Checks if room exists in Redis or memory store.
   */
  async roomExists(roomId: string): Promise<boolean> {
    const key = this.getRoomKey(roomId);
    try {
      const count = await this.redis.exists(key);
      if (count === 1) return true;
    } catch {
      // Ignore
    }

    const backup = this.memoryBackup.get(key);
    return !!(backup && backup.expiresAt > Date.now());
  }

  /**
   * Deletes a room immediately.
   */
  async deleteRoom(roomId: string): Promise<void> {
    const key = this.getRoomKey(roomId);
    this.memoryBackup.delete(key);
    try {
      await this.redis.del(key);
    } catch {
      // Ignore
    }
  }

  async addPlayer(roomId: string, player: Player): Promise<RoomState | null> {
    const room = await this.getRoom(roomId);
    if (!room) return null;

    room.players.set(player.socketId, player);
    await this.saveRoom(room);
    return room;
  }

  async removePlayer(roomId: string, socketId: string): Promise<RoomState | null> {
    const room = await this.getRoom(roomId);
    if (!room) return null;

    room.players.delete(socketId);
    await this.saveRoom(room);
    return room;
  }

  async updateRoomStatus(roomId: string, status: RoomStatus): Promise<RoomState | null> {
    const room = await this.getRoom(roomId);
    if (!room) return null;

    room.status = status;
    if (status === RoomStatus.ACTIVE && !room.startedAt) {
      room.startedAt = Date.now();
    }
    await this.saveRoom(room);
    return room;
  }
}

export const roomStore = new RedisRoomStore();
