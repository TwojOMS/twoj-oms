import { describe, it, expect } from 'vitest';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';
import { mapujZamowienieAllegro } from '../../src/domena/allegro-mapowanie.js';
import { proponowanaDataSprzedazy } from '../../src/domena/data-sprzedazy.js';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../src/oms/db/zamowienia.js';
import { dodajWplateReczna } from '../../src/oms/db/platnosci.js';

// PRZ-137.05 — `date_paid` NIE TWORZY WPŁATY PRZY POBRANIU (decyzja właściciela, plan D5).
//
// Woo wypełnia `date_paid` także przy płatności przy odbiorze (np. gdy sklep oznacza
// zamówienie jako zrealizowane). Mapowanie brało to bez warunku, więc powstawała wpłata
// `zrodlo='sklep'` na całą kwotę: saldo „pokryte" i data sprzedaży z art. 19a ust. 8
// („zaplata"), choć kurier zainkasuje pieniądze dopiero przy doręczeniu. Pomiar P1/P4
// w planie PRZ-137, rozdz. 3. Dane zmyślone („Pracownia Półcień", example.test).

const surowePobranie = (nad = {}) => ({
  id: 5001, number: '5001', status: 'processing', total: '212.90',
  payment_method: 'cod', payment_method_title: 'Płatność przy odbiorze',
  date_paid_gmt: '2026-10-29T13:00:00', date_paid: '2026-10-29T14:00:00',
  date_created_gmt: '2026-10-29T12:00:00',
  shipping_lines: [{ method_id: 'flat_rate', instance_id: '3', method_title: 'Kurier DPD' }],
  line_items: [], meta_data: [],
  billing: { company: 'Pracownia Półcień', email: 'biuro@example.test' }, shipping: {},
  ...nad,
});
const mapowaniePobranie = { instancje: { 3: { metoda: 'dpd', pobranie: true } }, poPozycji: [], bramkiPobrania: ['cod'] };
const mapowaniePrzelew = { instancje: { 3: { metoda: 'dpd', pobranie: false } }, poPozycji: [], bramkiPobrania: ['cod'] };

const surowePrzelew = () => surowePobranie({ payment_method: 'bacs', payment_method_title: 'Przelew tradycyjny' });

