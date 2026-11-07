
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MAX_PLAYERS = 10;
const BOT_COUNT = 8;
const SPAWN_POINTS = [
  { x: -55, z: -55 },
  { x: 55, z: -55 },
  { x: -55, z: 55 },
  { x: 55, z: 55 },
  { x: -42, z: -52 },
  { x: 42, z: -52 },
  { x: -42, z: 52 },
  { x: 42, z: 52 },
  { x: -52, z: 0 },
  { x: 52, z: 0 }
];

const makeCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

function cleanName(v) {
  return String(v || 'Oyuncu')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 16) || 'Oyuncu';
}

function roomPlayers(room) {
  return [...room.players.values()];
}

function createRoom(code) {
  return {
    code,
    players: new Map(),
    hostId: null,
    started: false,
    botsEnabled: true,
    bots: []
  };
}

function lobbyData(room) {
  return {
    code: room.code,
    players: roomPlayers(room),
    hostId: room.hostId,
    started: room.started,
    botsEnabled: room.botsEnabled
  };
}

function sendLobbyUpdate(room) {
  io.to(room.code).emit('lobbyUpdate', lobbyData(room));
}

function join(sock, room, name, cb) {
  sock.join(room.code);
  sock.data.roomCode = room.code;

const spawn = SPAWN_POINTS[room.players.size % SPAWN_POINTS.length];

const p = {
  id: sock.id,
  name: cleanName(name),
  x: spawn.x,
  y: 0,
  z: spawn.z,
    ry: 0,
    rx: 0,
    hp: 100,
    weapon: 'Vandal'
  };

  room.players.set(sock.id, p);

  if (!room.hostId) room.hostId = sock.id;

  cb({
  ok: true,
  ...lobbyData(room),
  bots: room.bots,
  spawn: { x: p.x, z: p.z }
});

  sock.to(room.code).emit('playerJoined', p);
  sendLobbyUpdate(room);
  io.to(room.code).emit('playersUpdate', roomPlayers(room));
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) =>
  res.json({ ok: true, rooms: rooms.size })
);

io.on('connection', socket => {

  socket.on('createRoom', (data = {}, cb = () => {}) => {
    let code;

    do {
      code = makeCode();
    } while (rooms.has(code));

    const room = createRoom(code);
    rooms.set(code, room);
    join(socket, room, data.name, cb);
  });

  socket.on('joinRoom', (data = {}, cb = () => {}) => {
    const code = String(data.code || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);

    const room = rooms.get(code);

    if (!room)
      return cb({ ok: false, error: 'Bu oda bulunamadı. Oda kodunu kontrol et.' });

    if (room.started)
      return cb({ ok: false, error: 'Bu odada oyun zaten başlamış.' });

    if (room.players.size >= MAX_PLAYERS)
      return cb({ ok: false, error: 'Oda dolu (en fazla 10 oyuncu).' });

    join(socket, room, data.name, cb);
  });

  socket.on('setBotMode', enabled => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.started || room.hostId !== socket.id) return;

    room.botsEnabled = enabled === true;
    sendLobbyUpdate(room);
  });

  socket.on('startMatch', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.started || room.hostId !== socket.id) return;

    room.started = true;

    room.bots = room.botsEnabled
      ? Array.from({ length: BOT_COUNT }, () => ({
          hp: 100,
          dead: false
        }))
      : [];

    io.to(room.code).emit('gameStarted', {
      botsEnabled: room.botsEnabled,
      bots: room.bots
    });
  });

  socket.on('playerState', state => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;

    const p = room.players.get(socket.id);
    if (!p) return;

    for (const k of ['x', 'y', 'z', 'ry', 'rx', 'hp']) {
      const n = Number(state[k]);
      if (Number.isFinite(n))
        p[k] = Math.max(-1000, Math.min(1000, n));
    }

    p.name = cleanName(state.name);
    p.weapon = String(state.weapon || 'Vandal').slice(0, 12);

    socket.to(room.code).emit('playersUpdate', [p]);
  });

  socket.on('botHit', data => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || !room.botsEnabled) return;

    const id = Math.floor(Number(data?.botId));
    const damage = Math.max(
      0,
      Math.min(100, Number(data?.damage) || 0)
    );

    if (!Number.isInteger(id) || id < 0 ||
        id >= room.bots.length || !damage) return;

    const bot = room.bots[id];
    if (bot.dead) return;

    bot.hp = Math.max(0, bot.hp - damage);
    bot.dead = bot.hp <= 0;

    io.to(room.code).emit('botUpdate', {
      botId: id,
      hp: bot.hp,
      dead: bot.dead
    });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    io.to(code).emit('playerLeft', socket.id);

    if (room.players.size === 0) {
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }

    sendLobbyUpdate(room);
    io.to(code).emit('playersUpdate', roomPlayers(room));
  });
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`TACTICAL STRIKE server listening on port ${PORT}`)
);
