import { h, $, roomCode, connect, hpBar, conditionChips, rollCard, BAND_LABEL } from './common.js';

const code = roomCode();
let S = null;
const landing = new Map(); // combatant id -> time its initiative die lands; totals stay covered until then
let feedHold = 0;          // the log line would give a total away before its die lands, so it waits too

$('#code').textContent = code;
$('#host').textContent = location.host;

connect({ role: 'table', code }, {
  state: (m) => { S = m.state; render(); },
  event: (m) => {
    const ev = m.event;
    feedHold = Date.now() + 1050;
    if (ev.kind === 'init' && ev.whoId) landing.set(ev.whoId, feedHold);
    setTimeout(() => { if (ev.whoId) landing.delete(ev.whoId); if (S) render(); }, 1100);
    const card = rollCard(ev);
    $('#tray').append(card);
    while ($('#tray').children.length > 4) $('#tray').firstChild.remove();
    setTimeout(() => card.remove(), 9000);
  },
  status: (on) => { $('#offline').hidden = on; },
  gone: () => { $('#spot').replaceChildren(h('h2', { class: 'mid' }, 'This table no longer exists.')); },
});

// Keep a shared screen awake for the whole session where the browser allows it.
const stayAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
stayAwake();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') stayAwake(); });

const byId = (id) => S.combatants.find((c) => c.id === id);
const pcs = () => S.combatants.filter((c) => c.kind === 'pc');
const stillRolling = (c) => (landing.get(c.id) || 0) > Date.now();

function healthLine(c) {
  if (c.hp !== undefined) return h('span', {}, h('b', { class: 'display' }, c.hp), ` / ${c.maxHp} HP`, c.tempHp ? ` (+${c.tempHp} temp)` : '');
  return h('span', { class: `badge ${c.band}` }, BAND_LABEL[c.band]);
}

function orderCard(c, isTurn) {
  return h('div', { class: `ocard ${c.kind}${isTurn ? ' turn' : ''}${c.band === 'down' ? ' down' : ''}` },
    h('div', { class: 'n' }, c.kind === 'pc' ? (stillRolling(c) ? '…' : c.init?.total ?? '–') : '?'),
    h('div', { style: { minWidth: 0 } },
      h('div', { class: 'nm' }, c.name),
      h('div', { class: 'sub' }, c.kind === 'pc' ? [c.playerName, `AC ${c.ac}`].filter(Boolean).join(' · ') : 'Enemy')),
    h('div', { class: 'hp' },
      c.hp !== undefined ? h('span', { class: 'num' }, `${c.hp} / ${c.maxHp}`) : h('span', { class: `badge ${c.band}`, style: { alignSelf: 'flex-end' } }, BAND_LABEL[c.band]),
      hpBar(c)),
    conditionChips(c));
}

/** Turn order starting from whoever is acting, so "next" is always the next card down. */
function renderOrder() {
  const ids = S.order;
  const start = Math.max(0, ids.indexOf(S.turnId));
  const out = [];
  ids.forEach((_, i) => {
    const idx = (start + i) % ids.length;
    if (i > 0 && idx === 0) out.push(h('div', { class: 'eyebrow', style: { padding: '0.3em 0.2em 0' } }, `Round ${S.round + 1}`));
    out.push(orderCard(byId(ids[idx]), ids[idx] === S.turnId));
  });
  const el = $('#order');
  el.style.fontSize = ids.length > 7 ? `${Math.max(0.62, 7 / ids.length)}em` : '';
  el.replaceChildren(...out);
}

function promptSpot() {
  const p = S.prompt;
  if (p.status === 'revealed') {
    return [
      h('span', { class: 'eyebrow' }, 'The answers'),
      h('h2', { class: 'mid' }, p.text),
      h('div', { class: 'reveal' }, pcs().map((c, i) => {
        const a = p.answers[c.id];
        return h('div', { style: { animationDelay: `${i * 0.35}s` } }, h('b', {}, c.name), a ? (a.text || p.options[a.choice]) : h('span', { class: 'muted' }, 'No answer'));
      })),
    ];
  }
  return [
    h('span', { class: 'eyebrow' }, 'Answer on your phone. Only the DM sees it.'),
    h('h2', { class: 'mid' }, p.text),
    h('div', { class: 'tiles' }, pcs().map((c) => {
      const done = p.answered.includes(c.id);
      return h('div', { class: `tile${done ? ' ready' : ''}` }, h('div', { style: { minWidth: 0 } }, h('div', { class: 'nm', style: { fontWeight: 600 } }, c.name), h('div', { class: 'muted' }, done ? 'Locked in' : 'Thinking…')));
    })),
  ];
}

