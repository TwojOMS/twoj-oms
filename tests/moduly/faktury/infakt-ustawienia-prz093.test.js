// PRZ-093.10 — Ustawienia → Integracje → inFakt: ten sam wzorzec co kurierzy (PRZ-092 DPD, PRZ-093.09 InPost):
// .env wygrywa w całości, klucz API nigdy nie wraca na ekran, adres API tylko z pliku, zmiana klucza bez restartu.
// Prawdziwy serwer (buildOmsServer), prawdziwy moduł faktur i prawdziwy createInfaktClient; globalny fetch
// podmieniony — żadne żądanie nie wychodzi do inFaktu. Klucze zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

const ADRES = '/ustawienia/integracje/infakt';
const KLUCZ = 'zmyslony0klucz0ekranu0infakt0prz093000c3';
const KLUCZ_2 = 'zmyslony0drugi0klucz0infakt0prz093000d4';
const KLUCZ_PLIKU = 'zmyslony0klucz0z0pliku0infakt0prz09300e5';
const STRONA = { metainfo: { count: 0, total_count: 0 }, entities: [] };

let siec;
let odpowiedz;
beforeEach(() => {
  odpowiedz = () => new Response(JSON.stringify(STRONA), { status: 200, headers: { 'content-type': 'application/json' } });
  siec = vi.fn(async () => odpowiedz());
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });
const kluczZadania = (i) => new Headers(siec.mock.calls[i][1].headers).get('x-infakt-apikey');

