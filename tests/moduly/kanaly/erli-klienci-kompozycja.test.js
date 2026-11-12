import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createModulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { zbudujAplikacje } from '../../../src/core/aplikacja.ts';
import { ustawRejestrKanalow } from '../../../src/domena/moduly-kanalow.ts';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { przekazNumerKanalu } from '../../../src/moduly/wysylka/services/numer-kanalu.js';
import { utworzUslugiWiadomosci } from '../../../src/moduly/wiadomosci/uslugi.ts';
import { createPollerWiadomosci } from '../../../src/moduly/wiadomosci/services/poller-wiadomosci.js';
import { createCzuwaczFormulki } from '../../../src/moduly/wiadomosci/services/czuwacz-formulki.js';
import { createOdswiezanieSpraw } from '../../../src/moduly/wiadomosci/services/dyskusje.js';
import { modulyPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { zapiszWatek } from '../../../src/oms/db/allegro-watki.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { kanalZWiadomosciami } from '../../../src/domena/moduly-kanalow.ts';

let db, app, katalog;
afterEach(async () => {
  await app?.app.close(); db?.close(); ustawRejestrKanalow(null);
  if (katalog) rmSync(katalog, { recursive: true, force: true });
  katalog = undefined; db = undefined; app = undefined;
});

async function przygotuj(pelna = false) {
  db = openOmsDb();
  const fetchImpl = vi.fn(async (url, init) => {
    if (url.endsWith('/shippingMethods')) return Response.json([]);
    if (url.endsWith('/deliveryMethods')) return Response.json([{ id: 'wlasny', vendor: 'dpd' }]);
    if (url.endsWith('/shipping/external')) return Response.json([{ id: 'PC-EXTERNAL-1' }]);
    throw new Error('Nieoczekiwany transport testowy');
  });
  if (pelna) katalog = mkdtempSync(new URL('../../../.tmp-prz157-12b-', import.meta.url));
  const env = pelna ? { ...ENV_DEMO, OMS_KANALY: '[]', OMS_USER: 'test', OMS_PASS: 'fikcyjne',
    OMS_PROFORMY_KATALOG: join(katalog, 'proformy'), OMS_ETYKIETY_KATALOG: join(katalog, 'etykiety') } : {};
  const kanaly = createModulKanaly([], pelna, { fetchImpl });
  const moduly = pelna ? modulyPiaskownicy(env).map(m => m.nazwa === 'kanaly' ? kanaly : m) : [modulRdzen, kanaly];
  app = await zbudujAplikacje({ db, moduly, env });
  db.prepare(`INSERT INTO kanaly_sprzedazy
    (klucz,typ,nazwa,srodowisko,zrodlo,konto_id,raport,autoryzacja,pobieranie,od_utc,
     wersja,generacja,generacja_importu,utworzono_at,zmieniono_at,aktor_id,aktor_login)
    VALUES ('konto_pc','erli','Pracownia Półcień','produkcja','panel','1000001','PC','polaczone',
      'wlaczone','2026-11-01T00:00:00Z',1,1,1,'2026-11-11T00:00:00Z','2026-11-11T00:00:00Z',0,'test')`).run();
  zapiszKonfiguracjeIntegracji(db, 'erli:konto_pc', {
    ustawienia: { adresApi: 'https://sklep.polcien.example' }, sekrety: { kluczApi: 'fikcyjny' },
  });
  return { klienci: app.usluga('kanaly', 'klienciKanalow'), fetchImpl };
}

it('połączony ERLI dodany po starcie jest klientem z rejestru; ustawienia Allegro pozostają osobno', async () => {
  const { klienci } = await przygotuj();
  expect(Object.keys(klienci)).toEqual(['konto_pc']);
  expect(klienci.konto_pc).toBe(app.usluga('kanaly', 'rejestrKanalow').klient('konto_pc'));
  expect(Object.keys(app.usluga('kanaly', 'config').kanaly)).toEqual([]);
  expect(Object.keys(app.usluga('kanaly', 'tokenyKanalow'))).toEqual([]);
});

it.each(['odlaczone', 'brak', 'wymaga_autoryzacji', 'oczekuje_potwierdzenia'])('ERLI %s nie jest dostępny w mapie', async stan => {
  const { klienci } = await przygotuj();
  expect(Object.keys(klienci)).toContain('konto_pc');
  db.prepare('UPDATE kanaly_sprzedazy SET autoryzacja=? WHERE klucz=?').run(stan, 'konto_pc');
  expect(Object.keys(klienci)).toEqual([]);
  expect(klienci.konto_pc).toBeUndefined();
});

it('konflikt klucza wyklucza ERLI', async () => {
  const { klienci } = await przygotuj();
  db.prepare("UPDATE kanaly_sprzedazy SET zrodlo='env' WHERE klucz='konto_pc'").run();
  expect(Object.keys(klienci)).toEqual([]);
});

it('przekazNumerKanalu używa klienta ERLI z kompozycji i zapisuje potwierdzenie', async () => {
  const { klienci, fetchImpl } = await przygotuj();
  const id = zapiszZamowienie(db, 'konto_pc', {
    zrodlo_id: 'PC-ERLI-0001', numer: 'PC-ERLI-0001', klient: {}, dostawa: {}, metoda_wysylki: 'dpd',
    kwota_pobrania: null, chce_fakture: 0, nip: null, oplacone_at: null, anulowane: 0, punkt_odbioru: null,
    kwota_brutto: '10.00', status_woo: 'purchased', utworzone_at: '2026-11-11T10:00:00Z', pozycje: [],
  }, { delivery: { typeId: 'wlasny' } });
  const p = rozpocznijPrzesylke(db, id, 'dpd');
  zakonczPrzesylke(db, p.id, { numerListu: 'PC-TRACK-1', etykietaSciezka: null, surowa: '{}' });
  expect(await przekazNumerKanalu({ db, klienci: {}, klienciKanalow: klienci }, p.id)).toEqual({ ok: true });
  const post = fetchImpl.mock.calls.find(([url]) => url.endsWith('/shipping/external'));
  expect(JSON.parse(post[1].body)).toMatchObject([{ orderId: 'PC-ERLI-0001', trackingNumber: 'PC-TRACK-1', vendor: 'dpd' }]);
  expect(db.prepare("SELECT wynik FROM log WHERE akcja='sync-numer.przyjeto'").get().wynik).toContain('PC-EXTERNAL-1');
});

// Odbiorcy dostają TĘ SAMĄ żywą mapę (tests/moduly/wiadomosci/okablowanie-wiadomosci.test.js) i sami pomijają ERLI.
it('wiadomości: trzej odbiorcy biorą tę samą mapę kompozycji i pomijają klienta ERLI', async () => {
  const { klienci, fetchImpl } = await przygotuj();
  const mapy = [];
  const teraz = () => new Date('2026-11-11T11:00:00Z');
  const u = utworzUslugiWiadomosci({ db, config: { poczta: null }, klienciKanalow: klienci,
    fabryki: Object.fromEntries(['createOdswiezanieSpraw', 'createPollerWiadomosci', 'createCzuwaczFormulki'].map(n => [n, o => {
      mapy.push(o.klienci); return ({ createOdswiezanieSpraw, createPollerWiadomosci, createCzuwaczFormulki })[n]({ ...o, teraz }); }])) });
  expect(u.klienciWiadomosci).toBe(klienci);
  expect(mapy).toHaveLength(3);
  for (const mapa of mapy) expect(mapa).toBe(klienci);
  expect(Object.keys(klienci)).toEqual(['konto_pc']);
  zapiszWatek(db, { kanal: 'konto_pc', threadId: 'PC-WATEK-2', typ: 'COMMON',
    interlocutorLogin: 'pracownia-polcien', ostatniaOdKupujacego: 1, lastMessageDateTime: '2026-11-11T10:00:00Z' });
  expect(await u.odswiezanieSpraw.przebieg()).toEqual({ zapisane: 0, bledy: [] });
  expect(await u.pollerWiadomosci.przebieg()).toMatchObject({ watkow: 0, bledy: [] });
  // Formułka włączona całą dobę, bez karencji: wątek ERLI kwalifikuje się czasem, a czuwacz i tak go pomija.
  zapiszUstawienia(db, { 'formulka.wlaczona': '1', 'formulka.tresc': 'Odpiszemy jutro.', 'formulka.od': '0',
    'formulka.do': '0', 'formulka.dni': '0,1,2,3,4,5,6', 'formulka.karencja': '0' });
  expect(await u.czuwaczFormulki.przebieg()).toMatchObject({ wyslane: 0, bledy: [] });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(db.prepare('SELECT COUNT(*) AS n FROM allegro_odpowiedzi').get().n).toBe(0);
  // Kontrola: ten sam układ z wątkiem Allegro wysyła formułkę.
  const wyslij = vi.fn(async () => ({}));
  zapiszWatek(db, { kanal: 'allegro_kontrola', threadId: 'PC-WATEK-3', typ: 'COMMON',
    interlocutorLogin: 'kupujacy-polcien', ostatniaOdKupujacego: 1, lastMessageDateTime: '2026-11-11T10:00:00Z' });
  const kontrola = createCzuwaczFormulki({ db, klienci: { ...Object.fromEntries(Object.keys(klienci).map(k => [k, klienci[k]])),
    allegro_kontrola: { wyslijWiadomosc: wyslij } }, teraz });
  expect(await kontrola.przebieg()).toMatchObject({ wyslane: 1, bledy: [] });
  expect(wyslij).toHaveBeenCalledWith('PC-WATEK-3', 'Odpiszemy jutro.');
});

it('predykat wiadomości: konto Allegro bez przedrostka w rejestrze przechodzi, ERLI nie', () => {
  ustawRejestrKanalow(k => ({ konto_pl: 'allegro', konto_pc: 'erli' })[k] ?? null);
  expect(kanalZWiadomosciami('konto_pl')).toBe(true);
  expect(kanalZWiadomosciami('konto_pc')).toBe(false);
  expect(kanalZWiadomosciami('allegro_nowe')).toBe(true);
});

it('samo ERLI nie włącza magazynu ofert ani faktur Allegro, włącza nadanie Przesyłek Erli; mapy odbiorców są żywe', async () => {
  const { klienci } = await przygotuj(true);
  expect(Object.keys(klienci)).toEqual(['konto_pc']);
  expect(app.usluga('magazyn', 'magazyn').gotowy()).toBe(false);
  expect(app.usluga('faktury', 'fakturaAllegro').gotowe()).toBe(false);
  // Samo ERLI włącza nadanie: Przesyłki Erli są kurierem (PRZ-157.08), więc nadanie jest gotowe.
  expect(app.usluga('wysylka', 'nadanie').gotowe()).toBe(true);
  expect(app.usluga('wiadomosci', 'klienciWiadomosci')).toBe(klienci);
});

it('trasa odpowiedzi odmawia klientowi ERLI przed zapisem dowodu i transportem', async () => {
  const { fetchImpl } = await przygotuj(true);
  zapiszWatek(db, { kanal: 'konto_pc', threadId: 'PC-WATEK-1', typ: 'COMMON',
    interlocutorLogin: 'pracownia-polcien', ostatniaOdKupujacego: 1, lastMessageDateTime: '2026-11-11T10:00:00Z' });
  const r = await app.app.inject({ method: 'POST', url: '/wiadomosci/konto_pc/PC-WATEK-1/odpowiedz',
    headers: { authorization: `Basic ${Buffer.from('test:fikcyjne').toString('base64')}`,
      origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'tresc=Test&potwierdzam=tak' });
  expect(r.statusCode).toBe(503);
  expect(db.prepare('SELECT COUNT(*) AS n FROM allegro_odpowiedzi').get().n).toBe(0);
  expect(fetchImpl).not.toHaveBeenCalled();
});
