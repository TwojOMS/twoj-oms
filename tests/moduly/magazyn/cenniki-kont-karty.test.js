import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { migracjaCennikowKanalowKart } from '../../../src/moduly/magazyn/migracje/0007-cenniki-kanalow-kart.ts';
import { dodajCennikOms, ustawCennikKarty, ustawPowiazanieCennika } from '../../../src/oms/db/cenniki-oms.ts';
import { ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import {
  usunWyjatekCennika,
  wyjatekCennika,
  wyjatkiCennikowKarty,
  zapiszWyjatekCennika,
  zrodloWyjatkuCennika,
} from '../../../src/oms/db/cenniki-kart.ts';
import { dobierzCennik, regulyKonta } from '../../../src/domena/cennik-dostaw.js';

// Cennik kanału wybrany na karcie dla jednego konta: wygrywa z cennikiem OMS karty, ten z doborem po rozmiarze,
// a bez żadnego z nich jest odmowa. Dane zmyślone: lampy „Pracowni Półcień”, konta allegro_lampy, erli_lampy
// i allegro_lampy_stare (konto, którego już nie ma w konfiguracji).

const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:05:00.000Z';
const A = 'allegro_lampy';
const B = 'erli_lampy';
const STARE = 'allegro_lampy_stare';
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
});

