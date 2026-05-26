import { describe, expect, test, beforeEach } from 'bun:test';
import { decrypt, encrypt, resetKeyCache } from './crypto.ts';

const KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

beforeEach(() => {
  resetKeyCache();
});

describe('encrypt/decrypt', () => {
  test('round-trips', () => {
    const blob = encrypt('hello world', KEY);
    expect(decrypt(blob, KEY)).toBe('hello world');
  });

  test('produces distinct ciphertexts for same plaintext', () => {
    const a = encrypt('same', KEY);
    const b = encrypt('same', KEY);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a, KEY)).toBe('same');
    expect(decrypt(b, KEY)).toBe('same');
  });

  test('rejects malformed key', () => {
    resetKeyCache();
    expect(() => encrypt('x', 'too-short')).toThrow();
  });

  test('rejects tampered ciphertext', () => {
    const blob = encrypt('secret', KEY);
    const lastIndex = blob.length - 1;
    blob[lastIndex] = (blob[lastIndex] ?? 0) ^ 0x01;
    expect(() => decrypt(blob, KEY)).toThrow();
  });
});
