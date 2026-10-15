// ⚠️⚠️ ZGŁOSZENIE WŁAŚCICIELA 12.08.2026: „na liście »do zrobienia« są 4 zamówienia wysłane
// z informacją »status u kuriera niedostępny«".
//
// Poprawka z 11.08 (`bezSledzenia`) zatkała ŹRÓDŁO — karta przestała wołać `statusPrzesylki`
// u kuriera, który śledzenia nie ma. Nie posprzątała jednak OSADU: cztery przesyłki miały
// już wpisane `status_kuriera_blad = 'BŁĄD TECHNICZNY: klient.statusPrzesylki is not
// a function'`, a jedyną udokumentowaną drogą kasowania tej kolumny jest „najbliższe UDANE
// odświeżenie" (patrz zapiszProbeStatusuDpd). Dla kuriera bez śledzenia takie odświeżenie
// NIE NASTĄPI NIGDY — zamówienia zostałyby na liście roboczej na zawsze.
//
// To jest dokładnie niezmiennik 4.9: panel nie może wchodzić w stan, z którego nie umie wyjść.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zbudujOms } from '../../pomoc/bootstrap-parytetu.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszProbeStatusuDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { wyczyscBladStatusuBezSledzenia } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { sprawyPrzesylki } from '../../../src/domena/przesylka-stan.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: '2026-08-12T06:00:00', ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-11T06:00:00',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 1, cena_brutto: '100.00', vat: null }],
  ...nad,
});

// Przesyłka nadana danym kurierem, z zapisanym błędem statusu — czyli DOKŁADNIE stan
// czterech zamówień z produkcji (numery listów AD0…, kurier `allegro_wza`).
function nadanaZBledem(db, zamowienieId, kurier, blad = 'BŁĄD TECHNICZNY: klient.statusPrzesylki is not a function') {
  const p = rozpocznijPrzesylke(db, zamowienieId, kurier);
  zakonczPrzesylke(db, p.id, { numerListu: 'AD0H89CGW4T87HXD8', etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  // Znacznik próby CELOWO stary — inaczej dławik godzinowy zdjąłby odświeżenie z gry
  // i test przechodziłby z powodu, którego nie bada.
  zapiszProbeStatusuDpd(db, p.id, { at: '2026-08-11T06:00:00.000Z', blad });
  return p.id;
}

const wiersz = (db, id) => db.prepare('SELECT * FROM przesylki WHERE id = ?').get(id);

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('osad po kurierze bez śledzenia', () => {
  it('kurier bez śledzenia zostawia zamówienie na liście roboczej — dopóki osad nie zniknie', () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(9001), {});
    const pid = nadanaZBledem(db, id, 'allegro_wza');
    // To jest właśnie odznaka, którą właściciel widzi na liście „do zrobienia".
    expect(sprawyPrzesylki(wiersz(db, pid))).toContain('status u kuriera niedostępny');
  });

  it('otwarcie karty KASUJE osad przy kurierze bez śledzenia', async () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(9002), {});
    const pid = nadanaZBledem(db, id, 'allegro_wza');
    const app = buildOmsServer({ db, config, poller, kurierzy: { allegro_wza: { bezSledzenia: true } } });
    await app.ready();

    const przedProba = wiersz(db, pid).status_kuriera_pobrany_at;
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(r.statusCode).toBe(200);
    expect(wiersz(db, pid).status_kuriera_blad).toBe(null);
    expect(sprawyPrzesylki(wiersz(db, pid))).not.toContain('status u kuriera niedostępny');
    // ⚠️ ZNACZNIK PRÓBY MA ZOSTAĆ. Skasowany razem z błędem wyglądałby na „nigdy nie pytaliśmy",
    // a karta pokazuje przy nim datę ostatniej próby. Wyszło z mutacji — pierwsza wersja tego
    // testu patrzyła wyłącznie na samą kolumnę błędu i przepuszczała skasowanie obu naraz.
    expect(wiersz(db, pid).status_kuriera_pobrany_at).toBe(przedProba);
  });

  // ⚠️ DRUGA STRONA TEJ SAMEJ MONETY. Kasowanie osadu nie może objąć kuriera, który
  // śledzenie MIEĆ POWINIEN — tam błąd jest prawdziwą awarią do pokazania człowiekowi.
  // Bez tego testu „naprawa" uciszyłaby wygasły token InPostu równie skutecznie.
  it('NIE kasuje błędu u kuriera, który śledzenie ma', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(9003), {});
    const pid = nadanaZBledem(db, id, 'dpd', 'INCORRECT_LOGIN_OR_PASSWORD');
    const app = buildOmsServer({
      db, config, poller,
      kurierzy: { dpd: { statusPrzesylki: async () => { throw new Error('sieć padła'); } } },
    });
    await app.ready();

    await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(wiersz(db, pid).status_kuriera_blad).not.toBe(null);
    expect(sprawyPrzesylki(wiersz(db, pid))).toContain('status u kuriera niedostępny');
  });
});

