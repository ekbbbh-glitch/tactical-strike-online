const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e5,
  pingInterval: 20000,
  pingTimeout: 60000,
  connectTimeout: 30000,
  connectionStateRecovery: { maxDisconnectionDuration: 120000, skipMiddlewares: true }
});
const PORT = process.env.PORT || 3000;
const rooms = new Map();

const MAX_PLAYERS = 10;
const BOT_COUNT = 8;
const TOTAL_ROUNDS = 12;
const PREP_TIME = 5000;
const BOMB_TIME = 45000;
const DEFUSE_TIME = 5000;
const WORLD_LIMIT = 97;

const CHARACTERS = ['soldier', 'heavy', 'special', 'jett', 'viper', 'steve', 'roblox'];
const ALLOWED_MODES = ['deathmatch', 'ffa', 'bomb', 'domination', 'swiftplay', 'spike', 'escalation'];
const ALLOWED_MAPS = ['desert', 'snow', 'factory', 'city', 'icebox', 'bind'];

const SPAWN_POINTS = [
  { x: -82, z: -82 }, { x: 82, z: -82 },
  { x: -82, z: 82 }, { x: 82, z: 82 },
  { x: -74, z: -82 }, { x: 74, z: -82 },
  { x: -74, z: 82 }, { x: 74, z: 82 },
  { x: -82, z: 0 }, { x: 82, z: 0 }
];

const ATTACK_SPAWNS = [
  { x: -82, z: -82 }, { x: -76, z: -82 },
  { x: -82, z: -76 }, { x: -70, z: -82 },
  { x: -82, z: -70 }
];

const DEFENSE_SPAWNS = [
  { x: 82, z: 82 }, { x: 76, z: 82 },
  { x: 82, z: 76 }, { x: 70, z: 82 },
  { x: 82, z: 70 }
];

const BOMB_SPAWN = { x: -78, z: -78 };
const BOMB_SITES = {
  A: { x: -42, z: 4 },
  B: { x: 42, z: -4 }
};

const makeCode = () =>
  Math.random().toString(36).slice(2, 8).toUpperCase();

function cleanName(value) {
  return String(value || 'Player')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 16) || 'Player';
}

function cleanCharacter(value) {
  const character = String(value || 'soldier').toLowerCase();
  return CHARACTERS.includes(character) ? character : 'soldier';
}

function finiteClamped(value, min, max, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, number))
    : fallback;
}

function roomPlayers(room) {
  return [...room.players.values()].map(player => ({ ...player }));
}

function createBombState() {
  return {
    planted: false,
    pickedUp: false,
    carrierId: null,
    site: null,
    endsAt: null,
    planterId: null,
    defuserId: null
  };
}

function createRoom(code) {
  return {
    code,
    players: new Map(),
    disconnectTimers: new Map(),
    hostId: null,
    started: false,
    botsEnabled: true,
    bots: [],
    gameMode: 'deathmatch',
    map: 'desert',
    bomb: createBombState(),
    bombTimer: null,
    defuseTimer: null,
    roundTimer: null,
    roundToken: 0,
    round: 1,
    roundOver: false,
    roundActive: false,
    roundWins: { attack: 0, defense: 0 },
    score: { attack: 0, defense: 0 },
    matchTimer: null,
    dominationTimer: null,
    domination: { owner: 'neutral', progress: 0 },
    escalationLevels: { attack: 0, defense: 0 },
    respawnTimers: new Map()
  };
}

function clearBombTimers(room) {
  if (room.bombTimer) clearTimeout(room.bombTimer);
  if (room.defuseTimer) clearTimeout(room.defuseTimer);
  room.bombTimer = null;
  room.defuseTimer = null;
}

function clearRoomTimers(room) {
  clearBombTimers(room);
  if (room.roundTimer) clearTimeout(room.roundTimer);
  if (room.matchTimer) clearTimeout(room.matchTimer);
  if (room.dominationTimer) clearInterval(room.dominationTimer);
  for (const timer of room.respawnTimers.values()) clearTimeout(timer);
  room.respawnTimers.clear();
  room.roundTimer = null; room.matchTimer = null; room.dominationTimer = null;
}

function resetBomb(room) {
  clearBombTimers(room);
  room.bomb = createBombState();
}

