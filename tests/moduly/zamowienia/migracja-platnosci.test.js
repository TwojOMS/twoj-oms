import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { platnosciZamowienia } from '../../../src/oms/db/platnosci.js';
import { createWooAdapter } from '../../../src/oms/woo/adapter.js';
import { createPoller } from '../../../src/moduly/kanaly/services/poller.js';

// ⚠️ NA PRODUKCJI SA TRZY ZAMOWIENIA, W TYM OPLACONE, Z PRAWDZIWA PRZESYLKA. Od tej zmiany
// `oplacone_at` wynika z listy wplat, wiec zamowienie ze starym znacznikiem, a bez wiersza
// na liscie, wygladaloby po wdrozeniu na NIEOPLACONE — i panel zaczalby ostrzegac przy
// nadawaniu paczki za zamowienie zaplacone dawno temu.
//
// Test idzie na PLIK, bo dwa razy ':memory:' to dwie osobne bazy i nie sprawdzaloby niczego.

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1267, numer: '1267', klient: { email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', koszt_dostawy_brutto: '0.00', status_woo: 'processing',
  oplacone_at: null, anulowane: 0, utworzone_at: '2026-07-29T13:19:52', pozycje: [],
  ...nad,
});

const plikBazy = () => join(mkdtempSync(join(tmpdir(), 'oms-pl-')), 'oms.sqlite');

// Baza W STANIE SPRZED tej zmiany: znacznik zaplaty siedzi w kolumnie, lista wplat pusta.
function bazaSprzedZmiany({ oplaconeAt, oplaconeRecznie, surowe = {} }) {
  const plik = plikBazy();
  const pierwsza = openOmsDb(plik);
  const id = zapiszZamowienie(pierwsza, 'pro', zmapowane(), { id: 1267, ...surowe });
  pierwsza.prepare('DELETE FROM platnosci WHERE zamowienie_id = ?').run(id);
  pierwsza.prepare('UPDATE zamowienia SET oplacone_at = ?, oplacone_recznie = ? WHERE id = ?')
    .run(oplaconeAt, oplaconeRecznie, id);
  pierwsza.close();
  return { plik, id };
}

describe('przeniesienie istniejących wpłat na listę', () => {
  it('zamówienie opłacone w sklepie dostaje wpłatę źródła „sklep”', () => {
    const { plik, id } = bazaSprzedZmiany({
      oplaconeAt: '2026-07-29T13:21:26', oplaconeRecznie: 0,
      surowe: { payment_method_title: 'Przelewy24' },
    });
    const db = openOmsDb(plik);
    const wplaty = platnosciZamowienia(db, id);
    expect(wplaty).toHaveLength(1);
    expect(wplaty[0]).toMatchObject({
      zrodlo: 'sklep', kwota: '212.90', data: '2026-07-29T13:21:26', metoda: 'Przelewy24',
    });
    // I sedno: zamowienie dalej jest OPLACONE, wiec panel nie zacznie ostrzegac przy nadaniu.
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-29T13:21:26');
  });

  // ⚠️ Wplata potwierdzona RECZNIE (przelew tradycyjny, ktorego Woo nigdy nie oznaczy)
  // zapisana jako 'sklep' zostalaby skasowana przez pierwszy przebieg pollera — pieniadze
  // zniknelyby z panelu po dwoch minutach od wdrozenia.
  it('wpłata potwierdzona ręcznie ląduje jako „reczna”, nie „sklep”', () => {
    const { plik, id } = bazaSprzedZmiany({ oplaconeAt: '2026-07-30T08:00:00', oplaconeRecznie: 1 });
    const db = openOmsDb(plik);
    const wplaty = platnosciZamowienia(db, id);
    expect(wplaty).toHaveLength(1);
    expect(wplaty[0]).toMatchObject({ zrodlo: 'reczna', kwota: '212.90', data: '2026-07-30T08:00:00' });
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-30T08:00:00');
  });

  it('przeniesiona wpłata ręczna przeżywa PEŁNY przebieg pollera z pustym date_paid', async () => {
    const { plik, id } = bazaSprzedZmiany({ oplaconeAt: '2026-07-30T08:00:00', oplaconeRecznie: 1 });
    const db = openOmsDb(plik);
    const woo = {
      pobierzZamowienia: vi.fn().mockResolvedValue({
        zamowienia: [{
          id: 1267, number: '1267', status: 'processing', total: '212.90',
          date_created: '2026-07-29T10:00:00', date_modified_gmt: '2026-07-29T12:00:00',
          date_paid: null, billing: {}, shipping: {},
          shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }], line_items: [], meta_data: [],
        }],
        stron: 1,
      }),
    };
    await createPoller({ db, kanal: createWooAdapter({ woo }), sklep: 'pro' }).przebieg();
    expect(platnosciZamowienia(db, id)).toHaveLength(1);
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-30T08:00:00');
  });

  it('zamówienie bez znacznika zapłaty nie dostaje żadnej wpłaty', () => {
    const { plik, id } = bazaSprzedZmiany({ oplaconeAt: null, oplaconeRecznie: 0 });
    const db = openOmsDb(plik);
    expect(platnosciZamowienia(db, id)).toHaveLength(0);
  });

  it('drugie i trzecie otwarcie bazy NIE dubluje wpłaty', () => {
    const { plik, id } = bazaSprzedZmiany({ oplaconeAt: '2026-07-29T13:21:26', oplaconeRecznie: 0 });
    const druga = openOmsDb(plik);
    expect(platnosciZamowienia(druga, id)).toHaveLength(1);
    druga.close();

    const trzecia = openOmsDb(plik);
    expect(platnosciZamowienia(trzecia, id)).toHaveLength(1);
    trzecia.close();

    const czwarta = openOmsDb(plik);
    expect(platnosciZamowienia(czwarta, id)).toHaveLength(1);
  });

  it('drugie otwarcie NIE dubluje też wpłaty przeniesionej z potwierdzenia ręcznego', () => {
    const { plik, id } = bazaSprzedZmiany({ oplaconeAt: '2026-07-30T08:00:00', oplaconeRecznie: 1 });
    const druga = openOmsDb(plik);
    expect(platnosciZamowienia(druga, id)).toHaveLength(1);
    druga.close();

    const trzecia = openOmsDb(plik);
    expect(platnosciZamowienia(trzecia, id)).toHaveLength(1);
  });

  // Stary znacznik reczny musi ZNIKNAC z kolumny: zostawiony kazalby migracji odtworzyc
  // wplate po tym, jak operator swiadomie ja usunie.
  it('po przeniesieniu wpłaty ręcznej stara kolumna jest wyczyszczona i nie wskrzesza wpłaty', () => {
    const { plik, id } = bazaSprzedZmiany({ oplaconeAt: '2026-07-30T08:00:00', oplaconeRecznie: 1 });
    const druga = openOmsDb(plik);
    expect(druga.prepare('SELECT oplacone_at, oplacone_recznie FROM zamowienia WHERE id = ?').get(id))
      .toMatchObject({ oplacone_at: null, oplacone_recznie: 0 });
    druga.prepare('DELETE FROM platnosci WHERE zamowienie_id = ?').run(id);
    druga.close();

    const trzecia = openOmsDb(plik);
    expect(platnosciZamowienia(trzecia, id)).toHaveLength(0);
  });
});
