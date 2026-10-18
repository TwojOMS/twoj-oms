// PRZ-093.09 — reguły formularza kuriera InPost w Ustawieniach (czyste funkcje). Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { sprawdzFormularzInpost, opcjeKlientaInpost, ADRES_INPOST } from '../../src/domena/konfiguracja-inpost.js';

const TOKEN = 'eyJ0eXAi.ZMYSLONY.token';
const OK = { nazwa: 'InPost', organizacja: '4242', token: TOKEN, paczkomatNadawczy: '' };

describe('sprawdzFormularzInpost', () => {
  it('poprawny formularz: bez błędów, przycięte pola, kod paczkomatu wielkimi literami', () => {
    const w = sprawdzFormularzInpost({ ...OK, organizacja: ' 4242 ', token: ` ${TOKEN}\n`, paczkomatNadawczy: ' abc01m ' });
    expect(w.bledy).toEqual([]);
    expect(w.ustawienia).toEqual({ nazwa: 'InPost', organizacja: '4242', paczkomatNadawczy: 'ABC01M' });
    expect(w.sekrety).toEqual({ token: TOKEN });
  });

  it('każde pole wymagane ma własny powód', () => {
    expect(sprawdzFormularzInpost({}).bledy).toEqual(['Podaj nazwę — dowolną, np. „InPost”.',
      'Podaj numer organizacji InPost (ID organizacji w ShipX).', 'Podaj token API ShipX.']);
  });

  it('organizacja tylko dodatnia liczba; token bez spacji w środku; zły kod paczkomatu; za długa nazwa', () => {
    expect(sprawdzFormularzInpost({ ...OK, organizacja: '12-34' }).bledy).toEqual(['Numer organizacji to same cyfry, większy od zera.']);
    expect(sprawdzFormularzInpost({ ...OK, organizacja: '0' }).bledy).toEqual(['Numer organizacji to same cyfry, większy od zera.']);
    expect(sprawdzFormularzInpost({ ...OK, token: 'ab cd' }).bledy).toEqual(['Token nie może zawierać spacji — skopiuj go w całości, bez dopisków.']);
    expect(sprawdzFormularzInpost({ ...OK, paczkomatNadawczy: 'KTY 01M' }).bledy).toEqual(['Kod paczkomatu nadawczego to litery i cyfry, np. ABC01M.']);
    expect(sprawdzFormularzInpost({ ...OK, nazwa: 'x'.repeat(61) }).bledy).toEqual(['Nazwa może mieć najwyżej 60 znaków.']);
  });

  it('pusty token przy istniejącym zapisie = zostaw zapisany; nowy zastępuje', () => {
    const zapisane = { ustawienia: {}, sekrety: { token: 'stary' } };
    const w = sprawdzFormularzInpost({ ...OK, token: '   ' }, zapisane);
    expect(w.bledy).toEqual([]);
    expect(w.sekrety).toEqual({ token: 'stary' });
    expect(sprawdzFormularzInpost({ ...OK, token: 'nowy' }, zapisane).sekrety).toEqual({ token: 'nowy' });
  });

  it('błędy formularza nie cytują tokenu', () => {
    const zly = 'eyJ SEKRET-W-BLEDZIE';
    expect(sprawdzFormularzInpost({ ...OK, token: zly }).bledy.join(' ')).not.toContain('SEKRET');
  });
});

describe('opcjeKlientaInpost', () => {
  const nadawca = { nazwa: 'N', ulica: 'U 1', kod: '00-001', miasto: 'M', kraj: 'PL', phone: '', email: '' };
  it('kształt jak opcje createInpostClient z pliku: produkcyjny adres, organizacja liczbą, brak paczkomatu = null', () => {
    const zapis = { ustawienia: { nazwa: 'InPost', organizacja: '4242', paczkomatNadawczy: '' }, sekrety: { token: TOKEN } };
    expect(opcjeKlientaInpost(zapis, nadawca)).toEqual({ url: ADRES_INPOST, token: TOKEN, organizacja: 4242, nadawca,
      paczkomatNadawczy: null });
    expect(ADRES_INPOST).toBe('https://api-shipx-pl.easypack24.net/v1');
  });

  it('paczkomat nadawczy przechodzi do klienta', () => {
    const zapis = { ustawienia: { organizacja: '7', paczkomatNadawczy: 'ABC01M' }, sekrety: { token: TOKEN } };
    expect(opcjeKlientaInpost(zapis, nadawca).paczkomatNadawczy).toBe('ABC01M');
  });
});
