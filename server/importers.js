// Turning other people's data into the four numbers combat needs: max HP, AC, initiative modifier, name.
import { UserError } from './rooms.js';

const abilityMod = (score) => Math.floor((Number(score) - 10) / 2);
const STATS = ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma'];
const num = (...vals) => { for (const v of vals) { const n = Number(v); if (v !== null && v !== undefined && v !== '' && Number.isFinite(n)) return n; } return undefined; };

/** Accepts a D&D Beyond character URL or a bare character id. */
export function ddbCharacterId(ref) {
  const s = String(ref ?? '').trim();
  const m = s.match(/characters\/(\d{3,12})/) || s.match(/^(\d{3,12})$/);
  if (!m) throw new UserError('Paste a D&D Beyond character link, like dndbeyond.com/characters/12345678.');
  return m[1];
}

/**
 * Best-effort read of D&D Beyond's character JSON (the unofficial character-service format).
 * HP and initiative are derived the way the sheet does it; AC covers armour, shields, flat bonuses
 * and unarmoured defence, but unusual features can be missed, so callers should let the player confirm.
 */
export function parseDdbCharacter(raw) {
  const c = raw?.data ?? raw;
  if (!c || typeof c !== 'object' || !Array.isArray(c.stats)) throw new UserError('That does not look like a D&D Beyond character.');

  const equipped = (c.inventory || []).filter((i) => i?.equipped);
  const equippedIds = new Set(equipped.map((i) => i.definition?.id));
  const mods = [];
  for (const [source, list] of Object.entries(c.modifiers || {})) {
    for (const m of Array.isArray(list) ? list : []) {
      if (source === 'item' && !equippedIds.has(m.componentId)) continue; // unequipped gear grants nothing
      mods.push(m);
    }
  }
  const val = (m) => num(m.value, m.fixedValue) ?? 0;
  const bonus = (subType) => mods.filter((m) => m.type === 'bonus' && m.subType === subType).reduce((s, m) => s + val(m), 0);
  const sets = (subType) => mods.filter((m) => m.type === 'set' && m.subType === subType);

  const score = (i) => {
    const id = i + 1;
    const override = num(c.overrideStats?.find((s) => s.id === id)?.value);
    if (override) return override;
    const base = (num(c.stats.find((s) => s.id === id)?.value) ?? 10)
      + (num(c.bonusStats?.find((s) => s.id === id)?.value) ?? 0)
      + bonus(`${STATS[i]}-score`);
    return Math.max(base, ...sets(`${STATS[i]}-score`).map(val));
  };
  const dex = abilityMod(score(1));
  const con = abilityMod(score(2));

  const classes = (c.classes || []).filter((k) => k?.level);
  const level = classes.reduce((s, k) => s + k.level, 0) || 1;

  const override = num(c.overrideHitPoints);
  const maxHp = Math.max(1, override
    ?? (num(c.baseHitPoints) ?? 1) + con * level + (num(c.bonusHitPoints) ?? 0) + bonus('hit-points-per-level') * level);
  const hp = Math.max(0, Math.min(maxHp, maxHp - (num(c.removedHitPoints) ?? 0)));

  let body = null;
  let shield = 0;
  for (const item of equipped) {
    const d = item.definition || {};
    if (!d.armorClass || (d.filterType && d.filterType !== 'Armor')) continue;
    if (d.armorTypeId === 4) shield = Math.max(shield, d.armorClass);
    else if (!body || d.armorClass > body.armorClass) body = d;
  }
  let ac;
  if (body) {
    const dexPart = body.armorTypeId === 1 ? dex : body.armorTypeId === 2 ? Math.min(dex, 2) : 0;
    ac = body.armorClass + dexPart + bonus('armored-armor-class');
  } else {
    ac = 10 + dex;
    for (const m of sets('unarmored-armor-class')) {
      const extra = m.statId ? abilityMod(score(m.statId - 1)) : 0;
      ac = Math.max(ac, 10 + dex + extra + val(m));
    }
    ac += bonus('unarmored-armor-class');
  }
  ac += shield + bonus('armor-class');

  return {
    name: String(c.name || 'Adventurer').slice(0, 40),
    maxHp,
    hp,
    tempHp: num(c.temporaryHitPoints) ?? 0,
    ac,
    initMod: dex + bonus('initiative'),
    summary: classes.map((k) => `${k.definition?.name ?? 'Class'} ${k.level}`).join(' / ') || `Level ${level}`,
    source: 'D&D Beyond',
    note: 'Imported from D&D Beyond. Check AC against your sheet: unusual features can be missed.',
  };
}

/** A hand-written sheet: { name, maxHp, ac, initMod } with a few common aliases, or dex instead of initMod. */
export function parseSimpleCharacter(o) {
  if (!o || typeof o !== 'object') throw new UserError('Expected a JSON object.');
  const maxHp = num(o.maxHp, o.max_hp, o.hitPoints, o.hit_points, o.hp);
  const ac = num(o.ac, o.armorClass, o.armor_class);
  if (!o.name || maxHp === undefined) throw new UserError('That JSON needs at least "name" and "maxHp".');
  const dexScore = num(o.dex, o.dexterity);
  return {
    name: String(o.name).slice(0, 40),
    maxHp,
    hp: num(o.currentHp, o.current_hp) ?? maxHp,
    tempHp: 0,
    ac: ac ?? 10,
    initMod: num(o.initMod, o.initiative, o.init) ?? (dexScore !== undefined ? abilityMod(dexScore) : 0),
    summary: o.class ? String(o.class).slice(0, 40) : '',
    source: 'JSON',
    note: '',
  };
}

export function parseCharacterJson(textValue) {
  let data;
  try { data = JSON.parse(String(textValue)); } catch { throw new UserError('That is not valid JSON.'); }
  const inner = data?.data ?? data;
  if (Array.isArray(inner?.stats) && ('baseHitPoints' in inner || 'classes' in inner)) return parseDdbCharacter(data);
  return parseSimpleCharacter(inner);
}

/** Open5e monster (v1) or creature (v2) to an enemy stat line. */
export function mapOpen5eMonster(m) {
  const acRaw = Array.isArray(m.armor_class) ? m.armor_class[0]?.value : m.armor_class;
  const dexScore = num(m.dexterity, m.ability_scores?.dexterity) ?? 10;
  return {
    name: String(m.name ?? 'Monster').slice(0, 40),
    maxHp: num(m.hit_points) ?? 1,
    ac: num(acRaw) ?? 10,
    initMod: abilityMod(dexScore),
    cr: String(m.challenge_rating ?? m.challenge_rating_text ?? m.challenge_rating_decimal ?? '?'),
    type: [m.size?.name ?? m.size, m.type?.name ?? m.type].filter((x) => typeof x === 'string' && x).join(' '),
    source: m.document__title ?? m.document?.name ?? '',
  };
}
