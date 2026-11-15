import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { migracjaStanowKanalow } from '../../../src/moduly/magazyn/migracje/0004-stany-kanalow.ts';
import { wstawOferte, zmienOferte, ofertaPoId, ofertyKarty, ofertyDoDecyzji, liczbaOfertDoDecyzji } from '../../../src/oms/db/oferty-kanalow.ts';

const T0 = '2026-11-14T10:00:00.000Z';
const T1 = '2026-11-14T11:00:00.000Z';
const T2 = '2026-11-14T12:00:00.000Z';
let db;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE karty_produktow (id INTEGER PRIMARY KEY, nazwa TEXT, sku TEXT);
    INSERT INTO karty_produktow VALUES (1, 'Lampa Półcień', 'LMP-1'), (2, 'Lampa duża', 'LMP-2')`);
  migracjaOfertKanalow.wykonaj(db);
  // E4.13: DO_DECYZJI czyta ilosc_problem_json (kolumna z 0003).
  migracjaStanowKanalow.wykonaj(db);
});
afterEach(() => db.close());
const nowa = (kanal = 'allegro_test', kartaId = 1) => wstawOferte(db, { kartaId, kanal, idZewnetrzne: `oferta-${kanal}-${kartaId}` }, { teraz: T0 });
const zapisane = id => JSON.parse(db.prepare('SELECT problemy_json FROM oferty_kanalow WHERE id = ?').get(id).problemy_json);

describe('czas problemów bez migracji', () => {
  it('przenosi od po kodzie, usuwa od z odczytu i nie zmienia wejścia', () => {
    const o = nowa();
    const problemy = [{ kod: 'karta', tekst: 'Brak zdjęć' }];
    zmienOferte(db, o.id, { problemy }, { teraz: T0 });
    expect(problemy).toEqual([{ kod: 'karta', tekst: 'Brak zdjęć' }]);
    zmienOferte(db, o.id, { problemy: [{ kod: 'karta', tekst: 'Brak nazwy' }] }, { teraz: T1 });
    expect(zapisane(o.id)).toEqual([{ kod: 'karta', tekst: 'Brak nazwy', od: T0 }]);
    expect(ofertaPoId(db, o.id)).toMatchObject({ problemy: [{ kod: 'karta', tekst: 'Brak nazwy' }], problemyOd: T0, zmienionoAt: T1 });
    expect(ofertyKarty(db, 1)[0].problemy).toEqual([{ kod: 'karta', tekst: 'Brak nazwy' }]);
  });
  it('nowy kod dostaje nowe od, najwcześniejsze zostaje niezależnie od kolejności', () => {
    const o = nowa();
    zmienOferte(db, o.id, { problemy: [{ kod: 'karta' }] }, { teraz: T0 });
    const r = zmienOferte(db, o.id, { problemy: [{ kod: 'cena' }, { kod: 'karta' }] }, { teraz: T1 });
    expect(zapisane(o.id)).toEqual([{ kod: 'cena', od: T1 }, { kod: 'karta', od: T0 }]);
    expect(r.problemyOd).toBe(T0);
    expect(zmienOferte(db, o.id, { problemy: [{ kod: 'cena' }] }, { teraz: T2 }).problemyOd).toBe(T1);
  });
  it('usunięty i powracający problem zaczyna się od nowa, pole wejściowe od nie steruje czasem', () => {
    const o = nowa();
    zmienOferte(db, o.id, { problemy: [{ kod: 'karta' }] }, { teraz: T0 });
    expect(zmienOferte(db, o.id, { problemy: null }, { teraz: T1 }).problemyOd).toBeNull();
    expect(zmienOferte(db, o.id, { problemy: [{ kod: 'karta', od: T0 }] }, { teraz: T2 }).problemyOd).toBe(T2);
  });
  it('stary problem dostaje czas pierwszego zapisu po wdrożeniu', () => {
    const o = nowa();
    db.prepare('UPDATE oferty_kanalow SET problemy_json = ? WHERE id = ?').run('[{"kod":"karta"}]', o.id);
    expect(ofertaPoId(db, o.id).problemyOd).toBeNull();
    expect(zmienOferte(db, o.id, { problemy: [{ kod: 'karta' }] }, { teraz: T1 }).problemyOd).toBe(T1);
    expect(zmienOferte(db, o.id, { liczbaProb: 1 }, { teraz: T2 }).problemyOd).toBe(T1);
  });
  it('błąd bez problemów używa zmienionoAt; puste problemy zwykłej oferty mają null', () => {
    const o = nowa();
    expect(o.problemyOd).toBeNull();
    expect(zmienOferte(db, o.id, { stan: 'blad', blad: 'Brak odpowiedzi' }, { teraz: T1 }).problemyOd).toBe(T1);
  });
});

describe('oferty do decyzji', () => {
  it('łączy kartę i wybiera problem, błąd i cenę przy aktywnej; sortuje przed limitem', () => {
    const problem = nowa('konto_a');
    const blad = nowa('konto_b', 2);
    const cena = nowa('konto_c');
    const zwykla = nowa('konto_d');
    zmienOferte(db, problem.id, { stan: 'problem', problemy: [{ kod: 'karta' }] }, { teraz: T2 });
    zmienOferte(db, blad.id, { stan: 'blad' }, { teraz: T0 });
    zmienOferte(db, cena.id, { stan: 'aktywna', cenaDoPotwierdzeniaGr: 12900, problemy: [{ kod: 'cena' }] }, { teraz: T1 });
    zmienOferte(db, zwykla.id, { stan: 'aktywna' });
    expect(liczbaOfertDoDecyzji(db)).toBe(3);
    expect(ofertyDoDecyzji(db).map(o => o.id)).toEqual([blad.id, cena.id, problem.id]);
    expect(ofertyDoDecyzji(db, { limit: 2 })).toMatchObject([
      { id: blad.id, nazwa: 'Lampa duża', sku: 'LMP-2', problemyOd: T0 },
      { id: cena.id, nazwa: 'Lampa Półcień', sku: 'LMP-1', problemyOd: T1 },
    ]);
    expect(ofertyDoDecyzji(db, { limit: 0 })).toEqual([]);
  });
  it('domyślnie ogranicza wynik do 200; licznik obejmuje całość', () => {
    for (let i = 0; i < 201; i++) {
      const o = nowa(`konto_${i}`);
      zmienOferte(db, o.id, { stan: 'problem' }, { teraz: T0 });
    }
    expect(ofertyDoDecyzji(db)).toHaveLength(200);
    expect(liczbaOfertDoDecyzji(db)).toBe(201);
  });
  it('pusta baza daje pustą listę i zero', () => {
    expect(ofertyDoDecyzji(db)).toEqual([]);
    expect(liczbaOfertDoDecyzji(db)).toBe(0);
  });
});
