import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanieHurtem, BUDZET_NADANIA_HURTEM_MS } from '../../../src/moduly/wysylka/services/nadanie-hurtem.js';

// PRZ-070: pętla nadania hurtem — kolejno, z budżetem czasu, z drukiem i logiem kwoty pobrania.
const baza = (n, nad = {}) => ({
  zrodlo_id: n, numer: String(n), klient: {},
  dostawa: { first_name: 'Jan', last_name: 'K', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '104.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-13T13:13:48Z', pozycje: [], ...nad,
});
const PACZKA = { waga: 1, dlugosc: 30, szerokosc: 20, wysokosc: 10 };
let db;
beforeEach(() => { db = openOmsDb(':memory:'); });
const wiersz = (id, nad = {}) => ({ z: { id, numer: String(id), rodzajFormularza: 'dpd', ...nad }, paczka: PACZKA });
const log = (id, akcja) => db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = ?').all(id, akcja).map((r) => r.wynik);

describe('PRZ-070: usługa nadania hurtem', () => {
  it('nadaje po kolei paczką z wiersza, paczka nr 1, BEZ kwotaPobrania (kwota z zamówienia)', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    const b = zapiszZamowienie(db, 'pro', baza(2), {});
    const nadaj = vi.fn().mockResolvedValueOnce({ numerListu: 'L-A' }).mockResolvedValueOnce({ numerListu: 'L-B' });
    const w = await createNadanieHurtem({ db, nadanie: { nadaj } }).nadajWiele([wiersz(a), wiersz(b)]);
    expect(nadaj.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(nadaj.mock.calls[0][1]).toEqual(PACZKA);
    const opcje = nadaj.mock.calls[0][2];
    expect(opcje.kolejnosc).toBe(1);
    expect(opcje).not.toHaveProperty('kwotaPobrania');
    expect(opcje.drukowac).toBe(false);
    expect(w.udane).toEqual([{ id: a, numer: String(a), opis: 'L-A' }, { id: b, numer: String(b), opis: 'L-B' }]);
  });

  it('pobranie DPD: kwota z zamówienia w logu PRZED kurierem (zostaje, gdy kurier padnie)', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1, { pobranie: 1, kwota_pobrania: '104.00' }), {});
    const nadaj = vi.fn().mockRejectedValue(new Error('DPD padło'));
    await createNadanieHurtem({ db, nadanie: { nadaj } }).nadajWiele([wiersz(a, { pobranie: 1, kwota_pobrania: '104.00' })]);
    expect(log(a, 'nadanie.pobranie')).toEqual(['nadanie hurtem: kurier zainkasuje kwotę z zamówienia — 104.00 zł']);
  });

  it('pobranie przez Allegro: log mówi, że kwotę poda Allegro', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    const nadaj = vi.fn().mockResolvedValue({ numerListu: 'AD1' });
    await createNadanieHurtem({ db, nadanie: { nadaj } })
      .nadajWiele([wiersz(a, { rodzajFormularza: 'wza', pobranie: 1, kwota_pobrania: '176.89' })]);
    expect(log(a, 'nadanie.pobranie')).toEqual(['nadanie hurtem: kwotę pobrania poda Allegro (w zamówieniu 176.89 zł)']);
  });

  it('bez pobrania żadnego wpisu o pobraniu', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    await createNadanieHurtem({ db, nadanie: { nadaj: vi.fn().mockResolvedValue({ numerListu: 'L' }) } }).nadajWiele([wiersz(a)]);
    expect(log(a, 'nadanie.pobranie')).toEqual([]);
  });

  it('błąd jednej paczki nie zatrzymuje reszty i trafia do logu oraz „nieudane”', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    const b = zapiszZamowienie(db, 'pro', baza(2), {});
    const nadaj = vi.fn().mockRejectedValueOnce(new Error('zły kod')).mockResolvedValueOnce({ numerListu: 'L-B' });
    const w = await createNadanieHurtem({ db, nadanie: { nadaj } }).nadajWiele([wiersz(a), wiersz(b)]);
    expect(w.udane.map((u) => u.id)).toEqual([b]);
    expect(w.nieudane.map((n) => n.id)).toEqual([a]);
    expect(log(a, 'nadanie.masowe')).toEqual(['BŁĄD: zły kod']);
  });

  it('po budżecie nie ZACZYNA następnej; reszta wraca jako nietknięte', async () => {
    let zegar = 0;
    const nadaj = vi.fn(async () => { zegar += BUDZET_NADANIA_HURTEM_MS + 1; return { numerListu: 'L' }; });
    const ids = [1, 2, 3].map((n) => zapiszZamowienie(db, 'pro', baza(n), {}));
    const w = await createNadanieHurtem({ db, nadanie: { nadaj }, teraz: () => zegar })
      .nadajWiele(ids.map((i) => wiersz(i)), { start: 0 });
    expect(nadaj).toHaveBeenCalledTimes(1);
    expect(w.nietkniete.map((n) => n.id)).toEqual([ids[1], ids[2]]);
  });

  it('pierwszą paczkę nadaje nawet przy budżecie wyczerpanym od startu', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    const nadaj = vi.fn().mockResolvedValue({ numerListu: 'L' });
    const w = await createNadanieHurtem({ db, nadanie: { nadaj }, teraz: () => 10 * BUDZET_NADANIA_HURTEM_MS })
      .nadajWiele([wiersz(a)], { start: 0 });
    expect(w.udane).toHaveLength(1);
  });

  it('„Nadaj i drukuj”: drukowac do kuriera, etykieta do kolejki, opis mówi, gdzie jest etykieta', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    const b = zapiszZamowienie(db, 'pro', baza(2), {});
    const nadaj = vi.fn().mockResolvedValue({ numerListu: 'L' });
    const kolejka = vi.fn().mockReturnValueOnce('w_kolejce').mockReturnValueOnce('brak_zpl');
    const w = await createNadanieHurtem({ db, nadanie: { nadaj }, kolejka }).nadajWiele([wiersz(a), wiersz(b)], { drukowac: true });
    expect(nadaj.mock.calls[0][2].drukowac).toBe(true);
    expect(kolejka.mock.calls).toEqual([[db, a, 1, 'Nadaj i drukuj — hurt'], [db, b, 1, 'Nadaj i drukuj — hurt']]);
    expect(w.udane.map((u) => u.opis)).toEqual(['L · etykieta w kolejce druku', 'L · etykieta tylko PDF — wydrukuj z karty']);
  });

  it('InPost „w trakcie tworzenia”: bez udawanego numeru i bez kolejki', async () => {
    const a = zapiszZamowienie(db, 'pro', baza(1), {});
    const kolejka = vi.fn();
    const nadaj = vi.fn().mockResolvedValue({ numerListu: null, wTrakcieTworzenia: true });
    const w = await createNadanieHurtem({ db, nadanie: { nadaj }, kolejka }).nadajWiele([wiersz(a)], { drukowac: true });
    expect(kolejka).not.toHaveBeenCalled();
    expect(w.udane[0].opis).toBe('przesyłka tworzona u kuriera — dokończ przyciskiem „Sprawdź ponownie” na karcie');
  });
});
