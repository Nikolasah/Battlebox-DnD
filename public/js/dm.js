import { h, $, roomCode, connect, api, toast, rerender, hpBar, conditionChips, rollCard, fmtMod, BAND_LABEL } from './common.js';

const code = roomCode();
const token = location.hash.slice(1);
let S = null;          // latest state from the server
let confirmEnd = false; // "End combat" asks twice

const conn = connect({ role: 'dm', code, token }, {
  state: (m) => { S = m.state; $('#app').hidden = false; render(); },
  event: (m) => showRoll(m.event),
  status: (on) => { $('#offline').hidden = on; },
  denied: () => block('This DM link does not work'),
  gone: () => block('This table no longer exists'),
});
const send = (type, payload) => conn.send(type, payload);

function block(title) {
  $('#app').hidden = true;
  $('#blockedTitle').textContent = title;
  $('#blocked').hidden = false;
}

// ---------- static controls ----------

$('#code').textContent = code;
$('#openTable').href = `/table/${code}`;
$('#copyLink').addEventListener('click', async () => {
  const link = `${location.origin}/play/${code}`;
  try { await navigator.clipboard.writeText(link); toast('Player link copied.', 'good'); } catch { toast(link); }
});

const formData = (form) => Object.fromEntries(new FormData(form));

$('#enemyForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  send('add_enemy', { ...formData(e.currentTarget), hidden: f.hidden.checked });
  f.name.value = '';
  f.count.value = 1;
  f.name.focus();
});

$('#pcForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send('add_pc', formData(e.currentTarget));
  e.currentTarget.reset();
});

// Sheet files: each one is read by the server, then added, or used to refresh the character of the same name.
$('#sheetFiles').addEventListener('change', async (e) => {
  const input = e.currentTarget;
  const added = []; const updated = []; const failed = [];
  const known = new Set((S?.combatants || []).filter((c) => c.kind === 'pc').map((c) => c.name.toLowerCase()));
  for (const file of [...input.files]) {
    try {
      if (file.size > 1_000_000) throw new Error('too large');
      const c = await api('/api/import/sheet', { text: await file.text() });
      (known.has(c.name.toLowerCase()) ? updated : added).push(c.name);
      known.add(c.name.toLowerCase());
      send('import_pc', c);
    } catch (err) {
      failed.push(`${file.name}: ${err.message}`);
    }
  }
  input.value = '';
  const parts = [added.length ? `Added ${added.join(', ')}` : '', updated.length ? `Updated ${updated.join(', ')}` : '', ...failed].filter(Boolean);
  toast(parts.join(' · '), failed.length ? 'bad' : 'good');
});

$('#promptForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget.elements;
  send('prompt_open', { text: f.text.value, options: [f.o0.value, f.o1.value, f.o2.value, f.o3.value], writeIn: f.writeIn.checked });
});

$('#enemyHp').addEventListener('change', (e) => send('setting', { key: 'enemyHp', value: e.target.value }));

$('#dmDice').append(...[20, 12, 10, 8, 6, 4, 100].map((sides) => h('button', {
  class: 'btn sm', type: 'button',
  onclick: () => send('roll', { sides, count: $('#dmCount').value, mod: $('#dmMod').value, private: !$('#dmPublic').checked }),
}, `d${sides}`)));

// Monster lookup fills the enemy form; the DM still chooses the count and whether it starts hidden.
let searchTimer;
$('#monsterQ').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const box = $('#monsterResults');
  if (q.length < 2) { box.replaceChildren(); return; }
  searchTimer = setTimeout(async () => {
    box.replaceChildren(h('p', { class: 'muted small' }, 'Searching…'));
    try {
      const { results } = await api(`/api/monsters?q=${encodeURIComponent(q)}`);
      if ($('#monsterQ').value.trim() !== q) return;
      box.replaceChildren(...(results.length ? results.map(monsterResult) : [h('p', { class: 'muted small' }, 'No matches. Add it by hand above.')]));
    } catch (err) {
      box.replaceChildren(h('p', { class: 'muted small' }, err.message));
    }
  }, 350);
});
function monsterResult(m) {
  return h('div', { class: 'result' },
    h('div', { class: 'grow' },
      h('div', { style: { fontWeight: 600 } }, m.name),
      h('div', { class: 'muted small' }, `CR ${m.cr} · HP ${m.maxHp} · AC ${m.ac} · Init ${fmtMod(m.initMod)}${m.source ? ` · ${m.source}` : ''}`)),
    h('button', { class: 'btn sm', type: 'button', onclick: () => {
      const f = $('#enemyForm').elements;
      f.name.value = m.name; f.maxHp.value = m.maxHp; f.ac.value = m.ac; f.initMod.value = m.initMod;
      f.count.focus(); f.count.select();
    } }, 'Use'));
}

