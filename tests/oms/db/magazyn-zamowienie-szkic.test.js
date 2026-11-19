import { afterEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszProduktSklepowy, szukajDoZamowienia, produktDoZamowienia } from '../../../src/oms/db/magazyn.js';
import { podgladPrzejecia } from '../../../src/moduly/magazyn/services/przejecie-stanow.js';

// Szkic w sklepie nie jest obecnoscia w kanale, wiec przy recznym zamowieniu nie podpowiadamy
// jego ceny — kupujacy go nie widzi, a operator wzialby go za oferte.

const KANAL = 'polcien';
const bazy = [];
afterEach(() => bazy.splice(0).forEach((db) => db.close()));

function baza() {
  const db = openOmsDb(':memory:');
  bazy.push(db);
  const zapisz = (produkt_id, nazwa, status_publikacji) =>
    zapiszProduktSklepowy(db, {
      kanal: KANAL,
      produkt_id,
      wariant_id: '',
      nazwa,
      cena_gr: 4900,
      status_publikacji,
      odczytane_at: '2026-11-18T10:00:00.000Z',
    });
  zapisz('101', 'Lampa Grzybek opublikowana', 'publish');
  zapisz('102', 'Lampa Grzybek szkic', 'draft');
  zapisz('103', 'Lampa Grzybek bez odczytu statusu', null);
  return db;
}

describe('ręczne zamówienie: szkic Woo ukryty', () => {
  it('wyszukiwarka pokazuje opublikowany i bez statusu, nie pokazuje szkicu', () => {
    const db = baza();
    const ids = szukajDoZamowienia(db, { fraza: 'grzybek', kanal: KANAL }).map((w) => w.produkt_id);
    expect(ids.sort()).toEqual(['101', '103']);
  });

  it('pozycji ze szkicu nie da się dopisać po kluczu, opublikowaną tak', () => {
    const db = baza();
    expect(produktDoZamowienia(db, { kanal: KANAL, produkt_id: '102', wariant_id: '' })).toBeNull();
    expect(produktDoZamowienia(db, { kanal: KANAL, produkt_id: '101', wariant_id: '' })?.cena_gr).toBe(4900);
  });
});

describe('przejęcie stanów Woo: kolumna Stan po polsku', () => {
  it('publish → opublikowany, draft → szkic, brak → null', () => {
    const db = baza();
    db.prepare("UPDATE produkty_sklepowe SET stan_prowadzony = 'tak'").run();
    const opisy = Object.fromEntries(
      podgladPrzejecia(db, KANAL, 'woo').wiersze.map((w) => [w.idZewnetrzne, w.stanOpis]),
    );
    expect(opisy).toEqual({ 101: 'opublikowany', 102: 'szkic', 103: null });
  });
});