function lobbyData(room) {
  return {
    code: room.code,
    players: roomPlayers(room),
    hostId: room.hostId,
    started: room.started,
    botsEnabled: room.botsEnabled,
    gameMode: room.gameMode,
    map: room.map
  };
}

function sendLobbyUpdate(room) {
  io.to(room.code).emit('lobbyUpdate', lobbyData(room));
}

function sendGameStarted(room) {
  io.to(room.code).emit('gameStarted', {
    botsEnabled: ['bomb','swiftplay','spike'].includes(room.gameMode) ? false : room.botsEnabled,
    bots: room.bots,
    gameMode: room.gameMode,
    map: room.map,
    players: roomPlayers(room),
    bomb: room.bomb,
    round: room.round
  });
}

function join(sock, room, name, character, cb) {
  sock.join(room.code);
  sock.data.roomCode = room.code;
  const pendingDisconnect = room.disconnectTimers?.get(sock.id);
  if (pendingDisconnect) { clearTimeout(pendingDisconnect); room.disconnectTimers.delete(sock.id); }
  if (room.hostId && !room.players.has(room.hostId)) room.hostId = sock.id;

  const attackCount = [...room.players.values()]
    .filter(p => p.team === 'attack').length;

  const defenseCount = [...room.players.values()]
    .filter(p => p.team === 'defense').length;

  const team = attackCount <= defenseCount ? 'attack' : 'defense';
  const spawn = SPAWN_POINTS[room.players.size % SPAWN_POINTS.length];

  const player = {
    id: sock.id,
    name: cleanName(name),
    character: cleanCharacter(character),
    x: spawn.x,
    y: 0,
    z: spawn.z,
    ry: 0,
    rx: 0,
    hp: 100,
    weapon: 'Vandal',
    team
  };

  room.players.set(sock.id, player);

  if (!room.hostId) room.hostId = sock.id;

  if (typeof cb === 'function') {
    cb({
      ok: true,
      ...lobbyData(room),
      bots: room.bots,
      spawn: { x: player.x, z: player.z }
    });
  }

  sock.to(room.code).emit('playerJoined', player);
  sendLobbyUpdate(room);
  io.to(room.code).emit('playersUpdate', roomPlayers(room));
}

