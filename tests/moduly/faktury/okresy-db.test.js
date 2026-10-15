import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapewnijOkres, pobierzOkres, zamknijOkres, otworzOkresPonownie, zamowieniaOkresu,
  rozpocznijFaktureOkresu, zakonczFaktureOkresu, oznaczOkresDoWyjasnienia, odblokujFaktureOkresu,
} from '../../../src/oms/db/okresy.js';
import { STAN } from '../../../src/domena/okres-rozliczeniowy.js';

// Zamowienie z minimalnym kompletem kolumn NOT NULL — interesuje nas tu wylacznie
// przynaleznosc do okresu i kolejnosc zlozenia, wiec reszta naglowka jest atrapa.
function dodajZamowienie(db, { numer, utworzone, okresId }) {
  return db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at,'
    + ' okres_rozliczeniowy_id) VALUES (?,?,?,?,?,?) RETURNING id',
  ).get('test', Number(numer), numer, '100.00', utworzone, okresId).id;
}

describe('okresy rozliczeniowe w bazie', () => {
  it('zaklada okres i oddaje go z powrotem', () => {
    const db = openOmsDb();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    expect(o.stan).toBe(STAN.OTWARTY);
    expect(o.rok).toBe(2026);
    expect(pobierzOkres(db, o.id).id).toBe(o.id);
  });

  it('jest idempotentny — drugie wywolanie oddaje TEN SAM wiersz', () => {
    const db = openOmsDb();
    const a = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    const b = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    expect(b.id).toBe(a.id);
  });

  it('rozni klienci i rozne miesiace to rozne okresy', () => {
    const db = openOmsDb();
    const a = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    const b = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 8 });
    const c = zapewnijOkres(db, { klientKlucz: 'inny', rok: 2026, miesiac: 7 });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
  });

  it('zamkniecie zmienia stan i stempluje czas', () => {
    const db = openOmsDb();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    const z = zamknijOkres(db, o.id);
    expect(z.stan).toBe(STAN.ZAMKNIETY);
    expect(z.zamkniety_at).toBeTruthy();
  });

  it('kolumna okres_rozliczeniowy_id istnieje na zamowieniach', () => {
    const db = openOmsDb();
    const kolumny = db.prepare('PRAGMA table_info(zamowienia)').all().map((k) => k.name);
    expect(kolumny).toContain('okres_rozliczeniowy_id');
  });

  // Ponowne otwarcie MUSI zdjac stempel czasu, a nie tylko cofnac stan: zostawiona data
  // zamkniecia opisywalaby zamkniecie, ktorego juz nie ma, i nastepne zamkniecie tego
  // okresu wygladaloby na wczesniejsze niz jest naprawde.
  it('ponowne otwarcie cofa stan i czysci stempel czasu', () => {
    const db = openOmsDb();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    zamknijOkres(db, o.id);
    const wrocony = otworzOkresPonownie(db, o.id);
    expect(wrocony.stan).toBe(STAN.OTWARTY);
    expect(wrocony.zamkniety_at).toBe(null);
  });

  it('zamowienia okresu ida w kolejnosci zlozenia i tylko z tego okresu', () => {
    const db = openOmsDb();
    const lipiec = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    const sierpien = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 8 });
    const pozniejsze = dodajZamowienie(db, { numer: '1002', utworzone: '2026-07-20T10:00:00Z', okresId: lipiec.id });
    const wczesniejsze = dodajZamowienie(db, { numer: '1001', utworzone: '2026-07-02T10:00:00Z', okresId: lipiec.id });
    dodajZamowienie(db, { numer: '1003', utworzone: '2026-08-01T10:00:00Z', okresId: sierpien.id });
    // Zamowienie rozliczane pojedynczo (NULL) nie nalezy do zadnego okresu.
    dodajZamowienie(db, { numer: '1004', utworzone: '2026-07-05T10:00:00Z', okresId: null });

    expect(zamowieniaOkresu(db, lipiec.id)).toEqual([wczesniejsze, pozniejsze]);
  });

  // `INSERT OR IGNORE` polyka takze naruszenia NOT NULL, wiec bez jawnego sprawdzenia
  // niekompletne wejscie konczyloby sie cichym `undefined` zamiast wierszem — a zamowienie
  // wypadloby z rozliczenia zbiorczego bez ani jednego bledu.
  it.each([
    ['bez klucza klienta', { klientKlucz: null, rok: 2026, miesiac: 7 }],
    ['bez roku', { klientKlucz: 'zetaklient', rok: null, miesiac: 7 }],
    ['bez miesiaca', { klientKlucz: 'zetaklient', rok: 2026, miesiac: null }],
    // Pusty i bialoznakowy klucz przechodza NOT NULL bez problemu (to nie NULL), wiec
    // `INSERT OR IGNORE` nie mialby czego polykac — bez jawnej strazy powstalby okres
    // bezimiennego klienta, ktorego zaden klucz z konfiguracji nigdy nie odnajdzie.
    ['pusty klucz klienta', { klientKlucz: '', rok: 2026, miesiac: 7 }],
    ['bialoznakowy klucz klienta', { klientKlucz: '   ', rok: 2026, miesiac: 7 }],
  ])('niekompletne wejscie (%s) rzuca, a nie oddaje po cichu undefined', (_opis, wejscie) => {
    const db = openOmsDb();
    expect(() => zapewnijOkres(db, wejscie)).toThrow(/okres/i);
    expect(db.prepare('SELECT COUNT(*) AS ile FROM okresy_rozliczeniowe').get().ile).toBe(0);
  });

  it('okres bez zamowien oddaje pusta tablice', () => {
    const db = openOmsDb();
    const o = zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 });
    expect(zamowieniaOkresu(db, o.id)).toEqual([]);
  });
});