function baza() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: () => new Date(T0) });
  bazy.push(db);
  // Demo zakłada własne cenniki — test zaczyna od czystych.
  db.prepare('DELETE FROM cenniki_dostaw_oms').run();
  const karta = db.prepare(
    `INSERT INTO karty_produktow (id, sku, nazwa, szerokosc_mm, wysokosc_mm, glebokosc_mm, waga_g,
    utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  karta.run(801, 'LMP-801', 'Lampka nocna Półcień', 300, 200, 60, 1500, T0, T0);
  karta.run(802, 'LMP-802', 'Kinkiet Półcień', 300, 200, 60, 1500, T0, T0);
  return db;
}

const dobor = (db, kartaId, konto) => {
  const w = dobierzCennik({
    karta: db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(kartaId),
    reguly: regulyKonta(ustawieniaOfertKonta(db, konto)),
    wyjatek: wyjatekCennika(db, { kartaId, konto }),
  });
  return w.odmowa ? 'odmowa' : w.cennik;
};

// Konto A: cennik po rozmiarze i powiązanie z cennikiem OMS „Szkło ostrożnie”; konto B tylko cennik po rozmiarze.
function cenniki(db) {
  const mala = dodajCennikOms(db, { nazwa: 'Mała paczka', doMm: [400, 300, 100], doG: 5000 }, { teraz: T0 });
  ustawPowiazanieCennika(db, { cennikId: mala, konto: A, cennikKanalu: 'a-mala' }, { teraz: T0 });
  ustawPowiazanieCennika(db, { cennikId: mala, konto: B, cennikKanalu: 'Mała paczka ERLI' }, { teraz: T0 });
  const szklo = dodajCennikOms(db, { nazwa: 'Szkło ostrożnie' }, { teraz: T0 });
  ustawPowiazanieCennika(db, { cennikId: szklo, konto: A, cennikKanalu: 'a-szklo' }, { teraz: T0 });
  return { mala, szklo };
}

describe('migracja cennika kanału na karcie', () => {
  it('ponowne uruchomienie nie wybucha i nie rusza zapisanych wyborów; dawna tabela zostaje', () => {
    const db = baza();
    zapiszWyjatekCennika(db, { kartaId: 801, konto: A, cennik: 'a-wybrany' }, { teraz: T0, aktor: 'administrator' });
    migracjaCennikowKanalowKart.wykonaj(db);
    migracjaCennikowKanalowKart.wykonaj(db);
    expect(db.prepare('SELECT * FROM karty_cenniki_kanalow').all()).toEqual([
      { karta_id: 801, konto: A, cennik_kanalu: 'a-wybrany', zmieniono_at: T0, aktor_login: 'administrator' },
    ]);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'karty_cenniki_kont'").get()).toBeTruthy();
    // Dawnej tabeli nikt już nie czyta: jej wiersz nie zmienia doboru.
    db.prepare(
      `INSERT INTO karty_cenniki_kont (karta_id, konto, cennik, zmieniono_at) VALUES (802, ?, 'a-dawny', ?)`,
    ).run(A, T0);
    expect(wyjatekCennika(db, { kartaId: 802, konto: A })).toBeNull();
  });

  it('pusty cennik albo konto odrzuca sama tabela; jedna para karta × konto', () => {
    const db = baza();
    const wstaw = (konto, cennik) =>
      db
        .prepare(
          'INSERT INTO karty_cenniki_kanalow (karta_id, konto, cennik_kanalu, zmieniono_at) VALUES (801, ?, ?, ?)',
        )
        .run(konto, cennik, T0);
    expect(() => wstaw(A, ' ')).toThrow(/CHECK/);
    expect(() => wstaw(' ', 'a-1')).toThrow(/CHECK/);
    expect(() => wstaw(A, 'a-1')).not.toThrow();
    expect(() => wstaw(A, 'a-2')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('usunięcie karty usuwa jej wybory (klucze obce włączone)', () => {
    const db = baza();
    expect(db.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1);
    zapiszWyjatekCennika(db, { kartaId: 801, konto: A, cennik: 'a-wybrany' }, { teraz: T0 });
    zapiszWyjatekCennika(db, { kartaId: 802, konto: A, cennik: 'a-inny' }, { teraz: T0 });
    db.prepare('DELETE FROM karty_produktow WHERE id = 801').run();
    expect(db.prepare('SELECT karta_id FROM karty_cenniki_kanalow').all()).toEqual([{ karta_id: 802 }]);
  });
});

describe('kolejność doboru cennika konta', () => {
  it('wybór konta → cennik OMS karty → rozmiar → odmowa', () => {
    const db = baza();
    const { szklo } = cenniki(db);
    ustawCennikKarty(db, { kartaId: 801, cennikId: szklo }, { teraz: T0 });
    zapiszWyjatekCennika(db, { kartaId: 801, konto: A, cennik: ' a-wybrany ' }, { teraz: T1, aktor: 'administrator' });

    // (1) wybór konta wygrywa z cennikiem OMS karty
    expect(dobor(db, 801, A)).toBe('a-wybrany');
    expect(zrodloWyjatkuCennika(db, { kartaId: 801, konto: A })).toEqual({ rodzaj: 'konto' });
    // konto bez wyboru i bez powiązania z cennikiem OMS karty → (3) rozmiar
    expect(dobor(db, 801, B)).toBe('Mała paczka ERLI');
    expect(zrodloWyjatkuCennika(db, { kartaId: 801, konto: B })).toBeNull();

    // (2) bez wyboru konta — cennik OMS karty
    expect(usunWyjatekCennika(db, { kartaId: 801, konto: A })).toBe(1);
    expect(usunWyjatekCennika(db, { kartaId: 801, konto: A })).toBe(0);
    expect(dobor(db, 801, A)).toBe('a-szklo');
    expect(zrodloWyjatkuCennika(db, { kartaId: 801, konto: A })).toEqual({
      rodzaj: 'oms',
      nazwaOms: 'Szkło ostrożnie',
    });

    // (3) karta bez cennika OMS — rozmiar
    ustawCennikKarty(db, { kartaId: 801, cennikId: null }, { teraz: T1 });
    expect(dobor(db, 801, A)).toBe('a-mala');

    // (4) konto bez żadnego cennika po rozmiarze — odmowa; wybór konta i tak działa
    expect(dobor(db, 801, STARE)).toBe('odmowa');
    zapiszWyjatekCennika(db, { kartaId: 801, konto: STARE, cennik: 'a-stary' }, { teraz: T1 });
    expect(dobor(db, 801, STARE)).toBe('a-stary');
  });

  it('wybór na koncie A nie zmienia konta B ani innej karty', () => {
    const db = baza();
    const { szklo } = cenniki(db);
    ustawPowiazanieCennika(db, { cennikId: szklo, konto: B, cennikKanalu: 'Szkło ERLI' }, { teraz: T0 });
    ustawCennikKarty(db, { kartaId: 801, cennikId: szklo }, { teraz: T0 });
    ustawCennikKarty(db, { kartaId: 802, cennikId: szklo }, { teraz: T0 });
    zapiszWyjatekCennika(db, { kartaId: 801, konto: A, cennik: 'a-wybrany' }, { teraz: T1 });
    expect(dobor(db, 801, A)).toBe('a-wybrany');
    expect(dobor(db, 801, B)).toBe('Szkło ERLI');
    expect(zrodloWyjatkuCennika(db, { kartaId: 801, konto: B })).toEqual({
      rodzaj: 'oms',
      nazwaOms: 'Szkło ostrożnie',
    });
    expect(dobor(db, 802, A)).toBe('a-szklo');
    // Zapis wyboru konta nie przepisuje cennika OMS karty (nie powstaje „Wyjątek N”).
    expect(db.prepare('SELECT count(*) n FROM cenniki_dostaw_oms').get().n).toBe(2);
    expect(db.prepare('SELECT cennik_id FROM karty_cennik_oms WHERE karta_id = 801').get().cennik_id).toBe(szklo);
  });

  it('lista wyborów karty: jeden wpis na konto, wybór konta wygrywa; konta spoza konfiguracji pomijane', () => {
    const db = baza();
    const { szklo } = cenniki(db);
    ustawCennikKarty(db, { kartaId: 801, cennikId: szklo }, { teraz: T0, aktor: 'sprzedawca' });
    zapiszWyjatekCennika(db, { kartaId: 801, konto: B, cennik: 'Paczkomat ERLI' }, { teraz: T1 });
    zapiszWyjatekCennika(db, { kartaId: 801, konto: STARE, cennik: 'a-stary' }, { teraz: T1 });
    expect(wyjatkiCennikowKarty(db, 801)).toEqual([
      { konto: A, cennik: 'a-szklo', zmienionoAt: T0, aktor: 'sprzedawca' },
      { konto: STARE, cennik: 'a-stary', zmienionoAt: T1, aktor: null },
      { konto: B, cennik: 'Paczkomat ERLI', zmienionoAt: T1, aktor: null },
    ]);
    zapiszWyjatekCennika(db, { kartaId: 801, konto: A, cennik: 'a-wybrany' }, { teraz: T1, aktor: 'administrator' });
    // Bieżąca konfiguracja ma tylko A i B — wybór na dawnym koncie zostaje w bazie, ale go nie ma na liście.
    expect(wyjatkiCennikowKarty(db, 801, { konta: [A, B] })).toEqual([
      { konto: A, cennik: 'a-wybrany', zmienionoAt: T1, aktor: 'administrator' },
      { konto: B, cennik: 'Paczkomat ERLI', zmienionoAt: T1, aktor: null },
    ]);
    expect(db.prepare('SELECT count(*) n FROM karty_cenniki_kanalow WHERE konto = ?').get(STARE).n).toBe(1);
  });
});
