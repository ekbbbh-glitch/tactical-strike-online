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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const rooms = new Map();

const MAX_PLAYERS = 10;
const MAX_ROUNDS = 12;
const ROUND_PREP_TIME = 5000;
const BOMB_TIME = 45000;
const DEFUSE_TIME = 5000;
const BOT_COUNT = 8;

const VALID_MAPS = [
  'desert', 'snow', 'factory', 'city', 'icebox', 'bind'
];

const VALID_CHARACTERS = [
  'soldier', 'heavy', 'special', 'jett',
  'viper', 'steve', 'roblox'
];

const BOMB_SITES = {
  A: { x: -42, z: 4 },
  B: { x: 42, z: -4 }
};

function makeCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function cleanName(value) {
  return String(value || 'Player')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 16) || 'Player';
}

function cleanCharacter(value) {
  return VALID_CHARACTERS.includes(value) ? value : 'soldier';
}

function cleanMap(value) {
  return VALID_MAPS.includes(value) ? value : 'desert';
}

function cleanTeam(value) {
  return value === 'defense' ? 'defense' : 'attack';
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makePlayer(socket, data = {}, team = 'attack') {
  return {
    id: socket.id,
    name: cleanName(data.name),
    team,
    character: cleanCharacter(data.character),
    x: team === 'attack' ? -82 : 82,
    y: 0,
    z: team === 'attack' ? -82 : 82,
    ry: 0,
    hp: 100,
    alive: true,
    weapon: 'Vandal',
    kills: 0,
    deaths: 0,
    isBot: false
  };
}

function makeBots() {
  return Array.from({ length: BOT_COUNT }, (_, id) => ({
    id,
    hp: 100,
    dead: false
  }));
}

function getRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.has(socketId)) return room;
  }
  return null;
}

function getPlayer(room, socketId) {
  return room.players.get(socketId);
}

function getTeamPlayers(room, team) {
  return [...room.players.values()].filter(
    player => player.team === team && player.alive
  );
}

function publicPlayers(room) {
  return [...room.players.values()].map(player => ({
    id: player.id,
    name: player.name,
    team: player.team,
    character: player.character,
    x: player.x,
    y: player.y,
    z: player.z,
    ry: player.ry,
    hp: player.hp,
    alive: player.alive,
    weapon: player.weapon,
    kills: player.kills,
    deaths: player.deaths,
    isBot: player.isBot
  }));
}

function publicBots(room) {
  return room.bots.map(bot => ({
    id: bot.id,
    hp: bot.hp,
    dead: bot.dead
  }));
}

function sendLobby(room) {
  io.to(room.code).emit('lobbyUpdate', {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    map: room.map,
    gameMode: room.gameMode,
    botsEnabled: room.botsEnabled,
    started: room.started
  });

  sendPlayers(room);
}

function sendPlayers(room) {
  io.to(room.code).emit('playersUpdate', publicPlayers(room));
}

function resetPlayers(room) {
  for (const player of room.players.values()) {
    player.hp = 100;
    player.alive = true;
    player.x = player.team === 'attack' ? -82 : 82;
    player.z = player.team === 'attack' ? -82 : 82;
    player.y = 0;
    player.ry = 0;
  }
}

function resetBomb(room) {
  room.bomb = {
    carrierId: null,
    planted: false,
    site: null,
    x: -78,
    z: -78,
    active: true,
    endsAt: null
  };
}

function clearRoomTimers(room) {
  if (room.prepTimer) clearTimeout(room.prepTimer);
  if (room.bombTimer) clearTimeout(room.bombTimer);
  if (room.defuseTimer) clearTimeout(room.defuseTimer);

  room.prepTimer = null;
  room.bombTimer = null;
  room.defuseTimer = null;
}

function createRoom(socket, data = {}) {
  const room = {
    code: makeCode(),
    hostId: socket.id,
    players: new Map(),
    map: cleanMap(data.map),
    gameMode: 'deathmatch',
    botsEnabled: true,
    started: false,
    round: 0,
    maxRounds: MAX_ROUNDS,
    attackWins: 0,
    defenseWins: 0,
    bots: makeBots(),
    bomb: {
      carrierId: null,
      planted: false,
      site: null,
      x: -78,
      z: -78,
      active: true,
      endsAt: null
    },
    prepTimer: null,
    bombTimer: null,
    defuseTimer: null
  };

  rooms.set(room.code, room);
  return room;
}

