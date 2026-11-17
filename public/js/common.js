// Shared by all three screens: DOM builder, live connection, and the pieces each screen draws the same way.

/** Build an element. Text always goes in as text nodes, so names typed by players can never inject markup. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && !['list', 'form', 'type'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const roomCode = () => (location.pathname.split('/')[2] || '').toUpperCase();
export const fmtMod = (m) => (m >= 0 ? `+${m}` : `−${Math.abs(m)}`);
export const BAND_LABEL = { healthy: 'Healthy', bloodied: 'Bloodied', critical: 'Critical', down: 'Down' };

let toastTimer;
export function toast(message, kind = 'info') {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3800);
}

/** Live connection that reconnects by itself and re-identifies each time. */
export function connect(hello, handlers) {
  let ws;
  let delay = 600;
  function open() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { delay = 600; ws.send(JSON.stringify({ type: 'hello', ...hello })); handlers.status?.(true); };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'error') toast(m.message, 'bad');
      handlers[m.type]?.(m);
    };
    ws.onclose = () => { handlers.status?.(false); setTimeout(open, delay); delay = Math.min(delay * 1.7, 5000); };
  }
  open();
  return {
    send(type, payload = {}) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type, ...payload }));
      else toast('Reconnecting… try again in a moment.', 'bad');
    },
  };
}

export async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

/** Re-render a region without losing what someone is typing in it. Inputs opt in with data-keep="unique-key". */
export function rerender(root, build) {
  const kept = new Map();
  let focusKey = null;
  let caret = null;
  for (const el of root.querySelectorAll('[data-keep]')) {
    kept.set(el.dataset.keep, el.value);
    if (el === document.activeElement) { focusKey = el.dataset.keep; try { caret = el.selectionStart; } catch { /* number inputs */ } }
  }
  const scroll = root.scrollTop;
  root.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
  for (const el of root.querySelectorAll('[data-keep]')) {
    if (kept.has(el.dataset.keep)) el.value = kept.get(el.dataset.keep);
    if (el.dataset.keep === focusKey) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* number inputs */ } }
  }
  root.scrollTop = scroll;
}

export function hpBar(c) {
  const known = c.hp !== undefined;
  const pct = known ? Math.round((c.hp / c.maxHp) * 100) : { healthy: 100, bloodied: 50, critical: 22, down: 0 }[c.band];
  const label = known ? `${c.hp} of ${c.maxHp} hit points` : BAND_LABEL[c.band];
  return h('div', { class: `hpbar ${c.band}${known ? '' : ' coarse'}`, role: 'img', 'aria-label': label },
    h('div', { class: 'fill', style: { width: `${pct}%` } }),
    c.tempHp ? h('div', { class: 'temp', style: { width: `${Math.min(100, Math.round((c.tempHp / c.maxHp) * 100))}%` } }) : null);
}

export function conditionChips(c, onRemove) {
  if (!c.conditions?.length) return null;
  return h('div', { class: 'chips' }, c.conditions.map((name) => (onRemove
    ? h('button', { class: 'chip', type: 'button', title: `Remove ${name}`, onclick: () => onRemove(name) }, name, h('span', { 'aria-hidden': 'true' }, ' ×'))
    : h('span', { class: 'chip' }, name))));
}

// ---------- dice ----------

/** One die that tumbles through random faces, then lands on its real value. */
export function dieEl(die, { delay = 0, duration = 900 } = {}) {
  const face = h('span', { class: 'face' }, '?');
  const el = h('span', { class: `die d${die.sides} rolling${die.dropped ? ' dropped' : ''}` }, face);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const land = () => {
    face.textContent = die.value;
    el.classList.remove('rolling');
    el.classList.add('landed');
    if (die.sides === 20 && !die.dropped) el.classList.add(die.value === 20 ? 'crit' : die.value === 1 ? 'fumble' : 'plain');
  };
  if (reduce) { land(); return el; }
  const spin = setInterval(() => { face.textContent = 1 + Math.floor(Math.random() * die.sides); }, 70);
  setTimeout(() => { clearInterval(spin); land(); }, delay + duration);
  return el;
}

/** A whole roll: who, what for, the dice, the modifier, and the total revealed once the dice land. */
export function rollCard(ev) {
  const settle = 900 + (ev.dice.length - 1) * 120;
  const total = h('strong', { class: 'total' }, '…');
  setTimeout(() => { total.textContent = ev.total; total.classList.add('shown'); }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : settle + 80);
  const tag = ev.mode === 'adv' ? 'Advantage' : ev.mode === 'dis' ? 'Disadvantage' : '';
  return h('div', { class: `rollcard ${ev.kind}${ev.private ? ' private' : ''}` },
    h('div', { class: 'who' }, h('b', {}, ev.who), ev.label ? ` · ${ev.label}` : '', tag ? ` · ${tag}` : '', ev.private ? ' · hidden from table' : ''),
    h('div', { class: 'dice' },
      ev.dice.map((d, i) => dieEl(d, { delay: i * 120 })),
      ev.mod ? h('span', { class: 'mod' }, fmtMod(ev.mod)) : null,
      h('span', { class: 'eq' }, '='), total));
}

/** Random key that identifies this phone to this table, kept so a refresh or a dropped call keeps your character. */
export function playerKey(code) {
  const name = `battlebox:key:${code}`;
  let key = null;
  try { key = localStorage.getItem(name); } catch { /* private mode */ }
  if (!key) {
    key = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(name, key); } catch { /* private mode */ }
  }
  return key;
}
