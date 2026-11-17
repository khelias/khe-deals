// Seals files with AES-256-GCM under STATE_KEY (32 bytes, base64), so the
// family's messages and watches cross jobs and sit in the cache unreadable.
//
//   node src/box.ts seal <in> <out>     node src/box.ts open <in> <out>
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const MAGIC = Buffer.from('KD1');

export function keyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.STATE_KEY;
  if (!raw) throw new Error('STATE_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('STATE_KEY must be 32 bytes in base64');
  return key;
}

export function seal(plain: Buffer | string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function open(sealed: Buffer, key: Buffer): Buffer {
  if (sealed.length < 31 || !sealed.subarray(0, 3).equals(MAGIC)) throw new Error('not a sealed file');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(3, 15));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(sealed.subarray(15, 31));
  return Buffer.concat([decipher.update(sealed.subarray(31)), decipher.final()]);
}

/** Writes through a temporary file, so a crash never leaves half a file. */
export function writeAtomic(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function writeSealedJson(path: string, value: unknown, key: Buffer): void {
  writeAtomic(path, seal(JSON.stringify(value), key));
}

/** The opened text of a sealed file, or null when there is none. */
export function readSealedText(path: string, key: Buffer): string | null {
  return existsSync(path) ? open(readFileSync(path), key).toString('utf8') : null;
}

export function readSealedJson<T>(path: string, key: Buffer): T | null {
  const text = readSealedText(path, key);
  return text === null ? null : (JSON.parse(text) as T);
}

if (import.meta.main) {
  const [cmd, input, output] = process.argv.slice(2);
  if ((cmd !== 'seal' && cmd !== 'open') || !input || !output) {
    console.error('usage: node src/box.ts seal|open <in> <out>');
    process.exit(2);
  }
  const key = keyFromEnv();
  const data = readFileSync(input);
  writeAtomic(output, cmd === 'seal' ? seal(data, key) : open(data, key));
}