function joinRoom(socket, room, data = {}) {
  if (!room) {
    return { ok: false, error: 'ROOM NOT FOUND.' };
  }

  if (room.players.size >= MAX_PLAYERS) {
    return { ok: false, error: 'ROOM IS FULL.' };
  }

  if (room.started) {
    return { ok: false, error: 'MATCH ALREADY STARTED.' };
  }

  const attackCount = [...room.players.values()]
    .filter(p => p.team === 'attack').length;

  const defenseCount = [...room.players.values()]
    .filter(p => p.team === 'defense').length;

  const team = attackCount <= defenseCount ? 'attack' : 'defense';
  const player = makePlayer(socket, data, team);

  room.players.set(socket.id, player);

  socket.join(room.code);
  socket.data.roomCode = room.code;

  sendLobby(room);

  return {
    ok: true,
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    spawn: { x: player.x, z: player.z },
    map: room.map,
    gameMode: room.gameMode,
    botsEnabled: room.botsEnabled
  };
}

function endRound(room, winner, reason) {
  if (!room.started || room.roundEnding) return;

  room.roundEnding = true;
  clearRoomTimers(room);

  if (winner === 'attack') room.attackWins++;
  if (winner === 'defense') room.defenseWins++;

  room.bomb.active = false;
  room.bomb.planted = false;
  room.bomb.carrierId = null;
  room.bomb.site = null;
  room.bomb.endsAt = null;

  io.to(room.code).emit('roundOver', {
    winner,
    reason,
    round: room.round,
    attackWins: room.attackWins,
    defenseWins: room.defenseWins
  });

  if (room.round >= room.maxRounds) {
    finishMatch(room);
    return;
  }

  room.prepTimer = setTimeout(() => {
    if (!rooms.has(room.code) || !room.started) return;
    startNextRound(room);
  }, 4000);
}

function finishMatch(room) {
  clearRoomTimers(room);

  room.started = false;
  room.roundEnding = false;

  let winner = 'draw';

  if (room.attackWins > room.defenseWins) winner = 'attack';
  if (room.defenseWins > room.attackWins) winner = 'defense';

  io.to(room.code).emit('gameEnded', {
    winner,
    attackWins: room.attackWins,
    defenseWins: room.defenseWins
  });

  sendLobby(room);
}

function startNextRound(room) {
  if (!room.started) return;

  room.roundEnding = false;
  room.round++;

  resetPlayers(room);
  room.bots = makeBots();
  resetBomb(room);

  io.to(room.code).emit('bombReset', {
    bomb: {
      planted: false,
      pickedUp: false,
      carrierId: null,
      site: null,
      endsAt: null
    }
  });

  io.to(room.code).emit('roundStarting', {
    round: room.round,
    maxRounds: room.maxRounds,
    attackWins: room.attackWins,
    defenseWins: room.defenseWins,
    prepareSeconds: ROUND_PREP_TIME / 1000
  });

  sendPlayers(room);

  room.prepTimer = setTimeout(() => {
    if (!room.started || room.roundEnding) return;

    io.to(room.code).emit('roundStarted', {
      round: room.round,
      bomb: room.bomb,
      sites: BOMB_SITES
    });

    if (!room.bomb.planted) {
      room.bombTimer = setTimeout(() => {
        if (!room.started || room.roundEnding || room.bomb.planted) return;
        endRound(room, 'defense', 'TIME OUT');
      }, BOMB_TIME);
    }
  }, ROUND_PREP_TIME);
}

