// PRZ-093.09 — Ustawienia → Integracje → Kurier InPost: ten sam wzorzec co DPD z PRZ-092 (.env wygrywa, zapis
// działa bez restartu, token nigdy nie wraca na ekran). Prawdziwy serwer (buildOmsServer), prawdziwy moduł wysyłki
// z podmienioną fabryką klienta InPost — żadne żądanie nie wychodzi do InPostu. Dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { zapiszAdresFirmy } from '../../../src/oms/db/adres-firmy.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

const TOKEN = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.ZMYSLONY-TOKEN-PRZ093.podpis';
const NADAWCA = { DPD_NADAWCA_NAZWA: 'Pracownia Testowa', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950',
  DPD_NADAWCA_MIASTO: 'Warszawa', DPD_NADAWCA_TELEFON: '000000000', DPD_NADAWCA_EMAIL: 'nadawca@example.invalid' };
const FORMULARZ = { nazwa: 'InPost', organizacja: '4242', token: TOKEN, paczkomatNadawczy: 'abc01m' };
const ADRES = '/ustawienia/integracje/inpost';

function panel({ env = NADAWCA, sprawdz = async () => ({ ok: true }), klient = null } = {}) {
  const utworzone = [];
  const nadaj = vi.fn(async () => ({ numerListu: 'ZMYSLONY-1' }));
  const createInpost = vi.fn((opcje) => {
    utworzone.push(opcje);
    if (klient) return klient(opcje); // prawdziwy createInpostClient z podanym fetchImpl — zero sieci
    return { nadaj, sprawdzPrzesylke: vi.fn(async (...a) => a), pobierzEtykiete: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn(sprawdz) };
  });
  const podglad = {};
  const podgladacz = { nazwa: 'test-podgladacz', wersja: '1.0.0', wymaga: ['wysylka'], migracje: [], menu: [], uprawnienia: [],
    konfiguracja: () => null, zbuduj: (ctx) => { podglad.kurierzy = ctx.usluga('wysylka', 'kurierzy'); return {}; } };
  const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka({ fabryki: { createInpost } }), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie, podgladacz];
  const p = nowyPanel({ moduly, env });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa'), createInpost, utworzone, podglad, nadaj };
}
const formularz = (html) => /<form id="inpost-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('PRZ-093.09 Ustawienia → Kurier InPost', () => {
  it('pusty ekran: token (hasło), organizacja, paczkomat nadawczy, adres nadawcy z adresu firmy, „Niepodłączony”', async () => {
    const { app, admin, podglad } = panel();
    const r = await get(app, ADRES, admin);
    expect(r.statusCode, r.body).toBe(200);
    const f = formularz(r.body);
    for (const pole of ['nazwa', 'organizacja', 'token', 'paczkomatNadawczy']) expect(f).toContain(`name="${pole}"`);
    expect(f).toMatch(/<input[^>]*type="password"[^>]*name="token"|<input[^>]*name="token"[^>]*type="password"/u);
    expect(r.body).toContain('Niepodłączony');
    expect(r.body).toContain('Zmyślona 1');
    expect(r.body).toContain('https://api-shipx-pl.easypack24.net/v1'); // adres API tylko do odczytu
    expect(f).not.toContain('name="url"');
    expect(r.body).toContain('href="/ustawienia/firma"');
    expect(podglad.kurierzy.inpost).toBeUndefined();
  });

  it('Integracje → Kurierzy mają wejście do InPostu obok DPD', async () => {
    const { app, admin } = panel();
    const r = await get(app, '/ustawienia/integracje', admin);
    expect(r.body).toContain('href="/ustawienia/integracje/dpd"');
    expect(r.body).toContain(`href="${ADRES}"`);
  });

  it('zapis: 303, wiersz „inpost” w bazie, token NIGDY nie wraca na ekran, kurier InPost gotowy bez restartu', async () => {
    const { app, admin, db, podglad, utworzone } = panel();
    const r = await post(app, ADRES, admin, FORMULARZ);
    expect(r.statusCode, r.body).toBe(303);
    const zapis = wczytajKonfiguracjeIntegracji(db, 'inpost');
    expect(zapis.ustawienia).toEqual({ nazwa: 'InPost', organizacja: '4242', paczkomatNadawczy: 'ABC01M' });
    expect(zapis.sekrety).toEqual({ token: TOKEN });
    expect(zapis.kontoLogin).toBe('adam');

    const ekran = await get(app, r.headers.location, admin);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).not.toContain(TOKEN);
    expect(ekran.body).not.toContain('ZMYSLONY-TOKEN');
    expect(ekran.body).toContain('Podłączony');
    expect(formularz(ekran.body)).toContain('value="4242"');
    expect(formularz(ekran.body)).toContain('value="ABC01M"');
    // Znalezione w działającym panelu: atrybut wstawiony przez <%= %> wychodził z &#34; zamiast cudzysłowów.
    expect(formularz(ekran.body)).toContain('placeholder="zapisany — zostaw puste, żeby nie zmieniać"');
    expect(formularz(ekran.body)).not.toMatch(/name="token"[^>]*required/u);

    expect(podglad.kurierzy.inpost).toBeDefined();
    await podglad.kurierzy.inpost.sprawdzPolaczenie();
    expect(utworzone.at(-1)).toEqual({ url: 'https://api-shipx-pl.easypack24.net/v1', token: TOKEN, organizacja: 4242,
      paczkomatNadawczy: 'ABC01M', nadawca: { nazwa: 'Pracownia Testowa', ulica: 'Zmyślona 1', kod: '00-950', miasto: 'Warszawa',
        kraj: 'PL', phone: '000000000', email: 'nadawca@example.invalid' } });
  });

  it('ponowny zapis z pustym tokenem zostawia zapisany; nowa organizacja trafia do następnego klienta bez restartu', async () => {
    const { app, admin, db, podglad, utworzone } = panel();
    await post(app, ADRES, admin, FORMULARZ);
    await podglad.kurierzy.inpost.sprawdzPolaczenie();
    const r = await post(app, ADRES, admin, { ...FORMULARZ, organizacja: '5151', token: '', paczkomatNadawczy: '' });
    expect(r.statusCode, r.body).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'inpost').sekrety).toEqual({ token: TOKEN });
    await podglad.kurierzy.inpost.sprawdzPolaczenie();
    expect(utworzone.at(-1)).toMatchObject({ organizacja: 5151, token: TOKEN, paczkomatNadawczy: null });
    expect(utworzone).toHaveLength(2);
  });

  it('nadanie przez kuriera z Ustawień: sprawdzenie przesyłki gubi drugi argument, jak klient z pliku', async () => {
    const { app, admin, podglad } = panel();
    await post(app, ADRES, admin, FORMULARZ);
    expect(await podglad.kurierzy.inpost.sprawdzPrzesylke('123', { sklep: 'x' })).toEqual(['123']);
  });

  it('błędny formularz: 400 z powodami, nic nie zapisane, wpisany token nie wraca w odpowiedzi', async () => {
    const { app, admin, db } = panel();
    const r = await post(app, ADRES, admin, { ...FORMULARZ, organizacja: 'abc', nazwa: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Numer organizacji to same cyfry');
    expect(r.body).toContain('Podaj nazwę');
    expect(r.body).not.toContain(TOKEN);
    expect(wczytajKonfiguracjeIntegracji(db, 'inpost')).toBeNull();
  });

  it('„Sprawdź połączenie”: sukces i odmowa InPostu jako czytelny komunikat; bez zapisu — prośba o zapis', async () => {
    let odp = async () => ({ ok: true });
    const { app, admin } = panel({ sprawdz: () => odp() });
    const przed = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(przed.body).toContain('Najpierw zapisz');
    await post(app, ADRES, admin, FORMULARZ);
    const ok = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).toContain('Połączenie z InPostem działa');
    odp = async () => { throw bladOperatora('InPost odrzucił żądanie (HTTP 401): Token is missing or invalid'); };
    const zle = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(zle.body).toContain('InPost odrzucił żądanie');
    expect(zle.body).not.toContain(TOKEN);
    odp = async () => { throw new Error(`TypeError w środku z ${TOKEN}`); }; // błąd techniczny nie idzie na ekran
    const tech = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(tech.body).not.toContain(TOKEN);
    expect(tech.body).toContain('błąd techniczny');
  });

  // Recenzja 09 (P3): prawdziwy klient ShipX, InPost odpowiada 403/404 i odbija token w treści — ekran testu
  // połączenia pokazuje powód (numer organizacji), a tokenu nie.
  it('„Sprawdź połączenie” przy 403/404 z tokenem w odpowiedzi: ekran bez tokenu', async () => {
    for (const status of [403, 404]) {
      const echo = JSON.stringify({ status, error: 'access_forbidden', message: `Organization not available for token ${TOKEN}` });
      const fetchImpl = vi.fn(async () => ({ status, ok: false, text: async () => echo }));
      const { app, admin } = panel({ klient: (o) => createInpostClient({ ...o, fetchImpl }) });
      await post(app, ADRES, admin, FORMULARZ);
      const r = await post(app, `${ADRES}/sprawdz`, admin, {});
      expect(fetchImpl, String(status)).toHaveBeenCalledTimes(1);
      expect(r.body, String(status)).toContain('Nie działa.');
      expect(r.body, String(status)).toContain('organizacji 4242');
      expect(r.body.includes(TOKEN), `${status}: token na ekranie`).toBe(false);
    }
  });

  it('„Odłącz InPost” kasuje zapis i wyłącza kuriera', async () => {
    const { app, admin, db, podglad } = panel();
    await post(app, ADRES, admin, FORMULARZ);
    const r = await post(app, `${ADRES}/odlacz`, admin, {});
    expect(r.statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'inpost')).toBeNull();
    expect(podglad.kurierzy.inpost).toBeUndefined();
  });

  it('InPost w pliku .env wygrywa: ekran tylko informuje, zapis odmawia 409 i niczego nie rusza', async () => {
    const env = { ...NADAWCA, INPOST_TOKEN: 'eyJ.Z-PLIKU.zmyslony', INPOST_ORGANIZACJA: '1' };
    const { app, admin, db, utworzone } = panel({ env });
    const r = await get(app, ADRES, admin);
    expect(r.body).toContain('w pliku konfiguracji');
    expect(formularz(r.body)).toBe('');
    expect(r.body).not.toContain('Z-PLIKU');
    const zapis = await post(app, ADRES, admin, FORMULARZ);
    expect(zapis.statusCode).toBe(409);
    expect(zapis.body).not.toContain(TOKEN);
    expect(wczytajKonfiguracjeIntegracji(db, 'inpost')).toBeNull();
    expect(utworzone).toHaveLength(1);
    expect(utworzone[0]).toMatchObject({ token: 'eyJ.Z-PLIKU.zmyslony', organizacja: 1 }); // klient z .env zbudowany przy starcie
  });

  it('InPost w .env, a w bazie stary zapis z ekranu: plik wygrywa, przycisk usunięcia działa', async () => {
    const env = { ...NADAWCA, INPOST_TOKEN: 'eyJ.Z-PLIKU.zmyslony', INPOST_ORGANIZACJA: '1' };
    const p = nowyPanelZZapisem(env);
    const ekran = await get(p.app, ADRES, p.admin);
    expect(ekran.body).toContain('Usuń zapisane dane InPost');
    expect(ekran.body).not.toContain(TOKEN);
    expect(p.utworzone).toEqual([expect.objectContaining({ token: 'eyJ.Z-PLIKU.zmyslony', organizacja: 1 })]);
    expect((await post(p.app, `${ADRES}/odlacz`, p.admin, {})).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(p.db, 'inpost')).toBeNull();
    expect(p.podglad.kurierzy.inpost).toBeDefined(); // odłączenie zapisu z ekranu nie zdejmuje kuriera z pliku
  });

  it('bez adresu firmy: test połączenia mówi o adresie (Ustawienia → Firma), nie „błąd techniczny”', async () => {
    const { app, admin } = panel({ env: {} });
    await post(app, ADRES, admin, FORMULARZ);
    const r = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(r.body).toContain('Brak adresu nadawcy');
    expect(r.body).not.toContain('błąd techniczny');
  });

  it('nadawca z Ustawień → Firma (adres w bazie, bez DPD_NADAWCA_* w pliku) trafia do klienta InPost', async () => {
    const { app, admin, db, podglad, utworzone } = panel({ env: {} });
    zapiszAdresFirmy(db, { nazwa: 'Firma z Ekranu', ulica: 'Ekranowa 5', kod: '01-234', miasto: 'Ekranowo', kraj: 'PL',
      telefon: '+48 000 000 000', email: 'firma@example.invalid' });
    await post(app, ADRES, admin, FORMULARZ);
    await podglad.kurierzy.inpost.sprawdzPolaczenie();
    expect(utworzone.at(-1).nadawca).toEqual({ nazwa: 'Firma z Ekranu', ulica: 'Ekranowa 5', kod: '01-234', miasto: 'Ekranowo',
      kraj: 'PL', phone: '+48 000 000 000', email: 'firma@example.invalid' });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body).toContain('Ekranowa 5');
  });

  it('adres firmy bez telefonu i e-maila: nadanie odmawia PRZED InPostem i wskazuje Ustawienia → Firma', async () => {
    const { app, admin, db, podglad, nadaj } = panel({ env: {} });
    zapiszAdresFirmy(db, { nazwa: 'Firma z Ekranu', ulica: 'Ekranowa 5', kod: '01-234', miasto: 'Ekranowo', kraj: 'PL', telefon: '', email: '' });
    await post(app, ADRES, admin, FORMULARZ);
    const e = await podglad.kurierzy.inpost.nadaj({ zamowienie: {}, paczka: {} }).catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('Ustawienia → Firma');
    expect(e.message).toContain('Panel niczego nie nadał');
    expect(nadaj).not.toHaveBeenCalled();
    await expect(podglad.kurierzy.inpost.sprawdzPolaczenie()).resolves.toEqual({ ok: true }); // połączenie da się sprawdzić
    expect((await get(app, ADRES, admin)).body).toContain('InPost wymaga telefonu i e-maila nadawcy');
  });

  // Znalezione w działającym panelu (demo ma adres w pliku, bez telefonu i e-maila): ekran Firma jest wtedy tylko do
  // odczytu, więc odsyłanie tam byłoby ślepą uliczką — ekran nazywa zmienne pliku.
  it('adres firmy z pliku bez telefonu i e-maila: ekran wskazuje zmienne pliku, nie Ustawienia → Firma', async () => {
    const { DPD_NADAWCA_TELEFON, DPD_NADAWCA_EMAIL, ...bezKontaktu } = NADAWCA;
    const { app, admin } = panel({ env: bezKontaktu });
    const r = await get(app, ADRES, admin);
    expect(r.body).toContain('InPost wymaga telefonu i e-maila nadawcy');
    expect(r.body).toContain('DPD_NADAWCA_TELEFON i DPD_NADAWCA_EMAIL');
    expect(r.body).not.toMatch(/dopisz [^<]* w <a href="\/ustawienia\/firma"/u);
  });

  it('telefon firmy, którego InPost nie przyjmie: czytelny powód zamiast „błąd techniczny”', async () => {
    const { app, admin, db } = panel({ env: {} });
    zapiszAdresFirmy(db, { nazwa: 'Firma z Ekranu', ulica: 'Ekranowa 5', kod: '01-234', miasto: 'Ekranowo', kraj: 'PL',
      telefon: '+49 30 1234567', email: 'firma@example.invalid' });
    await post(app, ADRES, admin, FORMULARZ);
    const r = await post(app, `${ADRES}/sprawdz`, admin, {});
    expect(r.body).toContain('Telefon');
    expect(r.body).toContain('Ustawienia → Firma');
    expect(r.body).not.toContain('błąd techniczny');
  });

  it('bez uprawnienia „ustawienia” — brak dostępu do ekranu, zapisu i odłączenia', async () => {
    const { app, ewa, admin, db } = panel();
    expect((await get(app, ADRES, ewa)).statusCode).toBe(403);
    expect((await post(app, ADRES, ewa, FORMULARZ)).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'inpost')).toBeNull();
    await post(app, ADRES, admin, FORMULARZ);
    expect((await post(app, `${ADRES}/odlacz`, ewa, {})).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'inpost')).not.toBeNull();
  });
});

