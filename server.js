
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
const TOTAL_ROUNDS = 12;
const PREP_TIME = 5000;

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

const ATTACK_SPAWNS = [
  { x: -50, z: -50 },
  { x: -46, z: -50 },
  { x: -50, z: -46 },
  { x: -42, z: -50 },
  { x: -50, z: -42 }
];

const DEFENSE_SPAWNS = [
  { x: 50, z: 50 },
  { x: 46, z: 50 },
  { x: 50, z: 46 },
  { x: 42, z: 50 },
  { x: 50, z: 42 }
];

const BOMB_SITES = {
  A: { x: -25, z: 0 },
  B: { x: 25, z: 0 }
};

const makeCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

function cleanName(v) {
  return String(v || 'Oyuncu')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 16) || 'Oyuncu';
}

function roomPlayers(room) {
  return [...room.players.values()].map(p => ({ ...p }));
}

function createRoom(code) {
  return {
    code,
    players: new Map(),
    hostId: null,
    started: false,
    botsEnabled: true,
    bots: [],
    gameMode: 'deathmatch',
    map: 'desert',

    bomb: {
      planted: false,
      pickedUp: false,
      carrierId: null,
      site: null,
      endsAt: null,
      planterId: null,
      defuserId: null
    },

    round: 1,
    roundOver: false,
    roundActive: false,
    roundWins: {
      attack: 0,
      defense: 0
    },
    roundTimer: null
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

  const spawn = SPAWN_POINTS[
    room.players.size % SPAWN_POINTS.length
  ];

  const attackCount = [...room.players.values()]
    .filter(p => p.team === 'attack').length;

  const defenseCount = [...room.players.values()]
    .filter(p => p.team === 'defense').length;

  const team = attackCount <= defenseCount
    ? 'attack'
    : 'defense';

  const p = {
    id: sock.id,
    name: cleanName(name),
    x: spawn.x,
    y: 0,
    z: spawn.z,
    ry: 0,
    rx: 0,
    hp: 100,
    weapon: 'Vandal',
    team
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

function resetBomb(room) {
  room.bomb = {
    planted: false,
    pickedUp: false,
    carrierId: null,
    site: null,
    endsAt: null,
    planterId: null,
    defuserId: null
  };
}

function startBombRound(room) {
  if (!room.started || room.gameMode !== 'bomb') return;

  room.roundOver = false;
  room.roundActive = false;
  resetBomb(room);

  let attackIndex = 0;
  let defenseIndex = 0;

  for (const player of room.players.values()) {
    player.hp = 100;
    player.y = 0;
    player.ry = 0;
    player.rx = 0;

    if (player.team === 'attack') {
      const spawn = ATTACK_SPAWNS[
        attackIndex++ % ATTACK_SPAWNS.length
      ];
      player.x = spawn.x;
      player.z = spawn.z;
    } else {
      const spawn = DEFENSE_SPAWNS[
        defenseIndex++ % DEFENSE_SPAWNS.length
      ];
      player.x = spawn.x;
      player.z = spawn.z;
    }
  }

  io.to(room.code).emit('playersUpdate', roomPlayers(room));

  io.to(room.code).emit('roundStarting', {
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    prepareSeconds: 5,
    attackWins: room.roundWins.attack,
    defenseWins: room.roundWins.defense
  });

   io.to(room.code).emit('bombReset', {
    round: room.round,
    bomb: room.bomb
  });

  clearTimeout(room.roundTimer);

  room.roundTimer = setTimeout(() => {
    if (!room.started || room.roundOver) return;

    room.roundActive = true;

    io.to(room.code).emit('roundStarted', {
      round: room.round,
      totalRounds: TOTAL_ROUNDS
    });
  }, PREP_TIME);
}

function finishBombRound(room, winner, reason) {
  if (!room.started || room.gameMode !== 'bomb') return;
  if (room.roundOver) return;

  room.roundOver = true;
  room.roundActive = false;

  if (winner === 'attack' || winner === 'defense') {
    room.roundWins[winner]++;
  }

  io.to(room.code).emit('roundOver', {
    winner,
    reason,
    round: room.round,
    totalRounds: TOTAL_ROUNDS,
    attackWins: room.roundWins.attack,
    defenseWins: room.roundWins.defense
  });

  if (room.round >= TOTAL_ROUNDS) {
    room.started = false;
    clearTimeout(room.roundTimer);

    io.to(room.code).emit('gameEnded', {
      attackWins: room.roundWins.attack,
      defenseWins: room.roundWins.defense,
      winner:
        room.roundWins.attack > room.roundWins.defense
          ? 'attack'
          : room.roundWins.defense > room.roundWins.attack
            ? 'defense'
            : 'draw'
    });

    sendLobbyUpdate(room);
    return;
  }

  room.roundTimer = setTimeout(() => {
    if (!room.started) return;

    room.round++;
    startBombRound(room);
  }, PREP_TIME);
}

function checkTeamElimination(room) {
  if (!room.started || room.gameMode !== 'bomb') return;
  if (!room.roundActive || room.roundOver) return;

  const aliveAttack = [...room.players.values()]
    .filter(p => p.team === 'attack' && p.hp > 0).length;

  const aliveDefense = [...room.players.values()]
    .filter(p => p.team === 'defense' && p.hp > 0).length;

  if (aliveAttack === 0) {
    finishBombRound(room, 'defense', 'elimination');
  } else if (aliveDefense === 0) {
    finishBombRound(room, 'attack', 'elimination');
  }
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
      return cb({
        ok: false,
        error: 'Bu oda bulunamadı. Oda kodunu kontrol et.'
      });

    if (room.started)
      return cb({
        ok: false,
        error: 'Bu odada oyun zaten başlamış.'
      });

    if (room.players.size >= MAX_PLAYERS)
      return cb({
        ok: false,
        error: 'Oda dolu (en fazla 10 oyuncu).'
      });

    join(socket, room, data.name, cb);
  });

  socket.on('setBotMode', enabled => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.started || room.hostId !== socket.id) return;

    room.botsEnabled = enabled === true;
    sendLobbyUpdate(room);
  });

  // OYUNU BASLATMA
  socket.on('startMatch', (data = {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.started || room.hostId !== socket.id) return;

    const allowedModes = [
      'deathmatch',
      'ffa',
      'bomb',
      'domination'
    ];

    const allowedMaps = [
      'desert',
      'snow',
      'factory',
      'city'
    ];

    const requestedMode = String(data.gameMode || 'deathmatch');
    const requestedMap = String(data.map || 'desert');

    room.gameMode = allowedModes.includes(requestedMode)
      ? requestedMode
      : 'deathmatch';

    room.map = allowedMaps.includes(requestedMap)
      ? requestedMap
      : 'desert';

    room.round = 1;
    room.roundOver = false;
    room.roundActive = false;

    room.roundWins = {
      attack: 0,
      defense: 0
    };

    room.bots = room.gameMode === 'bomb'
      ? []
      : (room.botsEnabled
          ? Array.from({ length: BOT_COUNT }, () => ({
              hp: 100,
              dead: false
            }))
          : []);

    room.started = true;

    if (room.gameMode === 'bomb') {
      startBombRound(room);
    } else {
      room.roundActive = true;
      resetBomb(room);
    }

    io.to(room.code).emit('gameStarted', {
      botsEnabled: room.gameMode === 'bomb'
        ? false
        : room.botsEnabled,
      bots: room.bots,
      gameMode: room.gameMode,
      map: room.map,
      players: roomPlayers(room),
      bomb: room.bomb,
      round: room.round
    });
  });

  // BOMBAYI ALMA
  socket.on('pickBomb', () => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || room.gameMode !== 'bomb') return;
    if (!room.roundActive || room.roundOver) return;

    const player = room.players.get(socket.id);

    if (!player || player.team !== 'attack' || player.hp <= 0) return;
    if (room.bomb.pickedUp || room.bomb.planted) return;

    const distance = Math.hypot(
      player.x - (-48),
      player.z - (-48)
    );

    if (distance > 6) return;

    room.bomb.pickedUp = true;
    room.bomb.carrierId = socket.id;

    io.to(room.code).emit('bombPickedUp', {
      carrierId: socket.id,
      playerName: player.name
    });
  });

  // BOMBAYI KURMA
  socket.on('plantBomb', data => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || room.gameMode !== 'bomb') return;
    if (!room.roundActive || room.roundOver || room.bomb.planted) return;

    const player = room.players.get(socket.id);

    if (!player || player.team !== 'attack' || player.hp <= 0) return;

    if (!room.bomb.pickedUp ||
        room.bomb.carrierId !== socket.id) return;

    const siteName = String(data?.site || '').toUpperCase();
    const site = BOMB_SITES[siteName];

    if (!site) return;

    if (Math.hypot(
      player.x - site.x,
      player.z - site.z
    ) > 8) return;

    room.bomb.planted = true;
    room.bomb.pickedUp = false;
    room.bomb.carrierId = null;
    room.bomb.site = siteName;
    room.bomb.planterId = socket.id;
    room.bomb.endsAt = Date.now() + 45000;

    io.to(room.code).emit('bombPlanted', {
      planted: true,
      site: siteName,
      endsAt: room.bomb.endsAt,
      planterId: socket.id
    });

    setTimeout(() => {
      if (!room.started || room.roundOver || !room.bomb.planted) return;

      finishBombRound(room, 'attack', 'explosion');
      io.to(room.code).emit('bombExploded', {
        winner: 'attack'
      });
    }, 45000);
  });

  // BOMBAYI ETKISIZLESTIRME
  socket.on('defuseBomb', () => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || room.gameMode !== 'bomb') return;
    if (!room.roundActive || !room.bomb.planted || room.roundOver) return;
    if (room.bomb.defuserId) return;

    const player = room.players.get(socket.id);

    if (!player || player.team !== 'defense' || player.hp <= 0) return;

    const site = BOMB_SITES[room.bomb.site];
    if (!site) return;

    if (Math.hypot(
      player.x - site.x,
      player.z - site.z
    ) > 8) return;

    room.bomb.defuserId = socket.id;

    io.to(room.code).emit('bombDefusing', {
      playerId: socket.id,
      duration: 5000
    });

    setTimeout(() => {
      if (!room.started || room.roundOver || !room.bomb.planted) return;

      const currentPlayer = room.players.get(socket.id);

      if (!currentPlayer || currentPlayer.hp <= 0) {
        room.bomb.defuserId = null;
        return;
      }

      if (Math.hypot(
        currentPlayer.x - site.x,
        currentPlayer.z - site.z
      ) > 8) {
        room.bomb.defuserId = null;
        return;
      }

      room.bomb.planted = false;

      finishBombRound(room, 'defense', 'defused');

      io.to(room.code).emit('bombDefused', {
        winner: 'defense'
      });
    }, 5000);
  });

  // OYUNCU KONUMU
  socket.on('playerState', state => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started) return;

    const p = room.players.get(socket.id);
    if (!p) return;

    for (const k of ['x', 'y', 'z', 'ry', 'rx']) {
      const n = Number(state[k]);

      if (Number.isFinite(n)) {
        p[k] = Math.max(-1000, Math.min(1000, n));
      }
    }

    p.name = cleanName(state.name);
    p.weapon = String(state.weapon || 'Vandal').slice(0, 12);

    socket.to(room.code).emit('playersUpdate', [p]);
  });

  // BOT HASARI
  socket.on('botHit', data => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !room.botsEnabled) return;

    const id = Math.floor(Number(data?.botId));
    const damage = Math.max(
      0,
      Math.min(100, Number(data?.damage) || 0)
    );

    if (!Number.isInteger(id) ||
        id < 0 ||
        id >= room.bots.length ||
        !damage) return;

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

  // OYUNCU HASARI
  socket.on('playerHit', data => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started) return;
    if (room.gameMode === 'bomb' &&
        (!room.roundActive || room.roundOver)) return;

    const attacker = room.players.get(socket.id);
    const target = room.players.get(String(data?.targetId || ''));

    if (!attacker || !target || attacker.id === target.id) return;
    if (attacker.hp <= 0 || target.hp <= 0) return;

    // TAKIM ARKADASINA HASAR VERILMEZ
    if (attacker.team === target.team) return;

    const damage = Math.max(
      0,
      Math.min(100, Number(data?.damage) || 0)
    );

    if (!damage) return;

    const distance = Math.hypot(
      attacker.x - target.x,
      attacker.z - target.z
    );

    if (distance > 150) return;

    target.hp = Math.max(0, target.hp - damage);

    io.to(target.id).emit('playerDamaged', {
      damage,
      hp: target.hp,
      attacker: attacker.name
    });

    if (target.hp <= 0) {
      io.to(room.code).emit('playerEliminated', {
        playerId: target.id,
        killerId: attacker.id,
        killerName: attacker.name
      });
    }

    io.to(room.code).emit('playersUpdate', roomPlayers(room));

    checkTeamElimination(room);
  });

  // OYUNCU AYRILDI
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    io.to(code).emit('playerLeft', socket.id);

    if (room.players.size === 0) {
      clearTimeout(room.roundTimer);
      rooms.delete(code);
      return;
    }

    if (room.hostId === socket.id) {
      room.hostId = room.players.keys().next().value;
    }

    if (room.started && room.gameMode === 'bomb') {
      checkTeamElimination(room);
    }

    sendLobbyUpdate(room);
    io.to(code).emit('playersUpdate', roomPlayers(room));
  });
});

server.listen(PORT, '0.0.0.0', () =>
  console.log(`TACTICAL STRIKE server listening on port ${PORT}`)
);