// Zamówienie już w bazie, zapisane STARYM mapowaniem (z wpłatą `sklep` z `date_paid`) —
// tak wyglądają zamówienia sprzed tej zmiany, których sklep już nie przyśle.
const zmapowaneStare = (nad = {}) => ({
  zrodlo_id: 1267, numer: '1267', klient: { email: 'j@example.test', company: 'Pracownia Półcień' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', pobranie: 1, kwota_pobrania: '212.90', chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  status_woo: 'processing', oplacone_at: '2026-10-29T13:00:00Z', metoda_platnosci: 'Płatność przy odbiorze', anulowane: 0,
  utworzone_at: '2026-10-29T12:19:52Z', pozycje: [], ...nad,
});

const wplaty = (db, id) => db.prepare('SELECT zrodlo, kwota, metoda FROM platnosci WHERE zamowienie_id = ? ORDER BY id').all(id);

describe('PRZ-137.05 mapowanie Woo: date_paid przy pobraniu', () => {
  it('P4: cod + date_paid → oplacone_at null, metoda płatności bez zmian', () => {
    const z = mapujZamowienie(surowePobranie(), mapowaniePobranie);
    expect(z.pobranie).toBe(1);
    expect(z.kwota_pobrania).toBe('212.90');
    expect(z.oplacone_at).toBeNull();
    expect(z.metoda_platnosci).toBe('Płatność przy odbiorze');
  });

  it('Woo przelew z date_paid → oplacone_at jak dziś (UTC z Z)', () => {
    const z = mapujZamowienie(surowePrzelew(), mapowaniePrzelew);
    expect(z.pobranie).toBe(0);
    expect(z.oplacone_at).toBe('2026-10-29T13:00:00Z');
    expect(z.metoda_platnosci).toBe('Przelew tradycyjny');
  });

  it('strażnik Allegro: pobranie z finishedAt dalej bez wpłaty, online z wpłatą', () => {
    const allegro = (type) => ({
      id: 'a-137', status: 'READY_FOR_PROCESSING',
      payment: { type, finishedAt: '2026-10-29T13:00:00Z' },
      buyer: { email: 'x1@example.test', address: null },
      delivery: { method: { id: 'm-1', name: 'Allegro Kurier DPD pobranie' }, cost: { amount: '0.00', currency: 'PLN' }, address: null },
      invoice: { required: false },
      lineItems: [{ id: 'li-1', offer: { name: 'Szablon', external: null }, quantity: 1, price: { amount: '99.00', currency: 'PLN' }, tax: { rate: '23.00' }, boughtAt: '2026-10-29T12:00:00Z' }],
      surcharges: [], summary: { totalToPay: { amount: '99.00', currency: 'PLN' } },
    });
    const m = { metodaZId: () => ({ metoda: 'allegro_dpd', etykieta: 'Allegro DPD' }) };
    expect(mapujZamowienieAllegro(allegro('CASH_ON_DELIVERY'), m).oplacone_at).toBeNull();
    expect(mapujZamowienieAllegro(allegro('ONLINE'), m).oplacone_at).toBe('2026-10-29T13:00:00Z');
  });
});

describe('PRZ-137.05 zapis zamówienia: wpłata sklepu przy pobraniu', () => {
  it('zapis zmapowanego P4 przez db/zamowienia.js → brak wiersza w platnosci', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', mapujZamowienie(surowePobranie(), mapowaniePobranie), {});
    expect(wplaty(db, id)).toEqual([]);
  });

  it('Woo przelew z date_paid → wpłata `sklep` jak dziś', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', mapujZamowienie(surowePrzelew(), mapowaniePrzelew), {});
    expect(wplaty(db, id)).toEqual([{ zrodlo: 'sklep', kwota: '212.90', metoda: 'Przelew tradycyjny' }]);
  });

  it('stara wpłata `sklep` znika przy ponownej synchronizacji, wpłata ręczna zostaje', () => {
    const db = openOmsDb(':memory:');
    const surowe = surowePobranie({ id: 1267, number: '1267' });
    const id = zapiszZamowienie(db, 'pro', zmapowaneStare(), {});
    dodajWplateReczna(db, id, { kwota: '10.00', data: '2026-10-28T10:00:00Z', metoda: 'Przelew' });
    expect(wplaty(db, id).map((w) => w.zrodlo).sort()).toEqual(['reczna', 'sklep']);
    const id2 = zapiszZamowienie(db, 'pro', mapujZamowienie(surowe, mapowaniePobranie), {});
    expect(id2).toBe(id);
    expect(wplaty(db, id)).toEqual([{ zrodlo: 'reczna', kwota: '10.00', metoda: 'Przelew' }]);
  });
});

describe('PRZ-137.05 data sprzedaży przy pobraniu ze starą wpłatą `sklep`', () => {
  it('P1 bez resynchronizacji: podstawa „wydanie", nie „zaplata"', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', zmapowaneStare(), {});
    const z = pobierzZamowienie(db, id);
    // Warunek wstępny: stara wpłata jest w bazie (metoda „Płatność przy odbiorze" nie jest
    // rozpoznana przez słownik metod jako inkaso — dlatego filtr idzie po źródle).
    expect((z.platnosci ?? []).map((p) => p.zrodlo)).toEqual(['sklep']);
    const d = proponowanaDataSprzedazy(z, '2026-11-04');
    expect(d.podstawa).toBe('wydanie');
    expect(d.data).toBe('2026-11-04');
  });

  it('pobranie + prawdziwy przelew ręczny przed wysyłką → dalej „zaplata" (bramka wąska)', () => {
    const z = {
      pobranie: 1, kwota_brutto: '212.90', pozycje: [], wyslane_at: '2026-10-30T10:00:00Z',
      platnosci: [
        { zrodlo: 'sklep', kwota: '212.90', data: '2026-10-28T10:00:00Z', metoda: 'Płatność przy odbiorze' },
        { zrodlo: 'reczna', kwota: '212.90', data: '2026-10-29T10:00:00Z', metoda: 'Przelew' },
      ],
    };
    const d = proponowanaDataSprzedazy(z, '2026-11-04');
    expect(d.podstawa).toBe('zaplata');
    expect(d.data).toBe('2026-10-29');
  });

  it('bez pobrania wpłata `sklep` przed wysyłką → „zaplata" jak dziś', () => {
    const z = {
      pobranie: 0, kwota_brutto: '212.90', pozycje: [], wyslane_at: '2026-10-30T10:00:00Z',
      platnosci: [{ zrodlo: 'sklep', kwota: '212.90', data: '2026-10-29T10:00:00Z', metoda: 'Przelew tradycyjny' }],
    };
    const d = proponowanaDataSprzedazy(z, '2026-11-04');
    expect(d.podstawa).toBe('zaplata');
    expect(d.data).toBe('2026-10-29');
  });
});

