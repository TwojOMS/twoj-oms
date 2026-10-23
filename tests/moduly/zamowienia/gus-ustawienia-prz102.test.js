// PRZ-102.11 — klucz GUS (REGON BIR1.1) w panelu: Ustawienia → Integracje → GUS. Ten sam wzorzec co kurierzy
// (PRZ-092 DPD, PRZ-093.09 InPost) i inFakt (PRZ-093.10): .env wygrywa (zapis = 409), klucz nigdy nie wraca na ekran,
// GUS_URL tylko z pliku, zmiana klucza działa bez restartu — przycisk „Pobierz z GUS” i trzy trasy GUS biorą usługę
// z bieżącej konfiguracji przy każdym żądaniu.
// Prawdziwy serwer (buildOmsServer), prawdziwe moduły i prawdziwy createGusClient; globalny fetch podmieniony atrapą
// BIR — żadne żądanie nie wychodzi do GUS. Klucze i NIP-y zmyślone.
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
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

const ADRES = '/ustawienia/integracje/gus';
const KLUCZ = 'zmyslony0klucz0gus0a1';
const KLUCZ_2 = 'zmyslony0drugi0gus0b2';
const KLUCZ_PLIKU = 'zmyslony0plik0gus0c3';
const NIP = '1234563218';
const KOMUNIKAT = 'GUS nie jest skonfigurowany — dodaj klucz w Ustawienia → Integracje → GUS albo wpisz dane ręcznie.';
const PRZYCISK = 'Pobierz z GUS';

const xml = (t) => t.replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const LOGOWANIE = (sid) => `<s:Envelope><s:Body><ZalogujResponse><ZalogujResult>${sid}</ZalogujResult></ZalogujResponse></s:Body></s:Envelope>`;
const FIRMA = '<s:Envelope><s:Body><DaneSzukajPodmiotyResponse><DaneSzukajPodmiotyResult>'
  + xml(`<root><dane><Nazwa>LAMPY PRZYKŁADOWE SP. Z O.O.</Nazwa><Nip>${NIP}</Nip><Ulica>ul. Zmyślona</Ulica>`
    + '<NrNieruchomosci>7</NrNieruchomosci><KodPocztowy>00001</KodPocztowy><Miejscowosc>PRZYKŁADOWO</Miejscowosc></dane></root>')
  + '</DaneSzukajPodmiotyResult></DaneSzukajPodmiotyResponse></s:Body></s:Envelope>';

let siec;
let odrzucaLogowanie;
beforeEach(() => {
  odrzucaLogowanie = false;
  // Atrapa BIR: logowanie kluczem oddaje sid (albo pusty wynik = zły klucz), wyszukiwanie oddaje jedną firmę.
  siec = vi.fn(async (_url, init) => {
    const body = String(init?.body ?? '');
    if (body.includes('pKluczUzytkownika')) return new Response(LOGOWANIE(odrzucaLogowanie ? '' : 'SID-ATRAPA'), { status: 200 });
    return new Response(FIRMA, { status: 200 });
  });
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });
/** Klucze, którymi atrapa BIR była logowana (kolejno). */
const kluczeLogowan = () => siec.mock.calls.map(([, init]) => /<ns:pKluczUzytkownika>([^<]*)</u.exec(String(init?.body ?? ''))?.[1])
  .filter(Boolean);

