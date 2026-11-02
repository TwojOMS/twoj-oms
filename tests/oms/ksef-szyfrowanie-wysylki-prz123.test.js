import { describe, it, expect } from 'vitest';
import {
  generateKeyPairSync, privateDecrypt, createDecipheriv, constants,
} from 'node:crypto';
import {
  kluczMf, nowyKluczSesji, zaszyfrujKluczSesji, zaszyfrujAes,
  skrotSha256Base64, skrotSha256Base64Url,
} from '../../src/oms/ksef/szyfrowanie.js';
import { createKsefClient } from '../../src/oms/ksef/client.js';
import { certyfikatTestowy } from './_ksef-pomocniki.js';

// PRZ-123 C03 — kryptografia sesji wysylki do KSeF. Zero sieci: para RSA powstaje tutaj,
// certyfikaty MF to atrapy (staly certyfikat testowy albo zmyslony napis).

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

describe('PRZ-123 C03 — klucz sesji szyfrowany RSA-OAEP (SHA-256)', () => {
  it('klucz sesji zaszyfrowany i odszyfrowany kluczem prywatnym = ten sam', () => {
    const klucz = nowyKluczSesji();
    expect(Buffer.isBuffer(klucz)).toBe(true);
    expect(klucz).toHaveLength(32);

    const szyfrogram = zaszyfrujKluczSesji(klucz, publicKey);
    expect(typeof szyfrogram).toBe('string');
    const odszyfrowany = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(szyfrogram, 'base64'),
    );
    expect(odszyfrowany.equals(klucz)).toBe(true);
  });

  it('kazdy nowy klucz sesji jest inny (losowy)', () => {
    expect(nowyKluczSesji().equals(nowyKluczSesji())).toBe(false);
  });
});

describe('PRZ-123 C03 — tresc faktury AES-256-CBC z PKCS#7', () => {
  const klucz = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(16, 3);

  it('node:crypto odszyfrowuje wejscie, dlugosc szyfrogramu to wielokrotnosc 16', () => {
    for (const dlugosc of [0, 1, 15, 16, 17, 100]) {
      const wejscie = Buffer.from('Pracownia Półcień — lampa '.repeat(10)).subarray(0, dlugosc);
      const szyfrogram = zaszyfrujAes(wejscie, klucz, iv);
      expect(Buffer.isBuffer(szyfrogram)).toBe(true);
      expect(szyfrogram.length % 16).toBe(0);
      // PKCS#7: zawsze dopelnienie, takze przy pelnym bloku
      expect(szyfrogram.length).toBe((Math.floor(dlugosc / 16) + 1) * 16);
      const d = createDecipheriv('aes-256-cbc', klucz, iv);
      expect(Buffer.concat([d.update(szyfrogram), d.final()]).equals(wejscie)).toBe(true);
    }
  });

  it('staly klucz, IV i tekst daja staly szyfrogram (wektor wpisany w test)', () => {
    const klucz0 = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
    const iv0 = Buffer.from('f0e0d0c0b0a090807060504030201000', 'hex');
    const szyfrogram = zaszyfrujAes(Buffer.from('<Faktura>Pracownia Półcień</Faktura>', 'utf8'), klucz0, iv0);
    expect(szyfrogram.toString('hex')).toBe(WEKTOR_AES_HEX);
  });

  it('odmawia klucza innego niz 32 bajty i IV innego niz 16', () => {
    expect(() => zaszyfrujAes(Buffer.from('x'), Buffer.alloc(16), iv)).toThrow();
    expect(() => zaszyfrujAes(Buffer.from('x'), klucz, Buffer.alloc(8))).toThrow();
  });
});

// Wektor wyliczony raz `node:crypto` (aes-256-cbc, PKCS#7) dla klucza 00..1f, IV f0..00
// i tekstu UTF-8 `<Faktura>Pracownia Półcień</Faktura>` (39 bajtow → 48 bajtow szyfrogramu).
const WEKTOR_AES_HEX = '309cbaa5169e5f2165fe8629e45ea8e11f6769742289b43fae2366b04837b72fd70460fd28c76efc58e94770ef90608e';

