import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as R from './rooms.js';
import { ddbCharacterId, parseDdbCharacter, parseCharacterJson, mapOpen5eMonster } from './importers.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ROOM_DIR = path.join(DATA_DIR, 'rooms');
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 200; // the create endpoint is open, so cap what it can write to disk
fs.mkdirSync(ROOM_DIR, { recursive: true });

// ---------- rooms on disk ----------

const rooms = new Map();
for (const file of fs.readdirSync(ROOM_DIR)) {
  if (!/^[A-Z]{4}\.json$/.test(file)) continue;
  try {
    const room = JSON.parse(fs.readFileSync(path.join(ROOM_DIR, file), 'utf8'));
    rooms.set(room.code, room);
  } catch (err) {
    console.error(`Skipping unreadable room file ${file}: ${err.message}`);
  }
}
console.log(`Loaded ${rooms.size} saved table(s) from ${ROOM_DIR}`);

const pendingSaves = new Map();
function writeRoom(room) {
  const file = path.join(ROOM_DIR, `${room.code}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(room));
  fs.renameSync(`${file}.tmp`, file); // rename is atomic, so a crash never leaves half a file
}
function save(room) {
  if (pendingSaves.has(room.code)) return;
  pendingSaves.set(room.code, setTimeout(() => {
    pendingSaves.delete(room.code);
    try { writeRoom(room); } catch (err) { console.error(`Could not save ${room.code}: ${err.message}`); }
  }, 250));
}
function flushSaves() {
  for (const [code, timer] of pendingSaves) { clearTimeout(timer); try { writeRoom(rooms.get(code)); } catch { /* shutting down */ } }
  pendingSaves.clear();
}

// ---------- http ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' })); // a full D&D Beyond character export can pass 1 MB
app.use(express.static(PUBLIC, { extensions: ['html'] }));

const page = (name) => (req, res) => res.sendFile(path.join(PUBLIC, `${name}.html`));
app.get('/dm/:code', page('dm'));
app.get('/table/:code', page('table'));
app.get('/play/:code', page('play'));
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const api = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (err) {
    if (err instanceof R.UserError) return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  }
};

app.post('/api/rooms', api((req) => {
  if (rooms.size >= MAX_ROOMS) throw new R.UserError('This server already has its maximum number of tables. Delete old files from data/rooms.');
  const room = R.createRoom(R.makeCode((c) => rooms.has(c)), req.body?.name);
  rooms.set(room.code, room);
  save(room);
  return { code: room.code, name: room.name, dmToken: room.dmToken };
}));

app.get('/api/rooms/:code', api((req) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) throw new R.UserError('No table with that code.');
  return { code: room.code, name: room.name };
}));

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

app.post('/api/import/ddb', api(async (req) => {
  const id = ddbCharacterId(req.body?.ref);
  let data;
  try {
    data = await getJson(`https://character-service.dndbeyond.com/character/v5/character/${id}`);
  } catch (err) {
    throw new R.UserError(err.status === 403 || err.status === 404
      ? 'D&D Beyond would not share that character. Set its privacy to Public, or paste the JSON instead.'
      : 'Could not reach D&D Beyond from the server. Paste the JSON or type the numbers instead.');
  }
  return parseDdbCharacter(data);
}));

app.post('/api/import/json', api((req) => parseCharacterJson(req.body?.text)));

const monsterCache = new Map();
app.get('/api/monsters', api(async (req) => {
  const q = R.text(req.query.q, 40).toLowerCase();
  if (q.length < 2) return { results: [] };
  if (monsterCache.has(q)) return monsterCache.get(q);
  const enc = encodeURIComponent(q);
  let raw;
  try {
    raw = await getJson(`https://api.open5e.com/v1/monsters/?search=${enc}&limit=12`);
  } catch {
    try {
      raw = await getJson(`https://api.open5e.com/v2/creatures/?name__icontains=${enc}&limit=12`);
    } catch {
      throw new R.UserError('Monster lookup is unreachable right now. Add the enemy by hand instead.');
    }
  }
  const results = (raw.results || []).map(mapOpen5eMonster)
    .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? 0 : 1) - (b.name.toLowerCase().startsWith(q) ? 0 : 1));
  const out = { results };
  if (monsterCache.size > 500) monsterCache.clear();
  monsterCache.set(q, out);
  return out;
}));

// ---------- live connections ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
const conns = new Map(); // room code -> Set of { ws, role, key, room }

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const peers = (room) => conns.get(room.code) || new Set();

function connectedPcIds(room) {
  const keys = new Set([...peers(room)].filter((c) => c.role === 'player').map((c) => c.key));
  return new Set(room.combatants.filter((c) => c.kind === 'pc' && c.owner && keys.has(c.owner)).map((c) => c.id));
}
function viewFor(conn, connected) {
  if (conn.role === 'dm') return R.dmView(conn.room, connected);
  if (conn.role === 'player') return R.playerView(conn.room, conn.key, connected);
  return R.publicView(conn.room, connected);
}
function broadcast(room) {
  const connected = connectedPcIds(room);
  for (const conn of peers(room)) send(conn.ws, { type: 'state', state: viewFor(conn, connected) });
}
function emit(room, events) {
  for (const event of [events].flat().filter(Boolean)) {
    for (const conn of peers(room)) if (!event.private || conn.role === 'dm') send(conn.ws, { type: 'event', event });
  }
}

