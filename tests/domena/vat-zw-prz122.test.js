// PRZ-122.B07a — stawka „zw” (zwolnienie z VAT) w domenie, dopuszczona WYŁĄCZNIE flagą `{ zw: true }`
// (= działa program fakturowy wbudowany, `opis.wbudowany`). Bez flagi każda funkcja zachowuje się jak przed
// zmianą: „zw” odrzucone albo zastąpione domyślną, tak jak każda stawka spoza listy — inFakt nigdy jej nie dostaje.
// Z flagą: netto = brutto, VAT 0 (zgodnie z sumami TwojeFaktury, src/domena/twojefaktury/sumy.js).
// Dane zmyślone.
import { describe, it, expect } from 'vitest';
import {
  STAWKI_VAT, STAWKI_Z_ZW, czyStawkaVat, stawkiDlaProgramu, stawkaPozycji, nettoZBruttoDoPokazania, bruttoZNetto,
} from '../../src/domena/vat.js';
import { parsujStawke, parsujNowaPozycje } from '../../src/domena/pozycje-reczne.js';
import { pozycjeDokumentu } from '../../src/domena/pozycje-faktury.js';
import { wierszePozycji, podsumowanieVatKarty } from '../../src/domena/tabela-pozycji.js';
import { czytajStawkeDomyslna, zapiszStawkeDomyslna } from '../../src/moduly/faktury/db/stawka-vat.js';

/** Atrapa bazy z jednym wpisem w `ustawienia` — tyle, ile czyta i pisze stawka-vat.js. */
function baza(wartosc) {
  const zapisy = [];
  return {
    zapisy,
    prepare: (sql) => ({
      get: () => (wartosc === undefined ? undefined : { wartosc }),
      run: (...arg) => { zapisy.push({ sql, arg }); },
    }),
  };
}