describe('PRZ-123 C03 — skroty SHA-256', () => {
  // Wektor NIST FIPS 180-2 dla "abc": ba7816bf...15ad. Base64 ma '+', '/' i '=' —
  // dokladnie te znaki, ktore Base64URL zamienia/usuwa.
  it('skrotSha256Base64 dla "abc" (wektor NIST)', () => {
    expect(skrotSha256Base64(Buffer.from('abc'))).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
  });

  it('skrotSha256Base64Url dla "abc" — bez +, / i =', () => {
    expect(skrotSha256Base64Url(Buffer.from('abc'))).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('napis traktuje jak UTF-8', () => {
    expect(skrotSha256Base64Url('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });
});

describe('PRZ-123 C03 — kluczMf(certy, usage)', () => {
  const tokenowy = { certificate: 'CERT-TOKEN', usage: ['KsefTokenEncryption'] };
  const symetryczny = { certificate: 'CERT-AES', usage: ['SymmetricKeyEncryption'] };

  it('dwa certyfikaty w odwrotnej kolejnosci → wlasciwy po usage', () => {
    expect(kluczMf([symetryczny, tokenowy], 'KsefTokenEncryption')).toBe('CERT-TOKEN');
    expect(kluczMf([tokenowy, symetryczny], 'SymmetricKeyEncryption')).toBe('CERT-AES');
  });

  it('usage jako pojedynczy napis tez dziala', () => {
    expect(kluczMf([{ certificate: 'A', usage: 'X' }, { certificate: 'B', usage: 'KsefTokenEncryption' }], 'KsefTokenEncryption')).toBe('B');
  });

  it('zaden certyfikat nie ma pola usage → pierwszy (jak dzis)', () => {
    expect(kluczMf([{ certificate: 'P1' }, { certificate: 'P2' }], 'SymmetricKeyEncryption')).toBe('P1');
  });

  it('pole usage jest, ale nic nie pasuje → czytelny blad, nie cichy pierwszy', () => {
    let blad = null;
    try {
      kluczMf([symetryczny], 'KsefTokenEncryption');
    } catch (e) {
      blad = e;
    }
    expect(blad).not.toBeNull();
    expect(blad.message).toContain('KsefTokenEncryption');
    expect(blad.dlaOperatora).toBe(true);
  });
});

// Klient logowania kosztow wybiera klucz po usage. Pierwszy na liscie jest „certyfikat”,
// ktorego nie da sie sparsowac — dzisiejsze `certy[0]` wywala sie na nim, wybor po usage nie.
describe('PRZ-123 C03 — logowanie KSeF bierze certyfikat KsefTokenEncryption', () => {
  function atrapa(certy) {
    const wywolania = [];
    const fetchImpl = async (url) => {
      wywolania.push(url);
      if (url.includes('security/public-key-certificates')) {
        return { ok: true, status: 200, json: async () => certy, text: async () => '' };
      }
      // Dalej nie idziemy — wystarczy, ze klient przeszedl krok klucza.
      throw new Error('atrapa: koniec');
    };
    return { fetchImpl, wywolania };
  }

  it('certyfikat tokenowy drugi na liscie → logowanie idzie dalej (challenge)', async () => {
    const { fetchImpl, wywolania } = atrapa([
      { certificate: 'to-nie-jest-certyfikat', usage: ['SymmetricKeyEncryption'] },
      { certificate: certyfikatTestowy(), usage: ['KsefTokenEncryption'] },
    ]);
    const klient = createKsefClient({ token: 'T', nip: '1234563218', fetchImpl });
    await klient.zaloguj().catch(() => {});
    expect(wywolania.some((u) => u.includes('auth/challenge'))).toBe(true);
  });

  it('zaden certyfikat nie pasuje → czytelna odmowa przed challenge', async () => {
    const { fetchImpl, wywolania } = atrapa([
      { certificate: certyfikatTestowy(), usage: ['SymmetricKeyEncryption'] },
    ]);
    const klient = createKsefClient({ token: 'SEKRET-TOKEN-9', nip: '1234563218', fetchImpl });
    let blad = null;
    try {
      await klient.zaloguj();
    } catch (e) {
      blad = e;
    }
    expect(blad?.dlaOperatora).toBe(true);
    expect(blad.message).not.toContain('SEKRET-TOKEN-9');
    expect(wywolania).toHaveLength(1);
  });
});

// PRZ-123 C05 — uwagi recenzji C03: pusta lista to czytelna odmowa (nie TypeError), a przy polach
// `validFrom`/`validTo` wybieramy certyfikat wazny „teraz” (zegar podany parametrem).
describe('PRZ-123 C05 — kluczMf: pusta lista i waznosc certyfikatu', () => {
  function zlap(fn) {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return null;
  }

  it('pusta lista albo brak listy → bladOperatora z czytelnym zdaniem, nie TypeError', () => {
    for (const certy of [[], undefined, null, [{}], [{ usage: ['SymmetricKeyEncryption'] }]]) {
      const blad = zlap(() => kluczMf(certy, 'SymmetricKeyEncryption'));
      expect(blad, JSON.stringify(certy)).not.toBeNull();
      expect(blad).not.toBeInstanceOf(TypeError);
      expect(blad.dlaOperatora).toBe(true);
      expect(blad.message).toMatch(/certyfikat/);
    }
  });

  const TERAZ = new Date('2026-10-27T12:00:00Z');
  const wygasly = {
    certificate: 'CERT-STARY', usage: ['SymmetricKeyEncryption'],
    validFrom: '2024-01-01T00:00:00Z', validTo: '2026-06-30T23:59:59Z',
  };
  const wazny = {
    certificate: 'CERT-WAZNY', usage: ['SymmetricKeyEncryption'],
    validFrom: '2026-07-01T00:00:00Z', validTo: '2028-06-30T23:59:59Z',
  };
  const przyszly = {
    certificate: 'CERT-PRZYSZLY', usage: ['SymmetricKeyEncryption'],
    validFrom: '2027-01-01T00:00:00Z', validTo: '2029-06-30T23:59:59Z',
  };
  const tokenowy = {
    certificate: 'CERT-TOKEN', usage: ['KsefTokenEncryption'],
    validFrom: '2024-01-01T00:00:00Z', validTo: '2029-01-01T00:00:00Z',
  };

  it('z polami waznosci → certyfikat wazny na „teraz”, niezaleznie od kolejnosci', () => {
    expect(kluczMf([wygasly, przyszly, tokenowy, wazny], 'SymmetricKeyEncryption', TERAZ)).toBe('CERT-WAZNY');
    expect(kluczMf([przyszly, wazny, wygasly], 'SymmetricKeyEncryption', TERAZ)).toBe('CERT-WAZNY');
    // ten sam zestaw, inny zegar → inny certyfikat
    expect(kluczMf([wygasly, wazny, przyszly], 'SymmetricKeyEncryption', new Date('2028-08-01T00:00:00Z')))
      .toBe('CERT-PRZYSZLY');
  });

  it('bez pola usage, z polami waznosci → pierwszy wazny', () => {
    const bezUsage = [wygasly, wazny].map(({ usage, ...c }) => c);
    expect(kluczMf(bezUsage, 'SymmetricKeyEncryption', TERAZ)).toBe('CERT-WAZNY');
  });

  it('pasuje usage, ale zaden nie jest wazny → czytelna odmowa', () => {
    const blad = zlap(() => kluczMf([wygasly, przyszly], 'SymmetricKeyEncryption', TERAZ));
    expect(blad?.dlaOperatora).toBe(true);
    expect(blad.message).toMatch(/ważn/);
  });

  it('domyslny zegar to biezaca chwila (bez trzeciego parametru)', () => {
    const teraz = Date.now();
    const dzis = {
      certificate: 'CERT-DZIS', usage: ['SymmetricKeyEncryption'],
      validFrom: new Date(teraz - 86400000).toISOString(), validTo: new Date(teraz + 86400000).toISOString(),
    };
    const wczoraj = {
      certificate: 'CERT-WCZORAJ', usage: ['SymmetricKeyEncryption'],
      validFrom: new Date(teraz - 3 * 86400000).toISOString(), validTo: new Date(teraz - 86400000 - 1).toISOString(),
    };
    expect(kluczMf([wczoraj, dzis], 'SymmetricKeyEncryption')).toBe('CERT-DZIS');
  });
});
