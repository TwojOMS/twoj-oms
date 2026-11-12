import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { ustawRejestrKanalow } from '../../../src/domena/moduly-kanalow.ts';
import { createSyncSklep } from '../../../src/moduly/zamowienia/services/sync-sklep.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';
import { createErliClient } from '../../../src/oms/erli/client.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

let db, id, klient, sync;
const surowe = { id: 'PC-ERLI-0001', sellerStatus: 'created', delivery: { name: 'Kurier testowy', typeId: 'kurierTestowy' } };
function fakty(nad) {
  for (const [pole, wartosc] of Object.entries(nad)) db.prepare(`UPDATE zamowienia SET ${pole} = ? WHERE id = ?`).run(wartosc, id);
}
beforeEach(() => {
  ustawRejestrKanalow(k => k === 'konto_pc' ? 'erli' : null);
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'konto_pc', {
    zrodlo_id: surowe.id, numer: surowe.id, klient: {}, dostawa: {}, metoda_wysylki: 'nieznana',
    kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '10.00', koszt_dostawy_brutto: '0.00',
    status_woo: 'purchased', status_realizacji: 'created', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-11-11T10:00:00Z', pozycje: [],
  }, surowe);
  klient = { ustawStatusSprzedawcy: vi.fn(async () => ({})) };
  sync = createSyncSklep({ db, klienciKanalow: { konto_pc: klient } });
});
afterEach(() => { db.close(); ustawRejestrKanalow(null); });

