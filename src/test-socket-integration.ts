import http from 'http';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import RedisMock from 'ioredis-mock';
import { registerSocketHandlers } from './socket/gameSocket';
import { RedisRoomStore } from './services/roomStore';
import { PlayerRole, RoomStatus, REDIS_ROOM_TTL_SECONDS } from './types/game.types';

async function runSocketIntegrationTest() {
  console.log('\n======================================================');
  console.log('🔌 RUNNING SOCKET.IO & REDIS INTEGRATION VERIFICATION');
  console.log('======================================================\n');

  const app = express();
  const server = http.createServer(app);
  const ioServer = new SocketIOServer(server, { cors: { origin: '*' } });
  
  const mockRedis = new RedisMock();
  const testStore = new RedisRoomStore(mockRedis as any);
  registerSocketHandlers(ioServer, testStore);

  await new Promise<void>((resolve) => server.listen(4999, resolve));
  const serverUrl = 'http://localhost:4999';
  console.log(`Test server running on ${serverUrl}`);

  // Helper to connect client
  function connectClient(label: string): Promise<ClientSocket> {
    return new Promise((resolve) => {
      const client = ioClient(serverUrl, { transports: ['websocket'] });
      client.on('connect', () => {
        console.log(` [${label}] Socket connected: ${client.id}`);
        resolve(client);
      });
    });
  }

  // 1. Host connects & creates room
  const hostSocket = await connectClient('HOST');
  let roomCode = '';

  const createRoomResponse: any = await new Promise((resolve) => {
    hostSocket.emit('create_room', { userId: 'host_user_1', displayName: 'GhostCommander' }, resolve);
  });

  console.log(' Host create_room response:', createRoomResponse);
  if (!createRoomResponse.success || !createRoomResponse.roomId) {
    throw new Error('create_room failed');
  }
  roomCode = createRoomResponse.roomId;
  console.log(` ✅ Room created with 6-char code: ${roomCode}`);

  if (!/^[A-Z0-9]{6}$/.test(roomCode)) {
    throw new Error(`Room code ${roomCode} does not match /^[A-Z0-9]{6}$/`);
  }

  // 2. Check Redis TTL (10 days = 864,000 seconds)
  const ttl = await testStore.getRoomTTL(roomCode);
  console.log(` ✅ Redis TTL verified: ${ttl}s (Expected <= ${REDIS_ROOM_TTL_SECONDS}s)`);
  if (ttl <= 0 || ttl > REDIS_ROOM_TTL_SECONDS) {
    throw new Error(`Invalid TTL: ${ttl}`);
  }

  // 3. Guest connects & joins room
  const guestSocket = await connectClient('GUEST');
  const joinResponse: any = await new Promise((resolve) => {
    guestSocket.emit('join_room', { roomId: roomCode, userId: 'guest_user_2', displayName: 'ShadowRunner' }, resolve);
  });
  console.log(' Guest join_room response:', joinResponse.success ? 'Success' : joinResponse.error);
  if (!joinResponse.success) {
    throw new Error('join_room failed');
  }

  // 4. Set roles: Host -> Hunter, Guest -> Runner
  await new Promise((resolve) => {
    hostSocket.emit('set_role', { roomId: roomCode, role: PlayerRole.HUNTER }, resolve);
  });
  await new Promise((resolve) => {
    guestSocket.emit('set_role', { roomId: roomCode, role: PlayerRole.RUNNER }, resolve);
  });
  console.log(' ✅ Roles assigned: Host -> Hunter, Guest -> Runner');

  // 5. Host starts game
  const startGameResponse: any = await new Promise((resolve) => {
    hostSocket.emit('start_game', { roomId: roomCode }, resolve);
  });
  console.log(' Game start status:', startGameResponse.status);
  if (startGameResponse.status !== RoomStatus.HEAD_START && startGameResponse.status !== RoomStatus.ACTIVE) {
    throw new Error(`Unexpected room status after start: ${startGameResponse.status}`);
  }
  console.log(' ✅ Game successfully started in authoritative state!');

  // Cleanup
  hostSocket.disconnect();
  guestSocket.disconnect();
  ioServer.close();
  server.close();

  console.log('\n======================================================');
  console.log('🎉 FULL SOCKET.IO & REDIS FLOW VERIFIED SUCCESSFULLY!');
  console.log('======================================================\n');
}

runSocketIntegrationTest().catch((err) => {
  console.error('Socket test error:', err);
  process.exit(1);
});
