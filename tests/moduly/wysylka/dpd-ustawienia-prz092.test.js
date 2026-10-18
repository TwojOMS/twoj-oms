// PRZ-092 — Ustawienia → Integracje → Kurier DPD: formularz na wzór Apilo dla instalacji klientów Twojego OMS-u.
// Prawdziwy serwer (buildOmsServer), prawdziwy moduł wysyłki z podmienioną fabryką klienta DPD — żadne żądanie
// nie wychodzi do DPD.
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
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

const HASLO = 'Tajne-Haslo-DPD-123';
// nowyPanel podmienia config — adres nadawcy idzie więc wprost zmiennymi, jak w oms.env klienta.
const NADAWCA = { DPD_NADAWCA_NAZWA: 'Pracownia Testowa', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Warszawa' };
const FORMULARZ = { nazwa: 'DPD', login: '11112222', fid: '333444', haslo: HASLO, typEtykiety: 'A4', kanal: '' };

function panel({ env = {}, sprawdz = async () => ({ ok: true }) } = {}) {
  const utworzone = [];
  const createDpd = vi.fn((opcje) => {
    utworzone.push(opcje);
    return { nadaj: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn(sprawdz) };
  });
  const podglad = {};
  const podgladacz = { nazwa: 'test-podgladacz', wersja: '1.0.0', wymaga: ['wysylka'], migracje: [], menu: [], uprawnienia: [],
    konfiguracja: () => null, zbuduj: (ctx) => { podglad.kurierzy = ctx.usluga('wysylka', 'kurierzy'); return {}; } };
  const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka({ fabryki: { createDpd } }), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie, podgladacz];
  const p = nowyPanel({ moduly, env: { ...NADAWCA, ...env } });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa'), createDpd, utworzone, podglad };
}
const formularz = (html) => /<form id="dpd-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('PRZ-092 Ustawienia → Kurier DPD', () => {
  it('pusty ekran: pola jak w Apilo, oba typy etykiet, adres nadawcy z konfiguracji, „Niepodłączony”', async () => {
    const { app, admin, podglad } = panel();
    const r = await get(app, '/ustawienia/integracje/dpd', admin);
    expect(r.statusCode, r.body).toBe(200);
    const f = formularz(r.body);
    for (const pole of ['nazwa', 'login', 'fid', 'haslo', 'typEtykiety', 'kanal']) expect(f).toContain(`name="${pole}"`);
    expect(f).toMatch(/<input[^>]*type="password"[^>]*name="haslo"|<input[^>]*name="haslo"[^>]*type="password"/u);
    expect(f).toContain('value="LBL_PRINTER"');
    expect(f).toContain('value="A4"');
    expect(r.body).toContain('Niepodłączony');
    expect(r.body).toContain('Zmyślona 1');
    expect(r.body).toContain('Master FID');
    expect(r.body).toContain('href="/ustawienia/zamowienia-i-wysylka"'); // wagi i wymiary = szablony paczek
    expect(podglad.kurierzy.dpd).toBeUndefined();
  });

  it('Integracje mają wejście do kuriera DPD', async () => {
    const { app, admin } = panel();
    const r = await get(app, '/ustawienia/integracje', admin);
    expect(r.body).toContain('href="/ustawienia/integracje/dpd"');
  });

  it('zapis: 303, wiersz w bazie, hasło NIGDY nie wraca na ekran, kurier DPD gotowy do nadania bez restartu', async () => {
    const { app, admin, db, podglad, utworzone } = panel();
    const r = await post(app, '/ustawienia/integracje/dpd', admin, FORMULARZ);
    expect(r.statusCode, r.body).toBe(303);
    const zapis = wczytajKonfiguracjeIntegracji(db, 'dpd');
    expect(zapis.ustawienia).toEqual({ nazwa: 'DPD', login: '11112222', fid: '333444', typEtykiety: 'A4' });
    expect(zapis.sekrety.haslo).toBe(HASLO);
    expect(zapis.kontoLogin).toBe('adam');

    const ekran = await get(app, r.headers.location, admin);
    expect(ekran.statusCode).toBe(200);
    expect(ekran.body).not.toContain(HASLO);
    expect(ekran.body).toContain('Podłączony');
    expect(formularz(ekran.body)).toContain('value="11112222"');

    expect(podglad.kurierzy.dpd).toBeDefined();
    await podglad.kurierzy.dpd.sprawdzPolaczenie();
    expect(utworzone.at(-1)).toMatchObject({ login: '11112222', haslo: HASLO, fid: '333444', formatEtykiety: 'A4',
      url: expect.stringContaining('dpdservices.dpd.com.pl'), nadawca: expect.objectContaining({ ulica: 'Zmyślona 1' }) });
    expect(podglad.kurierzy.dpd.bezSledzenia).toBe(true); // bez kanału DPD Info nie pytamy o statusy
  });

  it('ponowny zapis z pustym hasłem zostawia zapisane; nowy login trafia do następnego klienta', async () => {
    const { app, admin, db, podglad, utworzone } = panel();
    await post(app, '/ustawienia/integracje/dpd', admin, FORMULARZ);
    await podglad.kurierzy.dpd.sprawdzPolaczenie();
    const r = await post(app, '/ustawienia/integracje/dpd', admin, { ...FORMULARZ, login: '55556666', haslo: '', kanal: 'KANAL-1' });
    expect(r.statusCode, r.body).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd').sekrety).toEqual({ haslo: HASLO, kanal: 'KANAL-1' });
    await podglad.kurierzy.dpd.sprawdzPolaczenie();
    expect(utworzone.at(-1)).toMatchObject({ login: '55556666', haslo: HASLO, channel: 'KANAL-1',
      infoUrl: expect.stringContaining('dpdinfoservices') });
    expect(podglad.kurierzy.dpd.bezSledzenia).toBe(false);
  });

  it('błędny formularz: 400 z powodami, nic nie zapisane, wpisane hasło nie wraca w odpowiedzi', async () => {
    const { app, admin, db } = panel();
    const r = await post(app, '/ustawienia/integracje/dpd', admin, { ...FORMULARZ, fid: 'abc', login: '' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('Podaj login od DPD.');
    expect(r.body).toContain('to same cyfry');
    expect(r.body).not.toContain(HASLO);
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd')).toBeNull();
  });

  it('„Sprawdź połączenie”: sukces i odmowa DPD jako czytelny komunikat; bez zapisu — prośba o zapis', async () => {
    let odp = async () => ({ ok: true });
    const { app, admin } = panel({ sprawdz: () => odp() });
    const przed = await post(app, '/ustawienia/integracje/dpd/sprawdz', admin, {});
    expect(przed.body).toContain('Najpierw zapisz');
    await post(app, '/ustawienia/integracje/dpd', admin, FORMULARZ);
    const ok = await post(app, '/ustawienia/integracje/dpd/sprawdz', admin, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).toContain('Połączenie z DPD działa');
    odp = async () => { throw bladOperatora('DPD odrzuciło żądanie: Login failed for login: ***'); };
    const zle = await post(app, '/ustawienia/integracje/dpd/sprawdz', admin, {});
    expect(zle.body).toContain('DPD odrzuciło żądanie');
    expect(zle.body).not.toContain(HASLO);
    odp = async () => { throw new Error(`TypeError w środku z ${HASLO}`); }; // błąd techniczny nie idzie na ekran
    const tech = await post(app, '/ustawienia/integracje/dpd/sprawdz', admin, {});
    expect(tech.body).not.toContain(HASLO);
    expect(tech.body).toContain('błąd techniczny');
  });

  it('„Odłącz DPD” kasuje zapis i wyłącza kuriera', async () => {
    const { app, admin, db, podglad } = panel();
    await post(app, '/ustawienia/integracje/dpd', admin, FORMULARZ);
    const r = await post(app, '/ustawienia/integracje/dpd/odlacz', admin, {});
    expect(r.statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd')).toBeNull();
    expect(podglad.kurierzy.dpd).toBeUndefined();
  });

  it('DPD w pliku .env wygrywa: ekran tylko informuje, zapis odmawia 409 i niczego nie rusza', async () => {
    const env = { DPD_URL: 'https://dpd.invalid/ws', DPD_LOGIN: 'plik', DPD_PASSWORD: 'z-pliku', DPD_FID: '1',
      DPD_INFO_URL: 'https://dpd.invalid/info', DPD_INFO_CHANNEL: 'k' };
    const { app, admin, db, utworzone } = panel({ env });
    const r = await get(app, '/ustawienia/integracje/dpd', admin);
    expect(r.body).toContain('w pliku konfiguracji');
    expect(formularz(r.body)).toBe('');
    expect(r.body).not.toContain('z-pliku');
    const zapis = await post(app, '/ustawienia/integracje/dpd', admin, FORMULARZ);
    expect(zapis.statusCode).toBe(409);
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd')).toBeNull();
    expect(utworzone.at(-1)).toMatchObject({ login: 'plik' }); // klient z .env zbudowany przy starcie, jak dotąd
  });

  // Recenzja PRZ-092 (P3): dane z ekranu sprzed dopisania DPD do .env muszą dać się usunąć.
  it('DPD w .env, a w bazie stary zapis z ekranu: przycisk usunięcia działa', async () => {
    const env = { DPD_URL: 'https://dpd.invalid/ws', DPD_LOGIN: 'plik', DPD_PASSWORD: 'z-pliku', DPD_FID: '1',
      DPD_INFO_URL: 'https://dpd.invalid/info', DPD_INFO_CHANNEL: 'k' };
    const { app, admin, db } = panel({ env });
    zapiszKonfiguracjeIntegracji(db, 'dpd', { ustawienia: { ...FORMULARZ }, sekrety: { haslo: HASLO, kanal: '' } });
    const ekran = await get(app, '/ustawienia/integracje/dpd', admin);
    expect(ekran.body).toContain('Usuń zapisane dane DPD');
    expect(ekran.body).not.toContain(HASLO);
    expect((await post(app, '/ustawienia/integracje/dpd/odlacz', admin, {})).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd')).toBeNull();
  });

  it('bez adresu nadawcy: test połączenia mówi o adresie, nie „błąd techniczny”', async () => {
    const { app, admin } = panel({ env: { DPD_NADAWCA_ULICA: '' } });
    await post(app, '/ustawienia/integracje/dpd', admin, FORMULARZ);
    const r = await post(app, '/ustawienia/integracje/dpd/sprawdz', admin, {});
    expect(r.body).toContain('Brak adresu nadawcy');
    expect(r.body).not.toContain('błąd techniczny');
  });

  it('bez uprawnienia „ustawienia” — brak dostępu do ekranu i zapisu', async () => {
    const { app, ewa, db } = panel();
    expect((await get(app, '/ustawienia/integracje/dpd', ewa)).statusCode).toBe(403);
    expect((await post(app, '/ustawienia/integracje/dpd', ewa, FORMULARZ)).statusCode).toBe(403);
    expect(wczytajKonfiguracjeIntegracji(db, 'dpd')).toBeNull();
  });
});