describe('status zwrotny ERLI przez wspólną usługę', () => {
  it('karta HTML pokazuje ręczne anulowanie i istniejący przycisk ponowienia', async () => {
    const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' }, sklepy: {}, kanaly: {} },
      poller: { stan: () => ({}) }, syncSklep: sync });
    try {
      await app.ready();
      ustawRejestrKanalow(k => k === 'konto_pc' ? 'erli' : null);
      fakty({ anulowane: 1, sync_woo_blad: 'HTTP 503' });
      const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`,
        headers: { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64') } });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('anuluj w panelu ERLI');
      expect(r.body).toContain('Wyślij ponownie');
      expect(r.body).toContain(`/zamowienia/${id}/sync-sklep`);
    } finally { await app.close(); }
  });
  it('prawdziwy klient przyjmuje HTTP 202, wykonuje PATCH i nie odczytuje stanu ERLI', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const httpKlient = createErliClient({ adresApi: 'https://sklep.polcien.example/svc/shop-api', kluczApi: 'fikcyjny-klucz', fetchImpl });
    sync = createSyncSklep({ db, klienciKanalow: { konto_pc: httpKlient } });
    fakty({ w_realizacji_at: '2026-11-11T11:00:00Z' });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'inProgress' });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://sklep.polcien.example/svc/shop-api/orders/PC-ERLI-0001/status');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ status: 'inProgress' });
  });
  it('w realizacji wysyła inProgress raz mimo spóźnionego odczytu i nowej instancji usługi', async () => {
    fakty({ w_realizacji_at: '2026-11-11T11:00:00Z' });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'inProgress' });
    sync = createSyncSklep({ db, klienciKanalow: { konto_pc: klient } });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy.mock.calls).toEqual([[surowe.id, 'inProgress']]);
    expect(pobierzZamowienie(db, id).status_realizacji).toBe('created');
  });
  it('wysłane wysyła sent i nie cofa go potem do inProgress', async () => {
    fakty({ wyslane_at: '2026-11-11T11:00:00Z' });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'sent' });
    fakty({ wyslane_at: null, w_realizacji_at: '2026-11-11T11:00:00Z' });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy).toHaveBeenCalledTimes(1);
  });
  it('odbiór osobisty wysyła readyToPickup i także nie cofa statusu', async () => {
    fakty({ wyslane_at: '2026-11-11T11:00:00Z', metoda_wysylki: 'odbior_osobisty' });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'readyToPickup' });
    fakty({ wyslane_at: null, w_realizacji_at: '2026-11-11T11:00:00Z' });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy).toHaveBeenCalledTimes(1);
  });
  it('nazwa dostawy ERLI nie zastępuje metody wysyłki OMS', async () => {
    fakty({ wyslane_at: '2026-11-11T11:00:00Z', metoda_wysylki: 'dpd',
      surowe_json: JSON.stringify({ ...surowe, delivery: { name: 'Odbiór osobisty' } }) });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'sent' });
    expect(klient.ustawStatusSprzedawcy).toHaveBeenCalledWith(surowe.id, 'sent');
  });
  it.each(['sent', 'readyToPickup', 'received', 'returned', 'returningToSender', 'canceled'])(
    'stan ERLI %s blokuje cofnięcie do inProgress także bez śladu zapisu OMS', async status => {
      fakty({ status_realizacji: status, w_realizacji_at: '2026-11-11T11:00:00Z' });
      expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
      expect(klient.ustawStatusSprzedawcy).not.toHaveBeenCalled();
    });
  it('stan ERLI równy celowi nie zastępuje śladu zapisu OMS', async () => {
    fakty({ status_realizacji: 'sent', wyslane_at: '2026-11-11T11:00:00Z' });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'sent' });
    expect(klient.ustawStatusSprzedawcy).toHaveBeenCalledWith(surowe.id, 'sent');
  });
  it('punkt odbioru kuriera nie oznacza odbioru osobistego', async () => {
    fakty({ wyslane_at: '2026-11-11T11:00:00Z', surowe_json: JSON.stringify({ ...surowe, delivery: { name: 'Paczkomat', pickupPlace: { externalId: 'PC001' } } }) });
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'sent' });
  });
  it('zwrot z importu ERLI nie wysyła statusu nawet przed rejestracją zwrotu w OMS', async () => {
    fakty({ status_woo: 'returned', wyslane_at: '2026-11-11T11:00:00Z' });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy).not.toHaveBeenCalled();
  });
  it('anulowanie nie idzie automatem, karta kieruje do panelu ERLI', async () => {
    fakty({ anulowane: 1 });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy).not.toHaveBeenCalled();
    expect(sprawyKarty(pobierzZamowienie(db, id)).some(s => s.tekst.includes('anuluj w panelu ERLI'))).toBe(true);
  });
  it('anulowanie przez kupującego w ERLI nie wymaga ponownego anulowania w panelu', async () => {
    fakty({ anulowane: 1, status_woo: 'cancelled' });
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy).not.toHaveBeenCalled();
    expect(sprawyKarty(pobierzZamowienie(db, id)).some(s => s.klucz === 'anulowanie-kanalu')).toBe(false);
  });
  it.each([{}, { zwrot_at: '2026-11-11T11:00:00Z', wyslane_at: '2026-11-11T10:00:00Z' }])('nowe i zwroty pozostają bez zapisu: %j', async nad => {
    fakty(nad);
    expect((await sync.odeslijStatus(id)).wyslany).toBeNull();
    expect(klient.ustawStatusSprzedawcy).not.toHaveBeenCalled();
  });
  it('błąd HTTP zostawia sprawę i pozwala na skuteczne ponowienie', async () => {
    fakty({ w_realizacji_at: '2026-11-11T11:00:00Z' });
    klient.ustawStatusSprzedawcy.mockRejectedValueOnce(new Error('HTTP 503'));
    expect((await sync.odeslijStatus(id)).blad).toBe('HTTP 503');
    expect(pobierzZamowienie(db, id).sync_woo_blad).toContain('HTTP 503');
    expect(sprawyKarty(pobierzZamowienie(db, id)).find(s => s.klucz === 'sync-sklep').tekst).toContain('Wyślij ponownie');
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'inProgress' });
    expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });
  it('tylko odczyt pomija zapis i nie zapamiętuje go jako wysłanego', async () => {
    fakty({ w_realizacji_at: '2026-11-11T11:00:00Z' });
    klient.tylkoOdczyt = true;
    expect((await sync.odeslijStatus(id)).powod).toContain('tylko do odczytu');
    expect(klient.ustawStatusSprzedawcy).not.toHaveBeenCalled();
    klient.tylkoOdczyt = false;
    expect(await sync.odeslijStatus(id)).toEqual({ wyslany: 'inProgress' });
  });
});
