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

const VALID_MAPS = [
  'desert',
  'snow',
  'factory',
  'city',
  'icebox',
  'bind'
];

const VALID_CHARACTERS = [
  'soldier',
  'heavy',
  'special',
  'jett',
  'viper',
  'steve',
  'roblox'
];

const BOMB_SITES = {
  A: { x: -42, z: 4 },
  B: { x: 42, z: -4 }
};

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
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
  return value === 'defender' ? 'defender' : 'attacker';
}

function cleanNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makePlayer(socket, data = {}) {
  return {
    id: socket.id,
    name: cleanName(data.name),
    team: cleanTeam(data.team),
    character: cleanCharacter(data.character),
    x: 0,
    y: 0,
    z: 0,
    ry: 0,
    hp: 100,
    alive: true,
    weapon: 'rifle',
    kills: 0,
    deaths: 0,
    isBot: false
  };
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

function sendLobby(room) {
  const data = {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room),
    map: room.map,
    mode: room.mode,
    started: room.started
  };

  io.to(room.code).emit('lobbyUpdate', data);
  io.to(room.code).emit('playersUpdate', data);
}

function sendPlayers(room) {
  io.to(room.code).emit('playersUpdate', {
    code: room.code,
    hostId: room.hostId,
    players: publicPlayers(room)
  });
}

function resetPlayers(room) {
  for (const player of room.players.values()) {
    player.hp = 100;
    player.alive = true;
    player.x = player.team === 'attacker' ? -82 : 82;
    player.z = player.team === 'attacker' ? -82 : 82;
    player.y = 0;
    player.ry = 0;
  }
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
  const code = makeCode();

  const room = {
    code,
    hostId: socket.id,
    players: new Map(),
    map: cleanMap(data.map),
    mode: data.mode || 'bomb',
    started: false,
    round: 0,
    maxRounds: MAX_ROUNDS,
    attackerScore: 0,
    defenderScore: 0,
    bomb: {
      carrierId: null,
      planted: false,
      site: null,
      x: -78,
      z: -78,
      active: false
    },
    prepTimer: null,
    bombTimer: null,
    defuseTimer: null
  };

  rooms.set(code, room);
  return room;
}

function joinRoom(socket, room, data = {}) {
  if (!room) {
    socket.emit('roomError', 'Room not found.');
    return;
  }

  if (room.players.size >= MAX_PLAYERS) {
    socket.emit('roomError', 'Room is full.');
    return;
  }

  if (room.started) {
    socket.emit('roomError', 'Match already started.');
    return;
  }

  const player = makePlayer(socket, data);

  const attackers = [...room.players.values()].filter(
    p => p.team === 'attacker'
  ).length;

  const defenders = [...room.players.values()].filter(
    p => p.team === 'defender'
  ).length;

  if (data.team !== 'attacker' && data.team !== 'defender') {
    player.team = attackers <= defenders ? 'attacker' : 'defender';
  }

  room.players.set(socket.id, player);

  socket.join(room.code);
  socket.data.roomCode = room.code;

  socket.emit('roomJoined', {
    code: room.code,
    hostId: room.hostId,
    playerId: socket.id,
    map: room.map,
    mode: room.mode,
    players: publicPlayers(room)
  });

  sendLobby(room);
}

function endRound(room, winner, reason) {
  if (!room.started) return;

  clearRoomTimers(room);

  if (winner === 'attacker') {
    room.attackerScore++;
  } else if (winner === 'defender') {
    room.defenderScore++;
  }

  room.bomb.active = false;
  room.bomb.planted = false;
  room.bomb.carrierId = null;
  room.bomb.site = null;
  room.bomb.x = -78;
  room.bomb.z = -78;

  io.to(room.code).emit('roundOver', {
    winner,
    reason,
    round: room.round,
    attackerScore: room.attackerScore,
    defenderScore: room.defenderScore
  });

  if (room.round >= room.maxRounds) {
    finishMatch(room);
    return;
  }

  room.prepTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    startNextRound(room);
  }, 4000);
}

function finishMatch(room) {
  clearRoomTimers(room);

  room.started = false;

  let winner = 'draw';

  if (room.attackerScore > room.defenderScore) {
    winner = 'attacker';
  } else if (room.defenderScore > room.attackerScore) {
    winner = 'defender';
  }

  io.to(room.code).emit('gameEnded', {
    winner,
    attackerScore: room.attackerScore,
    defenderScore: room.defenderScore
  });

  sendLobby(room);
}

function startNextRound(room) {
  room.round++;

  resetPlayers(room);

  room.bomb.active = true;
  room.bomb.planted = false;
  room.bomb.carrierId = null;
  room.bomb.site = null;
  room.bomb.x = -78;
  room.bomb.z = -78;

  io.to(room.code).emit('roundStarting', {
    round: room.round,
    maxRounds: room.maxRounds,
    attackerScore: room.attackerScore,
    defenderScore: room.defenderScore
  });

  sendPlayers(room);

  io.to(room.code).emit('roundStarted', {
    round: room.round,
    bomb: room.bomb,
    sites: BOMB_SITES
  });

  room.prepTimer = setTimeout(() => {
    if (!room.started) return;

    room.bombTimer = setTimeout(() => {
      if (!room.started || room.bomb.planted) return;
      endRound(room, 'defender', 'TIME OUT');
    }, BOMB_TIME);
  }, ROUND_PREP_TIME);
}

