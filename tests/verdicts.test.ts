import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProposal, checkReply, checkVerdict, parseAnswers, parseVerdicts } from '../src/verdicts.ts';

const verdict = {
  id: 'hv:875412',
  watch: 'operator-ddr5',
  fits: true,
  item: '2x16 GB DDR5 5600 Kingston arvutis',
  asking_eur: 900,
  rest_value_eur: 650,
  effective_eur: 250,
  kind: 'ok',
  confidence: 'high',
  reason_et: 'Terve arvuti 2x16 GB DDR5-ga, ülejäänu müüdav.',
};

test('a valid verdict is accepted and extra keys are dropped', () => {
  const r = checkVerdict({ ...verdict, url: 'https://evil.example/x' });
  assert.equal(typeof r, 'object');
  assert.ok(!('url' in (r as object)));
  const { verdicts, errors } = parseVerdicts(JSON.stringify({ verdicts: [verdict] }));
  assert.equal(verdicts.length, 1);
  assert.deepEqual(errors, []);
});

test('six broken verdicts are refused', () => {
  const broken = [
    { ...verdict, fits: 'yes' },
    { ...verdict, kind: 'great' },
    { ...verdict, asking_eur: -5 },
    { ...verdict, effective_eur: '250' },
    { ...verdict, reason_et: 'x'.repeat(201) },
    { ...verdict, confidence: 'medium' },
  ];
  for (const b of broken) assert.equal(typeof checkVerdict(b), 'string', JSON.stringify(b));
  const { verdicts, errors } = parseVerdicts(JSON.stringify({ verdicts: broken }));
  assert.equal(verdicts.length, 0);
  assert.equal(errors.length, 6);
});

test('a broken verdicts file is refused whole', () => {
  assert.throws(() => parseVerdicts('[]'));
  assert.throws(() => parseVerdicts('not json'));
  assert.throws(() => parseVerdicts(JSON.stringify({ verdicts: [], pad: 'x'.repeat(70_000) })), /64 KB/);
});

test('answers: valid ones accepted, six broken ones refused', () => {
  const reply = { update_id: 1, text_et: 'Tasub küsida, kas mälu on testitud.' };
  const proposal = { update_id: 2, action: 'create', slug: 'beebikaru', fields: { name: 'Beebikäru' }, summary_et: 'Uus otsing beebikärule.' };
  const { answers, errors } = parseAnswers(JSON.stringify({ replies: [reply], proposals: [proposal] }));
  assert.equal(answers.replies.length, 1);
  assert.equal(answers.proposals.length, 1);
  assert.deepEqual(errors, []);
  const broken = [
    checkReply({ update_id: '1', text_et: 'x' }),
    checkReply({ update_id: 1, text_et: 'x'.repeat(801) }),
    checkProposal({ ...proposal, action: 'rename' }),
    checkProposal({ ...proposal, slug: 'Beebi Käru' }),
    checkProposal({ ...proposal, fields: { owner: 'partner' } }),
    checkProposal({ ...proposal, summary_et: '' }),
  ];
  for (const b of broken) assert.equal(typeof b, 'string');
  assert.throws(() => parseAnswers(JSON.stringify({ replies: [] })));
});
