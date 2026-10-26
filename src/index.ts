import express, { Request, Response } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import { registerSocketHandlers } from './socket/gameSocket';
import { roomStore } from './services/roomStore';
import { getRedisClient } from './services/redis';
import { REDIS_ROOM_TTL_SECONDS } from './types/game.types';

import path from 'path';
import os from 'os';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '4000', 10);

app.use(express.json());
// Serve mobile test client
app.use(express.static(path.join(__dirname, '../public')));

// Lightweight ping endpoint for keepalive and connection testing
app.get('/ping', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'pong',
    timestamp: Date.now(),
    service: 'tapapo-authoritative-server',
  });
});

// Health check endpoint
app.get('/health', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    serverTime: new Date().toISOString(),
    redisTTLPolicy: `${REDIS_ROOM_TTL_SECONDS}s (10 days)`,
  });
});

// REST endpoint to inspect room status directly from Redis
app.get('/api/rooms/:roomId', async (req: Request, res: Response) => {
  try {
    const rawRoomId = req.params.roomId;
    const roomId = (Array.isArray(rawRoomId) ? rawRoomId[0] : String(rawRoomId)).toUpperCase();
    const room = await roomStore.getRoom(roomId);
    if (!room) {
      res.status(404).json({ error: `Room ${roomId} not found or expired` });
      return;
    }

    const ttl = await roomStore.getRoomTTL(roomId);

    res.json({
      room: {
        ...room,
        players: Object.fromEntries(room.players),
      },
      ttlSecondsRemaining: ttl,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const server = http.createServer(app);

// Socket.IO authoritative server
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Register game handlers
registerSocketHandlers(io, roomStore);

// Helper to get local network IP
function getLocalNetworkIP(): string {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const networkIP = getLocalNetworkIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n======================================================`);
  console.log(` 🎮 Authoritative LAPCHUP Game Server Running!`);
  console.log(` 💻 Local Machine:    http://localhost:${PORT}`);
  console.log(` 📱 Mobile Phone URL: http://${networkIP}:${PORT}`);
  console.log(` ⏱️  Redis TTL Policy: 10-day TTL (${REDIS_ROOM_TTL_SECONDS}s)`);
  console.log(` 🔍 Health Endpoint:  http://localhost:${PORT}/health`);
  console.log(` 📡 Ping Endpoint:    http://localhost:${PORT}/ping`);
  console.log(`======================================================\n`);

  // Render free tier keep-alive: ping self every 10 minutes to stay awake during activity
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || 'https://tapapo-server.onrender.com';
  if (process.env.NODE_ENV === 'production' && externalUrl) {
    const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
    setInterval(async () => {
      try {
        const pingUrl = `${externalUrl.replace(/\/$/, '')}/ping`;
        const res = await fetch(pingUrl);
        console.log(`[KeepAlive] Self-ping status: ${res.status} at ${new Date().toISOString()}`);
      } catch (err: any) {
        console.warn('[KeepAlive] Self-ping warning:', err?.message || err);
      }
    }, PING_INTERVAL_MS);
    console.log(`[KeepAlive] Scheduled self-ping for ${externalUrl} every 10m`);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down server gracefully...');
  server.close();
  const redis = getRedisClient();
  await redis.quit();
  process.exit(0);
});

export { app, server, io };
