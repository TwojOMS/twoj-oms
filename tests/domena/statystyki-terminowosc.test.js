import { describe, it, expect } from 'vitest';
import { terminowosc } from '../../src/domena/statystyki-wysylki.js';

// Czwartek 13.08.2026, opłacone 06:00Z = 08:00 PL.
const z = (d = {}) => ({
  sklep: 'szkicownia', pobranie: 0, b2b: 0, indywidualne: 0, pozycje: [],
  utworzone_at: '2026-08-13T06:00:00Z', oplacone_at: '2026-08-13T06:00:00Z',
  wyslane_at: '2026-08-13T14:00:00Z', ...d,
});

describe('terminowosc — procenty i mianownik', () => {
  it('liczy oba procenty z mianownika wysłanych', () => {
    const w = terminowosc([
      z(),                                          // tego samego dnia, w terminie
      z({ wyslane_at: '2026-08-14T07:00:00Z' }),     // 1 dzień rob., w terminie
      z({ wyslane_at: '2026-08-18T07:00:00Z' }),     // 3 dni rob., PO terminie
      z({ wyslane_at: '2026-08-17T07:00:00Z' }),     // 2 dni rob., PO terminie
    ]);
    expect(w.mianownik).toBe(4);
    expect(w.wTerminie).toBe(2);
    expect(w.tegoSamegoDnia).toBe(1);
    expect(w.procentWTerminie).toBe(50);
    expect(w.procentTegoSamegoDnia).toBe(25);
  });

  it('rozkład ma cztery pozycje w stałej kolejności, także gdy są puste', () => {
    const w = terminowosc([z()]);
    expect(w.rozklad.map((p) => p.etykieta))
      .toEqual(['tego samego dnia', '1 dzień rob.', '2 dni rob.', '3+ dni rob.']);
    expect(w.rozklad.map((p) => p.ile)).toEqual([1, 0, 0, 0]);
  });

  // ⚠️ GRANICA 0/1 DNIA W ROZKŁADZIE — dopisane po recenzji 13.09.2026, bo jej brakowało.
  // Zamówienie wysłane NAZAJUTRZ ma zero różnicy z zamówieniem wysłanym tego samego dnia
  // w każdym innym wskaźniku (oba są w terminie, oba w mianowniku), więc jedynym miejscem,
  // gdzie się rozchodzą, jest właśnie ten kubełek. Bez tej asercji mutacja `dniRobocze <= 1`
  // → `< 1` przechodziła całą suitę na zielono: rozkład pokazywałby paczkę wysłaną jutro
  // jako „tego samego dnia", czyli wskaźnik, o który właściciel poprosił wprost, kłamałby
  // w najlepszą stronę.
  it('wysłane nazajutrz wpada w „1 dzień rob.", nie w „tego samego dnia"', () => {
    const w = terminowosc([z({ wyslane_at: '2026-08-14T07:00:00Z' })]);
    expect(w.rozklad.map((p) => p.ile)).toEqual([0, 1, 0, 0]);
    expect(w.tegoSamegoDnia).toBe(0);
    expect(w.procentTegoSamegoDnia).toBe(0);
  });

  it('3+ zbiera wszystko powyżej dwóch dni roboczych', () => {
    const w = terminowosc([
      z({ wyslane_at: '2026-08-18T07:00:00Z' }),
      z({ wyslane_at: '2026-08-25T07:00:00Z' }),
    ]);
    expect(w.rozklad[3].ile).toBe(2);
  });

  // ⚠️ BRAK WIEDZY TO NIE ZERO. Przy zerowej liczbie wysłanych procent jest `null`,
  // a widok rysuje „—". `0%` czytałoby się jako „nic nie wyszło w terminie".
  it('zero wysłanych daje null, nie zero procent', () => {
    const w = terminowosc([z({ wyslane_at: null }), z({ wyslane_at: null })]);
    expect(w.mianownik).toBe(0);
    expect(w.procentWTerminie).toBeNull();
    expect(w.procentTegoSamegoDnia).toBeNull();
    expect(w.rozklad.every((p) => p.ile === 0 && p.udzial === null)).toBe(true);
  });

  it('pusta lista nie wybucha', () => {
    const w = terminowosc([]);
    expect(w).toMatchObject({ mianownik: 0, wTerminie: 0, tegoSamegoDnia: 0 });
    expect(w.wylaczenia).toEqual({ niewyslane: 0, przedWplata: 0, bezStartu: 0 });
  });
});