// ---------- edit dialog ----------

let editing = null;
function openEdit(c) {
  editing = c.id;
  const f = $('#editForm').elements;
  $('#editDlg').returnValue = '';
  $('#editTitle').textContent = `Edit ${c.name}`;
  f.name.value = c.name; f.hp.value = c.hp; f.maxHp.value = c.maxHp; f.tempHp.value = c.tempHp;
  f.ac.value = c.ac; f.initMod.value = c.initMod; f.init.value = c.init ? c.init.total : '';
  $('#editDlg').showModal();
}
$('#editDlg').addEventListener('close', () => {
  if ($('#editDlg').returnValue !== 'save' || !editing) return;
  const d = formData($('#editForm'));
  // Max HP goes first so a raised maximum does not clip the new current HP.
  send('update', { id: editing, patch: { name: d.name, maxHp: d.maxHp, hp: d.hp, tempHp: d.tempHp, ac: d.ac, initMod: d.initMod, init: d.init === '' ? null : d.init } });
});
$('#editCancel').addEventListener('click', () => $('#editDlg').close('cancel'));
$('#editRemove').addEventListener('click', () => { send('remove', { id: editing }); $('#editDlg').close('cancel'); });

// ---------- live rendering ----------

function sorted() {
  const byId = new Map(S.combatants.map((c) => [c.id, c]));
  if (S.phase === 'lobby') return [...S.combatants].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'pc' ? -1 : 1));
  const inOrder = S.order.map((id) => byId.get(id));
  return [...inOrder, ...S.combatants.filter((c) => !c.init)];
}

function phaseBar() {
  const pcs = S.combatants.filter((c) => c.kind === 'pc');
  const foes = S.combatants.length - pcs.length;
  if (S.phase === 'lobby') {
    return [
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, 'Setting up'),
        h('div', { class: 'muted small' }, `${pcs.length} character${pcs.length === 1 ? '' : 's'}, ${foes} enem${foes === 1 ? 'y' : 'ies'}. Players can still join mid-fight.`)),
      h('button', { class: 'btn primary', type: 'button', disabled: !S.combatants.length, onclick: () => send('call_init') }, 'Call for initiative'),
    ];
  }
  if (S.phase === 'initiative') {
    const waiting = S.combatants.filter((c) => !c.init);
    return [
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, 'Rolling initiative'),
        h('div', { class: 'muted small' }, waiting.length ? `Waiting for ${waiting.map((c) => c.name).join(', ')}` : 'Everyone has rolled.')),
      waiting.length ? h('button', { class: 'btn', type: 'button', onclick: () => send('roll_rest') }, 'Roll for the rest') : null,
      h('button', { class: 'btn primary', type: 'button', disabled: !S.order.length, onclick: () => send('start') }, 'Start combat'),
    ];
  }
  const current = S.combatants.find((c) => c.id === S.turnId);
  return [
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, `Round ${S.round} · ${current ? `${current.name}'s turn` : 'no one acting'}`),
      h('div', { class: 'muted small' }, current?.hidden ? 'Hidden enemy: the table sees “an unseen foe acts”.' : 'Players can end their own turn from their phone.')),
    h('button', { class: 'btn', type: 'button', onclick: () => send('prev') }, 'Back'),
    h('button', { class: 'btn primary', type: 'button', id: 'nextTurn', onclick: () => send('next') }, 'Next turn'),
    confirmEnd
      ? h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmEnd = false; send('end'); } }, 'Confirm: end and clear enemies')
      : h('button', { class: 'btn danger', type: 'button', onclick: () => { confirmEnd = true; render(); setTimeout(() => { confirmEnd = false; render(); }, 4000); } }, 'End combat'),
  ];
}

