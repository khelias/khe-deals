import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanTexts, REMOVED_TEXT, stripLinks } from '../src/scan.ts';
import { CAPS, emptyState, trim } from '../src/state.ts';

test('links off the two Hinnavaatlus hosts are removed', () => {
  assert.equal(stripLinks('https://foorum.hinnavaatlus.ee/viewtopic.php?t=1 ja https://www.hinnavaatlus.ee/search/?query=x'), 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=1 ja https://www.hinnavaatlus.ee/search/?query=x');
  assert.equal(stripLinks('vaata http://foorum.hinnavaatlus.ee/x'), 'vaata (link eemaldatud)');
  assert.equal(stripLinks('https://foorum.hinnavaatlus.ee.evil.com/x'), '(link eemaldatud)');
  assert.equal(stripLinks('kirjuta t.me/abc või www.example.com'), 'kirjuta (link eemaldatud) või (link eemaldatud)');
  assert.equal(stripLinks('G.Skill Trident Z5, i5-14500'), 'G.Skill Trident Z5, i5-14500');
  assert.equal(stripLinks('maksa ette: pay-deal.cc, scam.ai, x.dev, shop.pl'), 'maksa ette: (link eemaldatud), (link eemaldatud), (link eemaldatud), (link eemaldatud)');
  assert.equal(stripLinks('tg://resolve?domain=x'), '(link eemaldatud)');
});

test('a scan hit replaces only its own text', async () => {
  const out = await cleanTexts(['hea', 'halb'], async (t) => t.map((x) => x === 'halb'));
  assert.deepEqual(out, ['hea', REMOVED_TEXT]);
});

test('state lists stay capped', () => {
  const s = emptyState();
  s.seen = Array.from({ length: CAPS.seen + 10 }, (_, i) => `hv:${i}`);
  for (let i = 1; i <= CAPS.alerts + 5; i++) s.alerts[String(i)] = { owner: 'operator', chatId: '1', messageId: i, key: '', watch: '', title: '', url: '', item: '', asking_eur: null, effective_eur: null, at: '' };
  trim(s);
  assert.equal(s.seen.length, CAPS.seen);
  assert.equal(s.seen[0], 'hv:10');
  assert.equal(Object.keys(s.alerts).length, CAPS.alerts);
  assert.ok(!s.alerts['5'] && s.alerts['6']);
});
