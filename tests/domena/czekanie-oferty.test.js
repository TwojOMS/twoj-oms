import { describe, it, expect } from 'vitest';
import { powodCzekaniaOferty, zdanieCzekaniaOferty, naglowekOferty } from '../../src/domena/czekanie-oferty.js';

const konto = (zmiany = {}) => ({
  klucz: 'allegro_polcien',
  nazwa: 'Pracownia Półcień',
  zgoda: true,
  tylkoOdczyt: () => false,
  ...zmiany,
});
const CZYNNE = { czynne: true };
const TERAZ = Date.parse('2026-11-19T12:00:00.000Z');
const oferta = (zmiany = {}) => ({ stan: 'do_wyslania', nastepnaProbaAt: null, wyslanePola: null, ...zmiany });
const zdanie = (zmiany = {}) =>
  zdanieCzekaniaOferty({
    rodzaj: 'allegro',
    konto: konto(),
    ustawienia: CZYNNE,
    oferta: oferta(),
    teraz: TERAZ,
    ...zmiany,
  });

describe('powód, dla którego pętla ofert Allegro pomija konto', () => {
  it('konto gotowe → brak powodu', () => {
    expect(powodCzekaniaOferty(konto(), CZYNNE)).toBeNull();
  });
  it('brak zgody na zapis ofert', () => {
    expect(powodCzekaniaOferty(konto({ zgoda: false }), CZYNNE)).toBe('brak_zgody');
    expect(powodCzekaniaOferty(konto({ zgoda: undefined }), CZYNNE)).toBe('brak_zgody');
  });
  it('oferty konta wstrzymane (czynne = false)', () => {
    expect(powodCzekaniaOferty(konto(), { czynne: false })).toBe('wstrzymane');
  });
  it('zapisy kanału zablokowane', () => {
    expect(powodCzekaniaOferty(konto({ tylkoOdczyt: () => true }), CZYNNE)).toBe('zablokowane');
  });
  it('kolejność: brak zgody wygrywa z wstrzymaniem, wstrzymanie z blokadą', () => {
    const wszystko = konto({ zgoda: false, tylkoOdczyt: () => true });
    expect(powodCzekaniaOferty(wszystko, { czynne: false })).toBe('brak_zgody');
    expect(powodCzekaniaOferty(konto({ tylkoOdczyt: () => true }), { czynne: false })).toBe('wstrzymane');
  });
});