describe('terminowosc — trzy wyłączenia stoją osobno i NIE wchodzą do procentu', () => {
  it('niewysłane', () => {
    const w = terminowosc([z(), z({ wyslane_at: null })]);
    expect(w.mianownik).toBe(1);
    expect(w.wylaczenia.niewyslane).toBe(1);
    expect(w.procentWTerminie).toBe(100);
  });

  // ⚠️ Zmierzone na produkcji: 15 zamówień, jedno o 217 h (28171: wysłane 4.08, opłacone 13.08).
  it('wysłane przed wpłatą', () => {
    const w = terminowosc([
      z(),
      z({ oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-04T10:07:34.648Z' }),
    ]);
    expect(w.mianownik).toBe(1);
    expect(w.wylaczenia.przedWplata).toBe(1);
    expect(w.procentWTerminie).toBe(100);
  });

  // ⚠️⚠️ RECENZJA 13.09.2026: na produkcji 13 z 15 zamówień „wysłanych przed wpłatą" różni
  // się o SEKUNDY, czyli mieści się w tym samym dniu warszawskim. Dawny warunek porównywał
  // dni, więc te 13 wpadało do mianownika jako wysyłki wzorowe („tego samego dnia",
  // „w terminie"), a wiersz wyłączenia pokazywał 2 zamiast 15 — czyli ekran chwalił wynik
  // przypadkami, których w ogóle nie umie policzyć.
  it('wysłane przed wpłatą W RAMACH JEDNEGO DNIA też wypada z mianownika', () => {
    const w = terminowosc([
      z(),
      // opłacone 20:00 PL, wysłane 08:00 PL tego samego dnia — 12 h ujemnego czasu.
      z({ oplacone_at: '2026-08-13T18:00:00Z', wyslane_at: '2026-08-13T06:00:00Z' }),
    ]);
    expect(w.mianownik).toBe(1);
    expect(w.wylaczenia.przedWplata).toBe(1);
    expect(w.tegoSamegoDnia).toBe(1);
    expect(w.procentTegoSamegoDnia).toBe(100);
    expect(w.rozklad[0].ile).toBe(1);
  });

  it('bez daty startu — nieopłacona przedpłata, która jednak wyszła', () => {
    const w = terminowosc([z(), z({ oplacone_at: null })]);
    expect(w.mianownik).toBe(1);
    expect(w.wylaczenia.bezStartu).toBe(1);
  });

  it('trzy wyłączenia i mianownik sumują się do długości listy', () => {
    const lista = [
      z(), z(),
      z({ wyslane_at: null }),
      z({ oplacone_at: null }),
      z({ oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-04T06:00:00Z' }),
    ];
    const w = terminowosc(lista);
    const { niewyslane, przedWplata, bezStartu } = w.wylaczenia;
    expect(w.mianownik + niewyslane + przedWplata + bezStartu).toBe(lista.length);
  });
});

describe('terminowosc — limit zależy od typu zamówienia', () => {
  it('Allegro przed 12:00 wysłane nazajutrz jest PO terminie, sklepowe nie', () => {
    const jutro = '2026-08-14T07:00:00Z';
    expect(terminowosc([z({ sklep: 'allegro_szkicownia', wyslane_at: jutro })]).wTerminie).toBe(0);
    expect(terminowosc([z({ wyslane_at: jutro })]).wTerminie).toBe(1);
  });

  it('indywidualne ma 7 dni roboczych', () => {
    const w = terminowosc([z({ indywidualne: 1, wyslane_at: '2026-08-21T07:00:00Z' })]);
    expect(w.wTerminie).toBe(1);
    expect(w.rozklad[3].ile).toBe(1);
  });

  it('ekspres ma 2 dni i bije indywidualne', () => {
    const w = terminowosc([z({
      indywidualne: 1, pozycje: [{ nazwa: 'Realizacja ekspresowa' }],
      wyslane_at: '2026-08-18T07:00:00Z',
    })]);
    expect(w.wTerminie).toBe(0);
  });

  it('pobranie liczy od złożenia, bo wpłaty przed wysyłką nie ma', () => {
    const w = terminowosc([z({
      pobranie: 1, oplacone_at: null,
      utworzone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-14T07:00:00Z',
    })]);
    expect(w.mianownik).toBe(1);
    expect(w.wTerminie).toBe(1);
    expect(w.wylaczenia.bezStartu).toBe(0);
  });
});
