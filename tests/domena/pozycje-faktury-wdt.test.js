import { describe, it, expect } from 'vitest';
import { pozycjeDokumentu } from '../../src/domena/pozycje-faktury.js';
import { podsumowanieVat } from '../../src/domena/podsumowanie-vat.js';

// Stawka DOKUMENTU liczy się z NIP-u nabywcy (domain/wdt.js) — nabywca z UE dostaje 0%
// na KAŻDEJ pozycji, razem z dostawą. Fixture jak w pozycje-faktury.test.js: funkcje czyste.
const zamowienie = (nad = {}) => ({
  kwota_brutto: '123.00',
  koszt_dostawy_brutto: '0.00',
  pozycje: [{ nazwa: 'STOP', ilosc: 2, cena_brutto: '61.50' }],
  ...nad,
});

describe('pozycjeDokumentu — stawka dokumentu z NIP-u nabywcy', () => {
  it('nabywca z UE (WDT): każda pozycja i dostawa z tax_symbol 0', () => {
    const services = pozycjeDokumentu(zamowienie({
      nip: 'SK1000000001', kwota_brutto: '139.00', koszt_dostawy_brutto: '16.00',
    }), { stawkaDomyslna: '23' });
    expect(services).toEqual([
      { name: 'STOP', quantity: 2, gross_price: 12300, tax_symbol: '0' },
      { name: 'Dostawa', quantity: 1, gross_price: 1600, tax_symbol: '0' },
    ]);
  });

  it('nabywca krajowy: stawka 23 — dokładnie jak dotąd', () => {
    const services = pozycjeDokumentu(zamowienie({ nip: '1000001106' }), { stawkaDomyslna: '23' });
    expect(services[0].tax_symbol).toBe('23');
  });

  // Ręczna poprawka NIP-u na karcie (klient_reczny_json) WYGRYWA ze sklepem — dokładnie
  // ta sama reguła, którą faktura wskazuje nabywcę (daneFaktury). Bez tego karta
  // pokazywałaby nabywcę SK, a stawka szłaby po starym numerze.
  it('nadpisany ręcznie NIP rozstrzyga stawkę', () => {
    const services = pozycjeDokumentu(zamowienie({
      nip: '1000001106',
      klient_reczny_json: JSON.stringify({ nip: 'SK1000000001' }),
    }), { stawkaDomyslna: '23' });
    expect(services[0].tax_symbol).toBe('0');
  });

  // Proforma dla WDT drukuje podsumowanie z tej samej listy — 0% ma dać VAT 0
  // i netto równe brutto, bez ani jednej zmiany w podsumowanie-vat.js.
  it('podsumowanie VAT pozycji WDT: netto = brutto, podatek 0', () => {
    const services = pozycjeDokumentu(zamowienie({ nip: 'SK1000000001' }), { stawkaDomyslna: '23' });
    const wiersze = podsumowanieVat(services);
    expect(wiersze[0]).toEqual({ stawka: 0, suma: false, nettoGr: 12300, vatGr: 0, bruttoGr: 12300 });
  });
});
