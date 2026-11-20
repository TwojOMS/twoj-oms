import { it, expect } from 'vitest';
import * as ostrzezenia from '../../src/domena/ostrzezenia.js';

it('osobisty filtr usuwa tylko wybrane typy, bez zmiany wierszy wejściowych', () => {
  const wiersze = [
    { typ: 'faktura-ksef', klucz: 'k' },
    { typ: 'niski-stan', klucz: 'niski-stan:2:0' },
  ];
  expect(ostrzezenia.zlozOstrzezenia({ wiersze, ukryteTypy: ['faktura-ksef'] })).toEqual([wiersze[1]]);
  expect(ostrzezenia.zlozOstrzezenia({ wiersze, ukryteTypy: ['niski-stan'] })).toEqual([wiersze[0]]);
  expect(ostrzezenia.zlozOstrzezenia({ wiersze })).toHaveLength(2);
  expect(wiersze).toHaveLength(2);
});

it('każdy typ ma dokładnie jeden opis i to samo źródło kolejności', async () => {
  const powiadomienia = await import('../../src/domena/powiadomienia.js');
  expect(powiadomienia.RODZAJE_OSTRZEZEN.map((r) => r.typ)).toEqual(ostrzezenia.KOLEJNOSC);
  expect(new Set(ostrzezenia.KOLEJNOSC).size).toBe(9);
  expect(ostrzezenia.KOLEJNOSC).toContain('niski-stan');
  for (const r of powiadomienia.RODZAJE_OSTRZEZEN) {
    expect(r.nazwa.length).toBeGreaterThan(5);
    expect(r.opis.length).toBeGreaterThan(20);
  }
});

it('walidacja przyjmuje tylko tablicę znanych typów i usuwa duplikaty', async () => {
  const powiadomienia = await import('../../src/domena/powiadomienia.js');
  expect(powiadomienia.sprawdzUkryteTypy(['przesylka', 'przesylka'])).toEqual(['przesylka']);
  for (const zle of [['obcy'], 'przesylka', null, [1], {}]) {
    expect(() => powiadomienia.sprawdzUkryteTypy(zle)).toThrow();
  }
});

it('opis rodzaju „Awarie integracji” ma aktualne zdanie', async () => {
  const { RODZAJE_OSTRZEZEN } = await import('../../src/domena/powiadomienia.js');
  const r = RODZAJE_OSTRZEZEN.find((x) => x.typ === 'integracja');
  expect(r.opis).toBe('Sklep, usługa albo zadanie w tle nie działa lub od dawna nie kończy przebiegu.');
});

it('awaria kanału stoi pierwsza i nie da się jej ukryć; wiadomości Allegro nie są już rodzajem', async () => {
  const p = await import('../../src/domena/powiadomienia.js');
  expect(p.KOLEJNOSC[0]).toBe('kanal');
  expect(p.RODZAJE_OSTRZEZEN[0]).toMatchObject({ zawsze: true });
  expect(p.KOLEJNOSC).not.toContain('wiadomosc-allegro');
  expect(() => p.sprawdzUkryteTypy(['kanal'])).toThrow();
  expect(() => p.sprawdzUkryteTypy(['wiadomosc-allegro'])).toThrow();
});

it('opisy rodzajów podają progi wzięte z kodu reguł', async () => {
  const { RODZAJE_OSTRZEZEN } = await import('../../src/domena/powiadomienia.js');
  const { PROG_BEZ_RUCHU_DNI_ROBOCZYCH } = await import('../../src/domena/etap-przesylki.js');
  const { DNI_UPRZEDZENIA } = await import('../../src/domena/kanal-stan.js');
  const opis = (typ) => RODZAJE_OSTRZEZEN.find((r) => r.typ === typ).opis;
  expect(opis('przesylka')).toContain(`ponad ${PROG_BEZ_RUCHU_DNI_ROBOCZYCH} dni robocze`);
  expect(opis('kanal')).toContain(`${DNI_UPRZEDZENIA} dni`);
});

it('rodzaj tylko dla administratora odpada innym kontom razem z niskim stanem bez magazynu', () => {
  const wiersze = [
    { typ: 'automatyzacja', klucz: 'automatyzacja:a', przycisk: null },
    { typ: 'niski-stan', klucz: 'niski-stan:2:0', przycisk: null },
    { typ: 'przesylka', klucz: 'przesylka:p', przycisk: null },
    { typ: 'kanal', klucz: 'kanal:k:pilne', przycisk: { href: '/ustawienia/integracje', etykieta: 'Połączenia' } },
  ];
  const typy = (konto, ukryteTypy = []) =>
    ostrzezenia.wierszeDlaKonta({ wiersze, konto, ukryteTypy }).map((w) => w.typ);
  const zwykle = { id: 2, admin: false, uprawnienia: new Set(['zamowienia']) };
  expect(typy(zwykle)).toEqual(['przesylka', 'kanal']);
  expect(typy({ ...zwykle, uprawnienia: new Set(['zamowienia', 'magazyn']) })).toEqual([
    'niski-stan',
    'przesylka',
    'kanal',
  ]);
  expect(typy({ id: 1, admin: true, uprawnienia: new Set() }, ['przesylka', 'kanal'])).toEqual([
    'automatyzacja',
    'niski-stan',
    'kanal',
  ]);
  // Awaria kanału zostaje u konta bez Ustawień — bez przycisku, którego i tak nie mogłoby użyć.
  expect(ostrzezenia.wierszeDlaKonta({ wiersze, konto: zwykle }).at(-1).przycisk).toBeNull();
});

it('kanał wymagający uwagi daje wiersz z kluczem kanału i stopniem; pilny bez „Ignoruj”', () => {
  const w = ostrzezenia.ostrzezeniaKanalow({
    kanaly: [
      { kanal: 'allegro_polcien', pilne: true, uprzedzenie: false, wolnoWiazac: true, powod: 'token odrzucony.' },
      { kanal: 'sklep_lampy', pilne: false, uprzedzenie: true, wolnoWiazac: false, powod: 'wygasa za 3 dni.' },
    ],
  });
  expect(w).toEqual([
    {
      typ: 'kanal',
      klucz: 'kanal:allegro_polcien:pilne',
      tekst: 'Kanał nie działa: token odrzucony. Naprawa: połączenie kanału z Allegro na nowo.',
      pilne: true,
      przycisk: { href: '/ustawienia/integracje', etykieta: 'Połączenia' },
      etykietaOdrzucenia: null,
    },
    {
      typ: 'kanal',
      klucz: 'kanal:sklep_lampy:uprzedzenie',
      tekst: 'Kanał wkrótce przestanie działać: wygasa za 3 dni.',
      pilne: false,
      przycisk: { href: '/ustawienia/integracje', etykieta: 'Połączenia' },
      etykietaOdrzucenia: 'Ignoruj',
    },
  ]);
  expect(w.every((x) => ostrzezenia.kluczDozwolony(x.klucz))).toBe(true);
});