function panel({ env = {}, zapisPrzedStartem = null } = {}) {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  let db;
  if (zapisPrzedStartem) {
    // Zapis z ekranu leży w bazie przed startem modułów — tak wygląda instalacja po restarcie.
    db = nowyPanel({ moduly, env }).db;
    zapiszKonfiguracjeIntegracji(db, 'gus', { ustawienia: {}, sekrety: { klucz: zapisPrzedStartem } });
  }
  const p = nowyPanel({ moduly, env, ...(db ? { db } : {}) });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'klienci']);
  const id = zapiszZamowienie(p.db, 'demo', {
    zrodlo_id: 'gus-10211', numer: 'DEMO-10211',
    klient: { first_name: 'Adam', last_name: 'Przykładowy' }, dostawa: {},
    metoda_wysylki: 'demo', kwota_pobrania: null, status_woo: 'processing', oplacone_at: null,
    chce_fakture: 1, nip: null, kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
    anulowane: 0, utworzone_at: '2026-10-20T08:00:00',
    pozycje: [{ nazwa: 'Lampa demo', sku: 'DEMO', ilosc: 1, cena_brutto: '100.00', vat: null }],
  }, {});
  return { ...p, id, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const formularz = (html) => /<form id="gus-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
/** Wszystkie ekrany, na których klucz mógłby wyciec. */
const ekrany = (id) => [ADRES, '/ustawienia/integracje', `/zamowienia/${id}?edytuj=faktura`, '/zamowienia/nowe', '/klienci?nowy=1'];

describe('PRZ-102.11 Ustawienia → Integracje → GUS', () => {
  it('bez pliku i bez zapisu: przycisk ukryty na karcie, nowym zamówieniu i Stałych klientach; trasy GUS odmawiają nowym komunikatem', async () => {
    const { app, admin, id } = panel();
    for (const adres of [`/zamowienia/${id}?edytuj=faktura`, '/zamowienia/nowe', '/klienci?nowy=1']) {
      const r = await get(app, adres, admin);
      expect(r.statusCode, adres).toBe(200);
      // Pole NIP stoi — inaczej brak przycisku byłby fałszywą zielenią (przycisk siedzi obok pola NIP).
      expect(r.body, adres).toMatch(/name="(f_)?nip"/u);
      expect(r.body.includes(PRZYCISK), adres).toBe(false);
    }
    const karta = await post(app, `/zamowienia/${id}/dane/gus`, admin, { nip: NIP });
    expect(karta.statusCode).toBe(503);
    // PRZ-109.06: odmowa formularza karty zachowuje panel i drogę powrotu.
    expect(karta.headers['content-type']).toContain('text/html');
    expect(karta.body).toContain(KOMUNIKAT);
    expect(karta.body).toContain(`href="/zamowienia/${id}#faktura">Wróć do zamówienia</a>`);
    expect((await post(app, '/zamowienia/nowe/gus', admin, { f_nip: NIP })).body).toContain(KOMUNIKAT);
    expect((await post(app, '/klienci/gus', admin, { f_nip: NIP })).body).toContain(KOMUNIKAT);
    expect(siec).not.toHaveBeenCalled();
  });

  it('Integracje mają wejście do GUS; pusty ekran: pole klucza (hasło), „Niepodłączony”, skąd wziąć klucz, bez adresu usługi', async () => {
    const { app, admin } = panel();
    expect((await get(app, '/ustawienia/integracje', admin)).body).toContain(`href="${ADRES}"`);
    const r = await get(app, ADRES, admin);
    expect(r.statusCode, r.body).toBe(200);
    const f = formularz(r.body);
    expect(f).toMatch(/<input id="gus-klucz" type="password" name="klucz"[^>]* required>/u);
    expect(f).not.toMatch(/name="(url|adres)"/u);
    expect(r.body).toContain('Niepodłączony');
    expect(r.body).toContain('Główny Urząd Statystyczny');
    expect(r.body.includes('wyszukiwarkaregon')).toBe(false);
  });

  it('admin zapisuje klucz → bez restartu przycisk widoczny, a trasa woła BIR kluczem z panelu; klucz nie wraca na żaden ekran', async () => {
    const { app, admin, db, id } = panel();
    const r = await post(app, ADRES, admin, { klucz: `  ${KLUCZ}\n` });
    expect(r.statusCode, r.body).toBe(303);
    expect(r.body.includes(KLUCZ)).toBe(false);
    const zapis = wczytajKonfiguracjeIntegracji(db, 'gus');
    expect(zapis.sekrety).toEqual({ klucz: KLUCZ });
    expect(zapis.kontoLogin).toBe('adam');

    for (const adres of [`/zamowienia/${id}?edytuj=faktura`, '/zamowienia/nowe', '/klienci?nowy=1']) {
      expect((await get(app, adres, admin)).body, adres).toContain(PRZYCISK);
    }
    const karta = await post(app, `/zamowienia/${id}/dane/gus`, admin, { nip: NIP });
    expect(karta.statusCode, karta.body).toBe(200);
    expect(karta.body).toContain('LAMPY PRZYKŁADOWE SP. Z O.O.');
    expect(kluczeLogowan()).toEqual([KLUCZ]);
    expect((await post(app, '/zamowienia/nowe/gus', admin, { f_nip: NIP })).body).toContain('LAMPY PRZYKŁADOWE');
    expect((await post(app, '/klienci/gus', admin, { f_nip: NIP })).body).toContain('LAMPY PRZYKŁADOWE');

    // Zmiana klucza też bez restartu: następne zapytanie loguje się nowym kluczem.
    expect((await post(app, ADRES, admin, { klucz: KLUCZ_2 })).statusCode).toBe(303);
    await post(app, `/zamowienia/${id}/dane/gus`, admin, { nip: NIP });
    expect(kluczeLogowan().at(-1)).toBe(KLUCZ_2);

    for (const adres of ekrany(id)) {
      const e = await get(app, adres, admin);
      expect(e.statusCode, adres).toBe(200);
      for (const k of [KLUCZ, KLUCZ_2]) expect(e.body.includes(k), `klucz na ekranie ${adres}`).toBe(false);
    }
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body).toContain('Podłączony');
    expect(formularz(ekran.body)).toMatch(/<input id="gus-klucz"[^>]* value=""[^>]* placeholder="zapisany — wpisz nowy, żeby zmienić">/u);
    // Log zdarzeń nie niesie klucza (zapytania GUS zapisują tylko NIP i wynik).
    expect(JSON.stringify(db.prepare('SELECT * FROM log').all()).includes(KLUCZ_2)).toBe(false);
  });

  it('usunięcie klucza: przycisk znika bez restartu, trasa znów 503', async () => {
    const { app, admin, db, id } = panel({ zapisPrzedStartem: KLUCZ });
    expect((await get(app, `/zamowienia/${id}?edytuj=faktura`, admin)).body).toContain(PRZYCISK);
    const r = await post(app, `${ADRES}/odlacz`, admin, {});
    expect(r.statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'gus')).toBeNull();
    expect((await get(app, `/zamowienia/${id}?edytuj=faktura`, admin)).body.includes(PRZYCISK)).toBe(false);
    expect((await post(app, `/zamowienia/${id}/dane/gus`, admin, { nip: NIP })).statusCode).toBe(503);
  });

  it('klucz w pliku: ekran tylko informuje, zapis 409, a trasa woła BIR kluczem z pliku — także gdy w bazie leży stary zapis z ekranu', async () => {
    const { app, admin, db, id } = panel({ env: { GUS_KLUCZ: KLUCZ_PLIKU }, zapisPrzedStartem: KLUCZ });
    const r = await post(app, ADRES, admin, { klucz: KLUCZ_2 });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('GUS_KLUCZ');
    expect(wczytajKonfiguracjeIntegracji(db, 'gus').sekrety).toEqual({ klucz: KLUCZ });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).toContain('pliku konfiguracji');
    expect(formularz(ekran.body)).toBe('');
    for (const k of [KLUCZ, KLUCZ_PLIKU]) expect(ekran.body.includes(k)).toBe(false);
    const karta = await post(app, `/zamowienia/${id}/dane/gus`, admin, { nip: NIP });
    expect(karta.statusCode).toBe(200);
    expect(kluczeLogowan()).toEqual([KLUCZ_PLIKU]);
  });

  it('„Sprawdź połączenie” loguje się do BIR zapisanym kluczem i niczego nie zmienia; zły klucz = czytelna odmowa bez klucza', async () => {
    const { app, admin } = panel();
    const bez = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(bez.body).toContain('Najpierw zapisz klucz');
    expect(siec).not.toHaveBeenCalled();
    await post(app, ADRES, admin, { klucz: KLUCZ });
    const ok = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Działa.');
    expect(siec).toHaveBeenCalledTimes(1);
    expect(kluczeLogowan()).toEqual([KLUCZ]);
    odrzucaLogowanie = true;
    const zle = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(zle.body).toContain('Nie działa.');
    expect(zle.body).toContain('GUS odrzucił logowanie');
    expect(zle.body.includes(KLUCZ)).toBe(false);
  });

  it('błędy formularza: pusty, ze spacją, za krótki — nic nie zapisane, wpisana wartość nie wraca', async () => {
    const { app, admin, db } = panel();
    for (const klucz of ['', 'ab cd ef gh ij', 'krotki']) {
      const r = await post(app, ADRES, admin, { klucz });
      expect(r.statusCode, klucz).toBe(400);
      expect(r.body).toContain('Nie zapisano.');
      if (klucz) expect(formularz(r.body).includes(klucz), klucz).toBe(false);
    }
    expect(wczytajKonfiguracjeIntegracji(db, 'gus')).toBeNull();
  });

  it('nie-admin (bez uprawnienia „ustawienia”) dostaje 403 na ekranie, zapisie, sprawdzeniu i usunięciu', async () => {
    const { app, ewa, db } = panel({ zapisPrzedStartem: KLUCZ });
    expect((await get(app, ADRES, ewa)).statusCode).toBe(403);
    expect((await post(app, ADRES, ewa, { klucz: KLUCZ_2 })).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/sprawdz`, ewa, {})).statusCode).toBe(403);
    expect((await post(app, `${ADRES}/odlacz`, ewa, {})).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'gus').sekrety).toEqual({ klucz: KLUCZ });
    expect(siec).not.toHaveBeenCalled();
  });
});
