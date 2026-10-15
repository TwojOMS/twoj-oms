import { publicEncrypt, constants, X509Certificate } from 'node:crypto';

// Klucz publiczny MF przychodzi jako certyfikat w base64 (GET /security/public-key-certificates).
// Certyfikat to NIE jest klucz - `createPublicKey` na surowym base64 konczy sie bledem parsera,
// wiec przechodzimy przez X509Certificate i bierzemy z niego publicKey.
export function kluczZCertyfikatu(base64Cert) {
  return new X509Certificate(Buffer.from(base64Cert, 'base64')).publicKey;
}

// UWAGA: TA FUNKCJA NIE MA PRAWA WOLAC `Date.now()`. Timestamp przychodzi gotowy z challenge'a
// (pole `timestampMs`), a ten projekt przejechal sie na strefach juz dwa razy.
export function zaszyfrujToken({ klucz, token, timestampMs }) {
  return publicEncrypt(
    { key: klucz, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`${token}|${timestampMs}`),
  ).toString('base64');
}
