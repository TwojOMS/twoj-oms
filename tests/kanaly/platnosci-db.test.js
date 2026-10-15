import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie, potwierdzWplate } from '../../src/oms/db/zamowienia.js';
import { dodajWplateReczna, usunWplateReczna, platnosciZamowienia } from '../../src/oms/db/platnosci.js';
import { createWooAdapter } from '../../src/oms/woo/adapter.js';
import { createPoller } from '../../src/moduly/kanaly/services/poller.js';

// Surowe zamowienie ze sklepu — takie, jakie dostaje PELNY przebieg pollera.
const surowe = (id, nad = {}) => ({
  id, number: String(id), status: 'processing', total: '212.90',
  date_created: '2026-07-29T10:00:00', date_modified_gmt: '2026-07-29T12:00:00',
  date_paid: null, payment_method_title: 'Przelew tradycyjny',
  billing: {}, shipping: {}, shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
  line_items: [], meta_data: [],
  ...nad,
});

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '212.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52', pozycje: [],
  ...nad,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

// Liczniki AUTOINCREMENT roznych tabel zbiegaja sie w swiezej bazie (przewodnik OMS, 6.3),
// wiec zamowienie i wplata dostawalyby to samo `id` — i pomylka argumentu przeszlaby
// niezauwazona. Zakladamy kilka zamowien-wypelniaczy, zeby liczniki sie rozjechaly.
function zamowienieZRozjechanymiLicznikami(nad = {}) {
  for (let i = 0; i < 4; i += 1) zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 9000 + i, numer: `900${i}` }), {});
  return zapiszZamowienie(db, 'pro', zmapowane(nad), {});
}