// Recenzja A1: instancja dostawy jeszcze nie w mapowaniu → metoda „nieznana", `pobranie:false`,
// choć klient wybrał bramkę pobrania (`cod` na liście `bramkiPobrania`). Wpłata `sklep` z `date_paid`
// powstawała wtedy dalej — i odżywała przy każdej synchronizacji po ręcznym ustawieniu pobrania na karcie.
describe('PRZ-137.05 A1: bramka pobrania przy nieznanej instancji dostawy', () => {
  const nieznanaInstancja = (nad = {}) => surowePobranie({
    id: 7, number: '7', shipping_lines: [{ method_id: 'flat_rate', instance_id: '9' }], ...nad,
  });

  it('cod z listy bramek, instancja spoza mapowania → oplacone_at null', () => {
    const z = mapujZamowienie(nieznanaInstancja(), mapowaniePobranie);
    expect(z.metoda_wysylki).toBe('nieznana');
    expect(z.oplacone_at).toBeNull();
    expect(z.metoda_platnosci).toBe('Płatność przy odbiorze');
  });

  it('zapis + pobranie ustawione na karcie + ponowna synchronizacja → brak wpłaty `sklep`', () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', mapujZamowienie(nieznanaInstancja(), mapowaniePobranie), {});
    expect(wplaty(db, id)).toEqual([]);
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?')
      .run(JSON.stringify({ metoda: 'dpd', pobranie: true, kwota_pobrania: '212.90' }), id);
    zapiszZamowienie(db, 'pro', mapujZamowienie(nieznanaInstancja(), mapowaniePobranie), {});
    expect(wplaty(db, id)).toEqual([]);
    expect(proponowanaDataSprzedazy(pobierzZamowienie(db, id), '2026-11-04').podstawa).toBe('wydanie');
  });

  // Pytanie T5 do właściciela: odbiór osobisty z bramką `cod` zostaje z wpłatą jak przed PRZ-137.
  // Zmiana tej decyzji = świadoma zmiana tego testu.
  it('odbiór osobisty z bramką cod i date_paid → wpłata jak dotąd (T5)', () => {
    const odbior = { instancje: { 4: { metoda: 'odbior_osobisty', pobranie: false } }, poPozycji: [], bramkiPobrania: ['cod'] };
    const z = mapujZamowienie(surowePobranie({ shipping_lines: [{ method_id: 'local_pickup', instance_id: '4' }] }), odbior);
    expect(z.metoda_wysylki).toBe('odbior_osobisty');
    expect(z.oplacone_at).toBe('2026-10-29T13:00:00Z');
  });

  it('p24 + instancja pobraniowa (sprzeczność, „nieznana") → wpłata zostaje', () => {
    const surowe = surowePobranie({ payment_method: 'p24', payment_method_title: 'Przelewy24' });
    const z = mapujZamowienie(surowe, mapowaniePobranie);
    expect(z.metoda_wysylki).toBe('nieznana');
    expect(z.pobranie).toBe(0);
    expect(z.oplacone_at).toBe('2026-10-29T13:00:00Z');
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', z, {});
    expect(wplaty(db, id)).toEqual([{ zrodlo: 'sklep', kwota: '212.90', metoda: 'Przelewy24' }]);
  });
});
