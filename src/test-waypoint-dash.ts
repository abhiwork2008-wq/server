import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RedisRoomStore } from './services/roomStore';
import { GameMode, PlayerRole, PlayerState, RoomStatus } from './types/game.types';
import { generateRandomGeofenceCoordinates, shuffleArray } from './utils/haversine';
import RedisMock from 'ioredis-mock';

describe('Waypoint Dash (Photo Hunt) Server Logic', () => {
  const mockRedis = new RedisMock();
  const store = new RedisRoomStore(mockRedis as any);

  it('generates random geofence coordinates within bounds', () => {
    const center = { lat: 18.6260, lng: 73.8122 };
    const radius = 500;
    const count = 5;
    const coords = generateRandomGeofenceCoordinates(center, radius, count);

    assert.strictEqual(coords.length, count);
    coords.forEach((c, idx) => {
      assert.strictEqual(c.order, idx + 1);
      assert.ok(c.lat >= -90 && c.lat <= 90);
      assert.ok(c.lng >= -180 && c.lng <= 180);
      assert.ok(c.id.startsWith('cp_'));
    });
  });

  it('shuffles coordinates independently per player', () => {
    const center = { lat: 18.6260, lng: 73.8122 };
    const master = generateRandomGeofenceCoordinates(center, 500, 10);

    const player1Route = shuffleArray(master);
    const player2Route = shuffleArray(master);

    assert.strictEqual(player1Route.length, 10);
    assert.strictEqual(player2Route.length, 10);
    // Over 10 items, identical order is 1 in 10! = 3.6 million chance
    const isDifferentOrder = player1Route.some((cp, idx) => cp.id !== player2Route[idx].id);
    assert.ok(isDifferentOrder, 'Player routes should be shuffled independently');
  });

  it('handles room store updateGameMode for WAYPOINT_DASH', async () => {
    const roomId = 'DASH01';
    await store.saveRoom({
      roomId,
      hostId: 'host_01',
      status: RoomStatus.LOBBY,
      config: {
        roundDurationSec: 1800,
        headStartSec: 0,
        pingIntervalSec: 120,
        speedLimitMps: 6.7,
        geofenceRadiusMeters: 600,
        geofenceCenter: { lat: 18.62, lng: 73.81 },
      },
      players: new Map([
        ['sock_1', {
          socketId: 'sock_1',
          userId: 'user_1',
          displayName: 'Runner1',
          role: PlayerRole.NONE,
          state: PlayerState.ACTIVE,
        }],
        ['sock_2', {
          socketId: 'sock_2',
          userId: 'user_2',
          displayName: 'Runner2',
          role: PlayerRole.NONE,
          state: PlayerState.ACTIVE,
        }],
      ]),
      createdAt: Date.now(),
    });

    const updated = await store.updateGameMode(roomId, GameMode.WAYPOINT_DASH, 7, 'FIRST_TO_FINISH');
    assert.ok(updated);
    assert.strictEqual(updated.config.mode, GameMode.WAYPOINT_DASH);
    assert.strictEqual(updated.config.total_checkpoints, 7);
    assert.strictEqual(updated.config.win_condition, 'FIRST_TO_FINISH');

    const fetched = await store.getRoom(roomId);
    assert.strictEqual(fetched?.config.mode, GameMode.WAYPOINT_DASH);
    assert.strictEqual(fetched?.config.total_checkpoints, 7);
  });
});

