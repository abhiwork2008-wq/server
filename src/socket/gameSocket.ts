import { Server as SocketIOServer, Socket } from 'socket.io';
import { 
  RoomState, 
  RoomStatus, 
  PlayerRole, 
  PlayerState, 
  Player, 
  DEFAULT_ROOM_CONFIG, 
  RoomConfig,
  RunnerSnapshot,
  RunnerPingSnapshotPayload
} from '../types/game.types';
import { generateRoomCode, isValidRoomCode } from '../utils/codeGen';
import { RedisRoomStore, roomStore } from '../services/roomStore';
import { verifyPlayerSpeed, calculateHaversineDistanceMeters, isValidLatLng } from '../utils/haversine';

/**
 * Payload definitions for Socket.IO events
 */
export interface CreateRoomDto {
  userId: string;
  displayName?: string;
  config?: Partial<RoomConfig>;
}

export interface JoinRoomDto {
  roomId: string;
  userId: string;
  displayName?: string;
  role?: PlayerRole;
}

export interface SetRoleDto {
  roomId: string;
  role: PlayerRole;
}

export interface StartGameDto {
  roomId: string;
}

export interface LocationUpdateDto {
  roomId: string;
  coords: {
    lat: number;
    lng: number;
  };
  speed?: number;
  accuracy?: number;
  timestamp?: number;
}

// ── Background Snapshot Interval Manager (180s by default) ──────────────────
const snapshotTimers = new Map<string, NodeJS.Timeout>();

/**
 * Emits timed runner snapshot pings to all active hunters in the specified room.
 */
export async function emitRunnerPingSnapshot(
  roomId: string, 
  io: SocketIOServer, 
  store: RedisRoomStore
): Promise<void> {
  const room = await store.getRoom(roomId);
  if (!room || room.status === RoomStatus.ENDED) {
    stopSnapshotTimer(roomId);
    return;
  }

  // Buffer and collect all active runner positions
  const snapshots: RunnerSnapshot[] = [];
  for (const player of room.players.values()) {
    if (player.role === PlayerRole.RUNNER && player.state === PlayerState.ACTIVE && player.lastKnownCoords) {
      snapshots.push({
        playerId: player.userId,
        socketId: player.socketId,
        displayName: player.displayName || `Runner-${player.userId.slice(0, 4)}`,
        coords: player.lastKnownCoords,
        speed: player.speed,
        capturedAt: player.lastUpdatedAt ?? Date.now(),
      });
    }
  }

  const payload: RunnerPingSnapshotPayload = {
    roomId,
    timestamp: Date.now(),
    snapshots,
  };

  // Asymmetric delivery: Emit ONLY to hunters
  let hunterCount = 0;
  for (const [socketId, player] of room.players.entries()) {
    if (player.role === PlayerRole.HUNTER) {
      io.to(socketId).emit('runner_ping_snapshot', payload);
      hunterCount++;
    }
  }

  console.log(`[Snapshot] Room ${roomId}: broadcasted ${snapshots.length} runner snapshot(s) to ${hunterCount} hunter(s).`);
}

/**
 * Ensures a recurring snapshot timer is active for the room (every 180s).
 */
export function ensureSnapshotTimer(
  roomId: string, 
  io: SocketIOServer, 
  store: RedisRoomStore, 
  intervalSec: number = 180
): void {
  const normalizedId = roomId.trim().toUpperCase();
  if (snapshotTimers.has(normalizedId)) return;

  const intervalMs = Math.max(1000, intervalSec * 1000);
  console.log(`[Snapshot Timer] Starting ${intervalSec}s runner ping snapshot interval for room ${normalizedId}`);

  const timer = setInterval(() => {
    emitRunnerPingSnapshot(normalizedId, io, store).catch((err) => {
      console.error(`[Snapshot Timer] Error emitting ping in room ${normalizedId}:`, err);
    });
  }, intervalMs);

  snapshotTimers.set(normalizedId, timer);
}

/**
 * Clears and removes a room's snapshot timer.
 */
