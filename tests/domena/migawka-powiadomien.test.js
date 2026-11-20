import { describe, it, expect } from 'vitest';
import { scalMigawke, RETENCJA_MS } from '../../src/domena/migawka-powiadomien.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { wczytajMigawke, zapiszMigawke, stanMigawki } from '../../src/oms/db/powiadomienia-migawka.js';
import { createMigawkaPowiadomien } from '../../src/moduly/zamowienia/services/migawka-powiadomien.js';
import { odrzuc } from '../../src/oms/db/ostrzezenia.js';

// Migawka powiadomień: sprawa jest aktualna, dopóki reguła ją zwraca; potem leży w archiwum 30 dni. Przeczytania
// są per konto, a sprawa, która wraca, ma być znów nieprzeczytana dla wszystkich. Dane zmyślone (katalog lamp).

const DZIEN = 24 * 3600 * 1000;
const T = new Date('2026-11-20T10:00:00.000Z');
const iso = (msWstecz) => new Date(T.getTime() - msWstecz).toISOString();

const lampa = (kod, typ = 'niski-stan') => ({
  klucz: `${typ}:${kod}`,
  typ,
  tekst: `Lampa ${kod}: zostały 2 sztuki`,
  title: `Karta ${kod}`,
  przycisk: { href: `/magazyn?q=${kod}`, etykieta: 'Magazyn' },
  etykietaOdrzucenia: 'Ignoruj',
});
const zapisany = (w, { pierwszy = iso(DZIEN), ostatnio = iso(60_000), rozwiazane = null } = {}) => ({
  klucz: w.klucz,
  typ: w.typ,
  tekst: w.tekst,
  title: w.title ?? null,
  href: w.przycisk?.href ?? null,
  etykieta_przycisku: w.przycisk?.etykieta ?? null,
  etykieta_odrzucenia: w.etykietaOdrzucenia ?? null,
  pilne: 0,
  pierwszy_raz_at: pierwszy,
  ostatnio_at: ostatnio,
  rozwiazane_at: rozwiazane,
});

