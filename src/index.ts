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

// Match invite deep link landing page
app.get('/join/:roomId', (req: Request, res: Response) => {
  const rawRoomId = req.params.roomId;
  const roomId = (Array.isArray(rawRoomId) ? rawRoomId[0] : String(rawRoomId)).toUpperCase();
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Join Tapapo Match - Sector ${roomId}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      background: #0A0F1E;
      color: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
      text-align: center;
    }
    .badge {
      background: #E63946;
      color: #FFF;
      font-weight: 900;
      padding: 4px 12px;
      letter-spacing: 2px;
      font-size: 11px;
      margin-bottom: 16px;
      display: inline-block;
    }
    h1 {
      margin: 0 0 10px 0;
      font-size: 32px;
      font-weight: 900;
      letter-spacing: -0.5px;
    }
    p {
      color: #8D99AE;
      font-size: 14px;
      max-width: 320px;
      line-height: 1.5;
      margin: 0 auto;
    }
    .code-box {
      background: #000000;
      border: 2px solid #E63946;
      padding: 16px 28px;
      font-size: 40px;
      font-weight: 900;
      letter-spacing: 6px;
      color: #FFF;
      margin: 24px 0;
      font-family: monospace;
    }
    .btn {
      background: #E63946;
      color: #FFF;
      text-decoration: none;
      font-weight: 900;
      padding: 16px 32px;
      font-size: 15px;
      display: inline-block;
      letter-spacing: 1.2px;
      border: 2px solid #000;
      cursor: pointer;
    }
    .subtext {
      margin-top: 24px;
      font-size: 12px;
      color: #6C757D;
    }
  </style>
  <script>
    // Attempt automatic app launch via custom scheme
    setTimeout(function() {
      window.location.href = "tapapo://join/" + encodeURIComponent("${roomId}");
    }, 150);
  </script>
</head>
<body>
  <div class="badge">MATCH INVITE</div>
  <h1>TAPAPO</h1>
  <p>You've been invited to join an authoritative tactical stealth match.</p>
  <div class="code-box">${roomId}</div>
  <a class="btn" href="tapapo://join/${roomId}">LAUNCH TAPAPO APP</a>
  <div class="subtext">
    If the app doesn't open automatically, install Tapapo and enter sector code <b>${roomId}</b>.
  </div>
</body>
</html>`);
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