// ⚠️ SPRZĄTANIE HURTEM PRZY STARCIE. Samo kasowanie „przy otwarciu karty" zostawiłoby cztery
// zamówienia na liście roboczej do czasu, aż ktoś wejdzie w każde z osobna — a odznaka jest
// właśnie po to, żeby NIE trzeba było otwierać. Reguła bierze listę kurierów z mapy
// zbudowanej w bootstrapie, więc nie zna żadnej nazwy kuriera na pamięć.
describe('wyczyscBladStatusuBezSledzenia', () => {
  it('kasuje osad tylko u wskazanych kurierów', () => {
    const id1 = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(9101), {});
    const bezSled = nadanaZBledem(db, id1, 'allegro_wza');
    const id2 = zapiszZamowienie(db, 'pro', zmapowane(9102), {});
    const zeSled = nadanaZBledem(db, id2, 'dpd', 'INCORRECT_LOGIN_OR_PASSWORD');

    const ile = wyczyscBladStatusuBezSledzenia(db, ['allegro_wza']);

    expect(ile).toBe(1);
    expect(wiersz(db, bezSled).status_kuriera_blad).toBe(null);
    expect(wiersz(db, zeSled).status_kuriera_blad).toBe('INCORRECT_LOGIN_OR_PASSWORD');
  });

  it('pusta lista kurierów nie rusza NICZEGO', () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(9103), {});
    const pid = nadanaZBledem(db, id, 'allegro_wza');

    expect(wyczyscBladStatusuBezSledzenia(db, [])).toBe(0);
    expect(wiersz(db, pid).status_kuriera_blad).not.toBe(null);
  });

  // Kolumna `status_kuriera_pobrany_at` zostaje NIETKNIĘTA: to znacznik dławika, a nie część
  // błędu. Skasowanie go kazałoby panelowi pytać od nowa przy każdym otwarciu karty.
  it('nie rusza znacznika próby ani statusu', () => {
    const id = zapiszZamowienie(db, 'allegro_szkicownia', zmapowane(9104), {});
    const pid = nadanaZBledem(db, id, 'allegro_wza');
    const przed = wiersz(db, pid).status_kuriera_pobrany_at;

    wyczyscBladStatusuBezSledzenia(db, ['allegro_wza']);

    expect(wiersz(db, pid).status_kuriera_pobrany_at).toBe(przed);
  });
});