function lobbySpot() {
  const list = pcs();
  return [
    h('span', { class: 'eyebrow' }, 'Getting ready'),
    h('h2', {}, 'Grab your phone and join.'),
    h('div', { class: 'facts' }, h('span', {}, 'Open ', h('b', {}, location.host), ' and enter ', h('b', { style: { color: 'var(--accent)', letterSpacing: '0.12em' } }, code))),
    list.length ? h('div', { class: 'tiles' }, list.map((c) => h('div', { class: `tile${c.connected ? ' ready' : ''}` },
      h('span', { class: `dot${c.connected ? ' on' : ''}` }),
      h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, c.name), h('div', { class: 'muted' }, `${c.hp} / ${c.maxHp} HP · AC ${c.ac}`)))))
      : h('p', { class: 'muted' }, 'Waiting for the first adventurer…'),
  ];
}

function initiativeSpot() {
  const foes = S.combatants.filter((c) => c.kind === 'enemy');
  return [
    h('span', { class: 'eyebrow' }, 'Tap Roll on your phone'),
    h('h2', {}, 'Roll for initiative!'),
    h('div', { class: 'tiles' },
      pcs().map((c) => {
        const shown = c.init && !stillRolling(c);
        return h('div', { class: `tile${shown ? ' ready' : ''}` },
          h('div', { class: `big${shown ? '' : ' wait'}` }, shown ? c.init.total : '…'),
          h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, c.name), h('div', { class: 'muted' }, shown ? 'Rolled' : c.init ? 'Rolling…' : 'Waiting')));
      }),
      foes.length ? h('div', { class: 'tile ready' }, h('div', { class: 'big', style: { color: 'var(--foe)' } }, foes.length), h('div', {}, h('div', { style: { fontWeight: 600 } }, foes.length === 1 ? 'Enemy' : 'Enemies'), h('div', { class: 'muted' }, 'Rolled in secret'))) : null),
  ];
}

function combatSpot() {
  const ids = S.order;
  const current = byId(S.turnId);
  const at = ids.indexOf(S.turnId);
  const upcoming = ids.length > 1 && at >= 0 ? [1, 2].map((n) => byId(ids[(at + n) % ids.length])).filter((c, i, a) => c && c.id !== S.turnId && a.indexOf(c) === i) : [];
  if (!current) {
    return [
      h('span', { class: 'eyebrow' }, `Round ${S.round}`),
      h('h2', {}, S.turnHidden ? 'An unseen foe acts…' : 'Waiting for the next turn'),
    ];
  }
  return [
    h('span', { class: 'eyebrow' }, current.kind === 'pc' ? `Round ${S.round} · ${current.playerName || 'Player'}` : `Round ${S.round} · Enemy`),
    h('h2', {}, `${current.name}'s turn`),
    h('div', { class: 'facts' }, healthLine(current), current.kind === 'pc' ? h('span', { class: 'muted' }, `AC ${current.ac}`) : null, conditionChips(current)),
    current.hp !== undefined ? h('div', { style: { maxWidth: '26em' } }, hpBar(current)) : null,
    upcoming.length ? h('div', { class: 'next' }, 'Up next: ', h('b', {}, upcoming[0].name), upcoming[1] ? [', then ', upcoming[1].name] : null) : null,
  ];
}

let lastSpotKey = '';
function render() {
  document.title = `${S.name} · BattleBox`;
  $('#name').textContent = S.name;
  $('#round').hidden = S.phase !== 'combat';
  $('#round').textContent = `Round ${S.round}`;

  const showOrder = S.phase === 'combat' && S.order.length > 0;
  $('#main').classList.toggle('solo', !showOrder);
  $('#order').hidden = !showOrder;
  if (showOrder) renderOrder();

  const spot = $('#spot');
  const build = S.prompt ? promptSpot : S.phase === 'lobby' ? lobbySpot : S.phase === 'initiative' ? initiativeSpot : combatSpot;
  spot.replaceChildren(...build().filter(Boolean));
  // Announce a change of turn or scene with one small pop, not on every HP tick.
  const key = `${S.phase}|${S.turnId}|${S.turnHidden}|${S.prompt?.id}|${S.prompt?.status}`;
  if (key !== lastSpotKey) { lastSpotKey = key; spot.style.animation = 'none'; void spot.offsetWidth; spot.style.animation = 'pop 0.35s ease-out'; }

  if (Date.now() >= feedHold) $('#feed').replaceChildren(...S.log.slice(-3).map((l) => h('div', {}, l.text)));
}
