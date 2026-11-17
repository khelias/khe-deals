import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { blobSha, formatWatch, loadWatchDir, validateSet, validateWatch } from '../src/watches.ts';
import { DDR5_WATCH, watch } from './helpers.ts';

const has = (errors: string[], part: string) => assert.ok(errors.some((e) => e.includes(part)), `expected "${part}" in ${JSON.stringify(errors)}`);

test('the first watch is valid', () => {
  assert.deepEqual(validateWatch('operator-ddr5', DDR5_WATCH), []);
});

test('unknown keys are refused', () => {
  has(validateWatch('operator-x', { ...watch(), regex: 'ddr5.*' }), 'unknown key regex');
});

test('owner must be known and match the file name prefix', () => {
  has(validateWatch('operator-x', watch({ owner: 'mari' as never })), 'owner must be one of');
  has(validateWatch('operator-x', watch({ owner: 'partner' })), 'does not match owner');
  has(validateWatch('Mari-x', watch()), 'must be <owner>-<slug>.json');
  has(validateWatch('operator-X_y', watch()), 'must be <owner>-<slug>.json');
});

test('forums must be from the list', () => {
  has(validateWatch('operator-x', watch({ forums: [3, 39] })), 'forum 39 is not one of');
  has(validateWatch('operator-x', watch({ forums: [] })), 'forums must be a non-empty list');
});

test('brief must not be empty', () => {
  has(validateWatch('operator-x', watch({ brief: '  ' })), 'brief must not be empty');
});

test('keyword count and length are capped', () => {
  has(validateWatch('operator-x', watch({ include: Array.from({ length: 61 }, (_, i) => `k${i}`) })), 'more than 60 keywords');
  has(validateWatch('operator-x', watch({ include: ['x'.repeat(41)] })), 'must be 2-40 characters');
  has(validateWatch('operator-x', watch({ exclude: ['a'] })), 'must be 2-40 characters');
  has(validateWatch('operator-x', watch({ include: [] })), 'needs at least 1 keyword');
});

test('missing keys and wrong types are refused', () => {
  const { brief: _brief, ...rest } = watch();
  has(validateWatch('operator-x', rest), 'missing brief');
  has(validateWatch('operator-x', watch({ max_eur: -1 })), 'max_eur');
  has(validateWatch('operator-x', watch({ active: 'yes' as never })), 'active must be');
});

test('at most ten watches per owner', () => {
  const ids = Array.from({ length: 11 }, (_, i) => `partner-w${i}`);
  has(validateSet(ids), 'partner has 11 watches');
  assert.deepEqual(validateSet(ids.slice(1)), []);
});

test('loadWatchDir reads, checks and hashes like git', () => {
  const dir = mkdtempSync(join(tmpdir(), 'watches-'));
  const text = formatWatch(watch());
  writeFileSync(join(dir, 'operator-a.json'), text);
  writeFileSync(join(dir, 'partner-b.json'), formatWatch(watch()));
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const { watches, errors } = loadWatchDir(dir);
  assert.equal(watches.length, 1);
  assert.equal(watches[0]?.sha, blobSha(text));
  has(errors, 'partner-b.json: file name prefix partner does not match owner operator');
  has(errors, 'notes.txt: not a .json file');
  // git hash-object of "hello\n"
  assert.equal(blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});
