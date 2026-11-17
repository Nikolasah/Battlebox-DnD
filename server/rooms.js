// Room state and every rule that changes it. No I/O here: index.js owns sockets and disk.
import { randomBytes, randomInt } from 'node:crypto';

export const CONDITIONS = [
  'Blinded', 'Charmed', 'Concentrating', 'Deafened', 'Frightened', 'Grappled', 'Incapacitated',
  'Invisible', 'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Stunned', 'Unconscious',
];
export const DICE = [4, 6, 8, 10, 12, 20, 100];
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so codes never spell words

/** A message that is safe to show to the person who caused it. */
export class UserError extends Error {}

export const cryptoRng = (sides) => randomInt(1, sides + 1);
const uid = () => randomBytes(6).toString('hex');

export function int(v, min, max, fallback) {
  const n = Math.round(Number(v));
  if (v === '' || v == null || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
export function text(v, max = 60) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function makeCode(isTaken) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
}

export function createRoom(code, name) {
  return {
    v: 1,
    code,
    name: text(name, 60) || 'Untitled table',
    dmToken: randomBytes(16).toString('hex'),
    createdAt: Date.now(),
    phase: 'lobby', // lobby -> initiative -> combat -> lobby
    round: 0,
    turnId: null,
    combatants: [],
    prompt: null,
    log: [],
    settings: { enemyHp: 'status' }, // what the table sees for enemies: 'status' | 'exact'
  };
}

function log(room, message, dmOnly = false) {
  room.log.push({ t: Date.now(), text: message, dm: dmOnly });
  if (room.log.length > 200) room.log.splice(0, room.log.length - 200);
}

export function find(room, id) {
  const c = room.combatants.find((x) => x.id === id);
  if (!c) throw new UserError('That combatant is no longer in the fight.');
  return c;
}
export const pcOf = (room, key) => room.combatants.find((c) => c.kind === 'pc' && c.owner === key) || null;

// ---------- combatants ----------

function baseCombatant(kind, d) {
  const maxHp = int(d.maxHp, 1, 9999, 10);
  return {
    id: uid(),
    kind,
    name: text(d.name, 40),
    maxHp,
    hp: int(d.hp, 0, maxHp, maxHp),
    tempHp: int(d.tempHp, 0, 999, 0),
    ac: int(d.ac, 0, 99, 10),
    initMod: int(d.initMod, -20, 30, 0),
    init: null, // { roll, total } once rolled
    conditions: [],
    hidden: false,
  };
}

export function addPc(room, d, owner = null) {
  const c = baseCombatant('pc', d);
  c.name = c.name || 'Adventurer';
  c.playerName = text(d.playerName, 30);
  c.owner = owner;
  room.combatants.push(c);
  log(room, `${c.name} joins the table.`);
  return c;
}

/**
 * Add a character, or refresh the one that already has this name. People edit a sheet file and
 * import it again to change stats, and that must not leave two copies of the same character.
 */
export function upsertPc(room, d, owner = null) {
  const name = text(d.name, 40).toLowerCase();
  const existing = name && room.combatants.find((c) => c.kind === 'pc' && c.name.toLowerCase() === name);
  if (!existing) return { pc: addPc(room, d, owner), created: true };
  updateCombatant(room, existing.id, { maxHp: d.maxHp, hp: d.hp, tempHp: d.tempHp, ac: d.ac, initMod: d.initMod });
  if (text(d.playerName, 30)) existing.playerName = text(d.playerName, 30);
  if (owner) existing.owner = owner;
  log(room, `${existing.name}'s sheet was updated.`, true);
  return { pc: existing, created: false };
}

export function addEnemies(room, d, rng = cryptoRng) {
  const base = text(d.name, 40) || 'Enemy';
  const count = int(d.count, 1, 20, 1);
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const numbered = new RegExp(`^${esc} (\\d+)$`);
  let highest = 0;
  for (const c of room.combatants) {
    if (c.kind !== 'enemy') continue;
    if (c.name === base) { c.name = `${base} 1`; highest = Math.max(highest, 1); }
    const m = c.name.match(numbered);
    if (m) highest = Math.max(highest, Number(m[1]));
  }
  const added = [];
  for (let i = 0; i < count; i++) {
    const c = baseCombatant('enemy', d);
    c.name = count === 1 && highest === 0 ? base : `${base} ${highest + i + 1}`;
    c.hidden = !!d.hidden;
    room.combatants.push(c);
    if (room.phase !== 'lobby') rollInitiative(room, c.id, rng);
    added.push(c);
  }
  log(room, `Added ${count > 1 ? `${count} × ` : ''}${base}${d.hidden ? ' (hidden)' : ''}.`, true);
  return added;
}

export function updateCombatant(room, id, patch = {}) {
  const c = find(room, id);
  if ('name' in patch) c.name = text(patch.name, 40) || c.name;
  if ('playerName' in patch && c.kind === 'pc') c.playerName = text(patch.playerName, 30);
  if ('maxHp' in patch) { c.maxHp = int(patch.maxHp, 1, 9999, c.maxHp); c.hp = Math.min(c.hp, c.maxHp); }
  if ('hp' in patch) c.hp = int(patch.hp, 0, c.maxHp, c.hp);
  if ('tempHp' in patch) c.tempHp = int(patch.tempHp, 0, 999, c.tempHp);
  if ('ac' in patch) c.ac = int(patch.ac, 0, 99, c.ac);
  if ('initMod' in patch) c.initMod = int(patch.initMod, -20, 30, c.initMod);
  if ('hidden' in patch && c.kind === 'enemy') {
    const was = c.hidden;
    c.hidden = !!patch.hidden;
    if (was && !c.hidden) log(room, `${c.name} appears!`);
  }
  if ('init' in patch) {
    if (patch.init === null || patch.init === '') c.init = null;
    else c.init = { roll: null, total: int(patch.init, -20, 99, c.init?.total ?? 10) };
    ensureTurn(room);
  }
  return c;
}

export function removeCombatant(room, id) {
  const c = find(room, id);
  if (room.turnId === id) {
    if (turnOrder(room).length > 1) nextTurn(room);
    else room.turnId = null;
  }
  room.combatants = room.combatants.filter((x) => x.id !== id);
  if (room.prompt) delete room.prompt.answers[id];
  log(room, `${c.name} removed.`, true);
}

export function applyHp(room, id, delta) {
  const c = find(room, id);
  const amount = int(Math.abs(delta), 0, 9999, 0);
  if (!amount) return c;
  const quiet = c.hidden;
  if (delta < 0) {
    const absorbed = Math.min(c.tempHp, amount);
    c.tempHp -= absorbed;
    const wasUp = c.hp > 0;
    c.hp = Math.max(0, c.hp - (amount - absorbed));
    log(room, `${c.name} takes ${amount} damage.`, quiet);
    if (wasUp && c.hp === 0) log(room, `${c.name} is down!`, quiet);
  } else {
    const before = c.hp;
    c.hp = Math.min(c.maxHp, c.hp + amount);
    log(room, `${c.name} regains ${c.hp - before} hit points.`, quiet);
  }
  return c;
}

export function setCondition(room, id, name, on) {
  const c = find(room, id);
  if (!CONDITIONS.includes(name)) throw new UserError('Unknown condition.');
  const has = c.conditions.includes(name);
  if (on && !has) { c.conditions.push(name); log(room, `${c.name} is now ${name.toLowerCase()}.`, c.hidden); }
  if (!on && has) { c.conditions = c.conditions.filter((x) => x !== name); log(room, `${c.name} is no longer ${name.toLowerCase()}.`, c.hidden); }
  return c;
}

// ---------- initiative and turns ----------

/** Highest total first; ties go to the higher modifier, then player characters, then join order. */
export function turnOrder(room) {
  return room.combatants
    .filter((c) => c.init)
    .sort((a, b) => b.init.total - a.init.total
      || b.initMod - a.initMod
      || (a.kind === b.kind ? 0 : a.kind === 'pc' ? -1 : 1));
}

const isSkipped = (c) => c.kind === 'enemy' && c.hp <= 0; // downed PCs still take their turn (death saves)

function ensureTurn(room) {
  if (room.phase !== 'combat') return;
  const order = turnOrder(room);
  if (!order.some((c) => c.id === room.turnId)) room.turnId = order[0]?.id ?? null;
}

export function rollInitiative(room, id, rng = cryptoRng) {
  const c = find(room, id);
  const roll = rng(20);
  c.init = { roll, total: roll + c.initMod };
  ensureTurn(room);
  const hiddenFromTable = c.kind === 'enemy';
  log(room, `${c.name} rolls initiative: ${c.init.total} (${roll}${fmtMod(c.initMod)}).`, hiddenFromTable);
  return {
    kind: 'init', id: uid(), whoId: c.id, who: c.name, label: 'Initiative',
    dice: [{ sides: 20, value: roll }], mod: c.initMod, total: c.init.total, private: hiddenFromTable,
  };
}

export function callInitiative(room, rng = cryptoRng) {
  if (!room.combatants.length) throw new UserError('Add at least one combatant first.');
  room.phase = 'initiative';
  room.round = 0;
  room.turnId = null;
  for (const c of room.combatants) c.init = null;
  log(room, 'Roll for initiative!');
  return room.combatants.filter((c) => c.kind === 'enemy').map((c) => rollInitiative(room, c.id, rng));
}

export function startCombat(room, rng = cryptoRng) {
  const events = room.combatants.filter((c) => c.kind === 'enemy' && !c.init).map((c) => rollInitiative(room, c.id, rng));
  const order = turnOrder(room);
  if (!order.length) throw new UserError('Nobody has rolled initiative yet.');
  room.phase = 'combat';
  room.round = 1;
  room.turnId = order[0].id;
  log(room, 'Combat begins. Round 1.');
  return events;
}

export function nextTurn(room) {
  if (room.phase !== 'combat') throw new UserError('Combat has not started.');
  const order = turnOrder(room);
  if (!order.length) return;
  let i = order.findIndex((c) => c.id === room.turnId);
  for (let n = 0; n < order.length; n++) {
    i += 1;
    if (i >= order.length) { i = 0; room.round += 1; log(room, `Round ${room.round}.`); }
    if (!isSkipped(order[i])) break;
  }
  room.turnId = order[i].id;
}

export function prevTurn(room) {
  if (room.phase !== 'combat') throw new UserError('Combat has not started.');
  const order = turnOrder(room);
  if (!order.length) return;
  let i = order.findIndex((c) => c.id === room.turnId);
  if (i === -1) i = 0;
  for (let n = 0; n < order.length; n++) {
    i -= 1;
    if (i < 0) {
      if (room.round <= 1) { i = 0; break; }
      i = order.length - 1;
      room.round -= 1;
    }
    if (!isSkipped(order[i])) break;
  }
  room.turnId = order[i].id;
}

export function endTurn(room, pcId) {
  if (room.phase !== 'combat' || room.turnId !== pcId) throw new UserError('It is not your turn.');
  nextTurn(room);
}

export function endCombat(room, { keepEnemies = false } = {}) {
  room.phase = 'lobby';
  room.round = 0;
  room.turnId = null;
  if (!keepEnemies) room.combatants = room.combatants.filter((c) => c.kind === 'pc');
  for (const c of room.combatants) c.init = null;
  log(room, 'Combat is over.');
}

// ---------- dice ----------

const fmtMod = (m) => (m ? (m > 0 ? `+${m}` : `−${Math.abs(m)}`) : '');

export function rollDice(room, who, d = {}, rng = cryptoRng) {
  const sides = DICE.includes(Number(d.sides)) ? Number(d.sides) : 20;
  const mode = sides === 20 && (d.mode === 'adv' || d.mode === 'dis') ? d.mode : null;
  const count = mode ? 1 : int(d.count, 1, 12, 1);
  const mod = int(d.mod, -99, 99, 0);
  const label = text(d.label, 24);
  let dice;
  if (mode) {
    const a = rng(20); const b = rng(20);
    const keepA = mode === 'adv' ? a >= b : a <= b;
    dice = [{ sides, value: a, dropped: !keepA }, { sides, value: b, dropped: keepA }];
  } else {
    dice = Array.from({ length: count }, () => ({ sides, value: rng(sides) }));
  }
  const total = dice.filter((x) => !x.dropped).reduce((s, x) => s + x.value, 0) + mod;
  const isPrivate = !!d.private;
  const tag = mode === 'adv' ? ' with advantage' : mode === 'dis' ? ' with disadvantage' : '';
  log(room, `${who.name} rolls ${label ? `${label}: ` : ''}${total} (${count > 1 ? count : ''}d${sides}${fmtMod(mod)}${tag}).`, isPrivate);
  return { kind: 'roll', id: uid(), whoId: who.id ?? null, who: who.name, label, dice, mod, total, mode, private: isPrivate };
}

// ---------- table prompt (secret choice) ----------

export function openPrompt(room, d = {}) {
  const promptText = text(d.text, 240);
  if (!promptText) throw new UserError('Write the prompt first.');
  const options = (Array.isArray(d.options) ? d.options : []).map((o) => text(o, 80)).filter(Boolean).slice(0, 4);
  room.prompt = { id: uid(), text: promptText, options, writeIn: !!d.writeIn || options.length === 0, status: 'open', answers: {} };
  log(room, `Prompt sent to phones: “${promptText}”`, true);
}

export function answerPrompt(room, pcId, d = {}) {
  const p = room.prompt;
  if (!p || p.status !== 'open') throw new UserError('That prompt is closed.');
  const written = p.writeIn ? text(d.text, 140) : '';
  const choice = Number.isInteger(d.choice) && d.choice >= 0 && d.choice < p.options.length ? d.choice : null;
  if (!written && choice === null) throw new UserError('Pick an option or write an answer.');
  p.answers[pcId] = written ? { choice: null, text: written } : { choice, text: '' };
}

export function closePrompt(room, reveal) {
  const p = room.prompt;
  if (!p) return;
  const lines = Object.entries(p.answers).map(([id, a]) => {
    const c = room.combatants.find((x) => x.id === id);
    return `${c?.name ?? '?'}: ${a.text || p.options[a.choice]}`;
  });
  log(room, `Answers to “${p.text}” — ${lines.join(' · ') || 'none'}`, !reveal);
  if (reveal) p.status = 'revealed';
  else room.prompt = null;
}

export function clearPrompt(room) { room.prompt = null; }

// ---------- views: what each kind of screen is allowed to see ----------

export function band(c) {
  if (c.hp <= 0) return 'down';
  const r = c.hp / c.maxHp;
  return r <= 0.25 ? 'critical' : r <= 0.5 ? 'bloodied' : 'healthy';
}

export function dmView(room, connected = new Set()) {
  return {
    role: 'dm', code: room.code, name: room.name, phase: room.phase, round: room.round, turnId: room.turnId,
    order: turnOrder(room).map((c) => c.id),
    combatants: room.combatants.map(({ owner, ...c }) => ({ ...c, band: band(c), claimed: !!owner, connected: connected.has(c.id) })),
    prompt: room.prompt,
    log: room.log.slice(-80),
    settings: room.settings,
    conditions: CONDITIONS,
  };
}

function publicCombatant(room, c, connected) {
  if (c.kind === 'pc') {
    return {
      id: c.id, kind: 'pc', name: c.name, playerName: c.playerName, hp: c.hp, maxHp: c.maxHp, tempHp: c.tempHp,
      ac: c.ac, initMod: c.initMod, init: c.init, conditions: c.conditions, band: band(c), connected: connected.has(c.id),
    };
  }
  const out = { id: c.id, kind: 'enemy', name: c.name, conditions: c.conditions, band: band(c), init: c.init ? {} : null };
  if (room.settings.enemyHp === 'exact') { out.hp = c.hp; out.maxHp = c.maxHp; }
  return out;
}

export function publicView(room, connected = new Set()) {
  const visible = room.combatants.filter((c) => !c.hidden);
  const visibleIds = new Set(visible.map((c) => c.id));
  const p = room.prompt;
  return {
    role: 'table', code: room.code, name: room.name, phase: room.phase, round: room.round,
    turnId: visibleIds.has(room.turnId) ? room.turnId : null,
    turnHidden: !!room.turnId && !visibleIds.has(room.turnId),
    order: turnOrder(room).filter((c) => visibleIds.has(c.id)).map((c) => c.id),
    combatants: visible.map((c) => publicCombatant(room, c, connected)),
    prompt: p && {
      id: p.id, text: p.text, options: p.options, writeIn: p.writeIn, status: p.status,
      answered: Object.keys(p.answers),
      answers: p.status === 'revealed' ? p.answers : undefined,
    },
    log: room.log.filter((l) => !l.dm).slice(-30),
    settings: room.settings,
  };
}

export function playerView(room, key, connected = new Set()) {
  const view = publicView(room, connected);
  const me = pcOf(room, key);
  view.role = 'player';
  view.you = me?.id ?? null;
  view.yourAnswer = (me && room.prompt?.answers[me.id]) || null;
  // Characters nobody is holding right now: a returning player picks theirs instead of retyping it.
  view.claimable = me ? [] : room.combatants
    .filter((c) => c.kind === 'pc' && !connected.has(c.id))
    .map((c) => ({ id: c.id, name: c.name, playerName: c.playerName }));
  return view;
}