describe('wpłata ze sklepu jest utrzymywana przez pollera', () => {
  it('date_paid ze sklepu tworzy wpłatę źródła „sklep” z metodą płatności', async () => {
    const woo = {
      pobierzZamowienia: vi.fn().mockResolvedValue({
        zamowienia: [surowe(1301, { date_paid: '2026-07-29T13:21:26', payment_method_title: 'Przelewy24' })],
        stron: 1,
      }),
    };
    await createPoller({ db, kanal: createWooAdapter({ woo }), sklep: 'pro' }).przebieg();
    const z = pobierzZamowienie(db, 1);
    expect(z.platnosci).toHaveLength(1);
    expect(z.platnosci[0]).toMatchObject({
      zrodlo: 'sklep', kwota: '212.90', data: '2026-07-29T13:21:26', metoda: 'Przelewy24',
    });
  });

  it('drugi przebieg NIE dubluje wpłaty ze sklepu', async () => {
    const woo = {
      pobierzZamowienia: vi.fn().mockResolvedValue({
        zamowienia: [surowe(1301, { date_paid: '2026-07-29T13:21:26' })], stron: 1,
      }),
    };
    const p = createPoller({ db, kanal: createWooAdapter({ woo }), sklep: 'pro' });
    await p.przebieg();
    await p.przebieg();
    expect(pobierzZamowienie(db, 1).platnosci).toHaveLength(1);
  });

  it('sklep cofnął zapłatę → wpłata ze sklepu znika', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: '2026-07-29T13:21:26' }), {});
    expect(pobierzZamowienie(db, id).platnosci).toHaveLength(1);
    zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: null }), {});
    expect(pobierzZamowienie(db, id).platnosci).toHaveLength(0);
  });

  // ⚠️ NIEZMIENNIK 4.7 PRZEWODNIKA. Test przepuszcza PELNY przebieg pollera (klient sklepu
  // → mapowanie → zapis), a nie sam zapis do bazy: dziura moglaby siedziec w kazdym z tych
  // krokow. Wplata reczna skasowana przez pollera to pieniadze znikajace z panelu bez sladu.
  it('PEŁNY przebieg pollera NIE kasuje ani nie nadpisuje wpłaty ręcznej', async () => {
    const woo = {
      pobierzZamowienia: vi.fn().mockResolvedValue({ zamowienia: [surowe(1301)], stron: 1 }),
    };
    const p = createPoller({ db, kanal: createWooAdapter({ woo }), sklep: 'pro' });
    await p.przebieg();
    const id = pobierzZamowienie(db, 1).id;
    dodajWplateReczna(db, id, { kwota: '212.90', data: '2026-07-30T08:00:00', metoda: 'przelew', uwaga: 'wpłata na konto' });

    await p.przebieg();
    await p.przebieg();

    const z = pobierzZamowienie(db, id);
    expect(z.platnosci).toHaveLength(1);
    expect(z.platnosci[0]).toMatchObject({
      zrodlo: 'reczna', kwota: '212.90', data: '2026-07-30T08:00:00', metoda: 'przelew', uwaga: 'wpłata na konto',
    });
    // I najwazniejsze: zamowienie po przebiegu pollera dalej jest OPLACONE.
    expect(z.oplacone_at).toBe('2026-07-30T08:00:00');
  });

  // Wplata reczna dopisana ZANIM sklep oznaczyl zaplate (zaliczka na konto, a potem
  // doplata przez bramke) to jedyny uklad, w ktorym synchronizacja szuka „swojego" wiersza
  // majac przed soba wylacznie CUDZY. Bez warunku `zrodlo = 'sklep'` w wyszukaniu wplata
  // czlowieka zostalaby po prostu przepisana na dane ze sklepu — bez sladu i bez bledu.
  it('wpłata ręczna dopisana PRZED zapłatą w sklepie nie zostaje przez nią nadpisana', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-07-28', metoda: 'przelew', uwaga: 'zaliczka' });
    zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: '2026-07-29T13:21:26' }), {});

    const wplaty = pobierzZamowienie(db, id).platnosci;
    expect(wplaty).toHaveLength(2);
    expect(wplaty.find((w) => w.zrodlo === 'reczna')).toMatchObject({ kwota: '100.00', uwaga: 'zaliczka' });
    expect(wplaty.find((w) => w.zrodlo === 'sklep')).toMatchObject({ kwota: '212.90' });
  });

  it('wpłata ręczna i wpłata ze sklepu żyją obok siebie', async () => {
    const woo = {
      pobierzZamowienia: vi.fn().mockResolvedValue({
        zamowienia: [surowe(1301, { date_paid: '2026-07-29T13:21:26' })], stron: 1,
      }),
    };
    const p = createPoller({ db, kanal: createWooAdapter({ woo }), sklep: 'pro' });
    await p.przebieg();
    const id = pobierzZamowienie(db, 1).id;
    dodajWplateReczna(db, id, { kwota: '50.00', data: '2026-08-01', uwaga: 'dopłata za dodatkowy szablon' });
    await p.przebieg();
    const z = pobierzZamowienie(db, id);
    expect(z.platnosci.map((w) => w.zrodlo)).toEqual(['sklep', 'reczna']);
  });
});

describe('„opłacone" wynika z listy wpłat', () => {
  it('suma pokrywająca kwotę → oplacone_at z datą wpłaty domykającej', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-07-28' });
    dodajWplateReczna(db, id, { kwota: '112.90', data: '2026-07-29' });
    const z = pobierzZamowienie(db, id);
    expect(z.oplacone_at).toBe('2026-07-29');
    expect(z.oplacone_recznie).toBe(1);
  });

  it('suma mniejsza od kwoty → oplacone_at pozostaje puste', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    dodajWplateReczna(db, id, { kwota: '212.89', data: '2026-07-29' });
    expect(pobierzZamowienie(db, id).oplacone_at).toBeNull();
  });

  // Cofniecie faktu cofa „oplacone" SAMO — to ta sama zasada, co przy statusie.
  it('usunięcie wpłaty cofa „opłacone"', () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '212.90', data: '2026-07-29' });
    const wplata = platnosciZamowienia(db, id)[0];
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-29');
    usunWplateReczna(db, id, wplata.id);
    expect(pobierzZamowienie(db, id).oplacone_at).toBeNull();
  });

  it('surowa kolumna ze sklepu zostaje widoczna obok, jako oplacone_at_sklep', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: '2026-07-29T13:21:26' }), {});
    expect(pobierzZamowienie(db, id).oplacone_at_sklep).toBe('2026-07-29T13:21:26');
  });
});