function modeRoundLimit(room) {
  if (room.gameMode === 'swiftplay') return 9;
  if (room.gameMode === 'spike') return 7;
  return TOTAL_ROUNDS;
}
function finishScoreMatch(room, winner, reason = 'score') {
  if (!room.started || ['bomb','swiftplay','spike'].includes(room.gameMode)) return;
  room.started = false; room.roundActive = false;
  if (room.matchTimer) clearTimeout(room.matchTimer);
  if (room.dominationTimer) clearInterval(room.dominationTimer);
  room.matchTimer = null; room.dominationTimer = null;
  io.to(room.code).emit('matchEnded',{gameMode:room.gameMode,winner,reason,score:room.score,players:roomPlayers(room)});
  sendLobbyUpdate(room);
}
function publishScore(room) {
  io.to(room.code).emit('matchScore',{gameMode:room.gameMode,score:room.score,players:roomPlayers(room),escalationLevels:room.escalationLevels,domination:room.domination});
}
function scheduleRespawn(room, player) {
  const old=room.respawnTimers.get(player.id); if(old) clearTimeout(old);
  const delay=room.gameMode==='ffa'?900:1500;
  const timer=setTimeout(()=>{
    room.respawnTimers.delete(player.id);
    if(!room.started||!room.players.has(player.id))return;
    const current=room.players.get(player.id); if(current.hp>0)return;
    let spawn=SPAWN_POINTS[Math.floor(Math.random()*SPAWN_POINTS.length)];
    if(['deathmatch','domination'].includes(room.gameMode)){
      const list=current.team==='attack'?ATTACK_SPAWNS:DEFENSE_SPAWNS;
      spawn=list[Math.floor(Math.random()*list.length)];
    }
    current.x=spawn.x;current.y=0;current.z=spawn.z;current.ry=0;current.rx=0;current.hp=100;
    io.to(room.code).emit('playerRespawned',{player:{...current},delay});
    io.to(room.code).emit('playersUpdate',roomPlayers(room));
  },delay);
  room.respawnTimers.set(player.id,timer);
}
function startDominationScoring(room) {
  if(room.dominationTimer)clearInterval(room.dominationTimer);
  room.dominationTimer=setInterval(()=>{
    if(!room.started||room.gameMode!=='domination')return;
    const inside=[...room.players.values()].filter(p=>p.hp>0&&Math.hypot(p.x,p.z)<=15);
    const teams=new Set(inside.map(p=>p.team));
    if(teams.size===1&&inside.length){
      const team=inside[0].team;room.domination.owner=team;
      room.domination.progress=Math.min(100,room.domination.progress+20);
      room.score[team]+=1;if(room.score[team]>=100)finishScoreMatch(room,team,'domination');
    }else if(teams.size>1)room.domination.progress=Math.max(0,room.domination.progress-5);
    publishScore(room);
  },1000);
}
function startBombRound(room, sendStartEvent = false) {
  if (!room.started || !['bomb','swiftplay','spike'].includes(room.gameMode)) return;

  room.roundOver = false;
  room.roundActive = false;
  room.roundToken++;

  const token = room.roundToken;
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

  if (sendStartEvent) sendGameStarted(room);

  io.to(room.code).emit('playersUpdate', roomPlayers(room));

  io.to(room.code).emit('roundStarting', {
    round: room.round,
    totalRounds: modeRoundLimit(room),
    prepareSeconds: 5,
    attackWins: room.roundWins.attack,
    defenseWins: room.roundWins.defense,
    players: roomPlayers(room)
  });

  io.to(room.code).emit('bombReset', {
    round: room.round,
    bomb: room.bomb
  });

  if (room.roundTimer) clearTimeout(room.roundTimer);

  room.roundTimer = setTimeout(() => {
    room.roundTimer = null;

    if (!room.started || room.roundOver ||
        room.roundToken !== token) return;

    room.roundActive = true;

    io.to(room.code).emit('roundStarted', {
      round: room.round,
      totalRounds: modeRoundLimit(room)
    });

    checkTeamElimination(room);
  }, PREP_TIME);
}

function finishBombRound(room, winner, reason) {
  if (!room.started || !['bomb','swiftplay','spike'].includes(room.gameMode) || room.roundOver) return;

  room.roundOver = true;
  room.roundActive = false;
  room.roundToken++;

  clearBombTimers(room);

  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = null;

  if (winner === 'attack' || winner === 'defense') {
    room.roundWins[winner]++;
  }

  io.to(room.code).emit('roundOver', {
    winner,
    reason,
    round: room.round,
    totalRounds: modeRoundLimit(room),
    attackWins: room.roundWins.attack,
    defenseWins: room.roundWins.defense
  });

  const targetWins = room.gameMode === 'swiftplay' ? 5 : room.gameMode === 'spike' ? 4 : 7;
  if (room.roundWins.attack >= targetWins || room.roundWins.defense >= targetWins || room.round >= modeRoundLimit(room)) {
    room.started = false;

    const finalWinner =
      room.roundWins.attack > room.roundWins.defense
        ? 'attack'
        : room.roundWins.defense > room.roundWins.attack
          ? 'defense'
          : 'draw';

    io.to(room.code).emit('gameEnded', {
      attackWins: room.roundWins.attack,
      defenseWins: room.roundWins.defense,
      winner: finalWinner
    });

    sendLobbyUpdate(room);
    return;
  }

  room.roundTimer = setTimeout(() => {
    room.roundTimer = null;

    if (!room.started || !['bomb','swiftplay','spike'].includes(room.gameMode)) return;
    room.round++;
    const swapAt=room.gameMode==='swiftplay'?5:room.gameMode==='spike'?4:7;
    if(room.round===swapAt)for(const p of room.players.values())p.team=p.team==='attack'?'defense':'attack';
    startBombRound(room);
  }, PREP_TIME);
}