// Zapis z ekranu MUSI leżeć w bazie przed startem modułów — tak wygląda instalacja, która dopisała InPost do pliku.
function nowyPanelZZapisem(env) {
  const utworzone = [];
  const createInpost = vi.fn((opcje) => { utworzone.push(opcje); return { nadaj: vi.fn(), sprawdzPrzesylke: vi.fn(), statusPrzesylki: vi.fn() }; });
  const podglad = {};
  const podgladacz = { nazwa: 'test-podgladacz', wersja: '1.0.0', wymaga: ['wysylka'], migracje: [], menu: [], uprawnienia: [],
    konfiguracja: () => null, zbuduj: (ctx) => {
      podglad.kurierzy = ctx.usluga('wysylka', 'kurierzy');
      return {};
    } };
  const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka({ fabryki: { createInpost } }), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie, podgladacz];
  const wstepny = nowyPanel({ moduly, env });
  zapiszKonfiguracjeIntegracji(wstepny.db, 'inpost', { ustawienia: { nazwa: 'InPost', organizacja: '4242', paczkomatNadawczy: '' },
    sekrety: { token: TOKEN } });
  utworzone.length = 0;
  const p = nowyPanel({ moduly, env, db: wstepny.db });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, admin: jako(p.db, 'adam'), utworzone, podglad };
}
