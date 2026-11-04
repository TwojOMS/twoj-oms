import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { pobierzZamowienie, zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { ustawKanalyAllegro } from '../../src/domena/moduly-kanalow.ts';
import { createSyncSklep } from '../../src/moduly/zamowienia/services/sync-sklep.js';

describe('status zwrotny — złoty wynik Pracowni Półcień', () => {
  let db;
  beforeEach(() => { db = openOmsDb(':memory:'); ustawKanalyAllegro(['polcien_konto']); });
  afterEach(() => { db.close(); ustawKanalyAllegro([]); });

  const klient = () => ({
    pobierzStanRealizacji: vi.fn().mockResolvedValue('NEW'),
    ustawStatusRealizacji: vi.fn().mockResolvedValue({}),
    ustawStatus: vi.fn().mockResolvedValue({}),
  });
  function zamowienie(sklep) {
    const id = zapiszZamowienie(db, sklep, {
      zrodlo_id: '1000001', numer: '1000001', klient: { first_name: 'Pracownia Półcień' },
      dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
      koszt_dostawy_brutto: '0.00', oplacone_at: null, anulowane: 0,
      pozycje: [], status_woo: 'processing', kwota_brutto: '0.00',
      utworzone_at: '2026-11-03T10:00:00',
    }, {});
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-11-03T11:00:00', id);
    return id;
  }
  const log = (id) => db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ?').all(id);

  it.each(['allegro_polcien', 'polcien_konto'])('Allegro %s: jeden odczyt i jeden zapis realizacji', async (sklep) => {
    const id = zamowienie(sklep), k = klient();
    expect(await createSyncSklep({ db, klienciKanalow: { [sklep]: k } }).odeslijStatus(id)).toEqual({ wyslany: 'SENT' });
    expect(k.pobierzStanRealizacji.mock.calls).toEqual([[1000001]]);
    expect(k.ustawStatusRealizacji.mock.calls).toEqual([[1000001, 'SENT']]);
    expect(k.ustawStatus).not.toHaveBeenCalled();
    expect(log(id)).toEqual([{ akcja: 'sync-allegro.status', wynik: 'status w Allegro ustawiony na „SENT"' }]);
  });

  it('sklep: jeden zapis completed', async () => {
    const id = zamowienie('polcien'), k = klient();
    expect(await createSyncSklep({ db, klienci: { polcien: k } }).odeslijStatus(id)).toEqual({ wyslany: 'completed' });
    expect(k.ustawStatus.mock.calls).toEqual([[1000001, 'completed']]);
    expect(k.ustawStatusRealizacji).not.toHaveBeenCalled();
    expect(k.pobierzStanRealizacji).not.toHaveBeenCalled();
    expect(log(id)).toEqual([{ akcja: 'sync-woo.status', wynik: 'status w sklepie ustawiony na „completed"' }]);
  });

  it('ręczne: bez wywołań i bez nowego logu', async () => {
    const id = zamowienie('reczne'), k = klient(), przed = log(id);
    expect(await createSyncSklep({ db, klienci: { reczne: k }, klienciKanalow: { allegro_polcien: k } }).odeslijStatus(id))
      .toEqual({ wyslany: null, powod: 'nie ma czego wysyłać' });
    for (const metoda of Object.values(k)) expect(metoda).not.toHaveBeenCalled();
    expect(log(id)).toEqual(przed);
  });

  it.each([
    ['polcien', 'completed', 'do sklepu', 'sync-woo.status'],
    ['allegro_polcien', 'SENT', 'do Allegro', 'sync-allegro.status'],
  ])('błąd klienta %s zachowuje ślad i log', async (sklep, status, dokad, akcja) => {
    const id = zamowienie(sklep), k = klient();
    k.ustawStatus.mockRejectedValue(new Error('awaria Półcienia'));
    k.ustawStatusRealizacji.mockRejectedValue(new Error('awaria Półcienia'));
    expect(await createSyncSklep({ db, klienci: { [sklep]: k }, klienciKanalow: { [sklep]: k } }).odeslijStatus(id))
      .toEqual({ wyslany: null, blad: 'awaria Półcienia' });
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBe(`status „${status}" nie dojechał ${dokad}: awaria Półcienia`);
    expect(log(id)).toEqual([{ akcja, wynik: 'BŁĄD: awaria Półcienia' }]);
    expect(k.ustawStatus.mock.calls.length + k.ustawStatusRealizacji.mock.calls.length).toBe(1);
  });
});