function startMatch(room, data = {}) {
  if (room.started) return;

  room.gameMode = ['deathmatch', 'ffa', 'bomb', 'domination']
    .includes(data.gameMode) ? data.gameMode : 'deathmatch';

  room.map = cleanMap(data.map);
  room.started = true;
  room.round = 0;
  room.attackWins = 0;
  room.defenseWins = 0;
  room.roundEnding = false;

  clearRoomTimers(room);

  io.to(room.code).emit('gameStarted', {
    map: room.map,
    gameMode: room.gameMode,
    players: publicPlayers(room),
    bots: room.gameMode === 'bomb' || !room.botsEnabled ? [] : publicBots(room),
    botsEnabled: room.botsEnabled,
    maxRounds: room.maxRounds
  });

  if (room.gameMode === 'bomb') {
    startNextRound(room);
  } else {
    resetPlayers(room);
    room.bots = makeBots();
    sendPlayers(room);
  }

  sendLobby(room);
}

function checkElimination(room) {
  if (!room.started || room.gameMode !== 'bomb' || room.roundEnding) return;

  const attackers = getTeamPlayers(room, 'attack');
  const defenders = getTeamPlayers(room, 'defense');

  if (attackers.length === 0) {
    endRound(room, 'defense', 'ATTACKERS ELIMINATED');
  } else if (defenders.length === 0) {
    endRound(room, 'attack', 'DEFENDERS ELIMINATED');
  }
}

function plantBomb(socket, data = {}) {
  const room = getRoomBySocket(socket.id);
  if (!room || !room.started || room.gameMode !== 'bomb') return;

  const player = getPlayer(room, socket.id);
  if (!player || !player.alive || player.team !== 'attack') return;
  if (room.bomb.planted || !room.bomb.active) return;
  if (room.bomb.carrierId !== socket.id) return;

  const siteName = data.site === 'B' ? 'B' : 'A';
  const target = BOMB_SITES[siteName];

  const distance = Math.hypot(
    player.x - target.x,
    player.z - target.z
  );

  if (distance > 12) return;

  room.bomb.planted = true;
  room.bomb.active = false;
  room.bomb.carrierId = null;
  room.bomb.site = siteName;
  room.bomb.x = target.x;
  room.bomb.z = target.z;
  room.bomb.endsAt = Date.now() + BOMB_TIME;

  if (room.bombTimer) clearTimeout(room.bombTimer);
  if (room.defuseTimer) clearTimeout(room.defuseTimer);

  io.to(room.code).emit('bombPlanted', {
    site: siteName,
    x: target.x,
    z: target.z,
    endsAt: room.bomb.endsAt,
    time: BOMB_TIME
  });

  room.bombTimer = setTimeout(() => {
    if (room.bomb.planted && room.started) {
      io.to(room.code).emit('bombExploded');
      endRound(room, 'attack', 'BOMB EXPLODED');
    }
  }, BOMB_TIME);
}

function defuseBomb(socket) {
  const room = getRoomBySocket(socket.id);
  if (!room || !room.started || room.gameMode !== 'bomb') return;
  if (!room.bomb.planted || room.defuseTimer) return;

  const player = getPlayer(room, socket.id);
  if (!player || !player.alive || player.team !== 'defense') return;

  const site = BOMB_SITES[room.bomb.site];
  if (!site) return;

  const distance = Math.hypot(
    player.x - site.x,
    player.z - site.z
  );

  if (distance > 10) return;

  if (room.bombTimer) clearTimeout(room.bombTimer);

  io.to(room.code).emit('bombDefusing', {
    playerId: socket.id,
    time: DEFUSE_TIME
  });

  room.defuseTimer = setTimeout(() => {
    if (!room.bomb.planted || !room.started) return;

    room.bomb.planted = false;
    io.to(room.code).emit('bombDefused');
    endRound(room, 'defense', 'BOMB DEFUSED');
  }, DEFUSE_TIME);
}

function removePlayer(socket) {
  const room = getRoomBySocket(socket.id);
  if (!room) return;

  const player = getPlayer(room, socket.id);
  if (player && player.alive && room.started && room.gameMode === 'bomb') {
    player.alive = false;
    player.hp = 0;
  }

  room.players.delete(socket.id);
  socket.leave(room.code);

  if (room.players.size === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.bomb.carrierId === socket.id) {
    room.bomb.carrierId = null;
  }

  sendLobby(room);
  sendPlayers(room);

  if (room.started) checkElimination(room);
}

