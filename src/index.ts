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

// Public Privacy Policy for Google Play Store compliance
app.get('/privacy', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tapapo - Privacy Policy</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0A0F1E;
      color: #F1F5F9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.6;
      padding: 32px 16px;
    }
    .container {
      max-width: 760px;
      margin: 0 auto;
      background: #101726;
      border: 2px solid #334155;
      padding: 32px;
    }
    .badge {
      display: inline-block;
      background: #E63946;
      color: #FFF;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 1.5px;
      padding: 4px 10px;
      margin-bottom: 16px;
      font-family: monospace;
    }
    h1 {
      font-size: 28px;
      font-weight: 900;
      margin-bottom: 6px;
      letter-spacing: -0.5px;
    }
    .subtitle {
      color: #94A3B8;
      font-size: 13px;
      font-family: monospace;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #334155;
    }
    h2 {
      font-size: 18px;
      color: #F1F5F9;
      margin: 24px 0 8px 0;
      font-weight: 800;
    }
    p, li {
      color: #CBD5E1;
      font-size: 14px;
      margin-bottom: 12px;
    }
    ul {
      padding-left: 20px;
      margin-bottom: 16px;
    }
    li { margin-bottom: 6px; }
    .highlight-box {
      background: #0D1322;
      border-left: 4px solid #E63946;
      padding: 14px 18px;
      margin: 16px 0;
    }
    .highlight-box p {
      margin: 0;
      color: #F8FAFC;
      font-size: 13px;
    }
    .contact-card {
      margin-top: 32px;
      padding: 16px;
      background: #090D16;
      border: 1px solid #334155;
      font-family: monospace;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="badge">LEGAL & PRIVACY</div>
    <h1>Tapapo Privacy Policy</h1>
    <div class="subtitle">Effective Date: October 26, 2026 // Package: com.tapapo.game</div>

    <p>Tapapo ("we", "our") is an authoritative outdoor GPS tactical stealth tag game. We are dedicated to protecting player privacy. This policy outlines our location and data practices in compliance with Google Play Developer Policies.</p>

    <h2>1. Location Data Collection & Purpose</h2>
    <div class="highlight-box">
      <p><b>Strict Foreground Use:</b> GPS location is accessed ONLY while a match is actively being played or during play zone setup. Tapapo never collects location data in the background when the game is not actively being played.</p>
    </div>
    <p>We request access to precise location (<code>ACCESS_FINE_LOCATION</code>) solely for real-time multiplayer gameplay:</p>
    <ul>
      <li><b>5-Meter Tag Detection:</b> Authoritatively confirming when a Hunter is within 5 meters of a Runner to register a tag.</li>
      <li><b>Geofence Safe Zone:</b> Checking whether Runners are within boundary zones or outside in penalty exposure.</li>
      <li><b>Radar Sweep Pulses:</b> Revealing approximate ping locations on the tactical radar scope during scheduled scans.</li>
    </ul>

    <h2>2. Ephemeral In-Memory Processing</h2>
    <p>All coordinate telemetry is processed in volatile memory on our authoritative server for the active match duration. When a match ends or a lobby is closed, active location trails are immediately purged. We do not store persistent movement histories or sell location tracks to advertisers.</p>

    <h2>3. No Ads, No Third-Party Trackers</h2>
    <p>Tapapo does not contain advertising SDKs, behavioral analytics trackers, or commercial profiling tools. We do not collect phone numbers, contacts, emails, or personal identifiers.</p>

    <h2>4. Infrastructure & Map Providers</h2>
    <ul>
      <li><b>Render.com:</b> Server hosting protected by Transport Layer Security (TLS 1.3 / HTTPS / WSS).</li>
      <li><b>OpenStreetMap:</b> Standard geographical map tiles cached locally for map display. No user location is shared with map tile providers.</li>
    </ul>

    <h2>5. Children's Privacy & Permissions</h2>
    <p>Tapapo is intended for outdoor recreation. We do not knowingly collect personal information from children under 13. Location permissions can be revoked at any time via Android Device Settings.</p>

    <div class="contact-card">
      <b>CONTACT INQUIRIES:</b><br>
      Email: support@tapapo.game<br>
      Website: https://tapapo-server.onrender.com/privacy
    </div>
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
