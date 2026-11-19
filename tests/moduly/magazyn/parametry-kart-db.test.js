import { afterEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import {
  listaParametrow,
  parametrPoId,
  dodajParametr,
  zmienParametr,
  przesunParametr,
  usunParametr,
  wartosciKarty,
  wartosciKart,
  ustawWartoscKarty,
  wyczyscWartoscKarty,
} from '../../../src/oms/db/parametry-kart.js';

// Warstwa bazy parametrów własnych kart na prawdziwej bazie (w pamięci, wszystkie migracje).
// Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.

const AT = '2026-11-19T10:00:00.000Z';
const AT2 = '2026-11-19T11:00:00.000Z';

let db;
afterEach(() => {
  db?.close();
  db = null;
});
const baza = () => (db = openOmsDb(':memory:'));
const karta = (n) => utworzKarte(db, { nazwa: `Lampa Półcień LMP-${n}`, sku: `LMP-${n}` });
const dodaj = (dane) => {
  const w = dodajParametr(db, dane, { at: AT });
  if (!w.ok) throw new Error(w.blad);
  return w.id;
};
const KOLOR = { nazwa: 'Kolor', typ: 'lista', wartosci: 'czarny\nbiały\nmosiadz' };
const MOC = { nazwa: 'Moc', typ: 'liczba', jednostka: 'W', wymagany: 'on' };
const UWAGI = { nazwa: 'Uwagi', typ: 'tekst' };
const wiersz = (kartaId, parametrId) =>
  db.prepare('SELECT * FROM karty_parametry WHERE karta_id = ? AND parametr_id = ?').get(kartaId, parametrId);

describe('definicje', () => {
  it('pusta baza — pusta lista', () => {
    baza();
    expect(listaParametrow(db)).toEqual([]);
  });

  it('dodaje w kolejności dopisywania; lista oddaje sparsowane wartości i liczbę kart z wartością', () => {
    baza();
    const kolor = dodaj(KOLOR);
    const moc = dodaj(MOC);
    const uwagi = dodaj(UWAGI);
    const [a, b] = [karta(1), karta(2)];
    karta(3);
    ustawWartoscKarty(db, a, kolor, 'czarny', { at: AT });
    ustawWartoscKarty(db, b, kolor, 'biały', { at: AT });
    ustawWartoscKarty(db, a, moc, '40', { at: AT });

    expect(listaParametrow(db)).toEqual([
      {
        id: kolor,
        nazwa: 'Kolor',
        typ: 'lista',
        jednostka: null,
        wartosci: ['czarny', 'biały', 'mosiadz'],
        wymagany: false,
        kolejnosc: 1,
        karty: 2,
        utworzono_at: AT,
        zmieniono_at: AT,
      },
      expect.objectContaining({
        id: moc,
        nazwa: 'Moc',
        typ: 'liczba',
        jednostka: 'W',
        wartosci: null,
        wymagany: true,
        kolejnosc: 2,
        karty: 1,
      }),
      expect.objectContaining({ id: uwagi, typ: 'tekst', kolejnosc: 3, karty: 0 }),
    ]);
    expect(parametrPoId(db, moc)).toEqual(listaParametrow(db)[1]);
    expect(parametrPoId(db, String(moc))).toEqual(listaParametrow(db)[1]);
    expect(parametrPoId(db, 999)).toBe(null);
    expect(parametrPoId(db, 'abc')).toBe(null);
  });

  it('odmawia złej definicji i nazwy zajętej bez względu na wielkość liter (także polskie litery)', () => {
    baza();
    dodaj({ nazwa: 'Materiał', typ: 'tekst' });
    expect(dodajParametr(db, { nazwa: 'MATERIAŁ', typ: 'lista', wartosci: 'a' })).toEqual({
      blad: expect.stringMatching(/już jest/),
      kod: 'NIEPOPRAWNE',
    });
    expect(dodajParametr(db, { nazwa: 'Waga', typ: 'liczba' }).blad).toMatch(/pole stałe/);
    expect(dodajParametr(db, { nazwa: 'Kolor', typ: 'lista', wartosci: '' }).blad).toMatch(/co najmniej jedną/);
    expect(listaParametrow(db)).toHaveLength(1);
  });

  it('najwyżej 50 parametrów', () => {
    baza();
    for (let i = 1; i <= 50; i++) dodaj({ nazwa: `Cecha ${i}`, typ: 'tekst' });
    expect(dodajParametr(db, { nazwa: 'Cecha 51', typ: 'tekst' }).blad).toMatch(/najwyżej 50/);
    expect(listaParametrow(db)).toHaveLength(50);
    // Zmiana istniejącego przy pełnym limicie jest dozwolona.
    expect(zmienParametr(db, listaParametrow(db)[0].id, { nazwa: 'Cecha pierwsza', typ: 'tekst' }).ok).toBe(true);
  });

  it('zmienia nazwę, jednostkę i wymagany; własna nazwa nie koliduje z samą sobą', () => {
    baza();
    const moc = dodaj(MOC);
    dodaj(UWAGI);
    expect(zmienParametr(db, moc, { nazwa: 'moc', typ: 'liczba', jednostka: 'kW' }, { at: AT2 })).toEqual({
      ok: true,
      przepisane: 0,
    });
    expect(parametrPoId(db, moc)).toMatchObject({
      nazwa: 'moc',
      jednostka: 'kW',
      wymagany: false,
      zmieniono_at: AT2,
      utworzono_at: AT,
    });
    expect(zmienParametr(db, moc, { nazwa: 'uwagi', typ: 'liczba' }).blad).toMatch(/już jest/);
    expect(zmienParametr(db, 999, { nazwa: 'X', typ: 'tekst' })).toEqual({
      blad: 'Nie ma takiego parametru.',
      kod: 'NIE_MA',
    });
  });

  it('typ zmienia się tylko, gdy żadna karta nie ma wartości', () => {
    baza();
    const uwagi = dodaj(UWAGI);
    expect(zmienParametr(db, uwagi, { nazwa: 'Uwagi', typ: 'lista', wartosci: 'a\nb' }).ok).toBe(true);
    expect(parametrPoId(db, uwagi)).toMatchObject({ typ: 'lista', wartosci: ['a', 'b'] });
    const [a, b] = [karta(1), karta(2)];
    ustawWartoscKarty(db, a, uwagi, 'a');
    ustawWartoscKarty(db, b, uwagi, 'b');
    expect(zmienParametr(db, uwagi, { nazwa: 'Uwagi', typ: 'tekst' })).toEqual({
      blad: 'Parametr ma wartości na 2 kartach — typu nie da się zmienić.',
      kod: 'TYP_Z_WARTOSCIAMI',
      karty: 2,
    });
    wyczyscWartoscKarty(db, b, uwagi);
    expect(zmienParametr(db, uwagi, { nazwa: 'Uwagi', typ: 'tekst' }).blad).toBe(
      'Parametr ma wartości na 1 karcie — typu nie da się zmienić.',
    );
    expect(parametrPoId(db, uwagi).typ).toBe('lista');
  });

  it('usunięcie używanej wartości listy — odmowa z liczbą kart; nieużywanej — można', () => {
    baza();
    const kolor = dodaj(KOLOR);
    for (const n of [1, 2, 3]) ustawWartoscKarty(db, karta(n), kolor, 'mosiadz');
    expect(zmienParametr(db, kolor, { ...KOLOR, wartosci: 'czarny\nbiały' })).toEqual({
      blad: 'Wartość „mosiadz” jest na 3 kartach — zmień je najpierw.',
      kod: 'WARTOSC_UZYWANA',
      karty: 3,
      wartosc: 'mosiadz',
    });
    expect(parametrPoId(db, kolor).wartosci).toEqual(['czarny', 'biały', 'mosiadz']);
    expect(zmienParametr(db, kolor, { ...KOLOR, wartosci: 'mosiadz\nczarny' }).ok).toBe(true);
    expect(parametrPoId(db, kolor).wartosci).toEqual(['mosiadz', 'czarny']);
  });

  it('zmiana nazwy wartości przepisuje karty w jednej transakcji', () => {
    baza();
    const kolor = dodaj(KOLOR);
    const [a, b, c] = [karta(1), karta(2), karta(3)];
    ustawWartoscKarty(db, a, kolor, 'mosiadz', { at: AT });
    ustawWartoscKarty(db, b, kolor, 'mosiadz', { at: AT });
    ustawWartoscKarty(db, c, kolor, 'czarny', { at: AT });
    expect(
      zmienParametr(
        db,
        kolor,
        { ...KOLOR, wartosc_z: 'mosiadz', wartosc_na: 'mosiądz' },
        { at: AT2, kto: 'administrator' },
      ),
    ).toEqual({ ok: true, przepisane: 2 });
    expect(parametrPoId(db, kolor).wartosci).toEqual(['czarny', 'biały', 'mosiądz']);
    expect(wiersz(a, kolor)).toMatchObject({ wartosc: 'mosiądz', zmieniono_at: AT2, kto: 'administrator' });
    expect(wiersz(b, kolor).wartosc).toBe('mosiądz');
    expect(wiersz(c, kolor)).toMatchObject({ wartosc: 'czarny', zmieniono_at: AT });

    // Połączenie z wartością, która już jest: karty „biały” przechodzą na „czarny”, „biały” znika z listy.
    ustawWartoscKarty(db, c, kolor, 'biały');
    expect(
      zmienParametr(db, kolor, {
        ...KOLOR,
        wartosci: 'czarny\nbiały\nmosiądz',
        wartosc_z: 'biały',
        wartosc_na: 'czarny',
      }),
    ).toEqual({
      ok: true,
      przepisane: 1,
    });
    expect(parametrPoId(db, kolor).wartosci).toEqual(['czarny', 'mosiądz']);
    expect(wiersz(c, kolor).wartosc).toBe('czarny');

    // Stara wartość spoza zapisanej listy — odmowa i nic się nie zmienia.
    expect(zmienParametr(db, kolor, { ...KOLOR, wartosc_z: 'zielony', wartosc_na: 'oliwkowy' })).toEqual({
      blad: 'Wartości „zielony” nie ma na liście parametru „Kolor”.',
      kod: 'NIEPOPRAWNE',
    });
    expect(parametrPoId(db, kolor).wartosci).toEqual(['czarny', 'mosiądz']);
  });

  it('nieudany zapis w połowie cofa całą zmianę (definicja i karty razem)', () => {
    baza();
    const kolor = dodaj(KOLOR);
    const a = karta(1);
    ustawWartoscKarty(db, a, kolor, 'mosiadz', { at: AT });
    db.exec(`CREATE TRIGGER blokuj BEFORE UPDATE ON karty_parametry BEGIN SELECT RAISE(ABORT, 'awaria'); END`);
    expect(() => zmienParametr(db, kolor, { ...KOLOR, wartosc_z: 'mosiadz', wartosc_na: 'mosiądz' })).toThrow(/awaria/);
    expect(parametrPoId(db, kolor).wartosci).toEqual(['czarny', 'biały', 'mosiadz']);
    expect(wiersz(a, kolor).wartosc).toBe('mosiadz');
    expect(db.isTransaction).toBe(false);
  });

  it('przesuwa ↑↓ i numeruje kolejność od 1; brzegi i nieznany kierunek bez zmian', () => {
    baza();
    const [a, b, c] = [dodaj(KOLOR), dodaj(MOC), dodaj(UWAGI)];
    const kolejnosc = () => listaParametrow(db).map((p) => [p.id, p.kolejnosc]);
    expect(przesunParametr(db, c, 'gora')).toEqual({ ok: true });
    expect(kolejnosc()).toEqual([
      [a, 1],
      [c, 2],
      [b, 3],
    ]);
    expect(przesunParametr(db, a, 'dol')).toEqual({ ok: true });
    expect(kolejnosc()).toEqual([
      [c, 1],
      [a, 2],
      [b, 3],
    ]);
    expect(przesunParametr(db, c, 'gora')).toEqual({ ok: true });
    expect(przesunParametr(db, b, 'dol')).toEqual({ ok: true });
    expect(kolejnosc()).toEqual([
      [c, 1],
      [a, 2],
      [b, 3],
    ]);
    expect(przesunParametr(db, a, 'w bok').blad).toMatch(/kierunek/);
    expect(przesunParametr(db, 999, 'gora')).toEqual({ blad: 'Nie ma takiego parametru.', kod: 'NIE_MA' });
    // Nowy parametr staje na końcu także po przestawieniach.
    const d = dodaj({ nazwa: 'Materiał', typ: 'tekst' });
    expect(kolejnosc().at(-1)).toEqual([d, 4]);
  });

  it('usunięcie zabiera wartości z kart (CASCADE) i oddaje ich liczbę', () => {
    baza();
    const kolor = dodaj(KOLOR);
    const moc = dodaj(MOC);
    const [a, b] = [karta(1), karta(2)];
    ustawWartoscKarty(db, a, kolor, 'czarny');
    ustawWartoscKarty(db, b, kolor, 'biały');
    ustawWartoscKarty(db, a, moc, '60');
    expect(usunParametr(db, kolor)).toEqual({ ok: true, karty: 2 });
    expect(listaParametrow(db).map((p) => p.id)).toEqual([moc]);
    expect(
      db
        .prepare('SELECT parametr_id FROM karty_parametry')
        .all()
        .map((w) => w.parametr_id),
    ).toEqual([moc]);
    expect(usunParametr(db, kolor)).toEqual({ blad: 'Nie ma takiego parametru.', kod: 'NIE_MA' });
  });
});

describe('wartości kart', () => {
  it('ustawia wartość wg typu, z kto i czasem; ta sama wartość nie zmienia czasu', () => {
    baza();
    const moc = dodaj(MOC);
    const a = karta(1);
    expect(ustawWartoscKarty(db, a, moc, '12,50', { at: AT, kto: 'administrator' })).toEqual({
      ok: true,
      wartosc: '12.5',
      zmieniono: true,
    });
    expect(wiersz(a, moc)).toEqual({
      karta_id: a,
      parametr_id: moc,
      wartosc: '12.5',
      zmieniono_at: AT,
      kto: 'administrator',
    });
    expect(ustawWartoscKarty(db, a, moc, '12.5', { at: AT2, kto: 'magazynier' })).toEqual({
      ok: true,
      wartosc: '12.5',
      zmieniono: false,
    });
    expect(wiersz(a, moc)).toMatchObject({ zmieniono_at: AT, kto: 'administrator' });
    expect(ustawWartoscKarty(db, a, moc, '40', { at: AT2, kto: 'magazynier' }).zmieniono).toBe(true);
    expect(wiersz(a, moc)).toMatchObject({ wartosc: '40', zmieniono_at: AT2, kto: 'magazynier' });
  });

  it('puste pole kasuje wiersz (brak wartości to brak wiersza)', () => {
    baza();
    const uwagi = dodaj(UWAGI);
    const a = karta(1);
    ustawWartoscKarty(db, a, uwagi, 'klosz z lnu');
    expect(ustawWartoscKarty(db, a, uwagi, '  ')).toEqual({ ok: true, wartosc: null, zmieniono: true });
    expect(wiersz(a, uwagi)).toBeUndefined();
    expect(ustawWartoscKarty(db, a, uwagi, '')).toEqual({ ok: true, wartosc: null, zmieniono: false });
    ustawWartoscKarty(db, a, uwagi, 'klosz z lnu');
    expect(wyczyscWartoscKarty(db, a, uwagi)).toEqual({ ok: true, zmieniono: true });
    expect(wyczyscWartoscKarty(db, a, uwagi)).toEqual({ ok: true, zmieniono: false });
    expect(wiersz(a, uwagi)).toBeUndefined();
  });

  it('odmawia wartości spoza listy, złej liczby, nieznanej karty i parametru — nic nie zapisuje', () => {
    baza();
    const kolor = dodaj(KOLOR);
    const moc = dodaj(MOC);
    const a = karta(1);
    expect(ustawWartoscKarty(db, a, kolor, 'zielony').blad).toMatch(/^Kolor: „zielony” nie ma na liście/);
    expect(ustawWartoscKarty(db, a, moc, '-5').blad).toMatch(/ujemna/);
    expect(ustawWartoscKarty(db, 999, moc, '5')).toEqual({ blad: 'Nie ma takiej karty.', kod: 'NIE_MA' });
    expect(ustawWartoscKarty(db, a, 999, '5')).toEqual({ blad: 'Nie ma takiego parametru.', kod: 'NIE_MA' });
    expect(wyczyscWartoscKarty(db, a, 999)).toEqual({ blad: 'Nie ma takiego parametru.', kod: 'NIE_MA' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM karty_parametry').get().n).toBe(0);
    expect(ustawWartoscKarty(db, a, kolor, 'BIAŁY').wartosc).toBe('biały');
  });

  it('wartości jednej karty i wielu kart naraz', () => {
    baza();
    const kolor = dodaj(KOLOR);
    const moc = dodaj(MOC);
    const [a, b, c] = [karta(1), karta(2), karta(3)];
    ustawWartoscKarty(db, a, kolor, 'czarny');
    ustawWartoscKarty(db, a, moc, '40');
    ustawWartoscKarty(db, b, moc, '7,5');
    expect(wartosciKarty(db, a)).toEqual(
      new Map([
        [kolor, 'czarny'],
        [moc, '40'],
      ]),
    );
    expect(wartosciKarty(db, c)).toEqual(new Map());
    expect(wartosciKart(db, [a, String(b), c, 'x', -1, a])).toEqual(
      new Map([
        [
          a,
          new Map([
            [kolor, 'czarny'],
            [moc, '40'],
          ]),
        ],
        [b, new Map([[moc, '7.5']])],
        [c, new Map()],
      ]),
    );
    expect(wartosciKart(db, [])).toEqual(new Map());
    // Wiele kart naraz bez limitu parametrów zapytania SQLite.
    const ids = Array.from({ length: 1200 }, (_, i) => karta(100 + i));
    for (const id of ids.slice(0, 3)) ustawWartoscKarty(db, id, moc, '1');
    const duzo = wartosciKart(db, ids);
    expect(duzo.size).toBe(1200);
    expect([...duzo.values()].filter((m) => m.size).length).toBe(3);
  });

  it('w transakcji wołającego nie otwiera własnej (hurt zapisze wiele kart razem)', () => {
    baza();
    const moc = dodaj(MOC);
    const [a, b] = [karta(1), karta(2)];
    db.exec('BEGIN IMMEDIATE');
    ustawWartoscKarty(db, a, moc, '1');
    ustawWartoscKarty(db, b, moc, '2');
    db.exec('ROLLBACK');
    expect(wartosciKart(db, [a, b])).toEqual(
      new Map([
        [a, new Map()],
        [b, new Map()],
      ]),
    );
  });

  it('usunięcie karty zabiera jej wartości', () => {
    baza();
    const moc = dodaj(MOC);
    const [a, b] = [karta(1), karta(2)];
    ustawWartoscKarty(db, a, moc, '1');
    ustawWartoscKarty(db, b, moc, '2');
    db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(a);
    expect(parametrPoId(db, moc).karty).toBe(1);
  });
});
