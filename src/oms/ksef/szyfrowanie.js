import {
  publicEncrypt, constants, X509Certificate, randomBytes, createCipheriv, createHash,
} from 'node:crypto';
import { bladOperatora } from '../../domena/bledy.js';

// Klucz publiczny MF przychodzi jako certyfikat w base64 (GET /security/public-key-certificates).
// Certyfikat to NIE jest klucz - `createPublicKey` na surowym base64 konczy sie bledem parsera,
// wiec przechodzimy przez X509Certificate i bierzemy z niego publicKey.
export function kluczZCertyfikatu(base64Cert) {
  return new X509Certificate(Buffer.from(base64Cert, 'base64')).publicKey;
}

// MF oddaje liste certyfikatow, kazdy z polem `usage` (lista: `KsefTokenEncryption`
// albo `SymmetricKeyEncryption`). Kolejnosc listy NIE jest umowa — wybieramy po `usage`.
// Gdy zaden certyfikat nie ma pola `usage` (starsza odpowiedz) — pierwszy, jak dotad.
// Gdy pole jest, ale nic nie pasuje — czytelna odmowa: cichy pierwszy zaszyfrowalby
// ladunek zlym kluczem i MF odrzucilby go komunikatem, z ktorego nic nie wynika.
// Oddaje certyfikat (base64), nie klucz — klucz robi z niego `kluczZCertyfikatu`.
//
// Waznosc (PRZ-123 C05): gdy certyfikat ma `validFrom`/`validTo`, bierzemy tylko wazny na `teraz`
// (MF wymienia klucze z zakladka — na liscie bywa stary i nowy). Brak pola = brak ograniczenia z tej
// strony, wiec odpowiedz bez tych pol dziala jak dotad. Data, ktorej nie da sie odczytac = niewazny.
// Pusta lista (albo nie-lista) to czytelna odmowa, a nie TypeError dalej w `kluczZCertyfikatu`.
export function kluczMf(certy, usage, teraz = new Date()) {
  const lista = (Array.isArray(certy) ? certy : []).filter((c) => c && typeof c === 'object');
  const odmowa = (powod) => bladOperatora(
    `KSeF nie oddał ${powod} — nie ma czym zaszyfrować danych, więc nic nie wysłano. `
    + 'Spróbuj ponownie za chwilę.',
  );
  if (!lista.some((c) => c.certificate)) {
    throw odmowa(`żadnego certyfikatu klucza publicznego (do użycia „${usage}”)`);
  }
  const t = teraz.getTime();
  const wazny = (c) => (c.validFrom == null || t >= Date.parse(c.validFrom))
    && (c.validTo == null || t <= Date.parse(c.validTo));
  const maUsage = lista.some((c) => c.usage !== undefined && c.usage !== null);
  const pasujace = maUsage
    ? lista.filter((c) => (Array.isArray(c.usage) ? c.usage.includes(usage) : c.usage === usage))
    : lista;
  if (maUsage && !pasujace.some((c) => c.certificate)) {
    throw odmowa(`certyfikatu klucza publicznego do użycia „${usage}”`);
  }
  const wybrany = pasujace.find((c) => c.certificate && wazny(c));
  if (!wybrany) {
    throw odmowa(`certyfikatu klucza publicznego do użycia „${usage}” ważnego w tej chwili`);
  }
  return wybrany.certificate;
}

// UWAGA: TA FUNKCJA NIE MA PRAWA WOLAC `Date.now()`. Timestamp przychodzi gotowy z challenge'a
// (pole `timestampMs`), a ten projekt przejechal sie na strefach juz dwa razy.
export function zaszyfrujToken({ klucz, token, timestampMs }) {
  return publicEncrypt(
    { key: klucz, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(`${token}|${timestampMs}`),
  ).toString('base64');
}

// Klucz sesji wysylki: 32 losowe bajty (AES-256). ⚠️ Zyje tylko w pamieci przebiegu —
// nigdy do logu, bledu, bazy ani na ekran.
export function nowyKluczSesji() {
  return randomBytes(32);
}

// Klucz sesji szyfrowany kluczem publicznym MF (`SymmetricKeyEncryption`): RSA-OAEP z SHA-256
// (MGF1 tez SHA-256 — node bierze `oaepHash` dla obu). Wynik w base64, jak chce `POST /sessions/online`.
export function zaszyfrujKluczSesji(kluczSesji, kluczPubliczny) {
  return publicEncrypt(
    { key: kluczPubliczny, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    kluczSesji,
  ).toString('base64');
}

// Tresc faktury: AES-256-CBC z dopelnieniem PKCS#7 (domyslne w node). Klucz 32 bajty, IV 16.
export function zaszyfrujAes(bajty, klucz, iv) {
  const szyfr = createCipheriv('aes-256-cbc', klucz, iv);
  return Buffer.concat([szyfr.update(bajty), szyfr.final()]);
}

// SHA-256 bajtow (napis = UTF-8) w Base64 — `invoiceHash` / `encryptedInvoiceHash` w KSeF.
export function skrotSha256Base64(bajty) {
  return createHash('sha256').update(bajty).digest('base64');
}

// SHA-256 w Base64URL bez dopelnienia — do adresu KOD I (QR).
export function skrotSha256Base64Url(bajty) {
  return createHash('sha256').update(bajty).digest('base64url');
}