function panel({ env = {}, zapisPrzedStartem = null } = {}) {
  const podglad = {};
  const podgladacz = { nazwa: 'test-podgladacz', wersja: '1.0.0', wymaga: ['faktury'], migracje: [], menu: [], uprawnienia: [],
    konfiguracja: () => null, zbuduj: (ctx) => {
      for (const n of ['infakt', 'faktura', 'fakturyWidok']) podglad[n] = ctx.usluga('faktury', n);
      return {};
    } };
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie, podgladacz];
  let db;
  if (zapisPrzedStartem) {
    // Zapis z ekranu MUSI leżeć w bazie przed startem modułów — tak wygląda instalacja po restarcie.
    db = nowyPanel({ moduly, env }).db;
    zapiszKonfiguracjeIntegracji(db, 'infakt', { ustawienia: {}, sekrety: { apiKey: zapisPrzedStartem } });
  }
  const p = nowyPanel({ moduly, env, ...(db ? { db } : {}) });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'faktury']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa'), podglad };
}
const formularz = (html) => /<form id="infakt-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('PRZ-093.10 Ustawienia → inFakt', () => {
  it('pusty ekran: pole klucza (hasło), adres API tylko do odczytu, „Niepodłączony”; Integracje mają wejście', async () => {
    const { app, admin, podglad } = panel();
    const r = await get(app, ADRES, admin);
    expect(r.statusCode, r.body).toBe(200);
    const f = formularz(r.body);
    expect(f).toMatch(/<input id="infakt-klucz" type="password" name="apiKey"[^>]* required>/u);
    expect(f).not.toMatch(/name="(baseUrl|url|adres|archiwum)"/u);
    expect(r.body).toContain('Niepodłączony');
    expect(r.body).toContain('https://api.infakt.pl/api');
    expect(r.body).toContain('INFAKT_ARCHIWUM');
    expect(podglad.infakt).toBeNull();
    expect((await get(app, '/ustawienia/integracje', admin)).body).toContain(`href="${ADRES}"`);
  });

  it('ekrany faktur bez inFaktu odsyłają do Ustawienia → Integracje → inFakt', async () => {
    const { app, admin } = panel();
    const lista = await get(app, '/faktury', admin);
    expect(lista.statusCode).toBe(200);
    expect(lista.body).toContain(`href="${ADRES}"`);
    const wystaw = await post(app, '/zamowienia/faktury-hurtem', admin, { id: '1' });
    expect(wystaw.statusCode).toBe(503);
    expect(wystaw.body).toContain(ADRES);
  });

  it('zapis: 303, wiersz „infakt” w bazie, klucz nie wraca na ekran; pierwsze podłączenie wymaga restartu', async () => {
    const { app, admin, db, podglad } = panel();
    const r = await post(app, ADRES, admin, { apiKey: KLUCZ });
    expect(r.statusCode, r.body).toBe(303);
    const zapis = wczytajKonfiguracjeIntegracji(db, 'infakt');
    expect(zapis.sekrety).toEqual({ apiKey: KLUCZ });
    expect(zapis.ustawienia).toEqual({});
    expect(zapis.kontoLogin).toBe('adam');
    const ekran = await get(app, r.headers.location, admin);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body.includes(KLUCZ), 'klucz na ekranie').toBe(false);
    expect(ekran.body.includes('zmyslony0klucz'), 'fragment klucza na ekranie').toBe(false);
    expect(ekran.body).toContain('Podłączony');
    expect(ekran.body).toContain('po ponownym uruchomieniu');
    const f = formularz(ekran.body);
    expect(f).not.toContain('&#34;');
    expect(f).toMatch(/<input id="infakt-klucz"[^>]* placeholder="zapisany — wpisz nowy, żeby zmienić">/u);
    expect(f).not.toMatch(/name="apiKey"[^>]*required/u);
    expect(podglad.infakt).toBeNull(); // usługi faktur powstają przy starcie — pierwsze podłączenie po restarcie
    expect(siec).not.toHaveBeenCalled();
  });

  it('błędny formularz: 400, nic nie zapisane, wpisana wartość nie wraca w odpowiedzi', async () => {
    const { app, admin, db } = panel();
    const zly = 'zmyslony klucz ze spacja w srodku 000';
    const r = await post(app, ADRES, admin, { apiKey: zly });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Nie zapisano');
    expect(r.body.includes(zly)).toBe(false);
    expect(wczytajKonfiguracjeIntegracji(db, 'infakt')).toBeNull();
  });

  it('„Sprawdź połączenie”: bez zapisu — prośba o zapis; po zapisie działa od razu (bez restartu), kluczem z ekranu', async () => {
    const { app, admin } = panel();
    expect((await post(app, `${ADRES}/sprawdz`, admin, {})).body).toContain('Najpierw zapisz');
    expect(siec).not.toHaveBeenCalled();
    await post(app, ADRES, admin, { apiKey: KLUCZ });
    const ok = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).toContain('Połączenie z inFaktem działa');
    expect(siec).toHaveBeenCalledTimes(1);
    expect(String(siec.mock.calls[0][0])).toBe('https://api.infakt.pl/api/v3/invoices.json?offset=0');
    expect(siec.mock.calls[0][1].method).toBe('GET');
    expect(kluczZadania(0) === KLUCZ).toBe(true);
  });

  for (const status of [401, 403]) {
    it(`„Sprawdź połączenie” przy ${status} z kluczem odbitym w treści: powód na ekranie, klucza brak`, async () => {
      odpowiedz = () => new Response(JSON.stringify({ error: `Nieprawidłowy klucz ${KLUCZ}` }), { status, headers: { 'content-type': 'application/json' } });
      const { app, admin } = panel();
      await post(app, ADRES, admin, { apiKey: KLUCZ });
      const r = await post(app, `${ADRES}/sprawdz`, admin, {});
      expect(r.body).toContain('Nie działa.');
      expect(r.body).toContain('nie przyjął klucza API');
      expect(r.body.includes(KLUCZ), `${status}: klucz na ekranie`).toBe(false);
    });
  }

  it('zapis sprzed startu: faktury czynne; nowy klucz działa od następnego żądania bez restartu; odłączenie wyłącza', async () => {
    const { app, admin, db, podglad } = panel({ zapisPrzedStartem: KLUCZ });
    expect(podglad.infakt).not.toBeNull();
    expect(podglad.faktura).toHaveProperty('wystaw');
    expect(siec).not.toHaveBeenCalled(); // budowa modułu niczego nie wysyła
    await podglad.infakt.listaFaktur({});
    expect(String(siec.mock.calls[0][0])).toBe('https://api.infakt.pl/api/v3/invoices.json?offset=0');
    expect(kluczZadania(0) === KLUCZ).toBe(true);
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body.includes('po ponownym uruchomieniu')).toBe(false);

    expect((await post(app, ADRES, admin, { apiKey: KLUCZ_2 })).statusCode).toBe(303);
    await podglad.infakt.listaFaktur({});
    expect(kluczZadania(1) === KLUCZ_2).toBe(true);

    expect((await post(app, `${ADRES}/odlacz`, admin, {})).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'infakt')).toBeNull();
    const e = await podglad.infakt.listaFaktur({}).catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain(ADRES);
    expect(siec).toHaveBeenCalledTimes(2);
    expect((await get(app, ADRES, admin)).body).toContain('Odłączony');
  });

  it('inFakt w pliku .env wygrywa: ekran tylko informuje, zapis = 409 i niczego nie rusza, klient z pliku', async () => {
    const { app, admin, db, podglad } = panel({ env: { INFAKT_API_KEY: KLUCZ_PLIKU } });
    const r = await get(app, ADRES, admin);
    expect(r.body).toContain('w pliku konfiguracji');
    expect(formularz(r.body)).toBe('');
    expect(r.body.includes(KLUCZ_PLIKU), 'klucz z pliku na ekranie').toBe(false);
    const zapis = await post(app, ADRES, admin, { apiKey: KLUCZ });
    expect(zapis.statusCode).toBe(409);
    expect(zapis.body.includes(KLUCZ)).toBe(false);
    expect(wczytajKonfiguracjeIntegracji(db, 'infakt')).toBeNull();
    await podglad.infakt.listaFaktur({});
    expect(kluczZadania(0) === KLUCZ_PLIKU).toBe(true);
  });

  it('inFakt w .env, a w bazie stary zapis z ekranu: plik wygrywa, przycisk usunięcia działa, sprawdzenie nie idzie kluczem z bazy', async () => {
    const { app, admin, db, podglad } = panel({ env: { INFAKT_API_KEY: KLUCZ_PLIKU }, zapisPrzedStartem: KLUCZ });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body).toContain('Usuń zapisany klucz');
    expect(ekran.body.includes(KLUCZ)).toBe(false);
    await podglad.infakt.listaFaktur({});
    expect(kluczZadania(0) === KLUCZ_PLIKU).toBe(true);
    await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(siec.mock.calls.every((_, i) => kluczZadania(i) === KLUCZ_PLIKU)).toBe(true);
    expect((await post(app, `${ADRES}/odlacz`, admin, {})).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'infakt')).toBeNull();
    await podglad.infakt.listaFaktur({});
    expect(kluczZadania(siec.mock.calls.length - 1) === KLUCZ_PLIKU).toBe(true); // klient z pliku zostaje
  });

  it('bez uprawnienia „ustawienia” — brak dostępu do ekranu, zapisu, sprawdzenia i odłączenia', async () => {
    const { app, ewa, admin, db } = panel();
    expect((await get(app, ADRES, ewa)).statusCode).toBe(403);
    expect((await post(app, ADRES, ewa, { apiKey: KLUCZ })).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'infakt')).toBeNull();
    await post(app, ADRES, admin, { apiKey: KLUCZ });
    expect((await post(app, `${ADRES}/sprawdz`, ewa, {})).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/odlacz`, ewa, {})).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'infakt')).not.toBeNull();
    expect(siec).not.toHaveBeenCalled();
  });
});