describe('scalMigawke', () => {
  it('nowa sprawa trafia do wstawienia z chwilą przebiegu; integracja jest pilna', () => {
    const awaria = { klucz: 'integracja:czuwacz', typ: 'integracja', tekst: 'Czuwacz stoi', przycisk: null };
    const z = scalMigawke({ poprzednie: [], nowe: [lampa('LAMPA-01'), awaria], teraz: T });
    expect(z.wstaw).toEqual([
      { ...zapisany(lampa('LAMPA-01'), { pierwszy: T.toISOString(), ostatnio: T.toISOString() }) },
      {
        ...zapisany(awaria, { pierwszy: T.toISOString(), ostatnio: T.toISOString() }),
        pilne: 1,
      },
    ]);
    expect(z.odswiez).toEqual([]);
    expect(z.rozwiaz).toEqual([]);
    expect(z.wroc).toEqual([]);
    expect(z.usun).toEqual([]);
  });

  it('trwająca sprawa: nowy tekst i ostatnio_at, pierwszy_raz_at zostaje', () => {
    const stary = zapisany(lampa('LAMPA-02'), { pierwszy: iso(3 * DZIEN) });
    const nowy = { ...lampa('LAMPA-02'), tekst: 'Lampa LAMPA-02: została 1 sztuka' };
    const z = scalMigawke({ poprzednie: [stary], nowe: [nowy], teraz: T });
    expect(z.wstaw).toEqual([]);
    expect(z.odswiez).toEqual([{ ...stary, tekst: 'Lampa LAMPA-02: została 1 sztuka', ostatnio_at: T.toISOString() }]);
    expect(z.rozwiaz).toEqual([]);
  });

  it('sprawa, której reguła już nie zwraca, jest rozwiązana; rozwiązana wcześniej nie rozwiązuje się drugi raz', () => {
    const trwa = zapisany(lampa('LAMPA-03'));
    const dawno = zapisany(lampa('LAMPA-04'), { rozwiazane: iso(5 * DZIEN) });
    const z = scalMigawke({ poprzednie: [trwa, dawno], nowe: [], teraz: T });
    expect(z.rozwiaz).toEqual(['niski-stan:LAMPA-03']);
    expect(z.usun).toEqual([]);
  });

  it('sprawa rozwiązana, której klucz wraca, wraca do aktualnych od chwili przebiegu', () => {
    const dawno = zapisany(lampa('LAMPA-05'), { pierwszy: iso(9 * DZIEN), rozwiazane: iso(2 * DZIEN) });
    const z = scalMigawke({ poprzednie: [dawno], nowe: [lampa('LAMPA-05')], teraz: T });
    expect(z.wroc).toEqual([
      { ...dawno, pierwszy_raz_at: T.toISOString(), ostatnio_at: T.toISOString(), rozwiazane_at: null },
    ]);
    expect(z.odswiez).toEqual([]);
    expect(z.wstaw).toEqual([]);
  });

  it('awaria integracji po wygaśnięciu dobowego wyciszenia wraca jako nowa', () => {
    const awaria = { klucz: 'integracja:kanal', typ: 'integracja', tekst: 'Kanał stoi' };
    const wyciszona = { ...zapisany(awaria, { ostatnio: iso(60_000) }), pilne: 1 };
    const odrzucone = new Map([['integracja:kanal', iso(DZIEN + 30_000)]]);
    const z = scalMigawke({ poprzednie: [wyciszona], nowe: [awaria], teraz: T, odrzucone });
    expect(z.wroc.map((w) => w.klucz)).toEqual(['integracja:kanal']);
    // Wyciszenie dalej trwa → zwykłe odświeżenie.
    const swieze = new Map([['integracja:kanal', iso(3600_000)]]);
    const z2 = scalMigawke({ poprzednie: [wyciszona], nowe: [awaria], teraz: T, odrzucone: swieze });
    expect(z2.wroc).toEqual([]);
    expect(z2.odswiez.map((w) => w.klucz)).toEqual(['integracja:kanal']);
  });

  it('retencja: rozwiązana ponad 30 dni temu do usunięcia, młodsza zostaje', () => {
    const stara = zapisany(lampa('LAMPA-06'), { rozwiazane: iso(RETENCJA_MS + 60_000) });
    const mloda = zapisany(lampa('LAMPA-07'), { rozwiazane: iso(10 * DZIEN) });
    const z = scalMigawke({ poprzednie: [stara, mloda], nowe: [], teraz: T });
    expect(RETENCJA_MS).toBe(30 * DZIEN);
    expect(z.usun).toEqual(['niski-stan:LAMPA-06']);
  });

  it('zignorowana ponad 30 dni temu znika z archiwum i nie wraca, choć reguła ją dalej zwraca', () => {
    const odrzucone = new Map([
      ['niski-stan:LAMPA-08', iso(31 * DZIEN)],
      ['niski-stan:LAMPA-09', iso(10 * DZIEN)],
    ]);
    const stara = zapisany(lampa('LAMPA-08'), { pierwszy: iso(40 * DZIEN) });
    const mloda = zapisany(lampa('LAMPA-09'), { pierwszy: iso(12 * DZIEN) });
    const z = scalMigawke({
      poprzednie: [stara, mloda],
      nowe: [lampa('LAMPA-08'), lampa('LAMPA-09')],
      teraz: T,
      odrzucone,
    });
    expect(z.usun).toEqual(['niski-stan:LAMPA-08']);
    expect(z.odswiez.map((w) => w.klucz)).toEqual(['niski-stan:LAMPA-09']);
    // Następny przebieg (wiersza już nie ma) — dalej nie wstawia.
    const z2 = scalMigawke({ poprzednie: [mloda], nowe: [lampa('LAMPA-08')], teraz: T, odrzucone });
    expect(z2.wstaw).toEqual([]);
    expect(z2.wroc).toEqual([]);
  });

  it('źródło, które zawiodło, nie rozwiązuje swoich spraw; inne źródła rozwiązują jak zwykle', () => {
    const ksef = zapisany(lampa('7:1', 'faktura-ksef:niepewna'));
    const minela = zapisany(lampa('LAMPA-11'));
    const dawnoKsef = zapisany(lampa('5:1', 'faktura-ksef:niepewna'), { rozwiazane: iso(RETENCJA_MS + 60_000) });
    const z = scalMigawke({
      poprzednie: [ksef, minela, dawnoKsef],
      nowe: [],
      teraz: T,
      nieudane: ['faktura-ksef:niepewna:'],
    });
    expect(z.rozwiaz).toEqual(['niski-stan:LAMPA-11']);
    // Sprawa źródła bez odpowiedzi zostaje jak była — bez rozwiązania i bez nowego `ostatnio_at`.
    expect(z.odswiez).toEqual([]);
    expect(z.usun).toEqual([]);
    expect(z.wroc).toEqual([]);
  });

  it('pierwszy przebieg: zignorowana niedawno wchodzi do migawki (archiwum pokaże ją jako zignorowaną)', () => {
    const odrzucone = new Map([['niski-stan:LAMPA-10', iso(2 * DZIEN)]]);
    const z = scalMigawke({ poprzednie: [], nowe: [lampa('LAMPA-10')], teraz: T, odrzucone });
    expect(z.wstaw.map((w) => w.klucz)).toEqual(['niski-stan:LAMPA-10']);
  });
});

