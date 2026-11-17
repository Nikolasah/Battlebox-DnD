import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../server/rooms.js';

/** A die that returns the queued values in order. */
const fixed = (...values) => () => values.shift();
const room = () => R.createRoom('TEST', 'Test table');

test('turn order: highest total, then modifier, then players before enemies', () => {
  const r = room();
  const a = R.addPc(r, { name: 'Slow', initMod: 0 }, 'k1');
  const b = R.addPc(r, { name: 'Quick', initMod: 3 }, 'k2');
  const [g] = R.addEnemies(r, { name: 'Goblin', maxHp: 7, initMod: 3 });
  R.callInitiative(r, fixed(12));            // goblin: 12 + 3 = 15
  R.rollInitiative(r, a.id, fixed(15));      // 15 + 0 = 15
  R.rollInitiative(r, b.id, fixed(12));      // 12 + 3 = 15
  assert.deepEqual(R.turnOrder(r).map((c) => c.name), ['Quick', 'Goblin', 'Slow']);
  R.startCombat(r);
  assert.equal(r.turnId, b.id);
  assert.equal(r.round, 1);
  assert.equal(g.init.total, 15);
});

test('next turn wraps into a new round and skips dead enemies but not downed players', () => {
  const r = room();
  const pc = R.addPc(r, { name: 'Hero', maxHp: 10 }, 'k1');
  const [g1, g2] = R.addEnemies(r, { name: 'Goblin', maxHp: 7, count: 2 });
  R.callInitiative(r, fixed(10, 5));
  R.rollInitiative(r, pc.id, fixed(20));
  R.startCombat(r);
  R.applyHp(r, g1.id, -7);
  R.nextTurn(r);
  assert.equal(r.turnId, g2.id, 'dead goblin 1 is skipped');
  R.applyHp(r, pc.id, -99);
  R.nextTurn(r);
  assert.equal(r.turnId, pc.id, 'a downed player still gets a turn');
  assert.equal(r.round, 2);
  R.prevTurn(r);
  assert.equal(r.turnId, g2.id);
  assert.equal(r.round, 1);
});

test('damage burns temporary hit points first; healing stops at max', () => {
  const r = room();
  const pc = R.addPc(r, { name: 'Hero', maxHp: 20 });
  R.updateCombatant(r, pc.id, { tempHp: 5 });
  R.applyHp(r, pc.id, -8);
  assert.deepEqual([pc.tempHp, pc.hp], [0, 17]);
  R.applyHp(r, pc.id, 50);
  assert.equal(pc.hp, 20);
});

test('enemies are numbered, and a second batch continues the count', () => {
  const r = room();
  R.addEnemies(r, { name: 'Wolf' });
  assert.deepEqual(r.combatants.map((c) => c.name), ['Wolf']);
  R.addEnemies(r, { name: 'Wolf', count: 2 });
  assert.deepEqual(r.combatants.map((c) => c.name), ['Wolf 1', 'Wolf 2', 'Wolf 3']);
});

test('the table never sees hidden enemies, enemy numbers, or unrevealed answers', () => {
  const r = room();
  const pc = R.addPc(r, { name: 'Hero', maxHp: 10 }, 'key-one');
  R.addEnemies(r, { name: 'Ogre', maxHp: 59, ac: 11 });
  const [lurker] = R.addEnemies(r, { name: 'Assassin', maxHp: 78, hidden: true });
  R.callInitiative(r, fixed(3, 19));
  R.rollInitiative(r, pc.id, fixed(10));
  R.startCombat(r);
  R.openPrompt(r, { text: 'Who do you trust?', options: ['The duke', 'Nobody'] });
  R.answerPrompt(r, pc.id, { choice: 1 });

  const view = R.publicView(r);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('Assassin'), 'hidden enemy name leaked');
  assert.ok(!json.includes('key-one') && !json.includes(r.dmToken), 'secret leaked');
  assert.equal(view.turnId, null);
  assert.equal(view.turnHidden, true, 'the hidden assassin is acting');
  const ogre = view.combatants.find((c) => c.name === 'Ogre');
  assert.equal(ogre.hp, undefined);
  assert.equal(ogre.band, 'healthy');
  assert.deepEqual(ogre.init, {}, 'enemy roll stays private');
  assert.deepEqual(view.prompt.answered, [pc.id]);
  assert.equal(view.prompt.answers, undefined);

  R.closePrompt(r, true);
  assert.equal(R.publicView(r).prompt.answers[pc.id].choice, 1);
  R.updateCombatant(r, lurker.id, { hidden: false });
  assert.ok(JSON.stringify(R.publicView(r)).includes('Assassin'));
});

