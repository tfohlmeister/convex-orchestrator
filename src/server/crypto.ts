import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SALT = Buffer.from('convex-orchestrator-v1');
const INFO = Buffer.from('record-encryption');

let cachedKey: Buffer | null = null;

export function deriveKey(masterKeyHex: string): Buffer {
  if (cachedKey) return cachedKey;
  if (!/^[0-9a-f]{64}$/i.test(masterKeyHex)) {
    throw new Error('ORCHESTRATOR_MASTER_KEY must be 32 bytes hex (64 hex chars)');
  }
  const master = Buffer.from(masterKeyHex, 'hex');
  const raw = hkdfSync('sha256', master, SALT, INFO, KEY_LEN);
  cachedKey = Buffer.from(raw as ArrayBuffer);
  return cachedKey;
}

export function resetKeyCache(): void {
  cachedKey = null;
}

export function encrypt(plaintext: string, masterKeyHex: string): Buffer {
  const key = deriveKey(masterKeyHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(blob: Buffer, masterKeyHex: string): string {
  if (blob.length < IV_LEN + TAG_LEN) {
    throw new Error('ciphertext too short');
  }
  const key = deriveKey(masterKeyHex);
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
