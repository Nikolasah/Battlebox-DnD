import test from 'node:test';
import assert from 'node:assert/strict';
import { ddbCharacterId, parseDdbCharacter, parseCharacterJson, mapOpen5eMonster } from '../server/importers.js';

const stats = (...v) => v.map((value, i) => ({ id: i + 1, value }));
const none = () => [1, 2, 3, 4, 5, 6].map((id) => ({ id, value: null }));

// Shaped like D&D Beyond's character-service JSON, trimmed to the fields the importer reads.
const fighter = {
  success: true,
  data: {
    name: 'Garrick',
    stats: stats(16, 14, 14, 10, 12, 8),
    bonusStats: none(),
    overrideStats: none(),
    baseHitPoints: 34, bonusHitPoints: null, overrideHitPoints: null, removedHitPoints: 6, temporaryHitPoints: 0,
    classes: [{ level: 5, definition: { name: 'Fighter' } }],
    inventory: [
      { equipped: true, definition: { id: 1, filterType: 'Armor', armorClass: 14, armorTypeId: 2, name: 'Breastplate' } },
      { equipped: true, definition: { id: 2, filterType: 'Armor', armorClass: 2, armorTypeId: 4, name: 'Shield' } },
      { equipped: false, definition: { id: 3, filterType: 'Armor', armorClass: 18, armorTypeId: 3, name: 'Plate' } },
      { equipped: false, definition: { id: 4, filterType: 'Wondrous item', name: 'Ring of Protection' } },
    ],
    modifiers: {
      race: [{ type: 'bonus', subType: 'constitution-score', value: 2 }],
      class: [{ type: 'bonus', subType: 'armored-armor-class', value: 1 }], // Defense fighting style
      feat: [{ type: 'bonus', subType: 'initiative', value: 5 }],            // Alert
      item: [{ type: 'bonus', subType: 'armor-class', value: 1, componentId: 4 }], // not equipped: ignored
      background: [], condition: [],
    },
  },
};

test('D&D Beyond: HP from base + CON per level, medium armour caps DEX, shield and style apply', () => {
  const c = parseDdbCharacter(fighter);
  assert.equal(c.name, 'Garrick');
  assert.equal(c.maxHp, 34 + 3 * 5, 'CON 14 + 2 racial = 16, +3 per level');
  assert.equal(c.hp, 43, 'six damage already taken');
  assert.equal(c.ac, 14 + 2 + 2 + 1, 'breastplate + DEX (max 2) + shield + Defense');
  assert.equal(c.initMod, 2 + 5);
  assert.equal(c.summary, 'Fighter 5');
});

test('D&D Beyond: unarmoured defence adds the second ability', () => {
  const monk = {
    name: 'Wren', stats: stats(10, 16, 12, 10, 16, 8), baseHitPoints: 20, removedHitPoints: 0,
    classes: [{ level: 3, definition: { name: 'Monk' } }], inventory: [],
    modifiers: { class: [{ type: 'set', subType: 'unarmored-armor-class', statId: 5, value: null }] },
  };
  const c = parseDdbCharacter(monk);
  assert.equal(c.ac, 10 + 3 + 3);
  assert.equal(c.maxHp, 23);
});

test('D&D Beyond: an HP override wins', () => {
  const c = parseDdbCharacter({ ...fighter.data, overrideHitPoints: 60 });
  assert.equal(c.maxHp, 60);
});

test('pasted JSON: detects D&D Beyond exports and plain hand-written sheets', () => {
  assert.equal(parseCharacterJson(JSON.stringify(fighter)).source, 'D&D Beyond');
  const simple = parseCharacterJson('{"name":"Ilyra","maxHp":24,"ac":12,"dex":16}');
  assert.deepEqual([simple.name, simple.maxHp, simple.ac, simple.initMod], ['Ilyra', 24, 12, 3]);
  assert.throws(() => parseCharacterJson('{nope'), /not valid JSON/);
  assert.throws(() => parseCharacterJson('{"name":"x"}'), /maxHp/);
});

test('character links and ids', () => {
  assert.equal(ddbCharacterId('https://www.dndbeyond.com/characters/48690485/AbCdEf'), '48690485');
  assert.equal(ddbCharacterId(' 48690485 '), '48690485');
  assert.throws(() => ddbCharacterId('https://example.com/evil'), /character link/);
});

test('Open5e monsters map in both API shapes', () => {
  const v1 = mapOpen5eMonster({ name: 'Goblin', size: 'Small', type: 'humanoid', armor_class: 15, hit_points: 7, dexterity: 14, challenge_rating: '1/4', document__title: '5e Core Rules' });
  assert.deepEqual(v1, { name: 'Goblin', maxHp: 7, ac: 15, initMod: 2, cr: '1/4', type: 'Small humanoid', source: '5e Core Rules' });
  const v2 = mapOpen5eMonster({ name: 'Goblin', armor_class: 15, hit_points: 7, ability_scores: { dexterity: 14 }, challenge_rating_text: '1/4', size: { name: 'Small' }, type: { name: 'Humanoid' }, document: { name: 'SRD' } });
  assert.deepEqual([v2.maxHp, v2.ac, v2.initMod, v2.cr, v2.type, v2.source], [7, 15, 2, '1/4', 'Small Humanoid', 'SRD']);
});