function checkTeamElimination(room) {
  if (!room.started || !['bomb','swiftplay','spike'].includes(room.gameMode) ||
      !room.roundActive || room.roundOver) return;

  const activePlayers = [...room.players.values()]
    .filter(p => p.hp > 0 && !room.disconnectTimers.has(p.id));
  const aliveAttack = activePlayers.filter(p => p.team === 'attack').length;
  const aliveDefense = activePlayers.filter(p => p.team === 'defense').length;

  if (room.players.size >= 2 && activePlayers.length <= 1) {
    finishBombRound(room, activePlayers.length === 1 ? activePlayers[0].team : 'draw', 'elimination');
  } else if (aliveAttack === 0 && aliveDefense === 0) {
    finishBombRound(room, 'draw', 'elimination');
  } else if (aliveAttack === 0) {
    finishBombRound(room, 'defense', 'elimination');
  } else if (aliveDefense === 0) {
    finishBombRound(room, 'attack', 'elimination');
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

io.on('connection', socket => {
  if (socket.recovered) {
    const recoveredCode = socket.data.roomCode;
    const recoveredRoom = rooms.get(recoveredCode);
    const pending = recoveredRoom?.disconnectTimers?.get(socket.id);
    if (pending) { clearTimeout(pending); recoveredRoom.disconnectTimers.delete(socket.id); }
    if (recoveredRoom) {
      io.to(recoveredCode).emit('playersUpdate', roomPlayers(recoveredRoom));
      sendLobbyUpdate(recoveredRoom);
    }
  }

  socket.on('createRoom', (data = {}, cb = () => {}) => {
    if (!data || typeof data !== 'object') data = {};

    let code;
    do {
      code = makeCode();
    } while (rooms.has(code));

    const room = createRoom(code);
    rooms.set(code, room);

    join(socket, room, data.name, data.character, cb);
  });

  socket.on('joinRoom', (data = {}, cb = () => {}) => {
    if (!data || typeof data !== 'object') data = {};

    const code = String(data.code || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);

    const room = rooms.get(code);

    if (!room) {
      return cb({
        ok: false,
        error: 'ROOM NOT FOUND. CHECK THE ROOM CODE.'
      });
    }

    if (room.started) {
      return cb({
        ok: false,
        error: 'THIS MATCH HAS ALREADY STARTED.'
      });
    }

    if (room.players.size >= MAX_PLAYERS) {
      return cb({
        ok: false,
        error: 'ROOM IS FULL (MAX 10 PLAYERS).'
      });
    }

    join(socket, room, data.name, data.character, cb);
  });

  socket.on('setBotMode', enabled => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.started || room.hostId !== socket.id) return;

    room.botsEnabled = enabled === true;
    sendLobbyUpdate(room);
  });

  socket.on('startMatch', (data = {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.started || room.hostId !== socket.id) return;

    const requestedMode = String(data?.gameMode || 'deathmatch');
    const requestedMap = String(data?.map || 'desert');

    room.gameMode = ALLOWED_MODES.includes(requestedMode)
      ? requestedMode
      : 'deathmatch';

    room.map = ALLOWED_MAPS.includes(requestedMap)
      ? requestedMap
      : 'desert';

    room.round = 1;
    room.roundOver = false;
    room.roundActive = false;
    room.roundWins = { attack: 0, defense: 0 };
    room.score={attack:0,defense:0};room.escalationLevels={attack:0,defense:0};room.domination={owner:'neutral',progress:0};
    if(room.matchTimer)clearTimeout(room.matchTimer);if(room.dominationTimer)clearInterval(room.dominationTimer);

    if (['bomb','swiftplay','spike'].includes(room.gameMode)) {
      room.bots = [];
    } else {
      room.bots = room.botsEnabled
        ? Array.from({ length: BOT_COUNT }, () => ({
            hp: 100,
            dead: false
          }))
        : [];
    }

    room.started = true;
    resetBomb(room);

    if (['bomb','swiftplay','spike'].includes(room.gameMode)) {
      startBombRound(room, true);
    } else {
      room.roundActive = true;

      roomPlayers(room).forEach(p => {
        const live = room.players.get(p.id);
        const spawn = SPAWN_POINTS[
          [...room.players.keys()].indexOf(p.id) %
          SPAWN_POINTS.length
        ];

        live.x = spawn.x;
        live.z = spawn.z;
        live.hp = 100;
      });

      sendGameStarted(room);
      io.to(room.code).emit('playersUpdate', roomPlayers(room));
      const duration=room.gameMode==='deathmatch'?570000:room.gameMode==='ffa'?540000:room.gameMode==='escalation'?600000:480000;
      room.matchTimer=setTimeout(()=>{
        const winner=room.gameMode==='ffa'?[...room.players.values()].sort((a,b)=>(b.kills||0)-(a.kills||0))[0]?.id||'draw':room.score.attack===room.score.defense?'draw':room.score.attack>room.score.defense?'attack':'defense';
        finishScoreMatch(room,winner,'time');
      },duration);
      if(room.gameMode==='domination')startDominationScoring(room);
    }

    sendLobbyUpdate(room);
  });

  socket.on('pickBomb', () => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !['bomb','swiftplay','spike'].includes(room.gameMode) ||
        !room.roundActive || room.roundOver) return;

    const player = room.players.get(socket.id);

    if (!player || player.team !== 'attack' || player.hp <= 0 ||
        room.bomb.pickedUp || room.bomb.planted) return;

    if (Math.hypot(
      player.x - BOMB_SPAWN.x,
      player.z - BOMB_SPAWN.z
    ) > 6) return;

    room.bomb.pickedUp = true;
    room.bomb.carrierId = socket.id;

    io.to(room.code).emit('bombPickedUp', {
      carrierId: socket.id,
      playerName: player.name
    });
  });

  socket.on('plantBomb', (data = {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !['bomb','swiftplay','spike'].includes(room.gameMode) ||
        !room.roundActive || room.roundOver || room.bomb.planted) return;

    const player = room.players.get(socket.id);

    if (!player || player.team !== 'attack' || player.hp <= 0 ||
        !room.bomb.pickedUp || room.bomb.carrierId !== socket.id) return;

    const siteName = String(data?.site || '').toUpperCase();
    const site = BOMB_SITES[siteName];

    if (!site || Math.hypot(
      player.x - site.x,
      player.z - site.z
    ) > 8) return;

    room.bomb.planted = true;
    room.bomb.pickedUp = false;
    room.bomb.carrierId = null;
    room.bomb.site = siteName;
    room.bomb.planterId = socket.id;
    room.bomb.endsAt = Date.now() + BOMB_TIME;

    const token = room.roundToken;
    clearBombTimers(room);

    io.to(room.code).emit('bombPlanted', {
      planted: true,
      site: siteName,
      endsAt: room.bomb.endsAt,
      planterId: socket.id
    });

    room.bombTimer = setTimeout(() => {
      if (!room.started || room.roundOver ||
          room.roundToken !== token || !room.bomb.planted) return;

      room.bombTimer = null;

      finishBombRound(room, 'attack', 'explosion');
      io.to(room.code).emit('bombExploded', { winner: 'attack' });
    }, BOMB_TIME);
  });

  socket.on('defuseBomb', () => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !['bomb','swiftplay','spike'].includes(room.gameMode) ||
        !room.roundActive || room.roundOver ||
        !room.bomb.planted || room.bomb.defuserId) return;

    const player = room.players.get(socket.id);

    if (!player || player.team !== 'defense' || player.hp <= 0) return;

    const site = BOMB_SITES[room.bomb.site];

    if (!site || Math.hypot(
      player.x - site.x,
      player.z - site.z
    ) > 8) return;

    room.bomb.defuserId = socket.id;
    const token = room.roundToken;

    io.to(room.code).emit('bombDefusing', {
      playerId: socket.id,
      duration: DEFUSE_TIME
    });

    room.defuseTimer = setTimeout(() => {
      if (!room.started || room.roundOver ||
          room.roundToken !== token || !room.bomb.planted ||
          room.bomb.defuserId !== socket.id) return;

      room.defuseTimer = null;

      const current = room.players.get(socket.id);

      if (!current || current.hp <= 0 ||
          Math.hypot(current.x - site.x, current.z - site.z) > 8) {
        room.bomb.defuserId = null;
        return;
      }

      room.bomb.planted = false;
      room.bomb.defuserId = null;

      finishBombRound(room, 'defense', 'defused');
      io.to(room.code).emit('bombDefused', { winner: 'defense' });
    }, DEFUSE_TIME);
  });

  socket.on('weaponFired', () => {
    const room=rooms.get(socket.data.roomCode);
    if(room?.started&&room.players.has(socket.id))socket.to(room.code).emit('weaponFired',{playerId:socket.id});
  });

  socket.on('healSelf', amount => {
    const room=rooms.get(socket.data.roomCode),player=room?.players.get(socket.id);
    if(!room||!room.started||!player||player.hp<=0)return;
    player.hp=Math.min(100,player.hp+finiteClamped(amount,0,40,0));
    io.to(socket.id).emit('playerHealed',{hp:player.hp});
    io.to(room.code).emit('playersUpdate',roomPlayers(room));
  });

  socket.on('chatMessage', raw => {
    const room=rooms.get(socket.data.roomCode),player=room?.players.get(socket.id);
    if(!room||!player||!room.started)return;
    const text=String(raw||'').replace(/[<>]/g,'').trim().slice(0,120);
    if(text)io.to(room.code).emit('chatMessage',{id:socket.id,name:player.name,text,at:Date.now()});
  });

  socket.on('voiceSignal', data => {
    const room=rooms.get(socket.data.roomCode),targetId=String(data?.targetId||'');
    if(!room||!room.players.has(socket.id)||!room.players.has(targetId)||
       !data?.signal||typeof data.signal!=='object')return;
    io.to(targetId).emit('voiceSignal',{from:socket.id,signal:data.signal});
  });

  socket.on('playerState', (state = {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !state ||
        typeof state !== 'object') return;

    const player = room.players.get(socket.id);

    if (!player || player.hp <= 0) return;

    player.x = finiteClamped(
      state.x, -WORLD_LIMIT, WORLD_LIMIT, player.x
    );

    player.y = finiteClamped(state.y, -2, 10, 0);

    player.z = finiteClamped(
      state.z, -WORLD_LIMIT, WORLD_LIMIT, player.z
    );

    player.ry = finiteClamped(
      state.ry, -Math.PI * 100, Math.PI * 100, player.ry
    );

    player.rx = finiteClamped(state.rx, -1.5, 1.5, player.rx);
    player.name = cleanName(state.name || player.name);

    player.weapon = ['Vandal', 'Şerif', 'AWM'].includes(state.weapon)
      ? state.weapon
      : player.weapon;

    player.character = cleanCharacter(
      state.character || player.character
    );
    player.shieldUntil = state.shield === true ? Date.now() + 300 : 0;

    socket.to(room.code).emit('playersUpdate', [player]);
  });

  socket.on('botHit', (data = {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !room.botsEnabled ||
        !data || typeof data !== 'object') return;

    const id = Math.floor(Number(data.botId));
    const damage = finiteClamped(data.damage, 0, 100, 0);

    if (!Number.isInteger(id) || id < 0 ||
        id >= room.bots.length || !damage) return;

    const bot = room.bots[id];

    if (!bot || bot.dead) return;

    bot.hp = Math.max(0, bot.hp - damage);
    bot.dead = bot.hp <= 0;

    io.to(room.code).emit('botUpdate', {
      botId: id,
      hp: bot.hp,
      dead: bot.dead
    });
  });

  socket.on('playerHit', (data = {}) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started || !data ||
        typeof data !== 'object') return;

    if (['bomb','swiftplay','spike'].includes(room.gameMode) &&
        (!room.roundActive || room.roundOver)) return;

    const attacker = room.players.get(socket.id);
    const target = room.players.get(String(data.targetId || ''));

    if (!attacker || !target || attacker.id === target.id ||
        attacker.hp <= 0 || target.hp <= 0) return;

    if (room.gameMode !== 'ffa' && attacker.team === target.team) return;

    const distance = Math.hypot(
      attacker.x - target.x,
      attacker.z - target.z
    );

    if (distance > 150) return;

    let damage = finiteClamped(data.damage, 0, 100, 0);
    if (!damage) return;
    if (target.shieldUntil > Date.now()) damage = Math.ceil(damage * 0.5);
    target.hp = Math.max(0, target.hp - damage);

    io.to(target.id).emit('playerDamaged', {
      damage,
      hp: target.hp,
      attacker: attacker.name
    });

    if (target.hp <= 0) {
      attacker.kills=(attacker.kills||0)+1;
      if(room.gameMode==='deathmatch'||room.gameMode==='domination')room.score[attacker.team]+=1;
      if(room.gameMode==='escalation')room.escalationLevels[attacker.team]=Math.min(12,room.escalationLevels[attacker.team]+1);
      io.to(room.code).emit('playerEliminated', {
        playerId: target.id,
        killerId: attacker.id,
        killerName: attacker.name
      });

      if (room.bomb.carrierId === target.id) {
        resetBomb(room);
        io.to(room.code).emit('bombReset', {
          round: room.round,
          bomb: room.bomb
        });
      }

      if (room.bomb.defuserId === target.id) {
        if (room.defuseTimer) clearTimeout(room.defuseTimer);
        room.defuseTimer = null;
        room.bomb.defuserId = null;
      }
      if(['deathmatch','ffa','domination'].includes(room.gameMode)&&room.started){
        if(room.gameMode==='ffa'&&attacker.kills>=40)finishScoreMatch(room,attacker.id,'kills');
        else if(room.gameMode!=='ffa'&&room.score[attacker.team]>=100)finishScoreMatch(room,attacker.team,'kills');
      }
      if(room.gameMode==='escalation'){
        const level=room.escalationLevels[attacker.team];io.to(room.code).emit('escalationUpdate',{team:attacker.team,level,playerId:attacker.id});
        if(level>=12)finishScoreMatch(room,attacker.team,'escalation');
      }
      if(['deathmatch','ffa','domination','escalation'].includes(room.gameMode)&&room.started)scheduleRespawn(room,target);
      publishScore(room);
    }

    io.to(room.code).emit('playersUpdate', roomPlayers(room));
    checkTeamElimination(room);
  });

  socket.on('leaveRoom', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    socket.data.roomCode = null;
    if (!room) return;
    const pending = room.disconnectTimers.get(socket.id);
    if (pending) { clearTimeout(pending); room.disconnectTimers.delete(socket.id); }
    const rt=room.respawnTimers.get(socket.id);if(rt)clearTimeout(rt);room.respawnTimers.delete(socket.id);
    room.players.delete(socket.id);
    socket.leave(code);
    if (room.bomb.carrierId === socket.id) {
      resetBomb(room);
      io.to(code).emit('bombReset', { round: room.round, bomb: room.bomb });
    }
    if (room.bomb.defuserId === socket.id) {
      if (room.defuseTimer) clearTimeout(room.defuseTimer);
      room.defuseTimer = null;
      room.bomb.defuserId = null;
    }
    io.to(code).emit('playerLeft', socket.id);
    if (room.players.size === 0) {
      clearRoomTimers(room);
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
    if (room.started && ['bomb','swiftplay','spike'].includes(room.gameMode)) checkTeamElimination(room);
    sendLobbyUpdate(room);
    io.to(code).emit('playersUpdate', roomPlayers(room));
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    // Keep the player/room briefly so Socket.IO can restore a dropped mobile connection.
    const timer = setTimeout(() => {
      room.disconnectTimers.delete(socket.id);
      if (socket.connected) return;
      const rt=room.respawnTimers.get(socket.id);if(rt)clearTimeout(rt);room.respawnTimers.delete(socket.id);
      room.players.delete(socket.id);

      if (room.bomb.carrierId === socket.id) {
        resetBomb(room);
        io.to(code).emit('bombReset', { round: room.round, bomb: room.bomb });
      }
      if (room.bomb.defuserId === socket.id) {
        if (room.defuseTimer) clearTimeout(room.defuseTimer);
        room.defuseTimer = null;
        room.bomb.defuserId = null;
      }
      io.to(code).emit('playerLeft', socket.id);
      if (room.players.size === 0) {
        clearRoomTimers(room);
        rooms.delete(code);
        return;
      }
      if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
      if (room.started && ['bomb','swiftplay','spike'].includes(room.gameMode)) checkTeamElimination(room);
      sendLobbyUpdate(room);
      io.to(code).emit('playersUpdate', roomPlayers(room));
    }, 125000);
    room.disconnectTimers.set(socket.id, timer);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RAGE X server listening on port ${PORT}`);
});
