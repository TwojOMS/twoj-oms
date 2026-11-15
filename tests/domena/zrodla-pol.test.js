import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { utworzKarte, zastosujHurtem, nadajSku } from '../../src/oms/db/magazyn.js';
import {
  polePuste, importMozeZapisac, POLA_ZASTANE, POLA_DODATNIE,
} from '../../src/domena/zrodla-pol.js';

// PRZ-160 E1.01 — reguła ochrony pól karty przed importem treści z kanału.
// Import pisze pole TYLKO, gdy kolumna jest pusta albo pole ma wiersz źródła z reczne = 0.
// Niepusta kolumna BEZ wiersza źródła (edycja hurtem, nadanie SKU, nowa karta, stare wydanie) jest chroniona.

describe('polePuste — ta sama definicja co SQL migracji 0012', () => {
  it('tekst: null, pusty i złożony z samych spacji, \\t, \\n, \\r jest pusty; inne znaki nie', () => {
    for (const w of [null, undefined, '', ' ', '\n\t', ' \r\n\t \n']) expect(polePuste('opis', w)).toBe(true);
    for (const w of ['a', ' Lampa ', '\n0\n', '0']) expect(polePuste('opis', w)).toBe(false);
    // SQL trim(x, ' '||char(9,10,13)) nie zdejmuje twardej spacji ani \v — JS też nie.
    expect(polePuste('nazwa', ' ')).toBe(false);
    expect(polePuste('nazwa', '\v')).toBe(false);
  });

  it('wymiary i waga: 0 i liczby ujemne to brak (rozmiar.js traktuje je jako brak)', () => {
    expect(POLA_DODATNIE).toEqual(['szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm', 'waga_g']);
    for (const pole of POLA_DODATNIE) {
      for (const w of [null, undefined, 0, -5, '0', '', ' ']) expect(polePuste(pole, w)).toBe(true);
      for (const w of [1, 300, '450']) expect(polePuste(pole, w)).toBe(false);
    }
  });

  it('cena 0 zł to prawdziwa wartość, nie brak', () => {
    expect(polePuste('cena_gr', 0)).toBe(false);
    expect(polePuste('cena_gr', 4990)).toBe(false);
    expect(polePuste('cena_gr', null)).toBe(true);
  });

  it('lista pól zastanych to kolumny treści karty, bez paczkomatu i wycofania', () => {
    expect(POLA_ZASTANE).toEqual(['nazwa', 'sku', 'opis', 'kategoria_glowna', 'stawka_vat', 'ean', 'cena_gr',
      'szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm', 'waga_g']);
  });
});

