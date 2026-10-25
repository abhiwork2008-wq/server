import http from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import RedisMock from 'ioredis-mock';
import { registerSocketHandlers } from './socket/gameSocket';
import { RedisRoomStore } from './services/roomStore';
import { PlayerRole, RoomStatus } from './types/game.types';

async function runLocationMultiplexerTest() {
  console.log('\n======================================================');
  console.log('🛰️ TESTING LOCATION MULTIPLEXER & ASYMMETRIC BROADCAST');
  console.log('======================================================\n');

  const app = express();
  const server = http.createServer(app);
  const ioServer = new SocketIOServer(server, { cors: { origin: '*' } });
  
  const mockRedis = new RedisMock();
  const testStore = new RedisRoomStore(mockRedis as any);
  registerSocketHandlers(ioServer, testStore);

  const PORT = 4888;
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  const serverUrl = `http://localhost:${PORT}`;
  console.log(`Test server running on ${serverUrl}`);

  function connectClient(label: string): Promise<ClientSocket> {
    return new Promise((resolve) => {
      const client = ioClient(serverUrl, { transports: ['websocket'] });
      client.on('connect', () => {
        console.log(` [${label}] Socket connected: ${client.id}`);
        resolve(client);
      });
    });
  }

  // 1. Create Room with 4 players: Runner 1 (Host), Runner 2, Hunter 1, Hunter 2
  const runner1 = await connectClient('Runner 1 (Host)');
  const runner2 = await connectClient('Runner 2 (Allied)');
  const hunter1 = await connectClient('Hunter 1 (Opponent)');
  const hunter2 = await connectClient('Hunter 2 (Fellow Hunter)');

  const createRes: any = await new Promise((res) => {
    runner1.emit('create_room', { userId: 'runner_1', displayName: 'Speedy' }, res);
  });
  const roomId = createRes.roomId;
  console.log(`Room created: ${roomId}`);

  await new Promise((res) => runner2.emit('join_room', { roomId, userId: 'runner_2', displayName: 'Ghost' }, res));
  await new Promise((res) => hunter1.emit('join_room', { roomId, userId: 'hunter_1', displayName: 'TrackerAlpha' }, res));
  await new Promise((res) => hunter2.emit('join_room', { roomId, userId: 'hunter_2', displayName: 'TrackerBravo' }, res));

  // Set roles
  await new Promise((res) => runner1.emit('set_role', { roomId, role: PlayerRole.RUNNER }, res));
  await new Promise((res) => runner2.emit('set_role', { roomId, role: PlayerRole.RUNNER }, res));
  await new Promise((res) => hunter1.emit('set_role', { roomId, role: PlayerRole.HUNTER }, res));
  await new Promise((res) => hunter2.emit('set_role', { roomId, role: PlayerRole.HUNTER }, res));

  // Start game
  await new Promise((res) => runner1.emit('start_game', { roomId }, res));
  console.log('✅ Game started with 2 Runners and 2 Hunters');

  // Track event receipts
  let runner2ReceivedLocation: any = null;
  let hunter1ReceivedLocation: any = null;
  let hunter2ReceivedLocation: any = null;
  let runner1OverspeedEvent: any = null;

  runner2.on('player_location', (loc) => { runner2ReceivedLocation = loc; });
  hunter1.on('player_location', (loc) => { hunter1ReceivedLocation = loc; });
  hunter2.on('player_location', (loc) => { hunter2ReceivedLocation = loc; });
  runner1.on('overspeed_violation', (ev) => { runner1OverspeedEvent = ev; });

  // ── TEST 1: Normal Runner Location Update (Jogging ~3 m/s) ──
  console.log('\n--- TEST 1: Normal Speed Update (< 6.7 m/s) ---');
  const t0 = 1000000;
  const t1 = t0 + 2000; // 2 seconds later
  // Initial position for Runner 1
  await new Promise((res) => {
    runner1.emit('location_update', {
      roomId,
      coords: { lat: 18.6260, lng: 73.8122 },
      timestamp: t0,
    }, res);
  });

  // Runner 1 moves ~6 meters in 2s (~3.0 m/s)
  // 0.00005 deg lat ≈ 5.56 meters
  runner2ReceivedLocation = null;
  hunter1ReceivedLocation = null;

  const normalRes: any = await new Promise((res) => {
    runner1.emit('location_update', {
      roomId,
      coords: { lat: 18.62605, lng: 73.8122 },
      timestamp: t1,
    }, res);
  });

  await new Promise((r) => setTimeout(r, 100));

  console.log(`Normal update speed: ${normalRes.calculatedSpeed?.toFixed(2)} m/s, overspeed: ${normalRes.overspeedViolation}`);
  if (normalRes.overspeedViolation !== false) {
    throw new Error('Expected normal speed (< 6.7 m/s) to NOT be flagged as overspeed violation');
  }

  // Asymmetric check: Runner 2 (allied) receives live location, Hunter 1 does NOT
  if (!runner2ReceivedLocation) {
    throw new Error('Allied Runner 2 did not receive Runner 1 live location!');
  }
  console.log('✅ Allied Runner 2 received live location from Runner 1');

  if (hunter1ReceivedLocation) {
    throw new Error('LEAK: Hunter 1 received live runner location! Asymmetric broadcast violated!');
  }
  console.log('✅ Hunter 1 did NOT receive live runner location (correctly hidden)');

  // ── TEST 2: Overspeed Violation (> 6.7 m/s) ──
  console.log('\n--- TEST 2: Overspeed Violation (> 6.7 m/s) ---');
  const t2 = t1 + 2000; // 2 seconds later
  // Runner 1 jumps 200 meters in 2 seconds (~100 m/s, vehicle/bike)
  // 0.0018 deg lat ≈ 200 meters
  runner2ReceivedLocation = null;
  hunter1ReceivedLocation = null;

  const overspeedRes: any = await new Promise((res) => {
    runner1.emit('location_update', {
      roomId,
      coords: { lat: 18.62785, lng: 73.8122 },
      timestamp: t2,
    }, res);
  });

  await new Promise((r) => setTimeout(r, 100));

  console.log(`Overspeed update speed: ${overspeedRes.calculatedSpeed?.toFixed(2)} m/s, overspeedViolation: ${overspeedRes.overspeedViolation}`);
  if (overspeedRes.overspeedViolation !== true) {
    throw new Error('Expected speed > 6.7 m/s to be flagged as overspeed violation!');
  }
  if (!runner2ReceivedLocation?.overspeedViolation) {
    throw new Error('Broadcast payload to allied runner was not flagged with overspeedViolation = true!');
  }
  console.log('✅ Overspeed violation successfully calculated and flagged on payload!');

  // ── TEST 3: Hunter-to-Fellow Hunter Asymmetric Broadcast ──
  console.log('\n--- TEST 3: Hunter Fellow Broadcast ---');
  let runner1ReceivedLoc = false;
  runner1.on('player_location', () => { runner1ReceivedLoc = true; });
  let hunter2ReceivedLoc = false;
  hunter2.on('player_location', () => { hunter2ReceivedLoc = true; });

  await new Promise((res) => {
    hunter1.emit('location_update', {
      roomId,
      coords: { lat: 18.6250, lng: 73.8110 },
      timestamp: Date.now(),
    }, res);
  });

  await new Promise((r) => setTimeout(r, 100));

  if (!hunter2ReceivedLoc) {
    throw new Error('Fellow Hunter 2 did not receive Hunter 1 location!');
  }
  if (runner1ReceivedLoc) {
    throw new Error('LEAK: Runner received Hunter live location!');
  }
  console.log('✅ Hunter 2 received Hunter 1 location; Runner was kept blind to Hunters');

  // ── TEST 4: Hunters Tracking Runners Snapshot (runner_ping_snapshot) ──
  console.log('\n--- TEST 4: Buffered Runner Ping Snapshot for Hunters ---');
  let hunter1Snapshot: any = null;
  let hunter2Snapshot: any = null;
  let runner1Snapshot: any = null;

  hunter1.on('runner_ping_snapshot', (snap) => { hunter1Snapshot = snap; });
  hunter2.on('runner_ping_snapshot', (snap) => { hunter2Snapshot = snap; });
  runner1.on('runner_ping_snapshot', (snap) => { runner1Snapshot = snap; });

  // Runner 2 also reports position
  await new Promise((res) => {
    runner2.emit('location_update', {
      roomId,
      coords: { lat: 18.6255, lng: 73.8115 },
      timestamp: Date.now(),
    }, res);
  });

  // Trigger snapshot dispatch
  await new Promise((res) => {
    hunter1.emit('trigger_ping_snapshot', { roomId }, res);
  });

  await new Promise((r) => setTimeout(r, 150));

  if (!hunter1Snapshot || !hunter2Snapshot) {
    throw new Error('Hunters did not receive runner_ping_snapshot!');
  }
  if (runner1Snapshot) {
    throw new Error('Runners received runner_ping_snapshot! Snapshots should only go to hunters.');
  }

  console.log(`✅ Snapshot received by hunters with ${hunter1Snapshot.snapshots.length} runner(s) buffered:`);
  hunter1Snapshot.snapshots.forEach((s: any) => {
    console.log(`   - Player: ${s.displayName} (${s.playerId}), Coords: [${s.coords.lat}, ${s.coords.lng}], Speed: ${s.speed?.toFixed(1)} m/s`);
  });

  if (hunter1Snapshot.snapshots.length !== 2) {
    throw new Error(`Expected 2 runners in snapshot, received ${hunter1Snapshot.snapshots.length}`);
  }

  // ── TEST 5: Out of Bounds Geofence Breach Continuous Reveal & Safe Zone Restoration ──
  console.log('\n--- TEST 5: Out of Bounds Breach Continuous Reveal & Safe Zone Restoration ---');

  let hunter1BreachAlert: any = null;
  let hunter1ClearedAlert: any = null;
  let runner1BoundaryWarning: any = null;
  let runner1BoundaryRestored: any = null;

  hunter1.on('runner_out_of_bounds_alert', (ev) => { hunter1BreachAlert = ev; });
  hunter1.on('runner_out_of_bounds_cleared', (ev) => { hunter1ClearedAlert = ev; });
  runner1.on('boundary_warning', (ev) => { runner1BoundaryWarning = ev; });
  runner1.on('boundary_restored', (ev) => { runner1BoundaryRestored = ev; });

  // 5A. Runner 1 steps outside the 500m geofence (Center is 18.6260, 73.8122; ~900m north is 18.6341)
  hunter1ReceivedLocation = null;
  hunter1BreachAlert = null;
  runner1BoundaryWarning = null;

  await new Promise((res) => {
    runner1.emit('location_update', {
      roomId,
      coords: { lat: 18.6341, lng: 73.8122 },
      timestamp: Date.now(),
    }, res);
  });

  await new Promise((r) => setTimeout(r, 100));

  if (!runner1BoundaryWarning) {
    throw new Error('Runner 1 did not receive boundary_warning when outside zone!');
  }
  if (!hunter1ReceivedLocation) {
    throw new Error('Hunter 1 did NOT receive live location for out-of-bounds Runner 1!');
  }
  if (!hunter1ReceivedLocation.isOutOfBounds || !hunter1ReceivedLocation.isCompromised) {
    throw new Error('Hunter 1 location payload did not flag isOutOfBounds / isCompromised!');
  }
  if (!hunter1BreachAlert) {
    throw new Error('Hunter 1 did not receive runner_out_of_bounds_alert event!');
  }
  console.log(`✅ TEST 5A PASSED: Out-of-bounds Runner 1 was CONTINUOUSLY REVEALED to Hunter 1 (${hunter1ReceivedLocation.distanceFromCenterMeters.toFixed(0)}m from center)`);

  // 5B. Runner 1 re-enters the 500m geofence (back to center 18.6260, 73.8122)
  hunter1ReceivedLocation = null;
  runner1BoundaryRestored = null;
  hunter1ClearedAlert = null;

  await new Promise((res) => {
    runner1.emit('location_update', {
      roomId,
      coords: { lat: 18.6260, lng: 73.8122 },
      timestamp: Date.now(),
    }, res);
  });

  await new Promise((r) => setTimeout(r, 100));

  if (!runner1BoundaryRestored) {
    throw new Error('Runner 1 did not receive boundary_restored when re-entering safe zone!');
  }
  if (!hunter1ClearedAlert) {
    throw new Error('Hunter 1 did not receive runner_out_of_bounds_cleared when Runner 1 re-entered!');
  }
  if (hunter1ReceivedLocation !== null) {
    throw new Error('Hunter 1 received live location for Runner 1 who is back inside safe zone! Location should be hidden.');
  }
  console.log('✅ TEST 5B PASSED: Runner 1 returned to safe zone; Hunter live tracking terminated and stealth restored!');

  // Cleanup
  runner1.disconnect();
  runner2.disconnect();
  hunter1.disconnect();
  hunter2.disconnect();
  ioServer.close();
  server.close();

  console.log('\n======================================================');
  console.log('🎉 ALL LOCATION MULTIPLEXER & GEOFENCE TESTS PASSED (100%)!');
  console.log('======================================================\n');
}

runLocationMultiplexerTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
