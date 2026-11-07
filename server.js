const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e5 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();
const MAX_PLAYERS = 10;
const BOT_COUNT = 8;
const makeCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
function cleanName(v){ return String(v || 'Oyuncu').replace(/[<>]/g,'').trim().slice(0,16) || 'Oyuncu'; }
function roomPlayers(room){ return [...room.players.values()]; }
function createRoom(code){
 return { code, players:new Map(), bots:Array.from({length:BOT_COUNT},()=>({hp:100,dead:false})) };
}
app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(req,res)=>res.json({ok:true,rooms:rooms.size}));
io.on('connection',socket=>{
 socket.on('createRoom',(data={},cb=()=>{})=>{
  let code; do{code=makeCode();}while(rooms.has(code));
  const room=createRoom(code);rooms.set(code,room);join(socket,room,data.name,cb);
 });
 socket.on('joinRoom',(data={},cb=()=>{})=>{
  const code=String(data.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);
  const room=rooms.get(code);
  if(!room)return cb({ok:false,error:'Bu oda bulunamadı. Oda kodunu kontrol et.'});
  if(room.players.size>=MAX_PLAYERS)return cb({ok:false,error:'Oda dolu (en fazla 10 oyuncu).'});
  join(socket,room,data.name,cb);
 });
 function join(sock,room,name,cb){
  sock.join(room.code);sock.data.roomCode=room.code;
  const p={id:sock.id,name:cleanName(name),x:-8,y:0,z:37,ry:0,rx:0,hp:100,weapon:'Vandal'};
  room.players.set(sock.id,p);
  cb({ok:true,code:room.code,players:roomPlayers(room),bots:room.bots});
  sock.to(room.code).emit('playerJoined',p);
  io.to(room.code).emit('playersUpdate',roomPlayers(room));
 }
 socket.on('playerState',state=>{
  const room=rooms.get(socket.data.roomCode);if(!room)return;
  const p=room.players.get(socket.id);if(!p)return;
  for(const k of ['x','y','z','ry','rx','hp']){const n=Number(state[k]);if(Number.isFinite(n))p[k]=Math.max(-1000,Math.min(1000,n));}
  p.name=cleanName(state.name);p.weapon=String(state.weapon||'Vandal').slice(0,12);
  socket.to(room.code).emit('playersUpdate',[p]);
 });
 socket.on('botHit',data=>{
  const room=rooms.get(socket.data.roomCode);if(!room)return;
  const id=Math.floor(Number(data?.botId));const damage=Math.max(0,Math.min(100,Number(data?.damage)||0));
  if(!Number.isInteger(id)||id<0||id>=room.bots.length||!damage)return;
  const bot=room.bots[id];if(bot.dead)return;
  bot.hp=Math.max(0,bot.hp-damage);bot.dead=bot.hp<=0;
  io.to(room.code).emit('botUpdate',{botId:id,hp:bot.hp,dead:bot.dead});
 });
 socket.on('disconnect',()=>{
  const code=socket.data.roomCode;if(!code)return;
  const room=rooms.get(code);if(!room)return;
  room.players.delete(socket.id);io.to(code).emit('playerLeft',socket.id);
  io.to(code).emit('playersUpdate',roomPlayers(room));
  if(room.players.size===0)rooms.delete(code);
 });
});
server.listen(PORT,'0.0.0.0',()=>console.log(`TACTICAL STRIKE server listening on port ${PORT}`));
