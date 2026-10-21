import { describe, it, expect } from 'vitest';
import { wierszePozycji, podsumowanieVatKarty } from '../../src/domena/tabela-pozycji.js';
import { pozycjeDokumentu } from '../../src/domena/pozycje-faktury.js';
import { podsumowanieWierszami } from '../../src/domena/podsumowanie-wierszami.js';

// PRZ-105: karta pokazuje stawkę każdej pozycji i podsumowanie netto / VAT / brutto — liczone z TYCH SAMYCH linii,
// które idą na fakturę (pozycjeDokumentu), regułą faktury (podsumowanieWierszami). Grosz różnicy = błąd.
const zamowienie = (nad = {}) => ({
  sklep: 'pro',
  kwota_brutto: '256.00',
  koszt_dostawy_brutto: '25.00',
  pozycje: [
    { klucz: 's1', nazwa: 'Lampa', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', cena_netto: '100.00', zrodlo: 'sklep', vat: '8' },
    { klucz: 'r2', nazwa: 'Album', ilosc: 1, cena_brutto: '108.00', brutto_linii: '108.00', zrodlo: 'reczna', reczna: true, vat: '8' },
  ],
  ...nad,
});

describe('wierszePozycji — stawka w wierszu (PRZ-105)', () => {
  it('sklepowa → domyślna, ręczna → własna, wysyłka → domyślna; „Razem” bez stawki', () => {
    const w = wierszePozycji(zamowienie(), { stawkaDomyslna: '23' });
    expect(w.map((x) => x.stawka)).toEqual(['23', '8', '23', null]);
  });

  it('netto pozycji ręcznej liczone JEJ stawką: 108,00 przy 8% → 100,00', () => {
    const w = wierszePozycji(zamowienie(), { stawkaDomyslna: '23' });
    expect(w[1].cenaNetto).toBe('100.00');
  });

  it('nabywca z UE → każda stawka 0 i opis „0% — WDT”', () => {
    const w = wierszePozycji(zamowienie({ nip: 'DE123456789' }), { stawkaDomyslna: '23' });
    expect(w.filter((x) => !x.podsumowanie).map((x) => x.stawka)).toEqual(['0', '0', '0']);
    expect(w[0].stawkaOpis).toBe('0% — WDT');
  });

  it('zamówienie ręczne: netto wysyłki liczone stawką domyślną (nie „—”), 19,00 przy 23% → 15,45', () => {
    const w = wierszePozycji(zamowienie({ sklep: 'reczne', koszt_dostawy_brutto: '19.00', kwota_brutto: '250.00' }), { stawkaDomyslna: '23' });
    expect(w.find((x) => x.wysylka).cenaNetto).toBe('15.45');
  });

  it('bez opcji (maile, nadanie) wiersze dalej się budują — stawka wbudowana', () => {
    expect(wierszePozycji(zamowienie())[0].stawka).toBe('23');
  });
});

describe('podsumowanieVatKarty (PRZ-105)', () => {
  it('równa się podsumowaniu linii faktury: 123/23 + 108/8 + 25/23 dostawy', () => {
    const z = zamowienie();
    const s = podsumowanieVatKarty(z, { stawkaDomyslna: '23' });
    const f = podsumowanieWierszami(pozycjeDokumentu(z, { stawkaDomyslna: '23' })
      .map((l) => ({ bruttoGr: l.gross_price, stawka: l.tax_symbol })));
    expect(s).toMatchObject({ nettoZl: '220.33', vatZl: '35.67', bruttoZl: '256.00', wdt: false, zeroKrajowe: false });
    expect([s.nettoZl, s.vatZl, s.bruttoZl]).toEqual([f.nettoGr, f.vatGr, f.bruttoGr].map((g) => (g / 100).toFixed(2)));
  });

  it('NIP z UE → VAT 0,00, netto = brutto, wdt: true', () => {
    expect(podsumowanieVatKarty(zamowienie({ nip: 'DE123456789' }), { stawkaDomyslna: '23' }))
      .toMatchObject({ nettoZl: '256.00', vatZl: '0.00', wdt: true });
  });

  it('pozycja 0% u nabywcy krajowego → zeroKrajowe: true (ostrzeżenie na ekranie)', () => {
    const z = zamowienie();
    z.pozycje[1].vat = '0';
    expect(podsumowanieVatKarty(z, { stawkaDomyslna: '23' }).zeroKrajowe).toBe(true);
  });

  it('uszkodzona kwota → blad zamiast liczb, karta nie pada', () => {
    const z = zamowienie();
    z.pozycje[0].brutto_linii = 'zła';
    z.pozycje[0].cena_brutto = 'zła';
    const s = podsumowanieVatKarty(z, { stawkaDomyslna: '23' });
    expect(s.blad).toBeTruthy();
    expect(s.nettoZl).toBeNull();
  });
});