describe('zdanie pod stanem oferty, która jeszcze nie wyszła', () => {
  it('brak zgody → zdanie o ponownym połączeniu konta, z nazwą konta', () => {
    expect(zdanie({ konto: konto({ zgoda: false }), ustawienia: { czynne: false } })).toEqual({
      kod: 'brak_zgody',
      tekst:
        'Czeka: konto Pracownia Półcień nie ma zgody na zapis ofert — połącz je ponownie w Ustawieniach → Integracje.',
      krok: null,
    });
  });
  it('wstrzymane → zdanie o „Oferty: czynne” i adres kroku Oferty konta', () => {
    expect(zdanie({ ustawienia: { czynne: false } })).toEqual({
      kod: 'wstrzymane',
      tekst:
        'Czeka: konto Pracownia Półcień ma oferty wstrzymane — nic nie wyjdzie do Allegro, dopóki nie włączysz „Oferty: czynne” w kroku Oferty konta.',
      krok: '/ustawienia/integracje/allegro/allegro_polcien/oferty#allegro-oferty-ustawienia',
    });
  });
  it('blokada zapisu → zdanie o zablokowanych zapisach', () => {
    expect(zdanie({ konto: konto({ tylkoOdczyt: () => true }) }).tekst).toBe(
      'Czeka: zapisy do konta Pracownia Półcień są zablokowane (Ustawienia → Integracje).',
    );
  });
  it('termin następnej próby w przyszłości → godzina po warszawsku', () => {
    expect(zdanie({ oferta: oferta({ nastepnaProbaAt: '2026-11-19T12:35:00.000Z' }) })).toEqual({
      kod: 'nastepna_proba',
      tekst: 'Następna próba: 19.11.2026 13:35.',
      krok: null,
    });
  });
  it('termin w przeszłości i konto gotowe → zdanie domyślne', () => {
    expect(zdanie({ oferta: oferta({ nastepnaProbaAt: '2026-11-19T11:00:00.000Z' }) }).tekst).toBe(
      'Czeka na wysłanie — OMS wysyła oferty co 5 minut.',
    );
  });
  it('bez nazwy konta zdanie podaje klucz', () => {
    expect(zdanie({ konto: konto({ nazwa: '' }), ustawienia: { czynne: false } }).tekst).toContain(
      'konto allegro_polcien ma',
    );
  });
  it('szkic ze zleconą aktywacją czeka tak samo', () => {
    const szkic = oferta({ stan: 'nieaktywna', wyslanePola: { szkic: true, aktywuj: true } });
    expect(zdanie({ oferta: szkic, ustawienia: { czynne: false } }).kod).toBe('wstrzymane');
  });
  it('oferta już wysłana (także bez odczytu) → bez zdania', () => {
    for (const stan of ['wyslana', 'sprawdzana', 'aktywna', 'nieaktywna', 'problem', 'blad'])
      expect(zdanie({ oferta: oferta({ stan }), ustawienia: { czynne: false } })).toBeNull();
  });
  it('ERLI: warunki konta nie grają (pętla ERLI ich nie ma) — tylko termin próby albo zdanie domyślne', () => {
    const erli = { klucz: 'erli-polcien', nazwa: 'Półcień', tylkoOdczyt: () => true };
    expect(zdanie({ rodzaj: 'erli', konto: erli, ustawienia: { czynne: false } }).kod).toBe('domyslne');
    expect(
      zdanie({
        rodzaj: 'erli',
        konto: erli,
        ustawienia: null,
        oferta: oferta({ nastepnaProbaAt: '2026-11-19T12:35:00.000Z' }),
      }).kod,
    ).toBe('nastepna_proba');
  });
});

describe('nagłówek oferty na karcie', () => {
  it('Allegro przed wysłaniem: nazwa konta, bez klucza i bez ext:', () => {
    expect(
      naglowekOferty({
        rodzaj: 'allegro',
        konto: konto(),
        oferta: { kanal: 'allegro_polcien', idZewnetrzne: 'ext:ab-K12' },
      }),
    ).toBe('Allegro · Pracownia Półcień');
  });
  it('Allegro po wysłaniu: z numerem oferty', () => {
    expect(
      naglowekOferty({
        rodzaj: 'allegro',
        konto: konto(),
        oferta: { kanal: 'allegro_polcien', idZewnetrzne: '19137921550' },
      }),
    ).toBe('Allegro · Pracownia Półcień · oferta 19137921550');
  });
  it('ERLI: numer dopiero, gdy oferta wyszła ze stanu do wysłania', () => {
    const erli = { klucz: 'erli-polcien', nazwa: 'Półcień' };
    const o = { kanal: 'erli-polcien', idZewnetrzne: 'PLC-12' };
    expect(naglowekOferty({ rodzaj: 'erli', konto: erli, oferta: { ...o, stan: 'do_wyslania' } })).toBe(
      'ERLI · Półcień',
    );
    expect(naglowekOferty({ rodzaj: 'erli', konto: erli, oferta: { ...o, stan: 'aktywna' } })).toBe(
      'ERLI · Półcień · oferta PLC-12',
    );
  });
  it('bez nazwy konta → klucz; konto nieznane → kanał, nigdy ext:', () => {
    expect(
      naglowekOferty({ rodzaj: 'allegro', konto: konto({ nazwa: null }), oferta: { idZewnetrzne: 'ext:x' } }),
    ).toBe('Allegro · allegro_polcien');
    expect(
      naglowekOferty({ rodzaj: null, konto: null, oferta: { kanal: 'allegro_stare', idZewnetrzne: 'ext:x-K1' } }),
    ).toBe('allegro_stare');
  });
});