describe('zapis migawki w bazie', () => {
  const przeczytaj = (db, konto, klucz) =>
    db
      .prepare('INSERT INTO powiadomienia_przeczytane (konto_id, klucz, przeczytane_at) VALUES (?, ?, ?)')
      .run(konto, klucz, iso(1000));
  const przeczytane = (db) =>
    db
      .prepare('SELECT konto_id, klucz FROM powiadomienia_przeczytane ORDER BY konto_id, klucz')
      .all()
      .map((w) => ({ ...w }));

  it('sprawa, która wraca, jest znów nieprzeczytana dla wszystkich kont; trwająca zostaje przeczytana', () => {
    const db = openOmsDb(':memory:');
    try {
      const pierwsza = new Date(T.getTime() - 5 * DZIEN);
      zapiszMigawke(
        db,
        scalMigawke({ poprzednie: [], nowe: [lampa('LAMPA-11'), lampa('LAMPA-12')], teraz: pierwsza }),
        { teraz: pierwsza, czasMs: 4 },
      );
      przeczytaj(db, 1, 'niski-stan:LAMPA-11');
      przeczytaj(db, 2, 'niski-stan:LAMPA-11');
      przeczytaj(db, 1, 'niski-stan:LAMPA-12');
      const druga = new Date(T.getTime() - 3 * DZIEN);
      zapiszMigawke(db, scalMigawke({ poprzednie: wczytajMigawke(db), nowe: [lampa('LAMPA-12')], teraz: druga }), {
        teraz: druga,
        czasMs: 4,
      });
      expect(wczytajMigawke(db).find((w) => w.klucz === 'niski-stan:LAMPA-11').rozwiazane_at).toBe(druga.toISOString());
      zapiszMigawke(
        db,
        scalMigawke({ poprzednie: wczytajMigawke(db), nowe: [lampa('LAMPA-11'), lampa('LAMPA-12')], teraz: T }),
        { teraz: T, czasMs: 4 },
      );
      expect(wczytajMigawke(db).every((w) => w.rozwiazane_at === null)).toBe(true);
      expect(przeczytane(db)).toEqual([{ konto_id: 1, klucz: 'niski-stan:LAMPA-12' }]);
      expect(stanMigawki(db)).toMatchObject({ odswiezone_at: T.toISOString(), czas_ms: 4, blad: null });
    } finally {
      db.close();
    }
  });

  it('retencja kasuje wiersz i jego przeczytania, wiersza ignorowania nie rusza', () => {
    const db = openOmsDb(':memory:');
    try {
      const dawno = new Date(T.getTime() - 40 * DZIEN);
      zapiszMigawke(db, scalMigawke({ poprzednie: [], nowe: [lampa('LAMPA-13'), lampa('LAMPA-14')], teraz: dawno }), {
        teraz: dawno,
        czasMs: 1,
      });
      odrzuc(db, 'niski-stan:LAMPA-14', { kto: 'magazynier', kiedy: dawno.toISOString() });
      przeczytaj(db, 1, 'niski-stan:LAMPA-13');
      przeczytaj(db, 1, 'niski-stan:LAMPA-14');
      const rozw = new Date(T.getTime() - 31 * DZIEN);
      zapiszMigawke(db, scalMigawke({ poprzednie: wczytajMigawke(db), nowe: [lampa('LAMPA-14')], teraz: rozw }), {
        teraz: rozw,
        czasMs: 1,
      });
      const odrzucone = new Map([['niski-stan:LAMPA-14', dawno.toISOString()]]);
      zapiszMigawke(
        db,
        scalMigawke({ poprzednie: wczytajMigawke(db), nowe: [lampa('LAMPA-14')], teraz: T, odrzucone }),
        { teraz: T, czasMs: 1 },
      );
      expect(wczytajMigawke(db)).toEqual([]);
      expect(przeczytane(db)).toEqual([]);
      expect(
        db
          .prepare('SELECT klucz FROM ostrzezenia_odrzucone')
          .all()
          .map((w) => w.klucz),
      ).toEqual(['niski-stan:LAMPA-14']);
    } finally {
      db.close();
    }
  });
});

describe('przebieg migawki', () => {
  it('błąd zbierania zapisuje błąd w stanie i nie czyści migawki; następny udany go gasi', async () => {
    const db = openOmsDb(':memory:');
    try {
      let zwroc = () => [lampa('LAMPA-15')];
      let chwila = new Date(T.getTime() - 120_000);
      const migawka = createMigawkaPowiadomien({ db, zbierz: () => zwroc(), teraz: () => chwila, log: () => {} });
      await migawka.przebieg();
      const przed = wczytajMigawke(db);
      expect(przed.map((w) => w.klucz)).toEqual(['niski-stan:LAMPA-15']);

      zwroc = () => {
        throw new Error('baza magazynu nie odpowiada');
      };
      chwila = new Date(T.getTime() - 60_000);
      const wynik = await migawka.przebieg();
      expect(wynik).toMatchObject({ blad: 'baza magazynu nie odpowiada' });
      expect(wczytajMigawke(db)).toEqual(przed);
      expect(stanMigawki(db)).toMatchObject({
        odswiezone_at: new Date(T.getTime() - 120_000).toISOString(),
        blad: 'baza magazynu nie odpowiada',
        blad_at: chwila.toISOString(),
      });

      zwroc = () => [lampa('LAMPA-15')];
      chwila = T;
      await migawka.przebieg();
      expect(stanMigawki(db)).toMatchObject({ odswiezone_at: T.toISOString(), blad: null, blad_at: null });
    } finally {
      db.close();
    }
  });
});