export function stopSnapshotTimer(roomId: string): void {
  const normalizedId = roomId.trim().toUpperCase();
  const timer = snapshotTimers.get(normalizedId);
  if (timer) {
    clearInterval(timer);
    snapshotTimers.delete(normalizedId);
    console.log(`[Snapshot Timer] Stopped snapshot timer for room ${normalizedId}`);
  }
}

/**
 * Registers Socket.IO game events and authoritative lobby logic
 */
export function registerSocketHandlers(io: SocketIOServer, store: RedisRoomStore = roomStore) {
  // Fast in-memory socket to roomId mapping for O(1) disconnect resolution
  const socketToRoom = new Map<string, string>();

  io.on('connection', (socket: Socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);

    /**
     * CREATE_ROOM:
     * Generates a 6-character uppercase alphanumeric room code, creates RoomState,
     * stores in Redis with 864,000s (10-day) TTL, and joins socket to room channel.
     */
    socket.on('create_room', async (data: CreateRoomDto, callback?: (res: any) => void) => {
      try {
        const { userId, displayName, config } = data;
        if (!userId) {
          callback?.({ success: false, error: 'userId is required' });
          return;
        }

        // Generate 6-char uppercase alphanumeric room code (e.g. 'XR7B9P')
        let roomId = generateRoomCode(6);
        let attempts = 0;
        while (await store.roomExists(roomId) && attempts < 5) {
          roomId = generateRoomCode(6);
          attempts++;
        }

        const hostPlayer: Player = {
          socketId: socket.id,
          userId,
          displayName: displayName || `Host-${userId.slice(0, 4)}`,
          role: PlayerRole.NONE,
          state: PlayerState.ACTIVE,
          lastKnownCoords: null,
          lastUpdatedAt: null,
        };

        const newRoom: RoomState = {
          roomId,
          hostId: userId,
          status: RoomStatus.LOBBY,
          config: {
            ...DEFAULT_ROOM_CONFIG,
            ...(config || {}),
          },
          players: new Map([[socket.id, hostPlayer]]),
          createdAt: Date.now(),
          startedAt: null,
        };

        // Save to Redis with 10-day TTL (864000 seconds)
        await store.saveRoom(newRoom);

        socketToRoom.set(socket.id, roomId);
        socket.join(`room:${roomId}`);

        console.log(`[Lobby] Room ${roomId} created by host ${userId} (socket ${socket.id})`);

        const responsePayload = {
          success: true,
          roomId,
          room: {
            ...newRoom,
            players: Object.fromEntries(newRoom.players),
          },
        };

        callback?.(responsePayload);
        socket.emit('room_created', responsePayload);
      } catch (err: any) {
        console.error('[create_room] Error:', err);
        callback?.({ success: false, error: err.message || 'Failed to create room' });
      }
    });

    /**
     * JOIN_ROOM:
     * Adds player to existing room in Redis and notifies other players.
     */
    socket.on('join_room', async (data: JoinRoomDto, callback?: (res: any) => void) => {
      try {
        const { roomId, userId, displayName, role } = data;
        const normalizedRoomId = (roomId || '').trim().toUpperCase();

        if (!isValidRoomCode(normalizedRoomId)) {
          callback?.({ success: false, error: 'Invalid 6-character room code format' });
          return;
        }

        let room = await store.getRoom(normalizedRoomId);
        if (!room) {
          if (normalizedRoomId === '4J8TTU') {
            const defaultRoom: RoomState = {
              roomId: '4J8TTU',
              hostId: userId,
              status: RoomStatus.LOBBY,
              config: { ...DEFAULT_ROOM_CONFIG },
              players: new Map(),
              createdAt: Date.now(),
            };
            await store.saveRoom(defaultRoom);
            room = defaultRoom;
            console.log(`[Lobby] Default room 4J8TTU auto-provisioned for user ${userId}`);
          } else {
            callback?.({ success: false, error: `Room ${normalizedRoomId} not found or expired` });
            return;
          }
        }

        // Corner Case: Purge any stale socket IDs belonging to this user in this room
        for (const [existingSocketId, existingPlayer] of room.players.entries()) {
          if (existingPlayer.userId === userId && existingSocketId !== socket.id) {
            room.players.delete(existingSocketId);
            socketToRoom.delete(existingSocketId);
            console.log(`[Lobby] Replaced stale socket ${existingSocketId} for user ${userId} in room ${normalizedRoomId}`);
          }
        }

        const newPlayer: Player = {
          socketId: socket.id,
          userId,
          displayName: displayName || `Player-${userId.slice(0, 4)}`,
          role: role || PlayerRole.RUNNER,
          state: PlayerState.ACTIVE,
          lastKnownCoords: null,
          lastUpdatedAt: null,
        };

        room.players.set(socket.id, newPlayer);
        socketToRoom.set(socket.id, normalizedRoomId);
        await store.saveRoom(room); // Persists to Redis with 10-day TTL

        socket.join(`room:${normalizedRoomId}`);
        socket.join(normalizedRoomId);

        console.log(`[Lobby] User ${userId} joined room ${normalizedRoomId} as ${newPlayer.role}`);

        const responsePayload = {
          success: true,
          roomId: normalizedRoomId,
          room: {
            ...room,
            players: Object.fromEntries(room.players),
          },
          player: newPlayer,
        };

        callback?.(responsePayload);
        socket.to(`room:${normalizedRoomId}`).emit('player_joined', {
          roomId: normalizedRoomId,
          player: newPlayer,
        });
      } catch (err: any) {
        console.error('[join_room] Error:', err);
        callback?.({ success: false, error: err.message || 'Failed to join room' });
      }
    });

    /**
     * SET_ROLE:
     * Sets role ('Hunter', 'Runner', 'Spectator', 'None')
     */
    socket.on('set_role', async (data: SetRoleDto, callback?: (res: any) => void) => {
      try {
        const { roomId, role } = data;
        const normalizedRoomId = (roomId || '').trim().toUpperCase();
        const room = await store.getRoom(normalizedRoomId);

        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        const player = room.players.get(socket.id);
        if (!player) {
          callback?.({ success: false, error: 'Player not found in room' });
          return;
        }

        player.role = role;
        await store.saveRoom(room);

        io.to(`room:${normalizedRoomId}`).emit('player_role_updated', {
          roomId: normalizedRoomId,
          socketId: socket.id,
          role,
        });

        callback?.({ success: true, role });
      } catch (err: any) {
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * START_GAME / startGame:
     * Transitions room status from LOBBY to HEAD_START / ACTIVE.
     * Initializes the 180s runner ping snapshot interval.
     */
    const handleStartGame = async (data: StartGameDto, callback?: (res: any) => void) => {
      try {
        const { roomId } = data;
        const normalizedRoomId = (roomId || '').trim().toUpperCase();
        const room = await store.getRoom(normalizedRoomId);

        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        // Authoritative verification: caller must be host
        const player = room.players.get(socket.id);
        if (!player || player.userId !== room.hostId) {
          callback?.({ success: false, error: 'Only the room host can start the game' });
          return;
        }

        // Corner Case: Cannot restart already running or ended game
        if (room.status === RoomStatus.ACTIVE || room.status === RoomStatus.HEAD_START) {
          callback?.({ success: true, status: room.status, message: 'Game already in progress' });
          return;
        }
        if (room.status === RoomStatus.ENDED) {
          callback?.({ success: false, error: 'Cannot start an ended game' });
          return;
        }

        // Role Assignment for match (Among Us style):
        // If no Hunter is assigned, pick 1 random player to be the Seeker/Hunter!
        const playerEntries = Array.from(room.players.entries());
        const hasHunter = playerEntries.some(([_, p]) => p.role === PlayerRole.HUNTER);
        
        if (!hasHunter && playerEntries.length > 0) {
          const randomIndex = Math.floor(Math.random() * playerEntries.length);
          playerEntries.forEach(([_, p], idx) => {
            p.role = idx === randomIndex ? PlayerRole.HUNTER : PlayerRole.RUNNER;
          });
          console.log(`[Lobby] Among Us Role Roulette: Assigned ${playerEntries[randomIndex][1].displayName} as SEEKER/HUNTER. Remaining ${playerEntries.length - 1} as RUNNERS.`);
        } else {
          // If any player is still unassigned (NONE), assign as RUNNER
          playerEntries.forEach(([_, p]) => {
            if (p.role === PlayerRole.NONE) {
              p.role = PlayerRole.RUNNER;
            }
          });
        }

        room.status = room.config.headStartSec > 0 ? RoomStatus.HEAD_START : RoomStatus.ACTIVE;
        room.startedAt = Date.now();
        await store.saveRoom(room);

        // Start runner ping snapshot scheduler for Hunters
        ensureSnapshotTimer(normalizedRoomId, io, store, room.config.pingIntervalSec || 180);

        const playersPayload = Object.fromEntries(room.players);

        io.to(`room:${normalizedRoomId}`).emit('game_started', {
          roomId: normalizedRoomId,
          status: room.status,
          startedAt: room.startedAt,
          config: room.config,
          players: playersPayload,
        });

        // Broadcast individual role updates for all players
        for (const [sId, p] of room.players.entries()) {
          io.to(`room:${normalizedRoomId}`).emit('player_role_updated', {
            roomId: normalizedRoomId,
            socketId: sId,
            userId: p.userId,
            displayName: p.displayName,
            role: p.role,
          });
        }

        callback?.({ success: true, status: room.status, players: playersPayload });
      } catch (err: any) {
        callback?.({ success: false, error: err.message });
      }
    };

    socket.on('start_game', handleStartGame);
    socket.on('startGame', handleStartGame);

    /**
     * ADD_TEST_PLAYER:
     * Allows adding a simulated squad operative to the room (useful for testing 2+ player lobbies).
     */
    socket.on('add_test_player', async (data: { roomId: string; displayName?: string }, callback?: (res: any) => void) => {
      try {
        const { roomId, displayName } = data;
        const normalizedRoomId = (roomId || '').trim().toUpperCase();
        const room = await store.getRoom(normalizedRoomId);
        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        const botId = `bot_${Date.now().toString().slice(-4)}`;
        const botNames = ['Viper_02', 'Shadow_03', 'Ghost_04', 'Phantom_05'];
        const chosenName = displayName || botNames[room.players.size % botNames.length];
        
        const testPlayer: Player = {
          socketId: `sim_${botId}`,
          userId: botId,
          displayName: chosenName,
          role: PlayerRole.RUNNER,
          state: PlayerState.ACTIVE,
          lastKnownCoords: room.config.geofenceCenter ? { ...room.config.geofenceCenter } : null,
          lastUpdatedAt: Date.now(),
        };

        room.players.set(testPlayer.socketId, testPlayer);
        await store.saveRoom(room);

        io.to(`room:${normalizedRoomId}`).emit('player_joined', {
          roomId: normalizedRoomId,
          player: testPlayer,
          players: Object.fromEntries(room.players),
        });

        console.log(`[Lobby] Added simulated operative ${chosenName} to room ${normalizedRoomId}`);
        callback?.({ success: true, player: testPlayer, players: Object.fromEntries(room.players) });
      } catch (err: any) {
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * GET_ROOM:
     * Authoritative query for room state from Redis.
     */
    socket.on('get_room', async (roomId: string, callback?: (res: any) => void) => {
      try {
        const normalizedRoomId = (roomId || '').trim().toUpperCase();
        const room = await store.getRoom(normalizedRoomId);
        const ttl = await store.getRoomTTL(normalizedRoomId);

        if (!room) {
          callback?.({ success: false, error: 'Room not found or expired' });
          return;
        }

        callback?.({
          success: true,
          room: {
            ...room,
            players: Object.fromEntries(room.players),
          },
          ttlSecondsRemaining: ttl,
        });
      } catch (err: any) {
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * LOCATION_UPDATE:
     * Receives GPS position updates.
     * 1. Server-side Haversine verification calculates speed.
     * 2. Flags payload as overspeed violation if speed > 6.7 m/s (~24 km/h).
     * 3. Implements asymmetric broadcasting:
     *    - Runners stream live coordinates ONLY to allied runners.
     *    - Hunters stream live coordinates ONLY to fellow hunters.
     *    - Runners' locations are buffered for hunters, emitting a runner_ping_snapshot
     *      only every 180 seconds.
     */
    socket.on('location_update', async (data: LocationUpdateDto, callback?: (res: any) => void) => {
      try {
        const { roomId, coords, speed, accuracy } = data;
        if (!roomId || !coords || !isValidLatLng(coords)) {
          callback?.({ success: false, error: 'roomId and valid coords (finite lat/lng) required' });
          return;
        }

        const normalizedRoomId = roomId.trim().toUpperCase();
        const room = await store.getRoom(normalizedRoomId);
        if (!room) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        const player = room.players.get(socket.id);
        if (!player) {
          callback?.({ success: false, error: 'Player not found in room' });
          return;
        }

        const updateTimestamp = data.timestamp || Date.now();

        // ── 1. Authoritative Server-side Haversine Speed Verification ──
        const speedVerification = verifyPlayerSpeed(
          player.lastKnownCoords,
          player.lastUpdatedAt,
          coords,
          updateTimestamp,
          room.config.speedLimitMps, // 6.7 m/s limit
          speed
        );

        const isOverspeed = speedVerification.isOverspeed;

        // Update player's authoritative position in state
        player.lastKnownCoords = coords;
        player.lastUpdatedAt = updateTimestamp;
        player.speed = speedVerification.calculatedSpeed;
        player.isOverspeed = isOverspeed;

        // Ensure the 180s ping snapshot timer is active if the game is ongoing
        if (room.status === RoomStatus.ACTIVE || room.status === RoomStatus.HEAD_START) {
          ensureSnapshotTimer(normalizedRoomId, io, store, room.config.pingIntervalSec || 180);
        }

        // ── 2. Authoritative Geofence Boundary Verification ──
        const GEOFENCE_CENTER = room?.config?.geofenceCenter || { lat: 18.6260, lng: 73.8122 };
        const GEOFENCE_RADIUS_METERS = room?.config?.geofenceRadiusMeters || 500.0;
        const distanceFromCenterMeters = calculateHaversineDistanceMeters(GEOFENCE_CENTER, coords);
        const isBoundaryBreached = distanceFromCenterMeters > GEOFENCE_RADIUS_METERS;

        const previousOutOfBounds = Boolean(player.isOutOfBounds);
        player.isOutOfBounds = isBoundaryBreached;
        player.distanceFromCenterMeters = distanceFromCenterMeters;
        await store.saveRoom(room);

        if (isBoundaryBreached) {
          console.warn(`[Geofence] Boundary Warning in ${normalizedRoomId}: Player ${player.displayName} (${player.role}) is ${distanceFromCenterMeters.toFixed(1)}m from center (Limit: ${GEOFENCE_RADIUS_METERS}m)`);
          
          const boundaryPayload = {
            roomId: normalizedRoomId,
            socketId: socket.id,
            userId: player.userId,
            displayName: player.displayName,
            role: player.role,
            coords,
            distanceMeters: distanceFromCenterMeters,
            limitMeters: GEOFENCE_RADIUS_METERS,
            timestamp: updateTimestamp,
            isCompromised: player.role === PlayerRole.RUNNER,
            message: player.role === PlayerRole.RUNNER
              ? `⚠️ GEOFENCE BREACHED: You are ${distanceFromCenterMeters.toFixed(0)}m from center (> ${GEOFENCE_RADIUS_METERS}m limit). Your LIVE location is now EXPOSED to Hunters!`
              : `⚠️ GEOFENCE BREACHED: You are ${distanceFromCenterMeters.toFixed(0)}m from center (> ${GEOFENCE_RADIUS_METERS}m limit)!`,
          };

          // Emit directly to violating player
          socket.emit('boundary_warning', boundaryPayload);
          // Broadcast to room channels
          io.to(`room:${normalizedRoomId}`).emit('boundary_warning', boundaryPayload);
          io.to(normalizedRoomId).emit('boundary_warning', boundaryPayload);
        } else if (previousOutOfBounds) {
          // Player was previously out of bounds and has now returned to the safe zone!
          console.log(`[Geofence] Player ${player.displayName} (${player.role}) returned to safe zone in ${normalizedRoomId}`);
          
          const restoredPayload = {
            roomId: normalizedRoomId,
            socketId: socket.id,
            userId: player.userId,
            displayName: player.displayName,
            role: player.role,
            coords,
            distanceMeters: distanceFromCenterMeters,
            limitMeters: GEOFENCE_RADIUS_METERS,
            timestamp: updateTimestamp,
            message: 'SAFE ZONE RESTORED: You have re-entered the play zone. Stealth cover re-engaged.',
          };

          socket.emit('boundary_restored', restoredPayload);
          io.to(`room:${normalizedRoomId}`).emit('boundary_restored', restoredPayload);
          io.to(normalizedRoomId).emit('boundary_restored', restoredPayload);

          // If the player is a Runner, notify all Hunters that the live signal has ceased
          if (player.role === PlayerRole.RUNNER) {
            for (const [targetSocketId, targetPlayer] of room.players.entries()) {
              if (targetPlayer.role === PlayerRole.HUNTER) {
                io.to(targetSocketId).emit('runner_out_of_bounds_cleared', {
                  roomId: normalizedRoomId,
                  userId: player.userId,
                  socketId: socket.id,
                  displayName: player.displayName,
                  timestamp: updateTimestamp,
                  message: `TARGET IN COVER: Runner ${player.displayName} re-entered the play zone. Live tracking terminated.`,
                });
              }
            }
          }
        }

        // ── 3. Location Payload with Overspeed & Boundary Flags ──
        const locationPayload = {
          socketId: socket.id,
          userId: player.userId,
          displayName: player.displayName,
          role: player.role,
          state: player.state,
          coords,
          reportedSpeed: speed ?? 0,
          calculatedSpeed: speedVerification.calculatedSpeed,
          distanceMeters: speedVerification.distanceMeters,
          timeDeltaSeconds: speedVerification.timeDeltaSeconds,
          isOverspeed,
          overspeedViolation: isOverspeed, // Flagged violation if > 6.7 m/s
          isBoundaryBreached,
          boundaryWarning: isBoundaryBreached,
          isOutOfBounds: isBoundaryBreached,
          isCompromised: player.role === PlayerRole.RUNNER && isBoundaryBreached,
          distanceFromCenterMeters,
          speedLimitMps: room.config.speedLimitMps,
          accuracy: accuracy ?? 0,
          timestamp: updateTimestamp,
        };

        if (isOverspeed) {
          console.warn(`[Anti-Cheat] Overspeed Violation in ${normalizedRoomId}: Player ${player.displayName} (${player.role}) moving at ${speedVerification.calculatedSpeed.toFixed(2)} m/s (Limit: ${room.config.speedLimitMps} m/s)`);
          socket.emit('overspeed_violation', {
            roomId: normalizedRoomId,
            calculatedSpeed: speedVerification.calculatedSpeed,
            limit: room.config.speedLimitMps,
            timestamp: updateTimestamp,
            message: `Overspeed violation: Speed ${speedVerification.calculatedSpeed.toFixed(2)} m/s exceeds speed limit of ${room.config.speedLimitMps} m/s`,
          });
        }

        // ── 4. Asymmetric Broadcast Logic ──
        if (player.role === PlayerRole.RUNNER) {
          // Runners stream continuous live GPS coordinates to ALLIED RUNNERS
          for (const [targetSocketId, targetPlayer] of room.players.entries()) {
            if (targetPlayer.role === PlayerRole.RUNNER && targetSocketId !== socket.id) {
              io.to(targetSocketId).emit('player_location', locationPayload);
            }
          }

          // ── OUT-OF-BOUNDS CONTINUOUS REVEAL RULE ──
          // If a runner is OUTSIDE the zone, broadcast their location continuously to HUNTERS!
          if (isBoundaryBreached) {
            const outOfBoundsPayload = {
              ...locationPayload,
              isCompromised: true,
              isOutOfBounds: true,
              boundaryWarning: true,
              alertNotice: `⚠️ TARGET COMPROMISED: Runner ${player.displayName} is outside the safe zone (${distanceFromCenterMeters.toFixed(0)}m). Live signal active!`,
            };

            for (const [targetSocketId, targetPlayer] of room.players.entries()) {
              if (targetPlayer.role === PlayerRole.HUNTER) {
                io.to(targetSocketId).emit('player_location', outOfBoundsPayload);
                if (!previousOutOfBounds) {
                  io.to(targetSocketId).emit('runner_out_of_bounds_alert', {
                    roomId: normalizedRoomId,
                    userId: player.userId,
                    socketId: socket.id,
                    displayName: player.displayName,
                    coords,
                    distanceMeters: distanceFromCenterMeters,
                    limitMeters: GEOFENCE_RADIUS_METERS,
                    timestamp: updateTimestamp,
                    message: `⚠️ ENEMY TARGET EXPOSED: Runner ${player.displayName} has breached the sector geofence! Continuous live GPS signal is active.`,
                  });
                }
              }
            }
          }
          // When INSIDE the zone, Hunters do NOT receive live runner positions (they only receive periodic 180s snapshots)
        } else if (player.role === PlayerRole.HUNTER) {
          // Hunters stream continuous live GPS coordinates to FELLOW HUNTERS ONLY
          for (const [targetSocketId, targetPlayer] of room.players.entries()) {
            if (targetPlayer.role === PlayerRole.HUNTER && targetSocketId !== socket.id) {
              io.to(targetSocketId).emit('player_location', locationPayload);
            }
          }
          // Runners do NOT receive live hunter positions (runners are visually blind to hunters)
        } else {
          // Spectators receive full tactical feed
          for (const [targetSocketId, targetPlayer] of room.players.entries()) {
            if (targetPlayer.role === PlayerRole.SPECTATOR && targetSocketId !== socket.id) {
              io.to(targetSocketId).emit('player_location', locationPayload);
            }
          }
        }

        callback?.({ 
          success: true, 
          isOverspeed, 
          calculatedSpeed: speedVerification.calculatedSpeed,
          overspeedViolation: isOverspeed
        });
      } catch (err: any) {
        console.error('[location_update] Error:', err);
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * TRIGGER_PING_SNAPSHOT (Manual / Test Hook):
     * Allows immediate emission of a runner_ping_snapshot to hunters
     * without waiting for the 180s timer.
     */
    socket.on('trigger_ping_snapshot', async (data: { roomId: string }, callback?: (res: any) => void) => {
      try {
        const normalizedRoomId = (data.roomId || '').trim().toUpperCase();
        await emitRunnerPingSnapshot(normalizedRoomId, io, store);
        callback?.({ success: true });
      } catch (err: any) {
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * PLAYER:TAGGED:
     * Runner confirms being physically tagged.
     * Transitions player to TAGGED state and SPECTATOR role in Redis,
     * broadcasts 'player_tagged' to room, and sends confirmation.
     */
    socket.on('player:tagged', async (data?: { roomId?: string }, callback?: (res: any) => void) => {
      try {
        let normalizedRoomId = data?.roomId?.trim().toUpperCase();
        let room: RoomState | null = null;

        if (normalizedRoomId) {
          room = await store.getRoom(normalizedRoomId);
        } else {
          for (const r of socket.rooms) {
            if (r.startsWith('room:')) {
              normalizedRoomId = r.replace('room:', '');
              room = await store.getRoom(normalizedRoomId);
              break;
            }
          }
        }

        if (!room || !normalizedRoomId) {
          callback?.({ success: false, error: 'Room not found' });
          return;
        }

        const player = room.players.get(socket.id);
        if (!player) {
          callback?.({ success: false, error: 'Player not found in room' });
          return;
        }

        player.state = PlayerState.TAGGED;
        player.role = PlayerRole.SPECTATOR;
        await store.saveRoom(room);

        console.log(`[Tag] Player ${player.displayName} (${player.userId}) tagged in room ${normalizedRoomId}`);

        io.to(`room:${normalizedRoomId}`).emit('player_tagged', {
          roomId: normalizedRoomId,
          socketId: socket.id,
          userId: player.userId,
          displayName: player.displayName,
          state: player.state,
          role: player.role,
        });

        callback?.({ 
          success: true, 
          message: 'Tag confirmed. Switched to Spectator mode.',
          player: {
            ...player,
            state: player.state,
            role: player.role,
          }
        });
      } catch (err: any) {
        console.error('[player:tagged] Error:', err);
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * LEAVE_ROOM:
     * Authoritatively exits the room. If the host leaves during LOBBY status,
     * the room is closed, snapshot timers stopped, and guests notified.
     */
    socket.on('leave_room', async (data?: { roomId?: string }, callback?: (res: any) => void) => {
      try {
        let normalizedRoomId = data?.roomId?.trim().toUpperCase() || socketToRoom.get(socket.id);
        if (!normalizedRoomId) {
          for (const r of socket.rooms) {
            if (r.startsWith('room:')) {
              normalizedRoomId = r.replace('room:', '');
              break;
            }
          }
        }

        if (!normalizedRoomId) {
          callback?.({ success: true, message: 'Not in a room' });
          return;
        }

        socketToRoom.delete(socket.id);
        socket.leave(`room:${normalizedRoomId}`);
        socket.leave(normalizedRoomId);

        const room = await store.getRoom(normalizedRoomId);
        if (!room) {
          callback?.({ success: true, message: 'Room already removed' });
          return;
        }

        const player = room.players.get(socket.id);
        if (!player) {
          callback?.({ success: true, message: 'Player was not in room' });
          return;
        }

        const isHost = player.userId === room.hostId;
        if (isHost && room.status === RoomStatus.LOBBY) {
          stopSnapshotTimer(normalizedRoomId);
          await store.deleteRoom(normalizedRoomId);
          console.log(`[Lobby] Host left. Room ${normalizedRoomId} closed.`);
          io.to(`room:${normalizedRoomId}`).emit('room_closed', {
            roomId: normalizedRoomId,
            reason: 'Host closed the room',
          });
          io.to(normalizedRoomId).emit('room_closed', {
            roomId: normalizedRoomId,
            reason: 'Host closed the room',
          });
        } else {
          room.players.delete(socket.id);
          await store.saveRoom(room);
          console.log(`[Lobby] Player ${player.displayName} left room ${normalizedRoomId}`);
          io.to(`room:${normalizedRoomId}`).emit('player_left', {
            roomId: normalizedRoomId,
            socketId: socket.id,
            userId: player.userId,
            displayName: player.displayName,
          });
          io.to(normalizedRoomId).emit('player_left', {
            roomId: normalizedRoomId,
            socketId: socket.id,
            userId: player.userId,
            displayName: player.displayName,
          });
        }

        callback?.({ success: true });
      } catch (err: any) {
        console.error('[leave_room] Error:', err);
        callback?.({ success: false, error: err.message });
      }
    });

    /**
     * DISCONNECT:
     * Authoritatively cleans up socket from active rooms or marks disconnected.
     */
    socket.on('disconnect', async () => {
      console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
      const roomId = socketToRoom.get(socket.id);
      if (!roomId) return;
      socketToRoom.delete(socket.id);

      try {
        const room = await store.getRoom(roomId);
        if (!room) return;

        const player = room.players.get(socket.id);
        if (!player) return;

        const isHost = player.userId === room.hostId;
        if (room.status === RoomStatus.LOBBY) {
          if (isHost) {
            stopSnapshotTimer(roomId);
            await store.deleteRoom(roomId);
            console.log(`[Lobby] Host socket ${socket.id} disconnected. Closing room ${roomId}.`);
            io.to(`room:${roomId}`).emit('room_closed', {
              roomId,
              reason: 'Host disconnected from lobby',
            });
            io.to(roomId).emit('room_closed', {
              roomId,
              reason: 'Host disconnected from lobby',
            });
          } else {
            room.players.delete(socket.id);
            await store.saveRoom(room);
            console.log(`[Lobby] Player ${player.displayName} disconnected. Removed from room ${roomId}.`);
            io.to(`room:${roomId}`).emit('player_left', {
              roomId,
              socketId: socket.id,
              userId: player.userId,
              displayName: player.displayName,
            });
            io.to(roomId).emit('player_left', {
              roomId,
              socketId: socket.id,
              userId: player.userId,
              displayName: player.displayName,
            });
          }
        } else {
          // Mid-match: mark player state as disconnected
          player.state = PlayerState.DISCONNECTED;
          await store.saveRoom(room);
          io.to(`room:${roomId}`).emit('player_disconnected', {
            roomId,
            socketId: socket.id,
            userId: player.userId,
            displayName: player.displayName,
          });
        }
      } catch (err: any) {
        console.error(`[disconnect] Error cleaning up socket ${socket.id}:`, err);
      }
    });
  });
}