describe('„Zaksięguj wpłatę" dopisuje BRAKUJĄCĄ kwotę', () => {
  it('bez żadnej wpłaty dopisuje całą kwotę zamówienia', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    potwierdzWplate(db, id, '2026-07-30T08:00:00');
    const z = pobierzZamowienie(db, id);
    expect(z.platnosci).toHaveLength(1);
    expect(z.platnosci[0]).toMatchObject({ kwota: '212.90', zrodlo: 'reczna' });
    expect(z.oplacone_at).toBe('2026-07-30T08:00:00');
  });

  // Przy zaliczce wpisanie calosci zrobiloby z niej nadplate rowna zaliczce.
  it('przy zaliczce dopisuje tylko różnicę', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-07-28' });
    potwierdzWplate(db, id, '2026-07-30T08:00:00');
    const z = pobierzZamowienie(db, id);
    expect(z.platnosci.map((w) => w.kwota)).toEqual(['100.00', '112.90']);
    expect(z.oplacone_at).toBe('2026-07-30T08:00:00');
  });

  it('przy kwocie już pokrytej odmawia zamiast dopisywać zero', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane({ oplacone_at: '2026-07-29T13:21:26' }), {});
    expect(() => potwierdzWplate(db, id)).toThrow(/pokrywające całą kwotę/);
    expect(pobierzZamowienie(db, id).platnosci).toHaveLength(1);
  });
});

describe('usuwanie wpłaty — wyjście z pomyłki', () => {
  it('wpłatę ręczną da się usunąć', () => {
    const id = zamowienieZRozjechanymiLicznikami();
    dodajWplateReczna(db, id, { kwota: '50.00', data: '2026-08-01' });
    const wplata = platnosciZamowienia(db, id)[0];
    expect(wplata.id).not.toBe(id);
    const usunieta = usunWplateReczna(db, id, wplata.id);
    expect(usunieta.kwota).toBe('50.00');
    expect(platnosciZamowienia(db, id)).toHaveLength(0);
  });

  // Wplata ze sklepu nalezy do sklepu: poller dopisalby ja z powrotem, wiec panel
  // obiecywalby skasowanie, ktore samo sie cofa po dwoch minutach.
  it('wpłaty ze sklepu usunąć się NIE DA', () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T13:21:26' });
    const wplata = platnosciZamowienia(db, id)[0];
    expect(wplata.zrodlo).toBe('sklep');
    expect(() => usunWplateReczna(db, id, wplata.id)).toThrow(/Wpłaty ze sklepu nie da się usunąć/);
    expect(platnosciZamowienia(db, id)).toHaveLength(1);
  });

  it('wpłata z INNEGO zamówienia → odmowa, nie skasowanie cudzego wiersza', () => {
    const a = zamowienieZRozjechanymiLicznikami({ zrodlo_id: 1301, numer: '1301' });
    const b = zapiszZamowienie(db, 'pro', zmapowane({ zrodlo_id: 1302, numer: '1302' }), {});
    dodajWplateReczna(db, b, { kwota: '50.00', data: '2026-08-01' });
    const cudza = platnosciZamowienia(db, b)[0];
    expect(() => usunWplateReczna(db, a, cudza.id)).toThrow(/Nie ma takiej wpłaty/);
    expect(platnosciZamowienia(db, b)).toHaveLength(1);
  });

  it('odmowy są otagowane jako przeznaczone dla operatora', () => {
    const id = zamowienieZRozjechanymiLicznikami({ oplacone_at: '2026-07-29T13:21:26' });
    const wplata = platnosciZamowienia(db, id)[0];
    try { usunWplateReczna(db, id, wplata.id); } catch (e) { expect(e.dlaOperatora).toBe(true); }
    expect.assertions(1);
  });
});