io.on('connection', socket => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', (data = {}, callback) => {
    try {
      const room = createRoom(socket, data);
      const result = joinRoom(socket, room, data);

      if (typeof callback === 'function') {
        callback(result);
      }
    } catch (error) {
      console.error('Create room error:', error);
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'ROOM CREATION FAILED.' });
      }
    }
  });

  socket.on('joinRoom', (data = {}, callback) => {
    try {
      const code = String(data.code || data.roomCode || '')
        .trim()
        .toUpperCase();

      const room = rooms.get(code);
      const result = joinRoom(socket, room, data);

      if (typeof callback === 'function') {
        callback(result);
      }
    } catch (error) {
      console.error('Join room error:', error);
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'COULD NOT JOIN ROOM.' });
      }
    }
  });

  socket.on('setBotMode', enabled => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.started || room.hostId !== socket.id) return;

    room.botsEnabled = enabled === true;
    sendLobby(room);
  });

  socket.on('startMatch', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    startMatch(room, data || {});
  });

  socket.on('playerState', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started) return;

    const player = getPlayer(room, socket.id);
    if (!player || !player.alive) return;

    player.x = Math.max(-97, Math.min(97, cleanNumber(data.x)));
    player.y = Math.max(0, Math.min(10, cleanNumber(data.y)));
    player.z = Math.max(-97, Math.min(97, cleanNumber(data.z)));
    player.ry = cleanNumber(data.ry);
    player.weapon = String(data.weapon || 'Vandal').slice(0, 20);

    if (data.character) {
      player.character = cleanCharacter(data.character);
    }

    sendPlayers(room);
  });

  socket.on('playerHit', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started) return;

    const attacker = getPlayer(room, socket.id);
    const target = room.players.get(String(data?.targetId || data?.id || ''));

    if (!attacker || !attacker.alive || !target || !target.alive) return;
    if (attacker.id === target.id) return;
    if (attacker.team === target.team) return;

    const damage = Math.max(
      1,
      Math.min(100, cleanNumber(data?.damage, 25))
    );

    target.hp = Math.max(0, target.hp - damage);

    io.to(target.id).emit('playerDamaged', {
      damage,
      attacker: attacker.name
    });

    if (target.hp <= 0) {
      target.alive = false;
      target.deaths++;
      attacker.kills++;

      io.to(room.code).emit('playerEliminated', {
        playerId: target.id,
        killerId: attacker.id,
        killerName: attacker.name
      });

      checkElimination(room);
    }

    sendPlayers(room);
  });

  socket.on('botHit', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started || room.gameMode === 'bomb' || !room.botsEnabled) return;

    const botId = Math.floor(cleanNumber(data?.botId, -1));
    const bot = room.bots[botId];

    if (!bot || bot.dead) return;

    const damage = Math.max(
      1,
      Math.min(100, cleanNumber(data?.damage, 25))
    );

    bot.hp = Math.max(0, bot.hp - damage);

    if (bot.hp <= 0) {
      bot.dead = true;
    }

    io.to(room.code).emit('botUpdate', {
      botId: bot.id,
      hp: bot.hp,
      dead: bot.dead,
      attackerId: socket.id
    });
  });

  socket.on('pickBomb', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started || room.gameMode !== 'bomb') return;

    const player = getPlayer(room, socket.id);
    if (!player || !player.alive || player.team !== 'attack') return;
    if (!room.bomb.active || room.bomb.planted || room.bomb.carrierId) return;

    const distance = Math.hypot(
      player.x - room.bomb.x,
      player.z - room.bomb.z
    );

    if (distance > 10) return;

    room.bomb.carrierId = socket.id;
    room.bomb.active = false;

    io.to(room.code).emit('bombPickedUp', {
      carrierId: socket.id,
      playerName: player.name
    });
  });

  socket.on('plantBomb', data => plantBomb(socket, data || {}));
  socket.on('defuseBomb', () => defuseBomb(socket));

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    removePlayer(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EmirCritical server running on port ${PORT}`);
});
