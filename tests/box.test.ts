import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keyFromEnv, open, readSealedJson, seal, writeSealedJson } from '../src/box.ts';

const key = randomBytes(32);

test('seal and open round trip', () => {
  const text = 'otsi beebikäru alla 150 eur';
  const sealed = seal(text, key);
  assert.ok(!sealed.includes(Buffer.from('beebi')));
  assert.equal(open(sealed, key).toString('utf8'), text);
  const dir = mkdtempSync(join(tmpdir(), 'box-'));
  writeSealedJson(join(dir, 's.sealed'), { a: [1, 'ü'] }, key);
  assert.deepEqual(readSealedJson(join(dir, 's.sealed'), key), { a: [1, 'ü'] });
});

test('a tampered file is refused', () => {
  const sealed = seal('{"seen":[]}', key);
  const bad = Buffer.from(sealed);
  bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
  assert.throws(() => open(bad, key));
  assert.throws(() => open(sealed, randomBytes(32)));
  assert.throws(() => open(Buffer.from('plain text, not sealed at all'), key));
});

test('the key must be 32 bytes of base64', () => {
  assert.throws(() => keyFromEnv({}), /not set/);
  assert.throws(() => keyFromEnv({ STATE_KEY: Buffer.alloc(16).toString('base64') }), /32 bytes/);
  assert.equal(keyFromEnv({ STATE_KEY: key.toString('base64') }).length, 32);
});
