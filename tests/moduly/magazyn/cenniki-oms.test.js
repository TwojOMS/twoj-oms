import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import {
  cennikiOms,
  cennikOmsKarty,
  dodajCennikOms,
  regulyCennikowKonta,
  ustawCennikKarty,
  ustawPowiazanieCennika,
  wyjatekKartyOms,
} from '../../../src/oms/db/cenniki-oms.ts';
import { ustawieniaOfertKonta, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import {
  usunWyjatekCennika,
  wyjatekCennika,
  wyjatkiCennikowKarty,
  zapiszWyjatekCennika,
} from '../../../src/oms/db/cenniki-kart.ts';
import { dobierzCennik, regulyKonta, TEKST_BRAK_CENNIKA } from '../../../src/domena/cennik-dostaw.js';

// Cenniki dostaw OMS: definicja raz, powiązania z kontami, cennik wybrany na karcie; dobór czyta je w dawnym
// kształcie reguł. Dane zmyślone: „Pracownia Półcień”, lampy, konta allegro_lampy i erli_lampy.

const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:05:00.000Z';
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
});

function baza() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: () => new Date(T0) });
  bazy.push(db);
  // Demo zakłada własne ustawienia kont — test zaczyna od czystych cenników.
  db.prepare('DELETE FROM cenniki_dostaw_oms').run();
  const karta = db.prepare(
    `INSERT INTO karty_produktow (id, sku, nazwa, szerokosc_mm, wysokosc_mm, glebokosc_mm, waga_g,
    utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  karta.run(701, 'LMP-701', 'Lampka biurkowa Półcień', 300, 200, 60, 1500, T0, T0);
  karta.run(702, 'LMP-702', 'Lampa stojąca Półcień', 1600, 400, 400, 9000, T0, T0);
  return db;
}

const dobor = (db, karta, konto) =>
  dobierzCennik({
    karta: db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(karta),
    reguly: regulyKonta(ustawieniaOfertKonta(db, konto)),
    wyjatek: wyjatekCennika(db, { kartaId: karta, konto }),
  });

describe('cenniki OMS — odczyt reguł konta', () => {
  it('najmniejszy pasujący wygrywa niezależnie od kolejności zakładania; domyślny na końcu', () => {
    const db = baza();
    const duza = dodajCennikOms(db, { nazwa: 'Duża paczka', doMm: [800, 600, 400], doG: 30000 }, { teraz: T0 });
    const mala = dodajCennikOms(db, { nazwa: 'Mała paczka', doMm: [80, 640, 380], doG: 25000 }, { teraz: T0 });
    const dom = dodajCennikOms(db, { nazwa: 'Domyślny', domyslny: true }, { teraz: T0 });
    for (const [id, c] of [
      [duza, 'a-duza'],
      [mala, 'a-mala'],
      [dom, 'a-gabaryt'],
    ])
      ustawPowiazanieCennika(db, { cennikId: id, konto: 'allegro_lampy', cennikKanalu: c }, { teraz: T0 });
    expect(regulyCennikowKonta(db, 'allegro_lampy')).toEqual([
      { doMm: [640, 380, 80], doG: 25000, cennik: 'a-mala', nazwaOms: 'Mała paczka' },
      { doMm: [800, 600, 400], doG: 30000, cennik: 'a-duza', nazwaOms: 'Duża paczka' },
      { cennik: 'a-gabaryt', nazwaOms: 'Domyślny' },
    ]);
    expect(ustawieniaOfertKonta(db, 'allegro_lampy').cenniki).toEqual(regulyCennikowKonta(db, 'allegro_lampy'));
    expect(dobor(db, 701, 'allegro_lampy')).toEqual({
      cennik: 'a-mala',
      powod: { rodzaj: 'regula', numer: 1, tekst: 'cennik OMS „Mała paczka” (do 64×38×8 cm, 25 kg)' },
    });
    expect(dobor(db, 702, 'allegro_lampy')).toEqual({
      cennik: 'a-gabaryt',
      powod: { rodzaj: 'wieksze', tekst: 'cennik OMS „Domyślny”' },
    });
  });

  it('cennik bez powiązania z kontem jest pomijany; konto bez powiązań → odmowa „brak cennika”', () => {
    const db = baza();
    const mala = dodajCennikOms(db, { nazwa: 'Mała paczka', doMm: [640, 380, 80], doG: 25000 }, { teraz: T0 });
    const srednia = dodajCennikOms(db, { nazwa: 'Średnia', doMm: [700, 500, 300], doG: 25000 }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: mala, konto: 'erli_lampy', cennikKanalu: 'e-mala' }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: srednia, konto: 'allegro_lampy', cennikKanalu: 'a-sr' }, { teraz: T0 });
    expect(regulyCennikowKonta(db, 'allegro_lampy').map((r) => r.cennik)).toEqual(['a-sr']);
    expect(dobor(db, 701, 'allegro_lampy').cennik).toBe('a-sr');
    // Domyślny bez powiązania z kontem: produkt większy od cenników rozmiaru dostaje odmowę.
    dodajCennikOms(db, { nazwa: 'Domyślny', domyslny: true }, { teraz: T0 });
    expect(dobor(db, 702, 'allegro_lampy')).toMatchObject({ odmowa: { kod: 'brak-domyslnego' } });
    expect(dobor(db, 701, 'konto_bez')).toEqual({ odmowa: { kod: 'brak-cennika', tekst: TEKST_BRAK_CENNIKA } });
  });

  it('cennik „tylko na karcie” nie bierze udziału w doborze po rozmiarze', () => {
    const db = baza();
    const naKarcie = dodajCennikOms(db, { nazwa: 'Szkło ostrożnie' }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: naKarcie, konto: 'allegro_lampy', cennikKanalu: 'a-szklo' }, { teraz: T0 });
    expect(regulyCennikowKonta(db, 'allegro_lampy')).toEqual([]);
    expect(cennikiOms(db).map((c) => [c.nazwa, c.rodzaj])).toEqual([['Szkło ostrożnie', 'karta']]);
  });
});

describe('cenniki OMS — cennik na karcie (wyjątek)', () => {
  it('wyjątek działa tylko dla kont z powiązaniem; reszta kont dobiera po rozmiarze', () => {
    const db = baza();
    const dom = dodajCennikOms(db, { nazwa: 'Domyślny', domyslny: true }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: dom, konto: 'allegro_lampy', cennikKanalu: 'a-dom' }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: dom, konto: 'erli_lampy', cennikKanalu: 'e-dom' }, { teraz: T0 });
    const szklo = dodajCennikOms(db, { nazwa: 'Szkło ostrożnie' }, { teraz: T0 });
    ustawPowiazanieCennika(db, { cennikId: szklo, konto: 'allegro_lampy', cennikKanalu: 'a-szklo' }, { teraz: T0 });
    ustawCennikKarty(db, { kartaId: 701, cennikId: szklo }, { teraz: T1, aktor: 'administrator' });
    expect(cennikOmsKarty(db, 701)).toEqual({
      cennikId: szklo,
      nazwa: 'Szkło ostrożnie',
      zmienionoAt: T1,
      aktor: 'administrator',
    });
    expect(wyjatekCennika(db, { kartaId: 701, konto: 'allegro_lampy' })).toBe('a-szklo');
    expect(wyjatekKartyOms(db, { kartaId: 701, konto: 'allegro_lampy' })).toEqual({
      cennik: 'a-szklo',
      nazwaOms: 'Szkło ostrożnie',
    });
    expect(wyjatekCennika(db, { kartaId: 701, konto: 'erli_lampy' })).toBeNull();
    expect(wyjatekCennika(db, { kartaId: 702, konto: 'allegro_lampy' })).toBeNull();
    expect(dobor(db, 701, 'erli_lampy').cennik).toBe('e-dom');
    expect(wyjatkiCennikowKarty(db, 701)).toEqual([
      { konto: 'allegro_lampy', cennik: 'a-szklo', zmienionoAt: T1, aktor: 'administrator' },
    ]);
    // Cennika wybranego na karcie nie da się usunąć; usunięcie karty zdejmuje wybór.
    expect(() => db.prepare('DELETE FROM cenniki_dostaw_oms WHERE id = ?').run(szklo)).toThrow(/FOREIGN KEY/);
    db.prepare('DELETE FROM karty_produktow WHERE id = 701').run();
    expect(cennikOmsKarty(db, 701)).toBeNull();
    db.prepare('DELETE FROM cenniki_dostaw_oms WHERE id = ?').run(szklo);
    expect(db.prepare('SELECT count(*) n FROM cenniki_dostaw_powiazania WHERE cennik_id = ?').get(szklo).n).toBe(0);
  });

  it('dawny zapis wyjątku per konto: karty o tym samym zbiorze par dzielą cennik „Wyjątek N”', () => {
    const db = baza();
    zapiszWyjatekCennika(db, { kartaId: 701, konto: 'allegro_lampy', cennik: ' a-szklo ' }, { teraz: T0 });
    zapiszWyjatekCennika(db, { kartaId: 702, konto: 'allegro_lampy', cennik: 'a-szklo' }, { teraz: T0 });
    expect(cennikOmsKarty(db, 701).nazwa).toBe('Wyjątek 1');
    expect(cennikOmsKarty(db, 702).cennikId).toBe(cennikOmsKarty(db, 701).cennikId);
    zapiszWyjatekCennika(db, { kartaId: 702, konto: 'erli_lampy', cennik: 'e-szklo' }, { teraz: T1 });
    expect(cennikOmsKarty(db, 702).nazwa).toBe('Wyjątek 2');
    // Cennik pierwszej karty się nie zmienił.
    expect(wyjatekCennika(db, { kartaId: 701, konto: 'erli_lampy' })).toBeNull();
    expect(wyjatkiCennikowKarty(db, 702).map((w) => [w.konto, w.cennik])).toEqual([
      ['allegro_lampy', 'a-szklo'],
      ['erli_lampy', 'e-szklo'],
    ]);
    expect(usunWyjatekCennika(db, { kartaId: 702, konto: 'erli_lampy' }, { teraz: T1 })).toBe(1);
    expect(cennikOmsKarty(db, 702).nazwa).toBe('Wyjątek 1');
    expect(usunWyjatekCennika(db, { kartaId: 702, konto: 'erli_lampy' })).toBe(0);
    expect(usunWyjatekCennika(db, { kartaId: 702, konto: 'allegro_lampy' })).toBe(1);
    expect(cennikOmsKarty(db, 702)).toBeNull();
    expect(() => zapiszWyjatekCennika(db, { kartaId: 701, konto: 'erli_lampy', cennik: ' ' })).toThrow();
  });
});

describe('cenniki OMS — dawny zapis reguł konta', () => {
  it('reguły konta zakładają cenniki o tych limitach i domyślny; inne konto z tymi limitami dzieli cennik', () => {
    const db = baza();
    const REGULY = [{ doMm: [80, 380, 640], doG: 25000, cennik: 'a-mala' }, { cennik: 'a-dom' }];
    zapiszUstawieniaOfertKonta(db, 'allegro_lampy', { cenniki: REGULY }, { teraz: T0 });
    zapiszUstawieniaOfertKonta(
      db,
      'erli_lampy',
      { cenniki: [{ doMm: [640, 80, 380], doG: 25000, cennik: 'e-mala' }, { cennik: 'e-dom' }] },
      { teraz: T0 },
    );
    expect(ustawieniaOfertKonta(db, 'allegro_lampy').cenniki).toEqual([
      { doMm: [640, 380, 80], doG: 25000, cennik: 'a-mala', nazwaOms: 'Do 64×38×8 cm, 25 kg' },
      { cennik: 'a-dom', nazwaOms: 'Domyślny' },
    ]);
    expect(cennikiOms(db).map((c) => [c.nazwa, c.powiazania.map((p) => p.konto)])).toEqual([
      ['Do 64×38×8 cm, 25 kg', ['allegro_lampy', 'erli_lampy']],
      ['Domyślny', ['allegro_lampy', 'erli_lampy']],
    ]);
    // Alias jednego cennika: konto zostaje tylko z domyślnym; drugie konto bez zmian.
    zapiszUstawieniaOfertKonta(db, 'allegro_lampy', { cennikDostaw: 'a-wszystko' }, { teraz: T1 });
    expect(ustawieniaOfertKonta(db, 'allegro_lampy').cenniki).toEqual([{ cennik: 'a-wszystko', nazwaOms: 'Domyślny' }]);
    expect(ustawieniaOfertKonta(db, 'erli_lampy').cenniki).toHaveLength(2);
    zapiszUstawieniaOfertKonta(db, 'allegro_lampy', { cennikDostaw: null }, { teraz: T1 });
    expect(ustawieniaOfertKonta(db, 'allegro_lampy').cenniki).toEqual([]);
  });

  it('zły zapis nie zmienia ani ustawień, ani powiązań', () => {
    const db = baza();
    zapiszUstawieniaOfertKonta(db, 'allegro_lampy', { cennikDostaw: 'a-dom' }, { teraz: T0 });
    expect(() =>
      zapiszUstawieniaOfertKonta(db, 'allegro_lampy', { cenniki: [{ doMm: [1, 2, 3], doG: 5, cennik: 'x' }] }),
    ).toThrow(/cennik domyślny/);
    expect(ustawieniaOfertKonta(db, 'allegro_lampy').cenniki).toEqual([{ cennik: 'a-dom', nazwaOms: 'Domyślny' }]);
  });
});

describe('cenniki OMS — ograniczenia tabel', () => {
  it('nazwa unikalna bez wielkości liter, jeden domyślny, limity wszystkie albo żadne', () => {
    const db = baza();
    const wstaw = (nazwa, a, g, domyslny = 0) =>
      db
        .prepare(
          `INSERT INTO cenniki_dostaw_oms (nazwa, do_a_mm, do_b_mm, do_c_mm, do_g, domyslny, utworzono_at, zmieniono_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(nazwa, a, a, a, g, domyslny, T0, T0);
    wstaw('Mała', 100, 1000);
    expect(() => wstaw(' mała ', 200, 1000)).toThrow(/UNIQUE/);
    expect(() => wstaw('Pół', 100, null)).toThrow(/CHECK/);
    expect(() => wstaw('   ', 100, 1000)).toThrow(/CHECK/);
    expect(() => wstaw('x'.repeat(61), 100, 1000)).toThrow(/CHECK/);
    expect(() => wstaw('Dom z limitem', 100, 1000, 1)).toThrow(/CHECK/);
    wstaw('Domyślny', null, null, 1);
    expect(() => wstaw('Drugi domyślny', null, null, 1)).toThrow(/UNIQUE/);
    expect(() =>
      ustawPowiazanieCennika(db, { cennikId: 1, konto: 'allegro_lampy', cennikKanalu: 'x'.repeat(201) }),
    ).toThrow(/CHECK/);
    expect(() => dodajCennikOms(db, { nazwa: 'Bez wagi', doMm: [1, 2, 3] })).toThrow();
  });
});
