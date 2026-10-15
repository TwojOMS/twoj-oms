import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { zaszyfrujToken } from '../../src/oms/ksef/szyfrowanie.js';

describe('szyfrowanie tokena KSeF', () => {
  it('szyfruje "token|timestampMs" tak, ze klucz prywatny odczytuje dokladnie te tresc', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const szyfr = zaszyfrujToken({ klucz: publicKey, token: 'ABC-123', timestampMs: 1752236636015 });
    const jawny = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(szyfr, 'base64'),
    ).toString();
    expect(jawny).toBe('ABC-123|1752236636015');
  });

  it('NIE oglada zegara — ten sam wsad daje sie odczytac niezaleznie od pory', () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jawny = (t) => privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(zaszyfrujToken({ klucz: publicKey, token: 'T', timestampMs: t }), 'base64'),
    ).toString();
    expect(jawny(1)).toBe('T|1');
    expect(jawny(2)).toBe('T|2');
  });
});
