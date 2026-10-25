/**
 * Comprehensive Backend Corner Case & Edge Case Verification Suite
 */

import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { io as ClientSocket, Socket as ClientSocketType } from 'socket.io-client';
import express from 'express';
import { RedisRoomStore } from './services/roomStore';
import { registerSocketHandlers } from './socket/gameSocket';
import { calculateHaversineDistanceMeters, verifyPlayerSpeed, isValidLatLng } from './utils/haversine';
import { RoomStatus, PlayerRole } from './types/game.types';

const TEST_PORT = 4991;
const SERVER_URL = `http://localhost:${TEST_PORT}`;

function connectClient(name: string): Promise<ClientSocketType> {
  return new Promise((resolve, reject) => {
    const socket = ClientSocket(SERVER_URL, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      reject(err);
    });
  });
}

async function runEdgeCaseTests() {
  console.log('\n======================================================');
  console.log('🧪 RUNNING COMPREHENSIVE CORNER CASES & EDGE TESTS');
  console.log('======================================================\n');

  // --- UNIT TESTS: Haversine & Anti-Cheat Coordinate & Clock Manipulation ---
  console.log('--- 1. Testing Coordinate Validation & Haversine Edge Cases ---');
  
  // Test 1A: NaN and out-of-range bounds
  const validCoord = { lat: 18.6260, lng: 73.8122 };
  const nanCoord = { lat: NaN, lng: 73.8122 };
  const outOfRangeCoord = { lat: 95.0, lng: 73.8122 };
  const malformedCoord = { lat: '18.6260' as any, lng: null as any };

  if (isValidLatLng(validCoord) && !isValidLatLng(nanCoord) && !isValidLatLng(outOfRangeCoord) && !isValidLatLng(malformedCoord)) {
    console.log('✅ 1A: isValidLatLng correctly validates finite WGS-84 ranges');
  } else {
    throw new Error('❌ 1A Failed: isValidLatLng returned incorrect validation');
  }

  const distNaN = calculateHaversineDistanceMeters(validCoord, nanCoord);
  if (isNaN(distNaN)) {
    console.log('✅ 1B: calculateHaversineDistanceMeters safely returns NaN on invalid input without crashing');
  } else {
    throw new Error('❌ 1B Failed: Did not return NaN');
  }

  // Test 1C: Teleportation Exploit (moving 500m with 0 elapsed time)
  const p1 = { lat: 18.6260, lng: 73.8122 };
  const p2Teleport = { lat: 18.6300, lng: 73.8122 }; // ~444m away
  const t0 = 1000000;
  const speedTamper = verifyPlayerSpeed(p1, t0, p2Teleport, t0, 6.7); // dt = 0
  if (speedTamper.isOverspeed && speedTamper.calculatedSpeed >= 999.0) {
    console.log('✅ 1C: Teleportation attack with frozen timestamp (dt <= 0) correctly caught as overspeed violation');
  } else {
    throw new Error('❌ 1C Failed: Teleportation exploit was not flagged as overspeed');
  }

  // Test 1D: Normal stationary jitter with 0 elapsed time (< 5m)
  const p2Jitter = { lat: 18.626001, lng: 73.812201 }; // ~0.15m away
  const speedJitter = verifyPlayerSpeed(p1, t0, p2Jitter, t0, 6.7, 0.5);
  if (!speedJitter.isOverspeed) {
    console.log('✅ 1D: Minor GPS jitter with frozen timestamp correctly ignored');
  } else {
    throw new Error('❌ 1D Failed: Minor GPS jitter falsely flagged as overspeed');
  }

  // --- INTEGRATION TESTS: Server, Sockets, and Room Lifecycles ---
  console.log('\n--- 2. Setting Up Test Socket Server ---');
  const app = express();
  const server = http.createServer(app);
  const io = new SocketIOServer(server, { cors: { origin: '*' } });
  const mockStore = new RedisRoomStore();

  registerSocketHandlers(io, mockStore);

  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`Test server running on port ${TEST_PORT}`);

  // Test 2A: Invalid / NaN Coordinates rejected in location_update
  console.log('\n--- 3. Testing Malformed Location Update Rejection ---');
  const host = await connectClient('Host');
  const createRoomRes = await new Promise<any>((resolve) => {
    host.emit('create_room', { userId: 'host_u1', displayName: 'Host' }, resolve);
  });
  const roomId = createRoomRes.roomId;

  const badLocationRes = await new Promise<any>((resolve) => {
    host.emit('location_update', {
      roomId,
      coords: { lat: NaN, lng: 73.8122 },
      speed: 1.0
    }, resolve);
  });

  if (badLocationRes.success === false && badLocationRes.error.includes('valid coords')) {
    console.log('✅ 3A: Server rejected location_update with NaN coords cleanly');
  } else {
    throw new Error('❌ 3A Failed: Server accepted malformed coordinates');
  }

  // Test 2B: Duplicate User Reconnection Handover
  console.log('\n--- 4. Testing Duplicate User Reconnection Handover ---');
  const guest1 = await connectClient('GuestSocket1');
  await new Promise<any>((resolve) => {
    guest1.emit('join_room', {
      roomId,
      userId: 'guest_user_99',
      displayName: 'GuestUser',
      role: PlayerRole.RUNNER,
    }, resolve);
  });

  let room = await mockStore.getRoom(roomId);
  if (room!.players.size !== 2) {
    throw new Error(`Expected 2 players, got ${room!.players.size}`);
  }

  // Same user connects on a NEW socket
  const guest1Reconnected = await connectClient('GuestSocket2');
  await new Promise<any>((resolve) => {
    guest1Reconnected.emit('join_room', {
      roomId,
      userId: 'guest_user_99',
      displayName: 'GuestUser',
      role: PlayerRole.RUNNER,
    }, resolve);
  });

  room = await mockStore.getRoom(roomId);
  if (room!.players.size === 2 && room!.players.has(guest1Reconnected.id!) && !room!.players.has(guest1.id!)) {
    console.log('✅ 4A: Reconnected user replaced stale socket without phantom duplication');
  } else {
    throw new Error(`❌ 4A Failed: Room has ${room!.players.size} players, stale socket not purged`);
  }

  // Test 2C: Guest leaves room (leave_room)
  console.log('\n--- 5. Testing Guest leave_room Handler ---');
  let guestLeftReceived = false;
  host.on('player_left', (data) => {
    if (data.userId === 'guest_user_99') {
      guestLeftReceived = true;
    }
  });

  const leaveRes = await new Promise<any>((resolve) => {
    guest1Reconnected.emit('leave_room', { roomId }, resolve);
  });

  await new Promise((r) => setTimeout(r, 100));
  room = await mockStore.getRoom(roomId);

  if (leaveRes.success && guestLeftReceived && room!.players.size === 1) {
    console.log('✅ 5A: Guest cleanly left room, host received player_left, store updated');
  } else {
    throw new Error('❌ 5A Failed: leave_room did not update room roster or emit event');
  }

  // Test 2D: Host leaves lobby -> Room Closed
  console.log('\n--- 6. Testing Host Closing Lobby (room_closed) ---');
  // Re-join a guest to listen for room_closed
  await new Promise<any>((resolve) => {
    guest1.emit('join_room', {
      roomId,
      userId: 'guest_listener',
      displayName: 'Listener',
      role: PlayerRole.RUNNER,
    }, resolve);
  });

  let roomClosedReceived = false;
  guest1.on('room_closed', (data) => {
    if (data.roomId === roomId) {
      roomClosedReceived = true;
    }
  });

  await new Promise<any>((resolve) => {
    host.emit('leave_room', { roomId }, resolve);
  });

  await new Promise((r) => setTimeout(r, 100));
  const closedRoom = await mockStore.getRoom(roomId);

  if (roomClosedReceived && closedRoom === null) {
    console.log('✅ 6A: Host left lobby; guest received room_closed and room was pruned from store');
  } else {
    throw new Error('❌ 6A Failed: Host leave did not close room or notify guest');
  }

  // Test 2E: Cannot restart active or ended game
  console.log('\n--- 7. Testing Game Status Transitions ---');
  const host2 = await connectClient('Host2');
  const res2 = await new Promise<any>((resolve) => {
    host2.emit('create_room', { userId: 'host_2', displayName: 'Host2' }, resolve);
  });
  const roomId2 = res2.roomId;

  const startRes1 = await new Promise<any>((resolve) => {
    host2.emit('start_game', { roomId: roomId2 }, resolve);
  });

  if (startRes1.success && (startRes1.status === RoomStatus.ACTIVE || startRes1.status === RoomStatus.HEAD_START)) {
    console.log('✅ 7A: Game started into authoritative running state');
  }

  const startRes2 = await new Promise<any>((resolve) => {
    host2.emit('start_game', { roomId: roomId2 }, resolve);
  });

  if (startRes2.success && startRes2.message === 'Game already in progress') {
    console.log('✅ 7B: Repeated start_game calls on running match rejected safely');
  } else {
    throw new Error('❌ 7B Failed: Allowed restarting of active match');
  }

  // Cleanup
  host.disconnect();
  guest1.disconnect();
  guest1Reconnected.disconnect();
  host2.disconnect();
  server.close();

  console.log('\n======================================================');
  console.log('🎉 ALL CORNER CASES & EDGE TESTS PASSED (100%)!');
  console.log('======================================================\n');
}

runEdgeCaseTests().catch((err) => {
  console.error('\n❌ TEST FAILURE:', err);
  process.exit(1);
});
