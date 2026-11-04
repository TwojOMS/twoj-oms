import { expect, it } from 'vitest';
import type { KrokKonfiguratora, OpisKanalu } from '../../../src/core/kontrakty.ts';
import { MODUL_WOO } from '../../../src/domena/modul-woo.ts';
import { MODUL_ALLEGRO } from '../../../src/domena/modul-allegro.ts';
import { sprawdzOpisyKanalow } from '../../../src/domena/moduly-kanalow.ts';

it('strażnik odrzuca niespójne kroki i pola, akceptuje oba kompletne opisy', () => {
  expect(() => sprawdzOpisyKanalow()).not.toThrow();
  const formularz = { akcja: 'szkice', przycisk: 'Dalej', pola: [] };
  const pole = { id: 'nazwa', etykieta: 'Nazwa', rodzaj: 'tekst', wymagane: true } as const;
  const przypadki: KrokKonfiguratora[][] = [
    [{ id: 'nazwa', numer: 1, tytul: 'Nazwa', formularz, widok: 'fragment' }],
    [{ id: 'nazwa', numer: 1, tytul: 'Nazwa' }],
    [1, 2].map(numer => ({ id: 'nazwa', numer, tytul: 'Nazwa', formularz })),
    [1, 3].map(numer => ({ id: `krok-${numer}`, numer, tytul: 'Nazwa', formularz })),
    [{ id: 'nazwa', numer: 1, tytul: 'Nazwa', formularz: { ...formularz, pola: [{ ...pole, opcje: [] }] } }],
    [{ id: 'nazwa', numer: 1, tytul: 'Nazwa', formularz: { ...formularz, pola: [pole, pole] } }],
  ];
  for (const kroki of przypadki) {
    const opis: OpisKanalu = { ...MODUL_WOO, konfigurator: { ...MODUL_WOO.konfigurator, kroki } };
    expect(() => sprawdzOpisyKanalow({ woo: opis }), JSON.stringify(kroki)).toThrow();
  }
  expect(MODUL_ALLEGRO.konfigurator.kroki.map(k => [k.numer, k.id])).toEqual([
    [0, 'aplikacja'], [1, 'nazwa'], [2, 'zgoda'], [3, 'konto'], [4, 'start'], [5, 'stan'],
  ]);
  expect(MODUL_WOO.konfigurator.kroki.map(k => [k.numer, k.id])).toEqual([
    [1, 'nazwa'], [2, 'klucze'], [3, 'mapowanie'], [4, 'start'], [5, 'stan'],
  ]);
});

it('stanKrokow oznacza wykonane, bieżący i przyszłe kroki', async () => {
  const { stanKrokow } = await import('../../../src/core/web/konfigurator/konfigurator.ts');
  expect(stanKrokow(MODUL_WOO.konfigurator, { biezacy: 'klucze', zrobione: ['nazwa'] })).toEqual(
    MODUL_WOO.konfigurator.kroki.map((k, i) => ({ numer: k.numer, tytul: k.tytul, stan: ['zrobione', 'biezacy', 'przed', 'przed', 'przed'][i] })),
  );
});

it('polaZFormularza przycina tylko pola kroku, adresAkcji rozwija klucz', async () => {
  const { polaZFormularza, adresAkcji } = await import('../../../src/core/web/konfigurator/konfigurator.ts');
  const opis: OpisKanalu = MODUL_WOO;
  const [nazwa, klucze, mapowanie] = opis.konfigurator.kroki;
  expect(polaZFormularza(nazwa!, { nazwa: ' Sklep Półcień ', adres: ' https://sklep.polcien.example ', cs: 'obce' }))
    .toEqual({ nazwa: 'Sklep Półcień', adres: 'https://sklep.polcien.example' });
  expect(polaZFormularza(klucze!, { ck: ['obce'], cs: 123 })).toEqual({ ck: '', cs: '' });
  expect(polaZFormularza(mapowanie!, {})).toEqual({});
  expect(adresAkcji(opis.konfigurator, nazwa!, 'polcien')).toBe('/ustawienia/integracje/woocommerce/szkice');
  expect(adresAkcji(opis.konfigurator, klucze!, 'sklep/polcien')).toBe('/ustawienia/integracje/woocommerce/sklep%2Fpolcien/klucze');
  expect(() => adresAkcji(opis.konfigurator, mapowanie!, 'polcien')).toThrow();
});

// Złoty szkielet kroków z tabeli 3.3 planu PRZ-132 — opierają się na nim 07a, 07b i 11 (recenzja K04).
const szkielet = (opis: OpisKanalu) => opis.konfigurator.kroki.map(k => [
  k.numer, k.id, k.tytul, k.widok ?? `${k.formularz!.akcja} → ${k.formularz!.przycisk}`,
  ...(k.formularz?.pola ?? []).map(p => [p.id, p.rodzaj, !!p.wymagane, p.domyslna ?? null, p.opcje?.map(o => (o as { wartosc?: string }).wartosc ?? o) ?? null]),
]);
it('kroki Allegro i Woo mają widoki, akcje, przyciski i pola z tabeli 3.3', () => {
  expect(szkielet(MODUL_ALLEGRO)).toEqual([
    [0, 'aplikacja', 'Aplikacja Allegro', 'allegro-aplikacja'],
    [1, 'nazwa', 'Nazwa i zakres zamówień', 'szkice → Dalej', ['nazwa', 'tekst', true, null, null], ['srodowisko', 'wybor', true, 'produkcja', ['produkcja', 'sandbox']], ['od', 'data', true, null, null]],
    [2, 'zgoda', 'Zgoda w Allegro', 'allegro-zgoda'],
    [3, 'konto', 'Potwierdź konto', 'allegro-konto'],
    [4, 'start', 'Data startu', ':kanal/data-startu → Zapisz datę startu', ['od', 'data', true, null, null]],
    [5, 'stan', 'Stan', 'allegro-stan'],
  ]);
  expect(szkielet(MODUL_WOO)).toEqual([
    [1, 'nazwa', 'Nazwa i adres', 'szkice → Dalej', ['nazwa', 'tekst', true, null, null], ['adres', 'adres', true, null, null]],
    [2, 'klucze', 'Klucze REST', ':kanal/klucze → Sprawdź połączenie', ['ck', 'sekret', true, null, null], ['cs', 'sekret', true, null, null]],
    [3, 'mapowanie', 'Metody wysyłki', 'woo-mapowanie'],
    [4, 'start', 'Data startu i „Aktywuj”', ':kanal/data-startu → Zapisz datę startu', ['od', 'data', true, null, null]],
    [5, 'stan', 'Stan', 'woo-stan'],
  ]);
});