const dmActions = {
  add_enemy: (room, m) => { R.addEnemies(room, m); },
  add_pc: (room, m) => { R.addPc(room, m); },
  update: (room, m) => { R.updateCombatant(room, m.id, m.patch); },
  hp: (room, m) => { R.applyHp(room, m.id, Number(m.delta)); },
  condition: (room, m) => { R.setCondition(room, m.id, m.name, !!m.on); },
  remove: (room, m) => { R.removeCombatant(room, m.id); },
  release: (room, m) => { R.find(room, m.id).owner = null; },
  call_init: (room) => R.callInitiative(room),
  roll_for: (room, m) => R.rollInitiative(room, m.id),
  roll_rest: (room) => room.combatants.filter((c) => !c.init).map((c) => R.rollInitiative(room, c.id)),
  start: (room) => R.startCombat(room),
  next: (room) => { R.nextTurn(room); },
  prev: (room) => { R.prevTurn(room); },
  end: (room, m) => { R.endCombat(room, { keepEnemies: !!m.keepEnemies }); },
  prompt_open: (room, m) => { R.openPrompt(room, m); },
  prompt_close: (room, m) => { R.closePrompt(room, !!m.reveal); },
  prompt_clear: (room) => { R.clearPrompt(room); },
  setting: (room, m) => { if (m.key === 'enemyHp' && ['status', 'exact'].includes(m.value)) room.settings.enemyHp = m.value; },
  rename: (room, m) => { room.name = R.text(m.name, 60) || room.name; },
  roll: (room, m) => R.rollDice(room, { id: null, name: 'DM' }, m),
};

function requirePc(conn) {
  const pc = R.pcOf(conn.room, conn.key);
  if (!pc) throw new R.UserError('Join with a character first.');
  return pc;
}
const playerActions = {
  join: (room, m, conn) => {
    if (R.pcOf(room, conn.key)) return;
    const playerName = R.text(m.playerName, 30);
    if (!R.text(m.character?.name, 40)) throw new R.UserError('Give your character a name.');
    if (room.combatants.filter((c) => c.kind === 'pc').length >= 12) throw new R.UserError('This table is full.');
    R.addPc(room, { ...m.character, playerName }, conn.key);
  },
  claim: (room, m, conn) => {
    if (R.pcOf(room, conn.key)) return;
    const pc = R.find(room, m.id);
    if (pc.kind !== 'pc' || connectedPcIds(room).has(pc.id)) throw new R.UserError('Someone is already playing that character.');
    pc.owner = conn.key;
    if (R.text(m.playerName, 30)) pc.playerName = R.text(m.playerName, 30);
  },
  leave: (room, m, conn) => { const pc = R.pcOf(room, conn.key); if (pc) pc.owner = null; },
  roll_init: (room, m, conn) => {
    const pc = requirePc(conn);
    if (room.phase === 'lobby') throw new R.UserError('The DM has not called for initiative yet.');
    if (pc.init) throw new R.UserError('You already rolled.');
    return R.rollInitiative(room, pc.id);
  },
  roll: (room, m, conn) => R.rollDice(room, requirePc(conn), { ...m, private: false }),
  end_turn: (room, m, conn) => { R.endTurn(room, requirePc(conn).id); },
  answer: (room, m, conn) => { R.answerPrompt(room, requirePc(conn).id, m); },
};

function handle(conn, m) {
  if (m.type === 'hello') {
    if (conn.room) return;
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room) return send(conn.ws, { type: 'gone' });
    const role = ['dm', 'player', 'table'].includes(m.role) ? m.role : 'table';
    if (role === 'dm' && m.token !== room.dmToken) return send(conn.ws, { type: 'denied' });
    if (role === 'player' && !/^[a-z0-9]{12,64}$/i.test(String(m.key || ''))) return send(conn.ws, { type: 'denied' });
    Object.assign(conn, { room, role, key: role === 'player' ? String(m.key) : null });
    if (!conns.has(room.code)) conns.set(room.code, new Set());
    conns.get(room.code).add(conn);
    broadcast(room); // everyone learns this player is connected
    return;
  }
  if (!conn.room) return;
  const action = (conn.role === 'dm' ? dmActions : conn.role === 'player' ? playerActions : {})[m.type];
  if (!action) return;
  const events = action(conn.room, m, conn);
  save(conn.room);
  emit(conn.room, events); // dice first, so screens can hold back a total until its die has landed
  broadcast(conn.room);
}

wss.on('connection', (ws) => {
  const conn = { ws, role: null, room: null, key: null, alive: true };
  ws.on('pong', () => { conn.alive = true; });
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try {
      handle(conn, m);
    } catch (err) {
      if (err instanceof R.UserError) return send(ws, { type: 'error', message: err.message });
      console.error(err);
      send(ws, { type: 'error', message: 'Something went wrong on the server.' });
    }
  });
  ws.on('close', () => {
    if (!conn.room) return;
    peers(conn.room).delete(conn);
    broadcast(conn.room);
  });
  ws.on('error', () => {});
});

// Tunnels and proxies drop idle sockets; a ping every 25 s keeps them open and clears dead ones.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) ws.ping();
}, 25000);

server.listen(PORT, () => console.log(`BattleBox is listening on http://localhost:${PORT}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(heartbeat);
    flushSaves();
    for (const ws of wss.clients) ws.terminate();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
