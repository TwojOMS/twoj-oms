import { expect, it } from 'vitest';
import type { OpisKanalu } from '../../src/core/kontrakty.ts';
import { MODULY_KANALOW, TYPY_KANALOW, czyTypKanalu, modulKanalu, sprawdzOpisyKanalow } from '../../src/domena/moduly-kanalow.ts';

it('rejestr zachowuje kolejność i odrzuca nieznane typy oraz klucze prototypu', () => {
  expect(TYPY_KANALOW).toEqual(['woo', 'allegro']);
  expect(Object.isFrozen(MODULY_KANALOW)).toBe(true);
  for (const typ of TYPY_KANALOW) {
    expect(czyTypKanalu(typ)).toBe(true);
    expect(modulKanalu(typ)).toBe(MODULY_KANALOW[typ]);
  }
  for (const typ of ['shoper', 'toString', '__proto__', '', null, undefined, 1]) {
    expect(czyTypKanalu(typ)).toBe(false);
    expect(() => modulKanalu(typ)).toThrow('Nieznany typ kanału');
  }
  expect(() => sprawdzOpisyKanalow()).not.toThrow();
});

it.each([
  ['woo', 'WooCommerce', 'W', 'woocommerce', 'sklep',
    { mianownik: 'sklep', dopelniacz: 'sklepu', miejscownik: 'sklepie', narzednik: 'sklepem' },
    ['CK', 'CS'], ['URL', 'CK', 'CS', 'MAPOWANIE'],
    { zdarzenia: 'odpytywanie', wymagaAkceptacji: false, statusZwrotny: 'wyslane', numerListu: 'notatka', plikFaktury: false, wiadomosci: false, wysylkaPlatformy: false, terminWysylki: false, scalanie: true, stany: 'produkty' },
    { sciezka: '/ustawienia/integracje/woocommerce', nowy: 'nowy', dodaj: 'Dodaj sklep', kroki: [] }],
  ['allegro', 'Allegro', 'a', 'allegro', 'allegro',
    { mianownik: 'Allegro', dopelniacz: 'Allegro', miejscownik: 'Allegro', narzednik: 'Allegro' },
    ['CLIENT_ID', 'CLIENT_SECRET'], ['CLIENT_ID', 'CLIENT_SECRET', 'USER_AGENT', 'OD'],
    { zdarzenia: 'odpytywanie', wymagaAkceptacji: false, statusZwrotny: 'mapa', numerListu: 'przesylki', plikFaktury: true, wiadomosci: true, wysylkaPlatformy: true, terminWysylki: true, scalanie: false, stany: 'oferty' },
    { sciezka: '/ustawienia/integracje/allegro', nowy: 'nowe', dodaj: 'Dodaj konto', kroki: [] }],
] as const)('opis i tabela umiejętności %s', (typ, nazwa, litera, idKatalogu, wzorzecLinku, komunikaty, sekrety, wymagane, umiejetnosci, konfigurator) => {
  // Kroki konfiguratora (od K04) sprawdza tests/moduly/kanaly/konfigurator-kontrakt.test.ts.
  const m = modulKanalu(typ);
  expect({ ...m, konfigurator: { ...m.konfigurator, kroki: [] } }).toEqual({ typ, nazwa, litera, idKatalogu, wzorzecLinku, komunikaty, kluczeEnv: { sekrety, wymagane }, umiejetnosci, konfigurator });
  expect(m.konfigurator.kroki.length).toBeGreaterThan(0);
});

function zmienWoo(zmiany: Partial<OpisKanalu>) {
  return { ...MODULY_KANALOW, woo: { ...MODULY_KANALOW.woo, ...zmiany } };
}

it.each([
  [{ litera: 'a' }, /litera/],
  [{ typ: 'inny' }, /typ/],
  [{ idKatalogu: 'allegro' }, /idKatalogu/],
  [{ kluczeEnv: { sekrety: ['CK', 'BRAK'], wymagane: ['CK'] } }, /BRAK/],
  [{ kluczeEnv: { sekrety: ['ck'], wymagane: ['ck', '1URL'] } }, /sufiks/],
] satisfies [Partial<OpisKanalu>, RegExp][])('strażnik odrzuca błędny opis %j', (zmiany, blad) => {
  expect(() => sprawdzOpisyKanalow(zmienWoo(zmiany))).toThrow(blad);
});

it('strażnik zbiera wszystkie błędy', () => {
  expect(() => sprawdzOpisyKanalow(zmienWoo({ typ: 'inny', litera: 'a', idKatalogu: 'allegro', kluczeEnv: { sekrety: ['BRAK'], wymagane: ['zly'] } })))
    .toThrow(/typ[\s\S]*litera[\s\S]*idKatalogu[\s\S]*sufiks[\s\S]*BRAK/);
});
