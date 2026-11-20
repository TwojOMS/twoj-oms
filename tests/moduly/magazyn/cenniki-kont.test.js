// Wspólna lista kont Allegro i ERLI z pobranymi cennikami (ekran Cenników, karta, podgląd ERLI, hurt): wartości,
// lista niepobrana, walidacja wyboru i napisy odmowy zależne od stanu listy konta. Konta i nazwy zmyślone.
import { beforeEach, describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import {
  bladWyboruCennika,
  kontaZCennikami,
  nazwaCennikaKonta,
  odmowaDlaKonta,
  stanWyboruCennika,
  TEKST_LISTA_NIEPOBRANA,
} from '../../../src/moduly/magazyn/services/cenniki-kont.js';
import {
  dobierzCennik,
  TEKST_BRAK_CENNIKA,
  TEKST_BRAK_DOMYSLNEGO,
  TEKST_BRAK_WYMIAROW,
} from '../../../src/domena/cennik-dostaw.js';

const T0 = '2026-11-14T08:00:00.000Z';
const DEFINICJE = [
  { klucz: 'allegro_polcien', typ: 'allegro', prefiks: 'ALLEGRO_POLCIEN', etykieta: 'polcien_allegro' },
  { klucz: 'allegro_nowe', typ: 'allegro', prefiks: 'ALLEGRO_NOWE', etykieta: 'nowe_allegro' },
  { klucz: 'erli_polcien', typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'polcien.erli' },
  { klucz: 'erli_nowe', typ: 'erli', prefiks: 'ERLI_NOWE', etykieta: 'nowe.erli' },
];

let db;
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: () => new Date(T0) });
  zapiszUstawieniaOfertKonta(
    db,
    'allegro_polcien',
    {
      slowniki: {
        pobranoAt: T0,
        cenniki: [{ id: 'cen-a', nazwa: 'Lampy — paczkomat' }, { id: 'cen-b' }, { id: ' ' }, null],
      },
    },
    { teraz: T0, aktor: 'adam' },
  );
  db.prepare(
    `INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at) VALUES (?, ?, '{}', ?)`,
  ).run('erli:erli_polcien', JSON.stringify({ cennikiDostaw: ['Paczkomat', 7, 'Kurier'], cennikiPobranoAt: T0 }), T0);
});

const konta = () =>
  kontaZCennikami(db, {
    kontaAllegro: [{ klucz: 'allegro_polcien' }, { klucz: 'allegro_nowe' }],
    kontaErli: [{ klucz: 'erli_polcien' }, { klucz: 'erli_nowe' }],
    definicje: DEFINICJE,
  });
const konto = (klucz) => konta().find((k) => k.klucz === klucz);

describe('kontaZCennikami', () => {
  it('Allegro: wartość = id, nazwa z listy albo id; ERLI: wartość = nazwa; null = lista niepobrana', () => {
    expect(konta()).toEqual([
      {
        klucz: 'allegro_polcien',
        rodzaj: 'allegro',
        nazwaKanalu: 'Allegro',
        etykieta: expect.stringMatching(/^Allegro · /u),
        cenniki: [
          { wartosc: 'cen-a', nazwa: 'Lampy — paczkomat' },
          { wartosc: 'cen-b', nazwa: 'cen-b' },
        ],
        pobranoAt: T0,
      },
      {
        klucz: 'allegro_nowe',
        rodzaj: 'allegro',
        nazwaKanalu: 'Allegro',
        etykieta: expect.stringMatching(/^Allegro · /u),
        cenniki: null,
        pobranoAt: null,
      },
      {
        klucz: 'erli_polcien',
        rodzaj: 'erli',
        nazwaKanalu: 'ERLI',
        etykieta: expect.stringMatching(/^ERLI · /u),
        cenniki: [
          { wartosc: 'Paczkomat', nazwa: 'Paczkomat' },
          { wartosc: 'Kurier', nazwa: 'Kurier' },
        ],
        pobranoAt: T0,
      },
      {
        klucz: 'erli_nowe',
        rodzaj: 'erli',
        nazwaKanalu: 'ERLI',
        etykieta: expect.stringMatching(/^ERLI · /u),
        cenniki: null,
        pobranoAt: null,
      },
    ]);
  });

  it('pobrana pusta lista to nie lista niepobrana', () => {
    zapiszUstawieniaOfertKonta(
      db,
      'allegro_nowe',
      { slowniki: { pobranoAt: T0, cenniki: [] } },
      { teraz: T0, aktor: 'adam' },
    );
    expect(konto('allegro_nowe').cenniki).toEqual([]);
  });

  it('nazwaCennikaKonta szuka po wartości; spoza listy albo lista niepobrana → null', () => {
    expect(nazwaCennikaKonta(konto('allegro_polcien'), 'cen-a')).toBe('Lampy — paczkomat');
    expect(nazwaCennikaKonta(konto('erli_polcien'), 'Kurier')).toBe('Kurier');
    expect(nazwaCennikaKonta(konto('allegro_polcien'), 'cen-dawny')).toBeNull();
    expect(nazwaCennikaKonta(konto('allegro_nowe'), 'cen-a')).toBeNull();
  });
});

