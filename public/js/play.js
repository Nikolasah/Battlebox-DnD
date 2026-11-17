import { h, $, roomCode, connect, api, toast, rerender, hpBar, conditionChips, rollCard, fmtMod, playerKey } from './common.js';

const code = roomCode();
const key = playerKey(code);
let S = null;
let wasMyTurn = false;

const conn = connect({ role: 'player', code, key }, {
  state: (m) => { S = m.state; render(); },
  event: (m) => {
    if (!S?.you || m.event.whoId !== S.you) return;
    $('#myRoll').replaceChildren(rollCard(m.event));
  },
  status: (on) => { $('#offline').hidden = on; },
  gone: () => show('gone'),
  denied: () => show('gone'),
});
const send = (type, payload) => conn.send(type, payload);

function show(view) {
  for (const id of ['gone', 'joinView', 'playView']) $(`#${id}`).hidden = id !== view;
}

// ---------- join ----------

const joinForm = $('#joinForm');
const jf = joinForm.elements;
try { jf.playerName.value = localStorage.getItem('battlebox:name') || ''; } catch { /* private mode */ }

for (const tab of document.querySelectorAll('.tabs [data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tabs [data-tab]')) t.setAttribute('aria-pressed', String(t === tab));
    $('#tab-ddb').hidden = tab.dataset.tab !== 'ddb';
    $('#tab-json').hidden = tab.dataset.tab !== 'json';
  });
}

function fillFrom(c) {
  jf.name.value = c.name; jf.maxHp.value = c.maxHp; jf.ac.value = c.ac; jf.initMod.value = c.initMod;
  jf.hp.value = c.hp ?? ''; jf.tempHp.value = c.tempHp ?? '';
  const note = $('#importNote');
  note.hidden = false;
  note.textContent = `Imported ${c.name}${c.summary ? ` (${c.summary})` : ''}. ${c.note || 'Check the numbers below, then take a seat.'}`;
  jf.maxHp.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
async function runImport(button, path, body) {
  const label = button.textContent;
  button.disabled = true; button.textContent = 'Reading…';
  try { fillFrom(await api(path, body)); } catch (err) { toast(err.message, 'bad'); }
  button.disabled = false; button.textContent = label;
}
$('#ddbFetch').addEventListener('click', (e) => runImport(e.currentTarget, '/api/import/ddb', { ref: $('#ddbRef').value }));
$('#jsonRead').addEventListener('click', (e) => runImport(e.currentTarget, '/api/import/sheet', { text: $('#jsonText').value }));
$('#sheetFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 1_000_000) { toast('That file is too large to be a character sheet.', 'bad'); return; }
  await runImport($('#jsonRead'), '/api/import/sheet', { text: await file.text() });
});
// Typing over an imported number means the imported current HP no longer applies.
jf.maxHp.addEventListener('input', () => { jf.hp.value = ''; });

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(joinForm));
  try { localStorage.setItem('battlebox:name', d.playerName); } catch { /* private mode */ }
  send('join', { playerName: d.playerName, character: { name: d.name, maxHp: d.maxHp, hp: d.hp, tempHp: d.tempHp, ac: d.ac, initMod: d.initMod } });
});

function renderJoin() {
  $('#joinTable').textContent = `${S.name} · ${S.code}`;
  $('#returning').hidden = !S.claimable.length;
  $('#claimables').replaceChildren(...S.claimable.map((c) => h('button', {
    class: 'option', type: 'button',
    onclick: () => send('claim', { id: c.id, playerName: jf.playerName.value }),
  }, c.name, c.playerName ? h('span', { class: 'muted' }, ` · ${c.playerName}`) : null)));
}

// ---------- dice pad (static controls, local settings) ----------

const pad = { label: 'Attack', mode: null, count: 1, mod: 0 };
try { Object.assign(pad, JSON.parse(localStorage.getItem(`battlebox:pad:${code}`) || '{}')); } catch { /* defaults */ }
const savePad = () => { try { localStorage.setItem(`battlebox:pad:${code}`, JSON.stringify(pad)); } catch { /* private mode */ } };

function seg(root, options, get, set) {
  const draw = () => root.replaceChildren(...options.map(([value, label]) => h('button', {
    type: 'button', 'aria-pressed': String(get() === value), onclick: () => { set(value); savePad(); draw(); },
  }, label)));
  draw();
}
seg($('#labelSeg'), [['Attack', 'Attack'], ['Damage', 'Damage'], ['Save', 'Save'], ['Check', 'Check']], () => pad.label, (v) => { pad.label = v; });
seg($('#modeSeg'), [[null, 'Normal'], ['adv', 'Advantage'], ['dis', 'Disadvantage']], () => pad.mode, (v) => { pad.mode = v; });

function drawSteppers() {
  $('#countOut').textContent = pad.count;
  $('#modOut').textContent = fmtMod(pad.mod);
}
const step = (prop, by, min, max) => () => { pad[prop] = Math.min(max, Math.max(min, pad[prop] + by)); savePad(); drawSteppers(); };
$('#countDown').addEventListener('click', step('count', -1, 1, 12));
$('#countUp').addEventListener('click', step('count', 1, 1, 12));
$('#modDown').addEventListener('click', step('mod', -1, -20, 30));
$('#modUp').addEventListener('click', step('mod', 1, -20, 30));
drawSteppers();

