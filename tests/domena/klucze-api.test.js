import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { ZAKRESY_API, nowyKlucz, skrotKlucza, rozbierzNaglowek, czyZakresyPoprawne } from '../../src/domena/klucze-api.js';

const zakresy = ['zamowienia:odczyt', 'zamowienia:zapis', 'proformy:zapis', 'produkty:odczyt',
  'produkty:zapis', 'zdjecia:zapis', 'stany:odczyt', 'stany:zapis', 'sprzedaz:odczyt', 'druk'];

describe('domena kluczy API', () => {
  it('udostępnia dokładne zakresy w ustalonej kolejności', () => {
    expect(ZAKRESY_API).toEqual(zakresy);
    expect(Object.isFrozen(ZAKRESY_API)).toBe(true);
  });
  it('generuje 1000 różnych kluczy i prefiksów, z poprawnym skrótem SHA-256', () => {
    const klucze = Array.from({ length: 1000 }, () => nowyKlucz());
    for (const { klucz, prefiks, skrot } of klucze) {
      expect(klucz).toMatch(/^toms_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
      expect(prefiks).toBe(klucz.slice(5, 13));
      expect(skrot).toBe(createHash('sha256').update(klucz).digest('hex'));
      expect(skrotKlucza(klucz)).toBe(skrot);
    }
    expect(new Set(klucze.map(k => k.klucz)).size).toBe(1000);
    expect(new Set(klucze.map(k => k.prefiks)).size).toBe(1000);
  });
  it('przyjmuje klucz z końcowym CRLF i białymi znakami nagłówka', () => {
    const { klucz } = nowyKlucz();
    expect(rozbierzNaglowek(`Bearer ${klucz}\r\n`)).toBe(klucz);
    expect(rozbierzNaglowek(` \t bEaReR ${klucz} \t`)).toBe(klucz);
  });
  it('odrzuca inne schematy i uszkodzony format klucza', () => {
    const { klucz } = nowyKlucz();
    for (const naglowek of [undefined, null, '', klucz, `Basic ${klucz}`, `Bearer ${klucz}x`,
      `Bearer ${klucz.slice(0, -1)}`, `Bearer ${klucz} drugi`, `Bearer ${klucz.replace('toms_', 'TOMS_')}`,
      `Bearer ${klucz.slice(0, 5)}ABCDEFGH${klucz.slice(13)}`, `Bearer ${klucz.slice(0, -1)}+`]) {
      expect(rozbierzNaglowek(naglowek)).toBeNull();
    }
  });
  it('wymaga niepustej tablicy znanych zakresów bez powtórzeń', () => {
    expect(czyZakresyPoprawne(zakresy)).toBe(true);
    expect(czyZakresyPoprawne(['druk'])).toBe(true);
    for (const z of [[], ['druk', 'druk'], ['admin'], ['druk', null], Array(1), 'druk', null, undefined, {}]) {
      expect(czyZakresyPoprawne(z)).toBe(false);
    }
  });
});
