import { io as ioClient, Socket } from 'socket.io-client';

async function testBoundaryWarningProtocol() {
  console.log('\n======================================================');
  console.log('🚨 LAPCHUP TACTICAL PROTOCOL TEST: GEOFENCE BOUNDARY BREACH');
  console.log('======================================================\n');

  const SERVER_URL = 'http://localhost:4000';
  const ROOM_ID = '4J8TTU';

  // ── 1. CONNECT SIMULATED FLUTTER MOBILE CLIENT (SPECTATOR / ALLIED LISTENER) ──
  console.log('[Step 1] Connecting Mobile Flutter Client listener to port 4000...');
  const mobileFlutterSocket: Socket = ioClient(SERVER_URL, {
    transports: ['websocket', 'polling'],
  });

  await new Promise<void>((resolve, reject) => {
    mobileFlutterSocket.on('connect', () => {
      console.log(`✅ [Mobile Client] Connected to server: socketId=${mobileFlutterSocket.id}`);
      resolve();
    });
    mobileFlutterSocket.on('connect_error', (err) => reject(err));
  });

  // Join room 4J8TTU as mobile runner/tactical client
  await new Promise<void>((resolve) => {
    mobileFlutterSocket.emit('join_room', {
      roomId: ROOM_ID,
      userId: 'flutter_hud_client',
      displayName: 'Mobile HUD User',
      role: 'Runner',
    }, (res: any) => {
      console.log(`✅ [Mobile Client] Joined room ${ROOM_ID}:`, res?.success ? 'SUCCESS' : res);
      resolve();
    });
  });

  // ── 2. CONNECT MOCK RUNNER TESTING AGENT ──
  console.log('\n[Step 2] Connecting Mock Runner testing agent to port 4000...');
  const mockRunnerSocket: Socket = ioClient(SERVER_URL, {
    transports: ['websocket', 'polling'],
  });

  await new Promise<void>((resolve, reject) => {
    mockRunnerSocket.on('connect', () => {
      console.log(`✅ [Mock Runner] Connected to server: socketId=${mockRunnerSocket.id}`);
      resolve();
    });
    mockRunnerSocket.on('connect_error', (err) => reject(err));
  });

  // Join room as Runner
  await new Promise<void>((resolve) => {
    mockRunnerSocket.emit('join_room', {
      roomId: ROOM_ID,
      userId: 'mock_runner_test_01',
      displayName: 'Agent Infiltrator',
      role: 'Runner',
    }, (res: any) => {
      console.log(`✅ [Mock Runner] Joined room ${ROOM_ID} as Runner:`, res?.success ? 'SUCCESS' : res);
      resolve();
    });
  });

  // ── 3. REGISTER BOUNDARY WARNING LISTENERS ON BOTH CLIENTS ──
  let mockRunnerReceivedWarning: any = null;
  let mobileClientReceivedWarning: any = null;

  mockRunnerSocket.on('boundary_warning', (data) => {
    console.log(`\n🚨 [Mock Runner Received] boundary_warning:`, JSON.stringify(data, null, 2));
    mockRunnerReceivedWarning = data;
  });

  mobileFlutterSocket.on('boundary_warning', (data) => {
    console.log(`\n🚨 [Mobile Flutter Client Received] boundary_warning:`, JSON.stringify(data, null, 2));
    mobileClientReceivedWarning = data;
  });

  // ── 4. EMIT LOCATION UPDATE WITHIN SAFE GEOFENCE (< 500m) ──
  console.log('\n[Step 3] Emitting location within 500m geofence (Center: 18.6260, 73.8122)...');
  await new Promise<void>((resolve) => {
    mockRunnerSocket.emit('location_update', {
      roomId: ROOM_ID,
      coords: { lat: 18.6262, lng: 73.8125 }, // ~38m from center
      speed: 2.5,
      accuracy: 3.0,
      timestamp: Date.now(),
    }, (ack: any) => {
      console.log('✅ Inside geofence update acknowledged:', ack);
      resolve();
    });
  });

  await new Promise((r) => setTimeout(r, 600));
  if (mockRunnerReceivedWarning === null) {
    console.log('✅ PASSED: No boundary warning triggered inside 500m geofence (~38m from center).');
  }

  // ── 5. EMIT LOCATION UPDATE EXCEEDING 500m GEOFENCE (> 1000m) ──
  console.log('\n[Step 4] Emitting location_update exceeding 500m geofence (Target: 18.6365, 73.8122)...');
  // 18.6365 vs 18.6260 is ~1,167 meters away from center (far beyond 500m perimeter)
  await new Promise<void>((resolve) => {
    mockRunnerSocket.emit('location_update', {
      roomId: ROOM_ID,
      coords: { lat: 18.6365, lng: 73.8122 },
      speed: 4.2,
      accuracy: 2.0,
      timestamp: Date.now(),
    }, (ack: any) => {
      console.log('✅ Out-of-bounds update acknowledged by server:', ack);
      resolve();
    });
  });

  // Wait 1.5 seconds for socket event propagation
  await new Promise((r) => setTimeout(r, 1500));

  // ── 6. VERIFY RESULTS ──
  console.log('\n======================================================');
  console.log('📊 TEST VERIFICATION SUMMARY');
  console.log('======================================================');

  if (mockRunnerReceivedWarning) {
    console.log('✅ Mock Runner received boundary_warning event directly:');
    console.log(`   - Distance from center: ${mockRunnerReceivedWarning.distanceMeters.toFixed(1)}m`);
    console.log(`   - Allowed limit: ${mockRunnerReceivedWarning.limitMeters}m`);
    console.log(`   - Violation message: "${mockRunnerReceivedWarning.message}"`);
  } else {
    console.error('❌ FAILED: Mock Runner did not receive boundary_warning!');
  }

  if (mobileClientReceivedWarning) {
    console.log('✅ Mobile Flutter Client received boundary_warning broadcast:');
    console.log(`   - Violating Player: ${mobileClientReceivedWarning.displayName} (${mobileClientReceivedWarning.role})`);
    console.log(`   - Distance: ${mobileClientReceivedWarning.distanceMeters.toFixed(1)}m`);
    console.log(`   - Boundary Warning verified for Tactical HUD red flashing visual state!`);
  } else {
    console.error('❌ FAILED: Mobile Flutter Client did not receive boundary_warning broadcast!');
  }

  const success = mockRunnerReceivedWarning !== null && mobileClientReceivedWarning !== null;
  console.log(`\nOVERALL TEST RESULT: ${success ? '🏆 PASSED (100% VERIFIED)' : '❌ FAILED'}`);

  mockRunnerSocket.disconnect();
  mobileFlutterSocket.disconnect();

  process.exit(success ? 0 : 1);
}

testBoundaryWarningProtocol().catch((err) => {
  console.error('Fatal Test Error:', err);
  process.exit(1);
});