function startMatch(room) {
  if (room.started) return;

  room.started = true;
  room.round = 0;
  room.attackerScore = 0;
  room.defenderScore = 0;

  clearRoomTimers(room);
  startNextRound(room);

  io.to(room.code).emit('gameStarted', {
    map: room.map,
    mode: room.mode,
    maxRounds: room.maxRounds
  });

  sendLobby(room);
}

function checkElimination(room) {
  const attackers = getTeamPlayers(room, 'attacker');
  const defenders = getTeamPlayers(room, 'defender');

  if (attackers.length === 0) {
    endRound(room, 'defender', 'ATTACKERS ELIMINATED');
  } else if (defenders.length === 0) {
    if (room.bomb.planted) {
      endRound(room, 'attacker', 'DEFENDERS ELIMINATED');
    } else {
      endRound(room, 'attacker', 'DEFENDERS ELIMINATED');
    }
  }
}

function plantBomb(socket, data = {}) {
  const room = getRoomBySocket(socket.id);
  if (!room || !room.started) return;

  const player = getPlayer(room, socket.id);
  if (!player || !player.alive || player.team !== 'attacker') return;

  if (room.bomb.planted || !room.bomb.active) return;

  const site = data.site === 'B' ? 'B' : 'A';
  const target = BOMB_SITES[site];

  const distance = Math.hypot(
    player.x - target.x,
    player.z - target.z
  );

  if (distance > 12) return;

  room.bomb.planted = true;
  room.bomb.active = false;
  room.bomb.carrierId = null;
  room.bomb.site = site;
  room.bomb.x = target.x;
  room.bomb.z = target.z;

  if (room.bombTimer) clearTimeout(room.bombTimer);

  io.to(room.code).emit('bombPlanted', {
    site,
    x: target.x,
    z: target.z,
    time: DEFUSE_TIME
  });

  room.bombTimer = setTimeout(() => {
    if (room.bomb.planted) {
      endRound(room, 'attacker', 'BOMB EXPLODED');
    }
  }, BOMB_TIME);
}

function defuseBomb(socket) {
  const room = getRoomBySocket(socket.id);
  if (!room || !room.started || !room.bomb.planted) return;

  const player = getPlayer(room, socket.id);
  if (!player || !player.alive || player.team !== 'defender') return;

  const site = BOMB_SITES[room.bomb.site];
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
    if (room.bomb.planted) {
      room.bomb.planted = false;
      endRound(room, 'defender', 'BOMB DEFUSED');
    }
  }, DEFUSE_TIME);
}

function removePlayer(socket) {
  const room = getRoomBySocket(socket.id);
  if (!room) return;

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

  socket.on('createRoom', data => {
    const room = createRoom(socket, data || {});
    joinRoom(socket, room, data || {});
  });

  socket.on('joinRoom', data => {
    const code = String(data.code || data.roomCode || '')
      .trim()
      .toUpperCase();

    joinRoom(socket, rooms.get(code), data || {});
  });

  socket.on('join', data => {
    const code = String(data.code || data.roomCode || '')
      .trim()
      .toUpperCase();

    if (data.action === 'create' || data.create === true) {
      const room = createRoom(socket, data);
      joinRoom(socket, room, data);
    } else {
      joinRoom(socket, rooms.get(code), data);
    }
  });

  socket.on('startMatch', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || room.hostId !== socket.id) return;
    startMatch(room);
  });

  socket.on('pickBomb', () => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started || room.bomb.planted) return;

    const player = getPlayer(room, socket.id);
    if (!player || !player.alive || player.team !== 'attacker') return;

    const distance = Math.hypot(
      player.x - room.bomb.x,
      player.z - room.bomb.z
    );

    if (distance > 10) return;

    room.bomb.carrierId = socket.id;
    room.bomb.active = false;

    io.to(room.code).emit('bombPicked', {
      carrierId: socket.id,
      playerName: player.name
    });
  });

  socket.on('plantBomb', data => plantBomb(socket, data || {}));
  socket.on('defuseBomb', () => defuseBomb(socket));

  socket.on('playerState', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started) return;

    const player = getPlayer(room, socket.id);
    if (!player || !player.alive) return;

    player.x = Math.max(-97, Math.min(97, cleanNumber(data.x)));
    player.y = Math.max(0, Math.min(10, cleanNumber(data.y)));
    player.z = Math.max(-97, Math.min(97, cleanNumber(data.z)));
    player.ry = cleanNumber(data.ry);
    player.weapon = String(data.weapon || 'rifle').slice(0, 20);

    if (data.character) {
      player.character = cleanCharacter(data.character);
    }

    sendPlayers(room);
  });

  socket.on('playerHit', data => {
    const room = getRoomBySocket(socket.id);
    if (!room || !room.started) return;

    const attacker = getPlayer(room, socket.id);
    const target = room.players.get(String(data.targetId || data.id || ''));

    if (!attacker || !target || !target.alive) return;
    if (attacker.id === target.id) return;

    if (attacker.team === target.team) return;

    const damage = Math.max(
      1,
      Math.min(100, cleanNumber(data.damage, 25))
    );

    target.hp -= damage;

    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      target.deaths++;
      attacker.kills++;

      io.to(room.code).emit('playerDied', {
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
    if (!room) return;

    io.to(room.code).emit('botHit', {
      botId: data.botId,
      damage: Math.max(1, Math.min(100, cleanNumber(data.damage, 25))),
      attackerId: socket.id
    });
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    removePlayer(socket);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`EmirCritical server running on port ${PORT}`);
});