// Zamówienie „Lampy Kowalczyk”: pozycja sklepowa, ręczna ze stawką „zw” i dostawa.
const zamowienie = (nad = {}) => ({
  sklep: 'pro',
  kwota_brutto: '200.00',
  koszt_dostawy_brutto: '20.00',
  pozycje: [
    { klucz: 's1', nazwa: 'Lampa wisząca', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', cena_netto: '100.00', zrodlo: 'sklep' },
    { klucz: 'r2', nazwa: 'Kurs szycia abażurów', ilosc: 1, cena_brutto: '57.00', brutto_linii: '57.00', zrodlo: 'reczna', reczna: true, vat: 'zw' },
  ],
  ...nad,
});

describe('vat.js — listy i sprawdzenie stawki', () => {
  it('STAWKI_VAT bez zmian (23, 8, 5, 0); STAWKI_Z_ZW = ta sama lista + „zw”', () => {
    expect(STAWKI_VAT).toEqual(['23', '8', '5', '0']);
    expect(STAWKI_Z_ZW).toEqual(['23', '8', '5', '0', 'zw']);
    expect(Object.isFrozen(STAWKI_Z_ZW)).toBe(true);
  });

  it('bez flagi „zw” nie jest stawką (także z { zw: false } i z liczbą w drugim argumencie)', () => {
    expect(czyStawkaVat('zw')).toBe(false);
    expect(czyStawkaVat(' zw ')).toBe(false);
    expect(czyStawkaVat('zw', { zw: false })).toBe(false);
    expect(czyStawkaVat('zw', {})).toBe(false);
    expect(czyStawkaVat('zw', null)).toBe(false);
    expect(['zw', '23'].filter(czyStawkaVat)).toEqual(['23']);
  });

  it('z flagą „zw” jest stawką; reszta listy jak bez flagi; „ZW”, „np”, „oo” dalej nie', () => {
    expect(czyStawkaVat('zw', { zw: true })).toBe(true);
    expect(czyStawkaVat(' zw ', { zw: true })).toBe(true);
    for (const s of ['23', '8', '5', '0', 23, 0]) expect(czyStawkaVat(s, { zw: true })).toBe(czyStawkaVat(s));
    for (const s of ['ZW', 'np', 'oo', '0 WDT', '', null, undefined, '08']) expect(czyStawkaVat(s, { zw: true })).toBe(false);
  });

  it('stawkiDlaProgramu: program wbudowany → z „zw”; inFakt, brak programu, brak opisu → STAWKI_VAT', () => {
    expect(stawkiDlaProgramu({ id: 'twojefaktury', wbudowany: true })).toBe(STAWKI_Z_ZW);
    expect(stawkiDlaProgramu({ id: 'infakt' })).toBe(STAWKI_VAT);
    expect(stawkiDlaProgramu({ id: 'infakt', wbudowany: false })).toBe(STAWKI_VAT);
    expect(stawkiDlaProgramu({ wbudowany: 'tak' })).toBe(STAWKI_VAT);
    expect(stawkiDlaProgramu(null)).toBe(STAWKI_VAT);
    expect(stawkiDlaProgramu(undefined)).toBe(STAWKI_VAT);
  });

  it('stawkaPozycji: ręczna „zw” bez flagi → domyślna (jak dziś), z flagą → „zw”; sklepowa zawsze domyślna', () => {
    const reczna = { zrodlo: 'reczna', vat: 'zw' };
    expect(stawkaPozycji(reczna, '23')).toBe('23');
    expect(stawkaPozycji(reczna, '8', { zw: false })).toBe('8');
    expect(stawkaPozycji(reczna, '23', { zw: true })).toBe('zw');
    expect(stawkaPozycji({ zrodlo: 'sklep', vat: 'zw' }, '23', { zw: true })).toBe('23');
    expect(stawkaPozycji({ zrodlo: 'reczna', vat: '8' }, 'zw', { zw: true })).toBe('8');
  });

  it('netto/brutto do pokazania: bez flagi „zw” daje to samo co dziś, z flagą netto = brutto', () => {
    // Dziś „zw” w dzielniku to NaN — zachowane znak w znak (nikt bez flagi nie poda tu „zw”).
    expect(nettoZBruttoDoPokazania('57.00', 'zw')).toBe('NaN');
    expect(bruttoZNetto('57.00', 'zw')).toBe('NaN');
    expect(nettoZBruttoDoPokazania('57.00', 'zw', { zw: true })).toBe('57.00');
    expect(bruttoZNetto('57,01', 'zw', { zw: true })).toBe('57.01');
    expect(nettoZBruttoDoPokazania('123.00', '23', { zw: true })).toBe(nettoZBruttoDoPokazania('123.00', '23'));
    expect(bruttoZNetto('100', '8', { zw: true })).toBe(bruttoZNetto('100', '8'));
    expect(nettoZBruttoDoPokazania('', 'zw', { zw: true })).toBeNull();
  });
});

describe('pozycje-reczne.js — stawka z formularza', () => {
  it('bez flagi „zw” to odmowa z tym samym zdaniem co dziś', () => {
    expect(() => parsujStawke('zw', '23')).toThrow('Nieznana stawka VAT „zw” — wybierz 23, 8, 5, 0%.');
    expect(() => parsujNowaPozycje({ nazwa: 'Kurs', ilosc: '1', cena_brutto: '57.00', vat: 'zw' }))
      .toThrow('Nieznana stawka VAT „zw”');
  });

  it('z flagą „zw” przechodzi; netto → brutto bez narzutu', () => {
    expect(parsujStawke('zw', '23', { zw: true })).toBe('zw');
    expect(parsujStawke('', 'zw', { zw: true })).toBe('zw');
    expect(parsujNowaPozycje({ nazwa: 'Kurs', ilosc: '2', cena_netto: '57,00', vat: 'zw' }, { zw: true }))
      .toEqual({ nazwa: 'Kurs', sku: null, ilosc: 2, cena_brutto: '57.00', brutto_linii: '114.00', vat: 'zw' });
  });

  it('z flagą stawka spoza listy dalej odmawia — zdanie wymienia też „zw”', () => {
    expect(() => parsujStawke('np', '23', { zw: true })).toThrow('Nieznana stawka VAT „np” — wybierz 23, 8, 5, 0% albo zw.');
  });

  it('z flagą stawki liczbowe dają to samo co bez flagi', () => {
    const body = { nazwa: 'Lampa', ilosc: '3', cena_netto: '81,30', vat: '23' };
    expect(parsujNowaPozycje(body, { zw: true })).toEqual(parsujNowaPozycje(body));
    expect(parsujNowaPozycje(body, { zw: true, wdt: true })).toEqual(parsujNowaPozycje(body, { wdt: true }));
  });
});

describe('stawka-vat.js — domyślna stawka firmy', () => {
  it('bez flagi wpis „zw” → STAWKA_VAT (23), jak każdy wpis spoza listy; z flagą → „zw”', () => {
    expect(czytajStawkeDomyslna(baza('zw'))).toBe('23');
    expect(czytajStawkeDomyslna(baza('zw'), { zw: true })).toBe('zw');
    expect(czytajStawkeDomyslna(baza('8'), { zw: true })).toBe('8');
    expect(czytajStawkeDomyslna(baza(undefined), { zw: true })).toBe('23');
  });

  it('zapis „zw” bez flagi odmawia i nic nie pisze; z flagą zapisuje', () => {
    const b = baza(undefined);
    expect(() => zapiszStawkeDomyslna(b, 'zw')).toThrow('Stawka VAT spoza listy: „zw”.');
    expect(b.zapisy).toHaveLength(0);
    zapiszStawkeDomyslna(b, 'zw', { zw: true });
    expect(b.zapisy).toHaveLength(1);
    expect(b.zapisy[0].arg.slice(0, 2)).toEqual(['vat.stawka_domyslna', 'zw']);
  });
});

describe('pozycje-faktury.js — linie dokumentu', () => {
  it('bez flagi: domyślna „zw” to wyjątek (jak dziś), ręczna „zw” idzie stawką domyślną', () => {
    expect(() => pozycjeDokumentu(zamowienie(), { stawkaDomyslna: 'zw' })).toThrow('brak albo zła stawka domyślna („zw”)');
    expect(pozycjeDokumentu(zamowienie(), { stawkaDomyslna: '23' }).map((l) => l.tax_symbol)).toEqual(['23', '23', '23']);
  });

  it('z flagą: ręczna „zw” zostaje „zw”, domyślna „zw” trafia do sklepowej i dostawy', () => {
    expect(pozycjeDokumentu(zamowienie(), { stawkaDomyslna: '23', zw: true }).map((l) => l.tax_symbol))
      .toEqual(['23', 'zw', '23']);
    expect(pozycjeDokumentu(zamowienie(), { stawkaDomyslna: 'zw', zw: true }).map((l) => l.tax_symbol))
      .toEqual(['zw', 'zw', 'zw']);
  });

  it('z flagą nabywca z UE dalej wymusza 0 na każdej linii (WDT bez zmian)', () => {
    expect(pozycjeDokumentu(zamowienie({ nip: 'DE123456789' }), { stawkaDomyslna: 'zw', zw: true }).map((l) => l.tax_symbol))
      .toEqual(['0', '0', '0']);
  });
});

describe('tabela-pozycji.js — karta zamówienia', () => {
  it('bez flagi: wiersze i podsumowanie jak dziś (ręczna „zw” liczona domyślną)', () => {
    const w = wierszePozycji(zamowienie(), { stawkaDomyslna: '23' });
    expect(w.map((x) => x.stawka)).toEqual(['23', '23', '23', null]);
    expect(w[1].stawkaWlasna).toBeNull();
    expect(w[1].cenaNetto).toBe('46.34');
    expect(podsumowanieVatKarty(zamowienie(), { stawkaDomyslna: '23' }))
      .toMatchObject({ nettoZl: '162.60', vatZl: '37.40', bruttoZl: '200.00', zeroKrajowe: false, blad: null });
  });

  it('z flagą: wiersz „zw” — netto = brutto, opis „zw” (bez %), stawka własna „zw”', () => {
    const w = wierszePozycji(zamowienie(), { stawkaDomyslna: '23', zw: true });
    expect(w.map((x) => x.stawka)).toEqual(['23', 'zw', '23', null]);
    expect(w[1]).toMatchObject({ cenaNetto: '57.00', stawkaOpis: 'zw', stawkaWlasna: 'zw' });
    expect(w[0].stawkaOpis).toBe('23%');
  });

  it('z flagą: podsumowanie mieszane „zw” + 23 — VAT tylko od części 23%', () => {
    // 123,00 / 23 → 100,00 + 23,00; 20,00 / 23 → 16,26 + 3,74; 57,00 zw → 57,00 + 0
    expect(podsumowanieVatKarty(zamowienie(), { stawkaDomyslna: '23', zw: true }))
      .toMatchObject({ nettoZl: '173.26', vatZl: '26.74', bruttoZl: '200.00', wdt: false, zeroKrajowe: false, blad: null });
  });

  it('z flagą i domyślną „zw”: cała karta bez VAT', () => {
    const w = wierszePozycji(zamowienie(), { stawkaDomyslna: 'zw', zw: true });
    expect(w.find((x) => x.wysylka)).toMatchObject({ stawka: 'zw', stawkaOpis: 'zw' });
    expect(podsumowanieVatKarty(zamowienie(), { stawkaDomyslna: 'zw', zw: true }))
      .toMatchObject({ nettoZl: '200.00', vatZl: '0.00', bruttoZl: '200.00' });
  });
});