// ⚠️ TEN TEST PILNUJE OKABLOWANIA, NIE REGUŁY. Sama funkcja może być doskonała i nadal
// nigdy nie zostać wywołana — ta klasa błędu („kod zbudowany, przetestowany i bez ani
// jednego wywołania") ma w tym projekcie własny komentarz w bootstrap.js i już się zdarzyła.
describe('bootstrap sprząta osad przy starcie', () => {
  const KANAL = {
    ALLEGRO_SZKICOWNIA_CLIENT_ID: 'id', ALLEGRO_SZKICOWNIA_CLIENT_SECRET: 'sekret',
    ALLEGRO_SZKICOWNIA_OD: '2026-07-01', ALLEGRO_SZKICOWNIA_API: 'https://api.allegro.test',
    ALLEGRO_USER_AGENT: 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)',
  };

  it('kasuje błąd statusu u kuriera z flagą bezSledzenia', () => {
    // Baza W PLIKU, a nie `:memory:` — inaczej nie da się zasiać stanu SPRZED startu usługi,
    // bo pamięciowa baza powstaje dopiero w środku `zbudujOms`.
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-osad-')), 'oms.sqlite');
    const zasiew = openOmsDb(plik);
    const id = zapiszZamowienie(zasiew, 'allegro_szkicownia', zmapowane(9201), {});
    const pid = nadanaZBledem(zasiew, id, 'allegro_wza');
    const idDpd = zapiszZamowienie(zasiew, 'pro', zmapowane(9202), {});
    const pidDpd = nadanaZBledem(zasiew, idDpd, 'dpd', 'INCORRECT_LOGIN_OR_PASSWORD');
    zasiew.close();

    const { db: dbUslugi } = zbudujOms({
      env: {
        OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x', OMS_DB_PATH: plik,
        OMS_ETYKIETY_DIR: mkdtempSync(join(tmpdir(), 'oms-etyk-')),
        SHOP_PRO_URL: 'https://pro.szkicownia.test', SHOP_PRO_CK: 'ck', SHOP_PRO_CS: 'cs',
        // ⚠️ DPD MUSI BYĆ SKONFIGUROWANY, inaczej ten test niczego nie pilnuje: bez niego
        // mapa kurierów ma JEDNEGO kuriera i „sprzątaj u wszystkich" znaczy dokładnie to
        // samo, co „sprzątaj u bezSledzenia". Wyszło z mutacji — filtr podmieniony na
        // `() => true` przechodził, dopóki w mapie nie było kuriera ze śledzeniem.
        DPD_URL: 'https://dpd/api', DPD_LOGIN: '99999999', DPD_PASSWORD: 'tajne', DPD_FID: '278216',
        DPD_NADAWCA_NAZWA: 'Lumina', DPD_NADAWCA_ULICA: 'Fabryczna 7',
        DPD_NADAWCA_KOD: '00-650', DPD_NADAWCA_MIASTO: 'Pęki',
        DPD_INFO_URL: 'https://dpd/info', DPD_INFO_CHANNEL: '278216',
        ...KANAL,
      },
      createDpd: () => ({ nadaj: () => {}, statusPrzesylki: async () => null }),
      createAllegroWza: () => ({ nadaj: () => {}, bezSledzenia: true }),
    });

    expect(wiersz(dbUslugi, pid).status_kuriera_blad).toBe(null);
    // Kurier ze śledzeniem zostaje nietknięty — to prawdziwa awaria, nie osad.
    expect(wiersz(dbUslugi, pidDpd).status_kuriera_blad).toBe('INCORRECT_LOGIN_OR_PASSWORD');
  });

  // ⚠️ OD 23.08 PACZKI WzA BYWAJĄ ŚLEDZALNE (podwykonawca DPD z pary carrierId+carrierWaybill
  // w surowej odpowiedzi). Sprzątanie hurtem per kurier skasowałoby PRAWDZIWE błędy
  // podwykonawcy — dokładnie ten sam błąd w drugą stronę, co 12.08. Dlatego WzA sprząta się
  // PER PACZKA: bez pary osad znika (jak dotąd), z parą błąd ZOSTAJE widoczny.
  it('paczka WzA Z parą przewoźnika NIE jest sprzątana — jej błąd może być prawdziwy', () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-osad2-')), 'oms.sqlite');
    const zasiew = openOmsDb(plik);
    const surowaZPara = JSON.stringify({ carrierTrackingData: { carrierId: 'DPD', carrierWaybill: '1049000000077U' } });
    const idBez = zapiszZamowienie(zasiew, 'allegro_szkicownia', zmapowane(9301), {});
    const pBez = rozpocznijPrzesylke(zasiew, idBez, 'allegro_wza');
    zakonczPrzesylke(zasiew, pBez.id, { numerListu: 'AD0BEZ', etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
    zapiszProbeStatusuDpd(zasiew, pBez.id, { at: '2026-08-11T06:00:00.000Z', blad: 'osad' });
    const idZ = zapiszZamowienie(zasiew, 'allegro_szkicownia', zmapowane(9302), {});
    const pZ = rozpocznijPrzesylke(zasiew, idZ, 'allegro_wza');
    zakonczPrzesylke(zasiew, pZ.id, { numerListu: 'AD0ZPARA', etykietaSciezka: '/tmp/e.pdf', surowa: surowaZPara });
    zapiszProbeStatusuDpd(zasiew, pZ.id, { at: '2026-08-11T06:00:00.000Z', blad: 'DPD: INCORRECT_LOGIN_OR_PASSWORD' });
    zasiew.close();

    const { db: dbUslugi } = zbudujOms({
      env: {
        OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x', OMS_DB_PATH: plik,
        OMS_ETYKIETY_DIR: mkdtempSync(join(tmpdir(), 'oms-etyk2-')),
        SHOP_PRO_URL: 'https://pro.szkicownia.test', SHOP_PRO_CK: 'ck', SHOP_PRO_CS: 'cs',
        DPD_URL: 'https://dpd/api', DPD_LOGIN: '99999999', DPD_PASSWORD: 'tajne', DPD_FID: '278216',
        DPD_NADAWCA_NAZWA: 'Lumina', DPD_NADAWCA_ULICA: 'Fabryczna 7',
        DPD_NADAWCA_KOD: '00-650', DPD_NADAWCA_MIASTO: 'Pęki',
        DPD_INFO_URL: 'https://dpd/info', DPD_INFO_CHANNEL: '278216',
        ...KANAL,
      },
      createDpd: () => ({ nadaj: () => {}, statusPrzesylki: async () => null }),
      createAllegroWza: () => ({ nadaj: () => {}, bezSledzenia: true }),
    });

    expect(wiersz(dbUslugi, pBez.id).status_kuriera_blad).toBe(null);
    expect(wiersz(dbUslugi, pZ.id).status_kuriera_blad).toBe('DPD: INCORRECT_LOGIN_OR_PASSWORD');
  });

  it('bez DPD, lecz z kontem Allegro zachowuje błąd śledzalnego One Box', () => {
    const plik = join(mkdtempSync(join(tmpdir(), 'oms-one-osad-')), 'oms.sqlite');
    const zasiew = openOmsDb(plik);
    const idOne = zapiszZamowienie(zasiew, 'allegro_szkicownia', zmapowane(9401), {});
    const pOne = rozpocznijPrzesylke(zasiew, idOne, 'allegro_wza');
    const rawOne = JSON.stringify({
      carrier: 'ALLEGRO',
      packages: [{ waybill: 'AD0ONE', transportingInfo: [{ carrierId: 'ALLEGRO_ONE_KURIER', carrierWaybill: 'SUB' }] }],
    });
    zakonczPrzesylke(zasiew, pOne.id, { numerListu: 'AD0ONE', etykietaSciezka: '/tmp/one.pdf', surowa: rawOne });
    zapiszProbeStatusuDpd(zasiew, pOne.id, { at: '2026-09-21T07:00:00.000Z', blad: 'Allegro: HTTP 503' });

    const idBez = zapiszZamowienie(zasiew, 'allegro_szkicownia', zmapowane(9402), {});
    const pBez = nadanaZBledem(zasiew, idBez, 'allegro_wza');
    zasiew.close();

    const { db: dbUslugi } = zbudujOms({
      env: {
        OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x', OMS_DB_PATH: plik,
        OMS_ETYKIETY_DIR: mkdtempSync(join(tmpdir(), 'oms-one-etyk-')),
        SHOP_PRO_URL: 'https://pro.szkicownia.test', SHOP_PRO_CK: 'ck', SHOP_PRO_CS: 'cs',
        ...KANAL,
      },
      createAllegroWza: () => ({ nadaj: () => {}, bezSledzenia: true }),
      createAllegroSledzenie: () => ({ statusPrzesylki: async () => null }),
    });

    expect(wiersz(dbUslugi, pOne.id).status_kuriera_blad).toBe('Allegro: HTTP 503');
    expect(wiersz(dbUslugi, pBez).status_kuriera_blad).toBeNull();
    dbUslugi.close();
  });
});