function row(c) {
  const amount = h('input', {
    type: 'number', min: 0, inputMode: 'numeric', placeholder: '0', dataset: { keep: `amt-${c.id}` }, 'aria-label': `Hit point change for ${c.name}`,
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(e.shiftKey ? 1 : -1); } },
  });
  const apply = (sign) => {
    const n = Math.abs(parseInt(amount.value, 10));
    if (!n) return amount.focus();
    amount.value = '';
    send('hp', { id: c.id, delta: sign * n });
  };
  const missing = S.conditions.filter((name) => !c.conditions.includes(name));
  const initCell = c.init
    ? h('div', { class: 'initbadge', title: c.init.roll ? `Rolled ${c.init.roll} ${fmtMod(c.initMod)}` : 'Set by hand' }, c.init.total)
    : S.phase === 'lobby'
      ? h('div', { class: 'initbadge none' }, '—')
      : h('button', { class: 'btn sm', type: 'button', title: `Roll initiative for ${c.name}`, onclick: () => send('roll_for', { id: c.id }) }, 'Roll');

  return h('div', { class: `crow${S.turnId === c.id ? ' turn' : ''}${c.kind === 'enemy' && c.hp <= 0 ? ' dead' : ''}${c.hidden ? ' is-hidden' : ''}`, dataset: { id: c.id } },
    initCell,
    h('div', {},
      h('div', { class: 'cname' },
        c.kind === 'pc' ? h('span', { class: `dot${c.connected ? ' on' : ''}`, title: c.connected ? 'Phone connected' : 'No phone connected' }) : null,
        h('span', {}, c.name),
        h('span', { class: `kind ${c.kind}` }, c.kind === 'pc' ? 'Player' : 'Enemy'),
        c.hidden ? h('span', { class: 'kind enemy' }, 'Hidden') : null),
      h('div', { class: 'muted small' }, [c.playerName, `AC ${c.ac}`, `Init ${fmtMod(c.initMod)}`].filter(Boolean).join(' · '))),
    h('div', { class: 'hpcell' },
      h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '6px' } },
        h('span', { class: 'hpnum' }, c.hp, h('small', {}, ` / ${c.maxHp}`, c.tempHp ? ` +${c.tempHp} temp` : '')),
        c.band !== 'healthy' ? h('span', { class: `badge ${c.band}` }, BAND_LABEL[c.band]) : null),
      hpBar(c)),
    h('div', { class: 'dmg' },
      amount,
      h('button', { class: 'btn hit', type: 'button', title: 'Damage (Enter)', onclick: () => apply(-1) }, 'Damage'),
      h('button', { class: 'btn heal', type: 'button', title: 'Heal (Shift+Enter)', onclick: () => apply(1) }, 'Heal')),
    h('div', { class: 'extras' },
      conditionChips(c, (name) => send('condition', { id: c.id, name, on: false })),
      h('select', { 'aria-label': `Add a condition to ${c.name}`, onchange: (e) => { if (e.target.value) send('condition', { id: c.id, name: e.target.value, on: true }); } },
        h('option', { value: '' }, '+ Condition'), missing.map((name) => h('option', { value: name }, name))),
      h('span', { class: 'grow' }),
      c.kind === 'enemy' ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => send('update', { id: c.id, patch: { hidden: !c.hidden } }) }, c.hidden ? 'Reveal to table' : 'Hide') : null,
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openEdit(c) }, 'Edit')));
}

function promptLive() {
  const p = S.prompt;
  const pcs = S.combatants.filter((c) => c.kind === 'pc');
  const answered = Object.keys(p.answers).length;
  return [
    h('div', {},
      h('span', { class: 'eyebrow' }, p.status === 'open' ? `Live on phones · ${answered} of ${pcs.length} answered` : 'Revealed on the table screen'),
      h('p', { style: { fontWeight: 600, fontSize: '16px', marginTop: '4px' } }, p.text)),
    h('div', { class: 'answers' }, pcs.map((c) => {
      const a = p.answers[c.id];
      return h('div', {}, h('b', {}, c.name), a ? h('span', {}, a.text ? `“${a.text}”` : p.options[a.choice]) : h('span', { class: 'muted' }, 'Still answering'));
    })),
    p.status === 'open'
      ? h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => send('prompt_close', { reveal: true }) }, 'Reveal on table'),
        h('button', { class: 'btn', type: 'button', onclick: () => send('prompt_close', { reveal: false }) }, 'Close, keep secret'))
      : h('button', { class: 'btn', type: 'button', onclick: () => send('prompt_clear') }, 'Clear from table'),
  ];
}

function render() {
  document.title = `${S.name} · DM · BattleBox`;
  $('#roomName').textContent = S.name;
  $('#enemyHp').value = S.settings.enemyHp;
  rerender($('#phasebar'), phaseBar);
  rerender($('#clist'), () => (S.combatants.length
    ? sorted().map(row)
    : h('div', { class: 'panel muted' }, 'Nobody here yet. Share the code with your players and add enemies on the left.')));

  const hadPrompt = !$('#promptLive').hidden;
  $('#promptForm').hidden = !!S.prompt;
  $('#promptLive').hidden = !S.prompt;
  if (S.prompt) rerender($('#promptLive'), promptLive);
  else if (hadPrompt) $('#promptForm').reset();

  $('#log').replaceChildren(...[...S.log].reverse().map((l) => h('div', { class: l.dm ? 'private' : '' }, l.text, l.dm ? ' (DM only)' : '')));
}

function showRoll(ev) {
  // The newest three stay put: the DM often needs a player's total a moment after it was rolled.
  $('#noRolls').hidden = true;
  $('#rolls').prepend(rollCard(ev));
  while ($('#rolls').children.length > 3) $('#rolls').lastChild.remove();
}

// N advances the turn when the DM is not typing in a field.
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || $('#editDlg').open) return;
  if (S?.phase === 'combat') send('next');
});
