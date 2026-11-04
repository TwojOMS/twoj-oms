import { describe, expect, it } from 'vitest';
import { MODULY_KANALOW } from '../../../src/domena/moduly-kanalow.ts';
import { definicjeKanalow } from '../../../src/moduly/kanaly/konfiguracja.ts';
import { brakujaceKluczeKanalu } from '../../../src/moduly/kanaly/kompletnosc.ts';

describe('typ i wymagane klucze kanału', () => {
  it('zachowuje komunikat dla nieznanego typu', () => {
    expect(() => definicjeKanalow({ OMS_KANALY: JSON.stringify([{ klucz: 'sklep', typ: 'shoper', prefiks: 'SKLEP' }]) }))
      .toThrow('OMS_KANALY: pozycja 1 (klucz „sklep”): pole „typ” ma być „woo” albo „allegro”');
  });
  it('zatrzymuje start przy zepsutym opisie rejestru', () => {
    const moduly = { ...MODULY_KANALOW, woo: { ...MODULY_KANALOW.woo, litera: MODULY_KANALOW.allegro.litera } };
    expect(() => definicjeKanalow({}, moduly)).toThrow('powtórzona litera');
  });
  it('zachowuje kolejność brakujących kluczy', () => {
    expect(brakujaceKluczeKanalu({ klucz: 'sklep', typ: 'woo', prefiks: 'SKLEP' }, {})).toEqual(['SKLEP_URL', 'SKLEP_CK', 'SKLEP_CS', 'SKLEP_MAPOWANIE']);
    expect(brakujaceKluczeKanalu({ klucz: 'rynek', typ: 'allegro', prefiks: 'RYNEK' }, {})).toEqual(['RYNEK_CLIENT_ID', 'RYNEK_CLIENT_SECRET', 'RYNEK_USER_AGENT', 'RYNEK_OD']);
  });
});
