// PRZ-117 — status, który nie dojechał do Allegro albo do sklepu przez chwilową awarię (zamówienie 1496, 26.10.2026:
// „PUT …/fulfillment: api.allegro.pl: żądanie anulowane” po równo 5 s, LIMIT_ZAPYTANIA_STATUSU_MS). Rano ten sam PUT
// trwał 170 ms. Do tej poprawki ślad czekał na „Wyślij ponownie”; teraz zegar ponawia sam — ale wyłącznie błędy
// PRZEJŚCIOWE (limit czasu, sieć, 5xx). Odmowa (4xx, brak konfiguracji) za kwadrans się nie zmieni.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createSyncSklep, bladPrzejsciowy, OKNO_PONAWIANIA_STATUSU_DNI } from '../../../src/moduly/zamowienia/services/sync-sklep.js';

const TERAZ = new Date('2026-10-26T12:30:00Z');
const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { email: 'j@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '36.85',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-26T11:10:09Z', pozycje: [], ...nad,
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zAllegro = (zrodlo = 'afd93fe0-0000-0000-0000-000000000001', nad = {}) => {
  const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(zrodlo, {
    zrodlo_id: zrodlo, metoda_wysylki: 'allegro_paczkomat', status_woo: 'READY_FOR_PROCESSING', ...nad,
  }), {});
  db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-10-26T12:12:40Z', id);
  return id;
};
const anulowane = () => Object.assign(new Error('api.allegro.pl: żądanie anulowane'), { name: 'AbortError' });

describe('PRZ-117: zegar ponawia status po błędzie przejściowym', () => {
  it('1496: PUT ucięty po 5 s → ślad; następny przebieg zegara wysyła i zdejmuje ślad', async () => {
    const klient = {
      pobierzStanRealizacji: vi.fn().mockResolvedValue('PROCESSING'),
      ustawStatusRealizacji: vi.fn().mockRejectedValueOnce(anulowane()).mockResolvedValue({}),
    };
    const sync = createSyncSklep({ db, klienciKanalow: { allegro_szkicownia: klient } });
    const id = zAllegro();
    await sync.odeslijStatus(id);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toMatch(/żądanie anulowane/);

    expect(await sync.ponowPrzejsciowe({ teraz: TERAZ })).toEqual({ kandydatow: 1, wyslane: 1, bledy: 0 });
    expect(klient.ustawStatusRealizacji).toHaveBeenLastCalledWith(expect.any(String), 'SENT');
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  it('odmowa (4xx) nie jest ponawiana — klient nie dostaje drugiego strzału', async () => {
    const klient = {
      pobierzStanRealizacji: vi.fn().mockResolvedValue('PROCESSING'),
      ustawStatusRealizacji: vi.fn().mockRejectedValue(new Error('Allegro: HTTP 422 przy /order/checkout-forms/{id}/fulfillment')),
    };
    const sync = createSyncSklep({ db, klienciKanalow: { allegro_szkicownia: klient } });
    const id = zAllegro();
    await sync.odeslijStatus(id);
    expect(await sync.ponowPrzejsciowe({ teraz: TERAZ })).toEqual({ kandydatow: 0, wyslane: 0, bledy: 0 });
    expect(klient.ustawStatusRealizacji).toHaveBeenCalledTimes(1);
    expect(pobierzZamowienie(db, id).sync_woo_blad).toMatch(/422/);
  });

  it(`zamówienie starsze niż ${OKNO_PONAWIANIA_STATUSU_DNI} dni zegar zostawia człowiekowi`, async () => {
    const klient = { pobierzStanRealizacji: vi.fn().mockResolvedValue('PROCESSING'), ustawStatusRealizacji: vi.fn() };
    const sync = createSyncSklep({ db, klienciKanalow: { allegro_szkicownia: klient } });
    const id = zAllegro('stare-1', { utworzone_at: '2026-09-01T10:00:00Z' });
    db.prepare("UPDATE zamowienia SET sync_woo_blad = 'status „SENT\" nie dojechał do Allegro: api.allegro.pl: żądanie anulowane' WHERE id = ?").run(id);
    expect(await sync.ponowPrzejsciowe({ teraz: TERAZ })).toEqual({ kandydatow: 0, wyslane: 0, bledy: 0 });
    expect(klient.pobierzStanRealizacji).not.toHaveBeenCalled();
  });

  it('sklep Woo: „Sklep nieosiągalny … błąd sieci” też jest przejściowy i wraca', async () => {
    const sklep = { ustawStatus: vi.fn().mockRejectedValueOnce(new Error('Sklep nieosiągalny: sklep.invalid: błąd sieci')).mockResolvedValue({}) };
    const sync = createSyncSklep({ db, klienci: { pro: sklep } });
    const id = zapiszZamowienie(db, 'pro', zmapowane(90453), {});
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-10-26T12:00:00Z', id);
    await sync.odeslijStatus(id);
    expect(await sync.ponowPrzejsciowe({ teraz: TERAZ })).toEqual({ kandydatow: 1, wyslane: 1, bledy: 0 });
    expect(sklep.ustawStatus).toHaveBeenLastCalledWith(90453, 'completed');
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });
});

describe('PRZ-117: co jest błędem przejściowym', () => {
  it.each([
    ['status „SENT" nie dojechał do Allegro: api.allegro.pl: żądanie anulowane', true],
    ['nie udało się sprawdzić stanu w Allegro: api.allegro.pl: limit czasu', true],
    ['status „completed" nie dojechał do sklepu: Sklep nieosiągalny: szkicownia.pl: błąd sieci', true],
    ['status „completed" nie dojechał do sklepu: Sklep odpowiedział 503: brak powodu', true],
    ['status „completed" nie dojechał do sklepu: Sklep odpowiedział 400: zły status', false],
    ['panel nie ma połączenia z „allegro_x" (brak konfiguracji)', false],
    ['status „SENT" nie dojechał do Allegro: Allegro: HTTP 422 przy /order/checkout-forms/{id}/fulfillment', false],
  ])('%s → %s', (opis, oczekiwane) => {
    expect(bladPrzejsciowy(opis)).toBe(oczekiwane);
  });
});