// Rezerwacja jest tu zwyklym UPDATE-em (wiersz okresu istnieje od pierwszego zamowienia
// miesiaca), wiec bez warunku i bez sprawdzenia liczby zmienionych wierszy nie bronila
// przed NICZYM — dwa przeplecione zadania przechodzily przez nia obydwa.
describe('rezerwacja faktury okresu', () => {
  const nowy = () => {
    const db = openOmsDb();
    return { db, okres: zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 }) };
  };

  it('pierwsza rezerwacja przechodzi i stempluje czas', () => {
    const { db, okres } = nowy();
    const po = rozpocznijFaktureOkresu(db, okres.id);
    expect(po.ksef_status).toBe('w_toku');
    expect(po.utworzona_at).toBeTruthy();
  });

  it('druga rezerwacja tego samego okresu ODMAWIA', () => {
    const { db, okres } = nowy();
    rozpocznijFaktureOkresu(db, okres.id);
    expect(() => rozpocznijFaktureOkresu(db, okres.id)).toThrow(/drugiego dokumentu|już gdzie indziej/i);
  });

  // ⚠️ Warunek MUSI patrzec takze na `stan`, nie tylko na kolumny faktury: odpowiedz inFaktu
  // bez uuid-a i bez numeru zostawialaby okres zafakturowany z pustymi kolumnami, a sam
  // warunek kolumnowy przepuscilby wtedy druga rezerwacje.
  it('okres zafakturowany z pustymi kolumnami tez odmawia rezerwacji', () => {
    const { db, okres } = nowy();
    zakonczFaktureOkresu(db, okres.id, { uuid: null, numer: null, ksefStatus: null });
    expect(() => rozpocznijFaktureOkresu(db, okres.id)).toThrow();
  });
});

// Bez tej furtki okres w stanie 'do_wyjasnienia'/'zawieszona' zostawal zablokowany NA ZAWSZE
// — a 'zawieszona' powstaje przy zwyklym restarcie panelu w trakcie wywolania inFaktu.
// Jedynym wyjsciem byla reczna edycja pliku SQLite na produkcji.
describe('odblokujFaktureOkresu', () => {
  const nowy = () => {
    const db = openOmsDb();
    return { db, okres: zapewnijOkres(db, { klientKlucz: 'zetaklient', rok: 2026, miesiac: 7 }) };
  };

  it('okres do wyjasnienia wraca do stanu sprzed proby i wolno go ponowic', () => {
    const { db, okres } = nowy();
    rozpocznijFaktureOkresu(db, okres.id);
    zamknijOkres(db, okres.id);
    oznaczOkresDoWyjasnienia(db, okres.id, 'socket hang up');
    const po = odblokujFaktureOkresu(db, okres.id);
    expect(po.ksef_status).toBeNull();
    expect(po.utworzona_at).toBeNull();
    expect(po.blad_opis).toBeNull();
    expect(po.zamkniety_at).toBeNull();
    expect(po.stan).toBe(STAN.OTWARTY);
    // Po odblokowaniu rezerwacja znow przechodzi — inaczej furtka niczego by nie odblokowala.
    expect(() => rozpocznijFaktureOkresu(db, okres.id)).not.toThrow();
  });

  it('rezerwacja osierocona (zawieszona) tez daje sie odblokowac', () => {
    const { db, okres } = nowy();
    rozpocznijFaktureOkresu(db, okres.id);
    db.prepare('UPDATE okresy_rozliczeniowe SET utworzona_at = ? WHERE id = ?')
      .run('2020-01-01T00:00:00.000Z', okres.id);
    expect(odblokujFaktureOkresu(db, okres.id).ksef_status).toBeNull();
  });

  it('trwajace wystawianie NIE daje sie odblokowac', () => {
    const { db, okres } = nowy();
    rozpocznijFaktureOkresu(db, okres.id);
    expect(() => odblokujFaktureOkresu(db, okres.id)).toThrow(/trwa/i);
  });

  // Faktura wystawiona jest nietykalna: zdjecie blokady zwolniloby okres, ktorego dokument
  // NA PEWNO istnieje w inFakcie, a nastepne klikniecie daloby drugi.
  it('okres zafakturowany NIE daje sie odblokowac', () => {
    const { db, okres } = nowy();
    rozpocznijFaktureOkresu(db, okres.id);
    zakonczFaktureOkresu(db, okres.id, { uuid: 'u-1', numer: 'FV/1/2026', ksefStatus: null });
    expect(() => odblokujFaktureOkresu(db, okres.id)).toThrow(/FV\/1\/2026/);
  });

  it('swiezy okres nie ma czego odblokowywac', () => {
    const { db, okres } = nowy();
    expect(() => odblokujFaktureOkresu(db, okres.id)).toThrow(/nie ma czego/i);
  });

  it('nieistniejacy okres to odmowa, a nie wyjatek techniczny', () => {
    const { db } = nowy();
    expect(() => odblokujFaktureOkresu(db, 9999)).toThrow(/okresu/i);
  });
});