describe('importMozeZapisac', () => {
  it('pusta kolumna — tak, z wierszem źródła i bez', () => {
    expect(importMozeZapisac('opis', null, undefined)).toBe(true);
    expect(importMozeZapisac('opis', ' \n\t', null)).toBe(true);
    expect(importMozeZapisac('waga_g', 0, undefined)).toBe(true);
    expect(importMozeZapisac('opis', '', { zrodlo: 'allegro:allegro_glowne', reczne: 0 })).toBe(true);
  });

  it('niepusta kolumna bez wiersza źródła — nie (chroniona jak zastane)', () => {
    expect(importMozeZapisac('opis', 'Opis wpisany hurtem', undefined)).toBe(false);
    expect(importMozeZapisac('opis', 'Opis', null)).toBe(false);
    expect(importMozeZapisac('cena_gr', 0, undefined)).toBe(false);
  });

  it('niepusta kolumna z wierszem reczne = 1 — nie; z reczne = 0 — tylko to samo źródło', () => {
    expect(importMozeZapisac('nazwa', 'Lampa', { zrodlo: 'reczne', reczne: 1 }, 'reczne')).toBe(false);
    expect(importMozeZapisac('nazwa', 'Lampa', { zrodlo: 'zastane', reczne: 1 }, 'allegro:allegro_glowne')).toBe(false);
    expect(importMozeZapisac('nazwa', 'Lampa', { zrodlo: 'api', reczne: 1 }, 'api')).toBe(false);
    expect(importMozeZapisac('nazwa', 'Lampa', { zrodlo: 'allegro:allegro_glowne', reczne: 0 }, 'allegro:allegro_glowne')).toBe(true);
    expect(importMozeZapisac('waga_g', 1200, { zrodlo: 'woo:woo_sklep', reczne: 0 }, 'woo:woo_sklep')).toBe(true);
  });

  it('Allegro nie nadpisuje pola z Woo ani z innego konta (D4)', () => {
    const zWoo = { zrodlo: 'woo:woo_sklep', reczne: 0 };
    expect(importMozeZapisac('cena_gr', 4990, zWoo, 'allegro:allegro_glowne')).toBe(false);
    expect(importMozeZapisac('cena_gr', 4990, zWoo, 'woo:woo_drugi')).toBe(false);
    expect(importMozeZapisac('nazwa', 'Lampa', { zrodlo: 'allegro:allegro_glowne', reczne: 0 }, 'allegro:allegro_drugie')).toBe(false);
    expect(importMozeZapisac('cena_gr', 4990, zWoo)).toBe(false);
  });

  it('pusta kolumna z wierszem reczne = 1 (celowo wyczyszczona) — nie; bez wiersza — tak', () => {
    for (const [pole, w] of [['opis', ''], ['opis', null], ['ean', ' \n\t'], ['waga_g', 0], ['cena_gr', undefined]]) {
      expect(importMozeZapisac(pole, w, { zrodlo: 'reczne', reczne: 1 }), `${pole}=${String(w)}`).toBe(false);
      expect(importMozeZapisac(pole, w, undefined), `${pole}=${String(w)} bez wiersza`).toBe(true);
      expect(importMozeZapisac(pole, w, { zrodlo: 'allegro:allegro_glowne', reczne: 0 })).toBe(true);
    }
  });
});

describe('karty zapisane dzisiejszym kodem bez wiersza źródła są chronione', () => {
  const zrodlo = (db, id, pole) => db.prepare('SELECT zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = ?').get(id, pole);
  const kolumna = (db, id, pole) => db.prepare(`SELECT ${pole} AS w FROM karty_produktow WHERE id = ?`).get(id).w;
  const mozna = (db, id, pole) => importMozeZapisac(pole, kolumna(db, id, pole), zrodlo(db, id, pole));

  it('edycja hurtem, nadanie SKU i nowa karta po migracji — import ich pól nie nadpisze', () => {
    const db = openOmsDb();
    try {
      const at = '2026-11-12T10:00:00.000Z';
      const id = utworzKarte(db, { nazwa: 'Lampa Półcień', opis: 'Opis z formularza' }, { at });
      zastosujHurtem(db, [{ id, zmiany: { kategoria_glowna: 'Kinkiety', szerokosc_mm: 300, wysokosc_mm: 400 } }], { at });
      nadajSku(db, [{ id, sku: 'PP-0001' }], { at });
      // Edycja hurtem od E1.05 zapisuje wiersz `reczne`; nowa karta i nadanie SKU nadal bez wiersza.
      for (const pole of ['kategoria_glowna', 'szerokosc_mm', 'wysokosc_mm']) {
        expect(zrodlo(db, id, pole), pole).toEqual({ zrodlo: 'reczne', reczne: 1 });
      }
      for (const pole of ['nazwa', 'opis', 'sku']) expect(zrodlo(db, id, pole), pole).toBeUndefined();
      for (const pole of ['nazwa', 'opis', 'kategoria_glowna', 'szerokosc_mm', 'wysokosc_mm', 'sku']) {
        expect(mozna(db, id, pole), pole).toBe(false);
      }
      // Pola, których nikt nie wypełnił, import uzupełni.
      for (const pole of ['glebokosc_mm', 'waga_g', 'ean', 'cena_gr']) expect(mozna(db, id, pole), pole).toBe(true);
    } finally { db.close(); }
  });
});
