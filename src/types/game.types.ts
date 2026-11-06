/**
 * Game Types & Interfaces for Authoritative Stealth Game Server
 */

export enum RoomStatus {
  LOBBY = 'LOBBY',
  HEAD_START = 'HEAD_START',
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED',
}

export enum GameMode {
  STEALTH = 'STEALTH',
  WAYPOINT_DASH = 'WAYPOINT_DASH',
}

export type WaypointWinCondition = 'TIME_LIMIT' | 'FIRST_TO_FINISH';

export interface CheckpointCoord {
  id: string;
  order: number;
  lat: number;
  lng: number;
  name?: string;
}

export enum PlayerRole {
  HUNTER = 'Hunter',
  RUNNER = 'Runner',
  SPECTATOR = 'Spectator',
  NONE = 'None',
}

export enum PlayerState {
  ACTIVE = 'Active',
  TAGGED = 'Tagged',
  DISCONNECTED = 'Disconnected',
}

export interface Player {
  socketId: string;
  userId: string;
  role: PlayerRole;
  state: PlayerState;
  displayName?: string;
  lastKnownCoords?: {
    lat: number;
    lng: number;
  } | null;
  lastUpdatedAt?: number | null;
  speed?: number;
  isOverspeed?: boolean;
  isOutOfBounds?: boolean;
  distanceFromCenterMeters?: number;
  consecutiveOverspeedCount?: number;
  // Waypoint Dash fields
  checkpointQueue?: CheckpointCoord[];
  completedCheckpoints?: CheckpointCoord[];
  currentCheckpoint?: CheckpointCoord | null;
  finishedAt?: number | null;
}

export interface RunnerSnapshot {
  playerId: string;
  socketId: string;
  displayName: string;
  coords: { lat: number; lng: number };
  speed?: number;
  capturedAt: number;
}

export interface RunnerPingSnapshotPayload {
  roomId: string;
  timestamp: number;
  snapshots: RunnerSnapshot[];
}

export interface RoomConfig {
  roundDurationSec: number;
  headStartSec: number;
  pingIntervalSec: number;
  speedLimitMps: number;
  geofenceRadiusMeters?: number;
  geofenceCenter?: { lat: number; lng: number };
  pingEnabled?: boolean;
  zoneShrinkEnabled?: boolean;
  // Waypoint Dash parameters
  mode?: GameMode | 'STEALTH' | 'WAYPOINT_DASH';
  gameMode?: GameMode | 'STEALTH' | 'WAYPOINT_DASH';
  total_checkpoints?: number;
  totalCheckpoints?: number;
  win_condition?: WaypointWinCondition | 'TIME_LIMIT' | 'FIRST_TO_FINISH';
  winCondition?: WaypointWinCondition | 'TIME_LIMIT' | 'FIRST_TO_FINISH';
  masterCheckpoints?: CheckpointCoord[];
}

/** Default room configuration as specified in authoritative design */
export const DEFAULT_ROOM_CONFIG: Readonly<RoomConfig> = Object.freeze({
  roundDurationSec: 2700, // 45 minutes
  headStartSec: 180,       // 3 minutes head start for runners
  pingIntervalSec: 180,    // 3 minutes snapshot interval for hunters
  speedLimitMps: 6.7,      // 6.7 m/s (~24 km/h / 15 mph sprint limit)
  geofenceRadiusMeters: 500, // Default 500m play zone radius
  pingEnabled: true,
  zoneShrinkEnabled: true,
  mode: GameMode.STEALTH,
  total_checkpoints: 5,
  win_condition: 'FIRST_TO_FINISH',
});

/** Maximum players allowed per room */
export const MAX_PLAYERS_PER_ROOM = 20;

/** Strict 10-day TTL in seconds for Redis ephemeral keys (lobby self-destruct) */
export const REDIS_ROOM_TTL_SECONDS = 864000; // 10 days = 10 * 24 * 60 * 60

/**
 * Authoritative in-memory / domain representation with Map
 */
export interface RoomState {
  roomId: string;
  hostId: string;
  status: RoomStatus;
  config: RoomConfig;
  players: Map<string, Player>; // Keyed by socketId
  createdAt: number;
  startedAt?: number | null;
}

/**
 * Plain JSON-serializable representation for Redis storage and wire transfer
 */
export interface SerializedRoomState {
  roomId: string;
  hostId: string;
  status: RoomStatus;
  config: RoomConfig;
  players: Record<string, Player>;
  createdAt: number;
  startedAt?: number | null;
}
