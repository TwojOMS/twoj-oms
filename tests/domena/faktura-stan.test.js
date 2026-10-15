import { describe, it, expect } from 'vitest';
import { stanFaktury, fakturaWymagaCzlowieka, PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../src/domena/faktura-stan.js';

const TERAZ = Date.parse('2026-07-30T12:00:00Z');
const przed = (ms) => new Date(TERAZ - ms).toISOString();

describe('stanFaktury', () => {
  it('brak wiersza → brak', () => {
    expect(stanFaktury(null, TERAZ)).toBe('brak');
    expect(stanFaktury(undefined, TERAZ)).toBe('brak');
  });

  it('świeża rezerwacja → w_toku', () => {
    expect(stanFaktury({ ksef_status: 'w_toku', utworzona_at: przed(3000) }, TERAZ)).toBe('w_toku');
  });

  // Sedno: proces panelu padl w trakcie wywolania inFaktu, wiec wiersz 'w_toku' zostal na
  // zawsze. Bez tego progu panel w nieskonczonosc odpowiadal „wlasnie trwa, odswiez za chwile".
  it('rezerwacja starsza niż próg → zawieszona', () => {
    const f = { ksef_status: 'w_toku', utworzona_at: przed(PROG_ZAWIESZONEJ_FAKTURY_MS + 1000) };
    expect(stanFaktury(f, TERAZ)).toBe('zawieszona');
  });

  // Granica pinowana OSOBNO: zamiana >= na > (albo progu na inna wartosc) ma psuc test.
  it('dokładnie na progu jest już zawieszona, sekundę wcześniej jeszcze trwa', () => {
    expect(stanFaktury({ ksef_status: 'w_toku', utworzona_at: przed(PROG_ZAWIESZONEJ_FAKTURY_MS) }, TERAZ)).toBe('zawieszona');
    expect(stanFaktury({ ksef_status: 'w_toku', utworzona_at: przed(PROG_ZAWIESZONEJ_FAKTURY_MS - 1000) }, TERAZ)).toBe('w_toku');
  });

  // Nieczytelna data NIE jest dowodem, ze cokolwiek trwa. Uznanie jej za „trwa" dawaloby
  // dokladnie te wieczna blokade, ktorej ten stan ma zapobiegac.
  it('nieczytelna data rezerwacji → zawieszona, nie wieczne „trwa”', () => {
    expect(stanFaktury({ ksef_status: 'w_toku', utworzona_at: 'kiedyś' }, TERAZ)).toBe('zawieszona');
    expect(stanFaktury({ ksef_status: 'w_toku', utworzona_at: null }, TERAZ)).toBe('zawieszona');
  });

  it('do_wyjasnienia zostaje sobą niezależnie od wieku', () => {
    expect(stanFaktury({ ksef_status: 'do_wyjasnienia', utworzona_at: przed(1000) }, TERAZ)).toBe('do_wyjasnienia');
  });

  it('wiersz z numerem → wystawiona', () => {
    expect(stanFaktury({ ksef_status: 'sent', numer: 'FV/1/2026', utworzona_at: przed(1000) }, TERAZ)).toBe('wystawiona');
  });
});

describe('fakturaWymagaCzlowieka', () => {
  it('do_wyjasnienia i zawieszona wymagają decyzji człowieka', () => {
    expect(fakturaWymagaCzlowieka({ ksef_status: 'do_wyjasnienia', utworzona_at: przed(1000) }, TERAZ)).toBe(true);
    expect(fakturaWymagaCzlowieka({ ksef_status: 'w_toku', utworzona_at: przed(PROG_ZAWIESZONEJ_FAKTURY_MS * 2) }, TERAZ)).toBe(true);
  });

  it('brak, trwające wystawianie i gotowa faktura NIE wymagają', () => {
    expect(fakturaWymagaCzlowieka(null, TERAZ)).toBe(false);
    expect(fakturaWymagaCzlowieka({ ksef_status: 'w_toku', utworzona_at: przed(1000) }, TERAZ)).toBe(false);
    expect(fakturaWymagaCzlowieka({ ksef_status: 'sent', numer: 'FV/1/2026', utworzona_at: przed(1000) }, TERAZ)).toBe(false);
  });
});
