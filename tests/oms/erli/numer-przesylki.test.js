import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { createPuls } from '../../../src/core/puls.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { ustawRejestrKanalow } from '../../../src/domena/moduly-kanalow.ts';
import { createErliClient } from '../../../src/oms/erli/client.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { konfliktNumeruErli } from '../../../src/domena/erli-numer.js';
import { ponowZalegleNotatki } from '../../../src/moduly/wysylka/services/notatka-nadania.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { przekazNumerKanalu } from '../../../src/moduly/wysylka/services/numer-kanalu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

let db, id, nadanie, fetchImpl, klient, numer, kurier;
let typ, tracking, kanal, httpBlad;
let katalog;
beforeEach(() => {
  db = openOmsDb(':memory:');
  ustawRejestrKanalow(k => k === 'konto_pc' ? 'erli' : null);
  typ = 'wlasny'; tracking = null; kanal = 'konto_pc'; httpBlad = null;
  numer = 'PC-TRACK-1'; kurier = 'dpd';
  fetchImpl = vi.fn(async (url, init) => {
    if (url.endsWith('/shippingMethods')) return Response.json([{ id: 'platforma', vendor: 'dpd' }]);
    if (url.endsWith('/deliveryMethods')) return Response.json([{ id: 'wlasny', vendor: kurier.startsWith('inpost') ? 'inpost' : 'dpd' }]);
    if (httpBlad) return Response.json({ message: 'Awaria testowa' }, { status: httpBlad });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json([{ id: `external-${numer}`, orderId: 'PC-ERLI-0001' }]);
  });
  klient = createErliClient({ adresApi: 'https://sklep.polcien.example', kluczApi: 'fikcyjny', fetchImpl });
  katalog = mkdtempSync(join(tmpdir(), 'prz-157-06-'));
});
afterEach(() => { db.close(); ustawRejestrKanalow(null); rmSync(katalog, { recursive: true, force: true }); });
function przygotuj() {
  id = zapiszZamowienie(db, kanal, {
    zrodlo_id: 'PC-ERLI-0001', numer: 'PC-ERLI-0001', klient: {}, dostawa: {}, metoda_wysylki: kurier,
    kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '10.00', status_woo: 'purchased',
    oplacone_at: null, anulowane: 0, utworzone_at: '2026-11-11T10:00:00Z', pozycje: [],
    punkt_odbioru: kurier === 'inpost_paczkomat' ? 'PC001' : null,
  }, { delivery: { typeId: typ }, ...(tracking ? { deliveryTracking: { trackingNumber: tracking } } : {}) });
  nadanie = createNadanie({ db, katalogEtykiet: katalog, klienci: { [kanal]: klient },
    kurierzy: { dpd: { nadaj: async () => ({ numerListu: numer, surowa: '<xml/>', etykietaPdf: Buffer.from('%PDF-test') }) },
      inpost: { nadaj: async () => ({ numerListu: numer, surowa: '{}', etykietaPdf: Buffer.from('%PDF-test') }) } } });
}
const zapisy = () => fetchImpl.mock.calls.filter(([, init]) => ['POST', 'DELETE'].includes(init.method));
const sprawa = () => sprawyKarty(pobierzZamowienie(db, id)).filter(s => s.tekst.includes('ERLI ma już inny numer'));
it.each(['nadanie', 'ręczne ponowienie', 'czuwacz'])('złożony moduł przekazuje klienta kanału ERLI: %s', async tryb => {
  przygotuj();
  const modul = createModulWysylka();
  const uslugi = {
    'kanaly.klienciSklepow': {}, 'kanaly.klienciKanalow': { konto_pc: klient },
    'kanaly.config': { definicje: [], sklepy: {} }, 'rdzen.sprzedawca': { rachunek: '' },
    'faktury.infakt': null, 'faktury.puls': createPuls(),
  };
  const z = modul.zbuduj({ db, konfiguracja: modul.konfiguracja({ OMS_ETYKIETY_KATALOG: katalog }),
    teraz: () => new Date(), log: () => {}, usluga: (m, n) => uslugi[`${m}.${n}`] });
  z.uslugi.kurierzy.dpd = { nadaj: async () => ({ numerListu: numer, surowa: '<xml/>', etykietaPdf: Buffer.from('%PDF-test') }) };
  if (tryb !== 'nadanie') httpBlad = 500;
  await z.uslugi.nadanie.nadaj(id);
  if (tryb !== 'nadanie') {
    expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toMatch(/^notatka: /);
    httpBlad = null;
    if (tryb === 'czuwacz') expect((await z.uslugi.czuwaczPrzesylek.przebieg()).notatki).toMatchObject({ wyslane: 1, bledy: 0 });
    else await z.uslugi.nadanie.ponowNotatke(pobierzZamowienie(db, id).przesylki[0].id);
  }
  expect(zapisy()).toHaveLength(tryb === 'nadanie' ? 1 : 2);
  expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
});
it('numer pierwszej nadanej paczki w ERLI pozwala wysłać numer drugiej bez konfliktu', async () => {
  tracking = numer; przygotuj(); await nadanie.nadaj(id);
  numer = 'PC-TRACK-2'; await nadanie.nadaj(id, undefined, { kolejnosc: 2 });
  expect(sprawa()).toEqual([]);
  expect(zapisy()).toHaveLength(1);
  expect(JSON.parse(zapisy()[0][1].body)[0].trackingNumber).toBe('PC-TRACK-2');
});
it('obcy numer w ERLI blokuje obie paczki i pokazuje jedną sprawę', async () => {
  tracking = 'PC-INNY'; przygotuj(); await nadanie.nadaj(id);
  numer = 'PC-TRACK-2'; await nadanie.nadaj(id, undefined, { kolejnosc: 2 });
  expect(zapisy()).toEqual([]);
  expect(sprawa()).toHaveLength(1);
});
it('po potwierdzonym sukcesie ponowne przekazanie numeru nie wysyła POST', async () => {
  przygotuj(); await nadanie.nadaj(id);
  const p = pobierzZamowienie(db, id).przesylki[0];
  expect(await przekazNumerKanalu({ db, klienci: { konto_pc: klient } }, p.id)).toEqual({ pominiety: true });
  expect(zapisy()).toHaveLength(1);
});
it.each([['dpd', 'dpd'], ['inpost_paczkomat', 'inpost'], ['inpost_kurier', 'inpost']])('umowa %s przekazuje vendor OMS i numer', async (k, vendor) => {
  kurier = k; przygotuj();
  // OMS obecnie nadaje InPost tylko do paczkomatu. Dla kuriera sprawdzamy ten sam ogon
  // nadania na zapisanej paczce, bez rozszerzania rejestru kurierów (zmiana poza briefem).
  if (k === 'inpost_kurier') {
    const p = rozpocznijPrzesylke(db, id, 'inpost');
    zakonczPrzesylke(db, p.id, { numerListu: numer, etykietaSciezka: null, surowa: '{}' });
    await przekazNumerKanalu({ db, klienci: { konto_pc: klient } }, p.id);
  } else await nadanie.nadaj(id);
  expect(zapisy()).toHaveLength(1);
  expect(zapisy()[0][0]).toBe('https://sklep.polcien.example/shipping/external');
  expect(JSON.parse(zapisy()[0][1].body)).toEqual([{ orderId: 'PC-ERLI-0001', vendor, trackingNumber: numer,
    ...(vendor === 'dpd' ? { typeId: 'dpd' } : {}) }]);
});
it('dwie paczki mają dwa numery, id zapisane trwale i nie niszczą odpowiedzi kuriera', async () => {
  przygotuj(); await nadanie.nadaj(id); numer = 'PC-TRACK-2'; await nadanie.nadaj(id, undefined, { kolejnosc: 2 });
  expect(zapisy()).toHaveLength(2);
  expect(pobierzZamowienie(db, id).przesylki.map(p => p.odpowiedz_surowa)).toEqual(['<xml/>', '<xml/>']);
  const p = pobierzZamowienie(db, id).przesylki[1];
  await nadanie.anulujNumerKanalu(p.id);
  expect(zapisy().at(-1)[0]).toBe('https://sklep.polcien.example/shipping/external/external-PC-TRACK-2');
  expect(zapisy().at(-1)[1].method).toBe('DELETE');
  await nadanie.anulujNumerKanalu(p.id);
  expect(zapisy()).toHaveLength(3);
});
it.each(['platforma', 'nieznana'])('%s: żadnego zapisu', async t => {
  typ = t; przygotuj(); await nadanie.nadaj(id); expect(zapisy()).toEqual([]);
});
it('inny numer blokuje wysyłkę i pokazuje sprawę na karcie', async () => {
  tracking = 'PC-INNY'; przygotuj(); await nadanie.nadaj(id);
  expect(zapisy()).toEqual([]); expect(sprawa()).toHaveLength(1);
});
it('ten sam numer nie jest wysyłany ponownie i nie tworzy sprawy', async () => {
  tracking = numer; przygotuj(); await nadanie.nadaj(id);
  expect(zapisy()).toEqual([]); expect(sprawa()).toEqual([]);
});
it.each([500, 429])('HTTP %s zapisuje kolejkę i czuwacz ponawia', async status => {
  httpBlad = status; przygotuj(); await nadanie.nadaj(id);
  expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toMatch(/^notatka: /);
  httpBlad = null;
  expect(await ponowZalegleNotatki({ db, klienci: { konto_pc: klient } })).toMatchObject({ wyslane: 1, bledy: 0 });
  expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
  expect(zapisy()).toHaveLength(2);
});
it('tylko odczyt nie wysyła i nie tworzy kolejki', async () => {
  klient.tylkoOdczyt = true; przygotuj(); await nadanie.nadaj(id);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
});
it('anulowanie bez znanego id nie wysyła DELETE', async () => {
  tracking = numer; przygotuj(); await nadanie.nadaj(id);
  await nadanie.anulujNumerKanalu(pobierzZamowienie(db, id).przesylki[0].id);
  expect(zapisy()).toEqual([]);
});
it.each(['pro', 'allegro_polcien'])('kanał %s zachowuje notatkę po nadaniu', async sklep => {
  kanal = sklep; klient = { dodajNotatke: vi.fn(async () => ({})) }; przygotuj(); await nadanie.nadaj(id);
  expect(klient.dodajNotatke).toHaveBeenCalledWith('PC-ERLI-0001', `Nadano DPD, list przewozowy ${numer}`);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('niedostępne słowniki trafiają do kolejki i nie gubią numeru', async () => {
  fetchImpl.mockImplementationOnce(async () => Response.json({}, { status: 500 }));
  przygotuj(); await nadanie.nadaj(id);
  expect(zapisy()).toEqual([]);
  expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toMatch(/^notatka: /);
  expect(await ponowZalegleNotatki({ db, klienci: { konto_pc: klient } })).toMatchObject({ wyslane: 1 });
  expect(zapisy()).toHaveLength(1);
});
it('nieudany DELETE jest ponawiany jako DELETE, nigdy jako POST', async () => {
  przygotuj(); await nadanie.nadaj(id);
  const p = pobierzZamowienie(db, id).przesylki[0];
  httpBlad = 500; await nadanie.anulujNumerKanalu(p.id); httpBlad = null;
  expect(await ponowZalegleNotatki({ db, klienci: { konto_pc: klient } })).toMatchObject({ wyslane: 1 });
  expect(zapisy().map(([, init]) => init.method)).toEqual(['POST', 'DELETE', 'DELETE']);
});
it('ponowienie po przełączeniu na odczyt i DELETE w odczycie nie wysyłają nic', async () => {
  httpBlad = 500; przygotuj(); await nadanie.nadaj(id);
  klient.tylkoOdczyt = true;
  const p = pobierzZamowienie(db, id).przesylki[0];
  await nadanie.ponowNotatke(p.id); await nadanie.anulujNumerKanalu(p.id);
  expect(zapisy()).toHaveLength(1);
  expect(pobierzZamowienie(db, id).przesylki[0].sync_woo_blad).toBeNull();
});
it('karta HTML pokazuje jedną sprawę konfliktu numeru', async () => {
  tracking = 'PC-INNY'; przygotuj(); await nadanie.nadaj(id);
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' }, sklepy: {}, kanaly: {} }, poller: { stan: () => ({}) } });
  try {
    await app.ready(); ustawRejestrKanalow(k => k === 'konto_pc' ? 'erli' : null);
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`,
      headers: { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64') } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('ERLI ma już inny numer przesyłki — sprawdź w panelu ERLI');
  } finally { await app.close(); }
});

it('numer w ERLI bez nadanej paczki w OMS (Przesyłki Erli, panel ERLI, paczka w trakcie) nie jest konfliktem', () => {
  const surowe_json = JSON.stringify({ deliveryTracking: { trackingNumber: 'PC-TRACK-9' } });
  expect(konfliktNumeruErli({ surowe_json, przesylki: [] })).toBe(false);
  expect(konfliktNumeruErli({ surowe_json, przesylki: [{ status: 'nowa', numer_listu: null }] })).toBe(false);
  expect(konfliktNumeruErli({ surowe_json, przesylki: [{ status: 'nadana', numer_listu: 'PC-TRACK-1' }] })).toBe(true);
  expect(konfliktNumeruErli({ surowe_json, przesylki: [{ status: 'nadana', numer_listu: 'PC-TRACK-1' }, { status: 'nadana', numer_listu: 'PC-TRACK-9' }] })).toBe(false);
});
