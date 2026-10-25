import RedisMock from 'ioredis-mock';
import { 
  RoomState, 
  RoomStatus, 
  PlayerRole, 
  PlayerState, 
  DEFAULT_ROOM_CONFIG, 
  REDIS_ROOM_TTL_SECONDS 
} from './types/game.types';
import { generateRoomCode, isValidRoomCode } from './utils/codeGen';
import { RedisRoomStore, serializeRoomState, deserializeRoomState } from './services/roomStore';

async function runVerification() {
  console.log('\n======================================================');
  console.log('🧪 RUNNING AUTHORITATIVE STEALTH GAME SERVER TESTS');
  console.log('======================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string) {
    totalTests++;
    if (condition) {
      console.log(` ✅ PASS: ${testName}`);
      passedTests++;
    } else {
      console.error(` ❌ FAIL: ${testName}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  // ── TEST 1: 6-Character Uppercase Alphanumeric Room Code Generation ──
  console.log('--- Test Suite 1: Room Generation ---');
  const code1 = generateRoomCode(6);
  console.log(`  Generated Sample Room Code 1: "${code1}"`);
  assert(code1.length === 6, 'Generated room code must be exactly 6 characters');
  assert(/^[A-Z0-9]{6}$/.test(code1), 'Room code must match /^[A-Z0-9]{6}$/ (e.g. XR7B9P)');
  assert(isValidRoomCode(code1), 'isValidRoomCode validates properly');

  // Verify uniqueness over 1,000 generations
  const sampleCodes = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const code = generateRoomCode(6);
    assert(/^[A-Z0-9]{6}$/.test(code), `Code ${code} must be uppercase alphanumeric`);
    sampleCodes.add(code);
  }
  assert(sampleCodes.size >= 995, 'High entropy: 1000 codes produced high collision resistance');

  // ── TEST 2: RoomState Interface & In-Memory Map Schema ──
  console.log('\n--- Test Suite 2: RoomState & In-Memory Map Schema ---');
  const testRoomId = 'XR7B9P';
  const testHostId = 'user_host_9999';
  const testSocketId = 'socket_host_abc123';

  const room: RoomState = {
    roomId: testRoomId,
    hostId: testHostId,
    status: RoomStatus.LOBBY,
    config: {
      roundDurationSec: 2700,
      headStartSec: 180,
      pingIntervalSec: 180,
      speedLimitMps: 6.7,
    },
    players: new Map([
      [
        testSocketId,
        {
          socketId: testSocketId,
          userId: testHostId,
          role: PlayerRole.HUNTER,
          state: PlayerState.ACTIVE,
        },
      ],
    ]),
    createdAt: Date.now(),
    startedAt: null,
  };

  assert(room.roomId === 'XR7B9P', 'roomId correctly set');
  assert(room.hostId === 'user_host_9999', 'hostId correctly set');
  assert(room.status === RoomStatus.LOBBY, 'status is RoomStatus.LOBBY');
  assert(room.config.roundDurationSec === 2700, 'config.roundDurationSec === 2700');
  assert(room.config.headStartSec === 180, 'config.headStartSec === 180');
  assert(room.config.pingIntervalSec === 180, 'config.pingIntervalSec === 180');
  assert(room.config.speedLimitMps === 6.7, 'config.speedLimitMps === 6.7');
  assert(room.players instanceof Map, 'players is a native JavaScript Map');

  const hostPlayer = room.players.get(testSocketId);
  assert(!!hostPlayer, 'Host player retrieved from Map');
  assert(hostPlayer?.role === PlayerRole.HUNTER, 'Player role is Hunter');
  assert(hostPlayer?.state === PlayerState.ACTIVE, 'Player state is Active');

  // ── TEST 3: Serialization & Map Deserialization ──
  console.log('\n--- Test Suite 3: Serialization & Map Deserialization ---');
  const serialized = serializeRoomState(room);
  assert(typeof serialized === 'string', 'Serialized output is JSON string');
  assert(serialized.includes('"players":{'), 'Map is converted to JSON object in serialized string');

  const deserialized = deserializeRoomState(serialized);
  assert(deserialized.players instanceof Map, 'Deserialized players is restored to native Map');
  assert(deserialized.players.size === 1, 'Map size is 1');
  const restoredPlayer = deserialized.players.get(testSocketId);
  assert(restoredPlayer?.role === PlayerRole.HUNTER, 'Restored player role preserves Hunter');
  assert(restoredPlayer?.state === PlayerState.ACTIVE, 'Restored player state preserves Active');

  // ── TEST 4: Redis Ephemeral Store with Strict 10-day TTL (864000s) ──
  console.log('\n--- Test Suite 4: Redis Ephemeral Store & 10-Day TTL ---');
  const mockRedis = new RedisMock();
  const store = new RedisRoomStore(mockRedis as any);

  // Save room to store
  await store.saveRoom(room);

  // Retrieve room
  const fetchedRoom = await store.getRoom(testRoomId);
  assert(!!fetchedRoom, 'Room fetched successfully from Redis store');
  assert(fetchedRoom?.roomId === testRoomId, 'Fetched roomId matches');
  assert(fetchedRoom?.players instanceof Map, 'Fetched room players is native Map');
  assert(fetchedRoom?.players.get(testSocketId)?.userId === testHostId, 'Fetched player in Map matches');

  // Check TTL: strictly 864000 seconds (10 days)
  const ttl = await store.getRoomTTL(testRoomId);
  console.log(`  Reported TTL from Redis: ${ttl} seconds`);
  assert(
    ttl > 0 && ttl <= REDIS_ROOM_TTL_SECONDS,
    `TTL (${ttl}s) must be positive and <= ${REDIS_ROOM_TTL_SECONDS}s (10 days)`
  );
  assert(REDIS_ROOM_TTL_SECONDS === 864000, 'Strict 10-day TTL constant equals 864000 seconds');

  // Add a second player (Runner, Active)
  const runnerSocketId = 'socket_runner_xyz789';
  const runnerUserId = 'user_runner_5555';
  await store.addPlayer(testRoomId, {
    socketId: runnerSocketId,
    userId: runnerUserId,
    role: PlayerRole.RUNNER,
    state: PlayerState.ACTIVE,
  });

  const updatedRoom = await store.getRoom(testRoomId);
  assert(updatedRoom?.players.size === 2, 'Room now has 2 players in Map');
  assert(
    updatedRoom?.players.get(runnerSocketId)?.role === PlayerRole.RUNNER,
    'Second player has Runner role'
  );

  // Transition status to HEAD_START
  await store.updateRoomStatus(testRoomId, RoomStatus.HEAD_START);
  const headStartRoom = await store.getRoom(testRoomId);
  assert(headStartRoom?.status === RoomStatus.HEAD_START, 'Room status updated to HEAD_START');

  // Transition status to ACTIVE
  await store.updateRoomStatus(testRoomId, RoomStatus.ACTIVE);
  const activeRoom = await store.getRoom(testRoomId);
  assert(activeRoom?.status === RoomStatus.ACTIVE, 'Room status updated to ACTIVE');

  console.log('\n======================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} TESTS PASSED SUCCESSFULLY!`);
  console.log('======================================================\n');
}

runVerification().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