describe('walidacja wyboru cennika konta', () => {
  it('nowy wybór z listy albo pusty → ok; spoza listy → odmowa z etykietą konta', () => {
    const a = konto('allegro_polcien');
    expect(stanWyboruCennika(a, 'cen-b', null)).toBe('ok');
    expect(stanWyboruCennika(a, '', 'cen-a')).toBe('ok');
    expect(stanWyboruCennika(a, 'cen-obcy', null)).toBe('spoza-listy');
    expect(bladWyboruCennika(a, 'cen-b', null)).toBeNull();
    expect(bladWyboruCennika(a, 'cen-obcy', 'cen-a')).toBe(`Wybierz cennik z listy konta ${a.etykieta}.`);
    const e = konto('erli_polcien');
    expect(bladWyboruCennika(e, 'Gabaryt', null)).toBe(`Wybierz cennik z listy konta ${e.etykieta}.`);
  });

  it('zapisany wcześniej spoza listy może zostać', () => {
    const a = konto('allegro_polcien');
    expect(stanWyboruCennika(a, 'cen-dawny', 'cen-dawny')).toBe('ok');
    expect(bladWyboruCennika(a, 'cen-dawny', 'cen-dawny')).toBeNull();
    expect(bladWyboruCennika(konto('allegro_nowe'), 'cen-dawny', 'cen-dawny')).toBeNull();
  });

  it('lista niepobrana: nowego wyboru nie ma z czego sprawdzić → odmowa', () => {
    const n = konto('allegro_nowe');
    expect(stanWyboruCennika(n, 'cen-a', null)).toBe('lista-niepobrana');
    expect(bladWyboruCennika(n, 'cen-a', null)).toBe(`Wybierz cennik z listy konta ${n.etykieta}.`);
    expect(bladWyboruCennika(konto('erli_nowe'), 'Paczkomat', null)).toMatch(/^Wybierz cennik z listy konta ERLI · /u);
  });
});

describe('napisy odmowy dla konta', () => {
  const MALA = { doMm: [80, 380, 640], doG: 25000, cennik: 'cen-a' };
  const karta = { szerokosc_mm: 100, wysokosc_mm: 50, glebokosc_mm: 20, waga_g: 300 };

  it('nowe treści napisów', () => {
    expect(TEKST_LISTA_NIEPOBRANA).toBe(
      'Lista cenników konta niepobrana — pobierz ją w Magazyn → Cenniki, potem wybierz cennik dla tego konta na karcie.',
    );
    expect(TEKST_BRAK_CENNIKA).toBe(
      'Brak cennika dla tego konta — wybierz go na karcie albo ustaw cennik z rozmiarem lub domyślny w Magazyn → Cenniki.',
    );
    expect(TEKST_BRAK_WYMIAROW.endsWith('ustaw cennik na karcie albo wybierz cennik dla konta.')).toBe(true);
  });

  it('konto z niepobraną listą i bez cennika → „lista niepobrana”', () => {
    const wynik = odmowaDlaKonta(konto('allegro_nowe'), dobierzCennik({ karta, reguly: [] }));
    expect(wynik).toEqual({ odmowa: { kod: 'lista-niepobrana', tekst: TEKST_LISTA_NIEPOBRANA } });
    expect(odmowaDlaKonta(konto('erli_nowe'), dobierzCennik({ karta, reguly: [] })).odmowa.kod).toBe(
      'lista-niepobrana',
    );
  });

  it('konto z pobraną listą, bez wyboru i bez cennika z doboru → brak cennika', () => {
    const wynik = odmowaDlaKonta(konto('allegro_polcien'), dobierzCennik({ karta, reguly: [] }));
    expect(wynik).toEqual({ odmowa: { kod: 'brak-cennika', tekst: TEKST_BRAK_CENNIKA } });
  });

  it('brak wymiarów i brak domyślnego zostają bez zmian, także przy liście niepobranej', () => {
    const bez = { ...karta, waga_g: null };
    for (const k of ['allegro_polcien', 'allegro_nowe']) {
      expect(odmowaDlaKonta(konto(k), dobierzCennik({ karta: bez, reguly: [MALA] }))).toEqual({
        odmowa: { kod: 'brak-wymiarow', tekst: TEKST_BRAK_WYMIAROW },
      });
      expect(odmowaDlaKonta(konto(k), dobierzCennik({ karta: { ...karta, waga_g: 30000 }, reguly: [MALA] }))).toEqual({
        odmowa: { kod: 'brak-domyslnego', tekst: TEKST_BRAK_DOMYSLNEGO },
      });
    }
  });

  it('dobrany cennik przechodzi bez zmian, także przy liście niepobranej', () => {
    const wynik = dobierzCennik({ karta, reguly: [MALA] });
    expect(odmowaDlaKonta(konto('allegro_nowe'), wynik)).toBe(wynik);
    expect(odmowaDlaKonta(konto('allegro_polcien'), wynik)).toBe(wynik);
  });
});