$('#dicepad').append(...[20, 12, 10, 8, 6, 4].map((sides) => h('button', {
  class: `btn${sides === 20 ? ' primary' : ''}`, type: 'button',
  onclick: () => send('roll', { sides, count: pad.count, mod: pad.mod, mode: sides === 20 ? pad.mode : null, label: pad.label }),
}, `d${sides}`)));

$('#leave').addEventListener('click', () => send('leave'));

// ---------- in play ----------

function statusBanner(me) {
  const p = S.prompt;
  if (p?.status === 'open') {
    const mine = S.yourAnswer;
    return h('section', { class: 'banner' },
      h('span', { class: 'eyebrow' }, 'Secret choice · only the DM sees your answer'),
      h('h2', {}, p.text),
      p.options.map((opt, i) => h('button', {
        class: 'option', type: 'button', 'aria-pressed': String(mine?.choice === i && !mine?.text),
        onclick: () => send('answer', { choice: i }),
      }, `${'ABCD'[i]}. ${opt}`)),
      p.writeIn ? h('form', { class: 'stack', style: { gap: '8px' }, onsubmit: (e) => { e.preventDefault(); const v = e.currentTarget.elements.own.value.trim(); if (v) send('answer', { text: v }); } },
        h('label', { class: 'field' }, p.options.length ? 'Or write your own' : 'Your answer',
          h('input', { name: 'own', type: 'text', maxLength: 140, dataset: { keep: `own-${p.id}` }, placeholder: 'I cast Detect Magic on the door' })),
        h('button', { class: 'btn', type: 'submit' }, 'Send my answer')) : null,
      mine ? h('p', { style: { color: 'var(--good)', fontWeight: 600 } }, `Locked in: ${mine.text ? `“${mine.text}”` : p.options[mine.choice]}. You can change it until the DM closes the round.`) : null);
  }
  if (p?.status === 'revealed') {
    return h('section', { class: 'banner' }, h('h2', {}, 'The answers are up.'), h('p', { class: 'muted' }, 'Look at the table screen.'));
  }
  if (S.phase === 'lobby') {
    return h('section', { class: 'banner' }, h('h2', {}, "You're in."), h('p', { class: 'muted' }, 'Watch the table screen. Your phone will ask for a roll when the fight starts.'));
  }
  if (!me.init) {
    return h('section', { class: 'banner' },
      h('span', { class: 'eyebrow' }, S.phase === 'combat' ? 'The fight is already on' : 'Roll for initiative'),
      h('button', { class: 'btn primary big', type: 'button', id: 'rollInit', style: { minHeight: '96px', fontSize: '24px' }, onclick: () => send('roll_init') }, `Roll initiative (d20 ${fmtMod(me.initMod)})`));
  }
  if (S.phase === 'initiative') {
    const waiting = S.combatants.filter((c) => c.kind === 'pc' && !c.init).length;
    return h('section', { class: 'banner' },
      h('span', { class: 'eyebrow' }, 'Your initiative'),
      h('h2', {}, `${me.init.total}`, me.init.roll ? h('span', { class: 'muted', style: { fontSize: '16px', fontFamily: 'var(--body)' } }, `  rolled ${me.init.roll} ${fmtMod(me.initMod)}`) : null),
      h('p', { class: 'muted' }, waiting ? `Waiting for ${waiting} more.` : 'Everyone has rolled. Waiting for the DM.'));
  }
  if (S.turnId === me.id) {
    return h('section', { class: 'banner yours' },
      h('span', { style: { fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: '12px' } }, `Round ${S.round}`),
      h('h2', {}, "It's your turn!"),
      h('button', { class: 'btn big', type: 'button', id: 'endTurn', onclick: () => send('end_turn') }, 'End my turn'));
  }
  const ids = S.order;
  const at = ids.indexOf(S.turnId);
  const mineAt = ids.indexOf(me.id);
  const away = at < 0 || mineAt < 0 ? null : (mineAt - at + ids.length) % ids.length;
  const acting = S.combatants.find((c) => c.id === S.turnId);
  return h('section', { class: 'banner' },
    h('span', { class: 'eyebrow' }, `Round ${S.round}`),
    h('h2', {}, acting ? `${acting.name} is acting` : 'An unseen foe acts…'),
    away ? h('p', { class: 'muted' }, away === 1 ? 'You are up next. Get ready.' : `You are up in ${away} turns.`) : null);
}

function render() {
  const me = S.you && S.combatants.find((c) => c.id === S.you);
  document.title = `${me ? me.name : 'Join'} · ${S.code}`;
  if (!me) { wasMyTurn = false; show('joinView'); renderJoin(); return; }
  show('playView');
  $('#meTable').textContent = `${S.name} · ${S.code}`;
  $('#meName').textContent = me.name;
  $('#meHp').replaceChildren(String(me.hp), h('small', {}, ` / ${me.maxHp}${me.tempHp ? ` +${me.tempHp}` : ''}`));
  $('#meAc').textContent = `AC ${me.ac}`;
  $('#meBar').replaceChildren(hpBar(me));
  $('#meChips').replaceChildren(...[conditionChips(me)].filter(Boolean));
  rerender($('#status'), () => statusBanner(me));

  const myTurn = S.phase === 'combat' && S.turnId === me.id;
  if (myTurn && !wasMyTurn) navigator.vibrate?.([180, 90, 180]);
  wasMyTurn = myTurn;
}
