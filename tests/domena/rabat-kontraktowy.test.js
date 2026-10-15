import { describe, it, expect } from 'vitest';

import { stawkaKontraktowa, decyzjaRabatu } from '../../src/domena/rabat-kontraktowy.js';

const zBazy = (procent) => stawkaKontraktowa({ klientBazy: { rabat_procent: procent } });

describe('stawka kontraktowa', () => {
  it('bierze stawkę z karty klienta', () => {
    expect(stawkaKontraktowa({ klientBazy: { rabat_procent: 40 } }))
      .toEqual({ procent: 40, zrodlo: 'baza' });
  });

  it('klient spoza bazy nie ma stawki i wie o tym', () => {
    expect(stawkaKontraktowa({ klientBazy: null })).toEqual({ procent: 0, zrodlo: 'brak' });
  });

  // ⚠️ POLE `rozjazd` ODESZLO 24.08.2026 razem z `OMS_KLIENCI_ZBIORCZY`. Do tego dnia te same
  // 40% stały w DWOCH miejscach naraz i funkcja oddawala roznice, zeby karta mogla ja pokazac.
  // Zrodlo jest dzis JEDNO, wiec nie ma czego uzgadniac — a pole, ktore zawsze bylo `null`,
  // bylo by zaproszeniem do przywrocenia drugiego zrodla.
  it('wynik nie niesie już rozjazdu z konfiguracją', () => {
    expect(stawkaKontraktowa({ klientBazy: { rabat_procent: 40 } })).not.toHaveProperty('rozjazd');
  });
});

describe('decyzja o rabacie', () => {
  it('zamówienie bez rabatu dostaje stawkę umowną', () => {
    expect(decyzjaRabatu({ rabatZamowienia: 0, stawka: zBazy(40) })).toBe('ustaw');
  });

  // Uzgodnienie czlowieka wygrywa z automatem — decyzja wlasciciela z 23.08.2026.
  it('rabat wpisany ręcznie NIE jest nadpisywany, tylko zgłaszany', () => {
    expect(decyzjaRabatu({ rabatZamowienia: 25, stawka: zBazy(40) })).toBe('ostrzez');
  });

  it('zgodna stawka nie robi nic', () => {
    expect(decyzjaRabatu({ rabatZamowienia: 40, stawka: zBazy(40) })).toBe('nic');
  });

  // ⚠️ STRAZNIK OSTRZEZENIA WYJACEGO PRZY DOBRYCH DANYCH: klient spoza umowy z rabatem
  // wpisanym recznie to normalna sprzedaz, nie rozjazd.
  it('klient spoza bazy z ręcznym rabatem nie zapala niczego', () => {
    const spoza = stawkaKontraktowa({ klientBazy: null, klientZbiorczy: null });
    expect(decyzjaRabatu({ rabatZamowienia: 25, stawka: spoza })).toBe('nic');
  });

  it('klient z umową bez rabatu (0%) też nie zapala niczego przy zamówieniu bez rabatu', () => {
    expect(decyzjaRabatu({ rabatZamowienia: 0, stawka: zBazy(0) })).toBe('nic');
  });
});
