import { describe, it, expect } from 'vitest';
import { stawkaWiersza, przelicz } from '../../src/public/cena-netto.js';
import { bruttoZNetto, nettoZBruttoDoPokazania } from '../../src/domena/vat.js';

// PRZ-105: przeliczanie netto ↔ brutto w przeglądarce (karta „Dodaj pozycję” i ekran „Nowe zamówienie”) — plik,
// który naprawdę jedzie do przeglądarki, na atrapach elementów (repo nie ma biblioteki DOM). Stawka z listy
// w wierszu, bez listy z `data-vat` formularza; `data-wdt="1"` (nabywca z UE) = 0%. Zmiana stawki zostawia
// BRUTTO (wartość przechowywaną) i przelicza netto — ten sam kierunek, co serwer (brutto wygrywa).

const pole = (name, value = '') => ({ name, value });
function wiersz({ netto = '', brutto = '', vat = null } = {}) {
  const pola = { netto: pole('poz_cena_netto', netto), brutto: pole('poz_cena_brutto', brutto) };
  if (vat !== null) pola.vat = { ...pole('poz_vat', vat), tagName: 'SELECT' };
  const tr = {
    dataset: {},
    querySelector: (s) => (s.includes('cena_netto') ? pola.netto : s.includes('cena_brutto') ? pola.brutto
      : s.includes('vat') ? (pola.vat ?? null) : null),
  };
  for (const p of Object.values(pola)) p.closest = (s) => (s === 'tr' ? tr : null);
  return { tr, ...pola };
}
const formularz = (dataset) => ({ dataset });

describe('stawkaWiersza', () => {
  it('lista w wierszu wygrywa z data-vat formularza', () => {
    expect(stawkaWiersza(wiersz({ vat: '8' }).tr, formularz({ vat: '23', wdt: '0' }))).toBe(8);
  });
  it('bez listy — data-vat; 0 jest stawką, nie „brak”', () => {
    expect(stawkaWiersza(wiersz().tr, formularz({ vat: '5' }))).toBe(5);
    expect(stawkaWiersza(wiersz().tr, formularz({ vat: '0' }))).toBe(0);
  });
  it('data-wdt="1" → 0 niezależnie od listy', () => {
    expect(stawkaWiersza(wiersz({ vat: '23' }).tr, formularz({ vat: '23', wdt: '1' }))).toBe(0);
  });
  it('brak albo zepsuty data-vat i brak listy → null (skrypt nic nie liczy)', () => {
    expect(stawkaWiersza(wiersz().tr, formularz({}))).toBeNull();
    expect(stawkaWiersza(wiersz().tr, formularz({ vat: 'abc' }))).toBeNull();
  });
});

describe('przelicz — wynik zgodny z serwerem (domain/vat.js)', () => {
  const f = formularz({ vat: '23', wdt: '0' });

  it('wpisane netto przy 8% → brutto jak bruttoZNetto', () => {
    const w = wiersz({ netto: '99,99', vat: '8' });
    przelicz({ target: w.netto }, f);
    expect(w.brutto.value).toBe(bruttoZNetto('99.99', '8'));
  });

  it('wpisane brutto przy 5% → netto jak nettoZBruttoDoPokazania', () => {
    const w = wiersz({ brutto: '10.50', vat: '5' });
    przelicz({ target: w.brutto }, f);
    expect(w.netto.value).toBe(nettoZBruttoDoPokazania('10.50', '5'));
  });

  it('zmiana stawki zostawia brutto i przelicza netto', () => {
    const w = wiersz({ netto: '100.00', brutto: '123.00', vat: '8' });
    przelicz({ target: w.vat }, f);
    expect(w.brutto.value).toBe('123.00');
    expect(w.netto.value).toBe('113.89');
  });

  // Recenzja PRZ-105 (P2): kolumny stoją netto → stawka → brutto, więc naturalna kolejność to „wpisz netto,
  // wybierz stawkę”. Brutto policzone przez skrypt starą stawką nie może zostać — klient zapłaciłby 123 zł
  // zamiast 108 zł. Zmiana stawki liczy z pola, które operator wpisał OSTATNIO.
  it('netto wpisane ręcznie, potem stawka 8 → brutto 108,00 (liczy z netto)', () => {
    const w = wiersz({ netto: '100', vat: '23' });
    przelicz({ target: w.netto }, f);
    expect(w.brutto.value).toBe('123.00');
    w.vat.value = '8';
    przelicz({ target: w.vat }, f);
    expect(w.brutto.value).toBe('108.00');
    expect(w.netto.value).toBe('100');
  });

  it('brutto wpisane ręcznie, potem stawka 8 → brutto zostaje, netto z brutto', () => {
    const w = wiersz({ brutto: '123.00', vat: '23' });
    przelicz({ target: w.brutto }, f);
    w.vat.value = '8';
    przelicz({ target: w.vat }, f);
    expect(w.brutto.value).toBe('123.00');
    expect(w.netto.value).toBe('113.89');
  });

  it('zmiana stawki przy samym netto (brutto puste) liczy brutto', () => {
    const w = wiersz({ netto: '100.00', vat: '5' });
    przelicz({ target: w.vat }, f);
    expect(w.brutto.value).toBe('105.00');
  });

  it('WDT: netto 100 → brutto 100,00', () => {
    const w = wiersz({ netto: '100', vat: '23' });
    przelicz({ target: w.netto }, formularz({ vat: '23', wdt: '1' }));
    expect(w.brutto.value).toBe('100.00');
  });

  it('pole spoza pary i formularz bez stawki — nic nie rusza', () => {
    const w = wiersz({ netto: '100' });
    przelicz({ target: pole('poz_nazwa', 'X') }, f);
    przelicz({ target: w.netto }, formularz({}));
    expect(w.brutto.value).toBe('');
  });
});