test('keeping a prompt secret removes it and logs the answers for the DM only', () => {
  const r = room();
  const pc = R.addPc(r, { name: 'Hero' }, 'k');
  R.openPrompt(r, { text: 'Steal the gem?', options: [] });
  assert.equal(r.prompt.writeIn, true, 'no options means write-in');
  R.answerPrompt(r, pc.id, { text: 'I pocket it' });
  R.closePrompt(r, false);
  assert.equal(r.prompt, null);
  assert.ok(!JSON.stringify(R.publicView(r).log).includes('pocket'));
  assert.ok(JSON.stringify(R.dmView(r).log).includes('pocket'));
});

test('advantage keeps the higher d20 and adds the modifier', () => {
  const r = room();
  const e = R.rollDice(r, { id: 'x', name: 'Hero' }, { sides: 20, mode: 'adv', mod: 5, label: 'Attack' }, fixed(4, 17));
  assert.equal(e.total, 22);
  assert.deepEqual(e.dice.map((d) => !!d.dropped), [true, false]);
  const dmg = R.rollDice(r, { id: 'x', name: 'Hero' }, { sides: 6, count: 2, mod: 3 }, fixed(2, 5));
  assert.equal(dmg.total, 10);
});

test('removing whoever is acting passes the turn on; ending combat clears enemies', () => {
  const r = room();
  const pc = R.addPc(r, { name: 'Hero' }, 'k');
  const [g] = R.addEnemies(r, { name: 'Goblin' });
  R.callInitiative(r, fixed(20));
  R.rollInitiative(r, pc.id, fixed(1));
  R.startCombat(r);
  assert.equal(r.turnId, g.id);
  R.removeCombatant(r, g.id);
  assert.equal(r.turnId, pc.id);
  R.endCombat(r);
  assert.deepEqual([r.phase, r.combatants.length, pc.init], ['lobby', 1, null]);
});

test('a player only sees claimable characters while they have none', () => {
  const r = room();
  const pc = R.addPc(r, { name: 'Ilyra' }, 'old-key');
  assert.deepEqual(R.playerView(r, 'new-key').claimable.map((c) => c.name), ['Ilyra']);
  assert.deepEqual(R.playerView(r, 'new-key', new Set([pc.id])).claimable, [], 'not while someone is playing her');
  assert.equal(R.playerView(r, 'old-key').you, pc.id);
});

test('importing a sheet again updates the character instead of duplicating it', () => {
  const r = room();
  const first = R.upsertPc(r, { name: 'Pijo', maxHp: 21, hp: 17, ac: 12, initMod: 2 });
  assert.equal(first.created, true);
  R.setCondition(r, first.pc.id, 'Poisoned', true);
  const again = R.upsertPc(r, { name: 'pijo', maxHp: 28, hp: 28, ac: 13, initMod: 2 }, 'phone-key');
  assert.equal(again.created, false);
  assert.equal(r.combatants.length, 1);
  const pc = r.combatants[0];
  assert.deepEqual([pc.name, pc.maxHp, pc.hp, pc.ac, pc.owner], ['Pijo', 28, 28, 13, 'phone-key']);
  assert.deepEqual(pc.conditions, ['Poisoned'], 'conditions survive a re-import');
  R.upsertPc(r, { name: 'Pijo', maxHp: 28, hp: '', ac: 13, initMod: 2 });
  assert.equal(pc.hp, 28, 'a typed-in rejoin without current HP leaves HP alone');
});
