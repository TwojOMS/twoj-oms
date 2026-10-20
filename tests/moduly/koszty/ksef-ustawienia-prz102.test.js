// PRZ-102.22 — token KSeF (faktury kosztowe) w panelu: Ustawienia → Integracje → KSeF. Wzór: klucz GUS z PRZ-102.11
// (plik wygrywa = 409, sekret nigdy na ekran, zmiana bez restartu, „Sprawdź połączenie”).
// Pełna kompozycja produktu (modulyDla) z atrapą klienta KSeF wstrzykniętą w moduł kosztów; globalny fetch odmawia,
// więc żadne żądanie nie wychodzi do KSeF. Tokeny i NIP-y zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { jako } from '../../pomoc/konta-prz068.js';

const ADRES = '/ustawienia/integracje/ksef';
const NIP = '1234563218';
const TOKEN = '20261020-EC-ZMYSLONY0001|nip-1234563218|aaaaaaaaaaaaaaaa';
const TOKEN_2 = '20261020-EC-ZMYSLONY0002|nip-1234563218|bbbbbbbbbbbbbbbb';
const TOKEN_PLIKU = '20261020-EC-ZMYSLONYPLIK|nip-1234563218|cccccccccccccccc';
const ZDANIE = 'Wygeneruj w KSeF token z uprawnieniem tylko do przeglądania faktur zakupowych — panel niczego przez KSeF nie wysyła.';
const ENV = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: NIP, OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
// 03:30 czasu Warszawy — pora nocnego pobrania kosztów (zegar bez `wymuszony` pobiera tylko o 3).
const TERAZ = new Date('2026-10-20T01:30:00Z');

let siec;
beforeEach(() => {
  siec = vi.fn(async () => { throw new Error('Sieć zabroniona w teście KSeF z panelu'); });
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Atrapa klienta KSeF: zapamiętuje, z jakim tokenem powstała i które metody wołano. */
function atrapaKsef({ odrzucaToken = null } = {}) {
  const klienci = [];
  const fabryka = vi.fn(({ token, nip }) => {
    const wolania = [];
    const klient = {
      token, nip, wolania,
      zaloguj: vi.fn(async () => {
        wolania.push('zaloguj');
        if (token === odrzucaToken) throw Object.assign(new Error('KSeF odmówił przy uwierzytelnianiu tokenem: HTTP 401 — token nieważny'), { dlaOperatora: true, status: 401 });
        return { accessToken: `access-${klienci.length}`, accessDo: '2027-01-01T00:00:00Z', refreshToken: 'refresh', refreshDo: '2027-02-01T00:00:00Z' };
      }),
      odswiez: vi.fn(async () => ({ accessToken: 'odswiezony', accessDo: '2027-01-01T00:00:00Z' })),
      pobierzMetadane: vi.fn(async () => { wolania.push('pobierzMetadane'); return { faktury: [], hasMore: false, isTruncated: false }; }),
      pobierzXml: vi.fn(async () => '<Faktura/>'),
    };
    klienci.push(klient);
    return klient;
  });
  return { fabryka, klienci, tokeny: () => klienci.map((k) => k.token) };
}

async function oms({ env = {}, atrapa = atrapaKsef(), zapisPrzedStartem = null, fabryki = undefined, db: bazaZewnetrzna = null } = {}) {
  const logi = [];
  const e = { ...ENV, ...env };
  const moduly = modulyDla(e).map((m) => (m.nazwa === 'koszty' ? createModulKoszty({ createKlient: atrapa.fabryka, fabryki }) : m));
  let db = bazaZewnetrzna;
  if (zapisPrzedStartem && !db) {
    const { openOmsDb } = await import('../../../src/oms/db/db.ts');
    db = openOmsDb(':memory:', { moduly });
    zapiszKonfiguracjeIntegracji(db, 'ksef', { ustawienia: {}, sekrety: { token: zapisPrzedStartem } });
  }
  const z = await zbudujOms({ env: e, moduly, ...(db ? { db } : {}), teraz: () => new Date(TERAZ), log: (...t) => logi.push(t.join(' ')) });
  if (!bazaZewnetrzna) {
  zalozKonto(z.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(z.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(z.db, kontoPoLoginie(z.db, 'ewa').id, ['zamowienia', 'koszty']);
  }
  const naglowki = (login) => ({ accept: 'text/html', ...jako(z.db, login) });
  const get = (url, kto = 'adam') => z.app.inject({ method: 'GET', url, headers: naglowki(kto) });
  const post = (url, payload = {}, kto = 'adam') => z.app.inject({ method: 'POST', url, headers: { ...naglowki(kto), origin: 'http://localhost' }, payload });
  const zegar = () => z.zegary.find((x) => x.nazwa === 'czuwaczKosztow');
  return { ...z, atrapa, logi, get, post, zegar, zamknij: async () => { await z.app.close(); z.db.close(); } };
}
const formularz = (html) => /<form id="ksef-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('PRZ-102.22 Ustawienia → Integracje → KSeF (faktury kosztowe)', () => {
  it('Integracje mają kartę KSeF; pusty ekran: pole tokenu (hasło), NIP opcjonalny, zdanie o uprawnieniu, bez adresu API', async () => {
    const o = await oms();
    try {
      const lista = await o.get('/ustawienia/integracje');
      expect(lista.body).toContain(`href="${ADRES}"`);
      expect(lista.body).toContain('KSeF — faktury kosztowe');
      const r = await o.get(ADRES);
      expect(r.statusCode, r.body).toBe(200);
      const f = formularz(r.body);
      expect(f).toMatch(/<input id="ksef-token" type="password" name="token"[^>]* required>/u);
      expect(f).toMatch(/<input id="ksef-nip"[^>]* name="nip"/u);
      expect(f).not.toMatch(/name="(api|adres|url|archiwum)"/u);
      expect(r.body).toContain(ZDANIE);
      expect(r.body).toContain('Niepodłączony');
      expect(r.body.includes('api.ksef.mf.gov.pl')).toBe(false);
    } finally { await o.zamknij(); }
  });

  it('zapis tokenu w panelu → bez restartu zegar czuwacza kosztów pobiera tym tokenem; ten sam token = ta sama sesja, nowy token = nowy klient', async () => {
    const o = await oms();
    try {
      // Bez tokenu zegar stoi w składzie (zapis z panelu musi zadziałać bez restartu), ale niczego nie woła.
      expect(o.zegar(), 'zegar czuwacza kosztów bez tokenu').toBeTruthy();
      await o.zegar().przebieg();
      expect(o.atrapa.fabryka).not.toHaveBeenCalled();

      const r = await o.post(ADRES, { token: `  ${TOKEN}\n`, nip: '' });
      expect(r.statusCode, r.body).toBe(303);
      expect(r.body.includes(TOKEN)).toBe(false);
      const zapis = wczytajKonfiguracjeIntegracji(o.db, 'ksef');
      expect(zapis.sekrety).toEqual({ token: TOKEN });
      expect(zapis.kontoLogin).toBe('adam');

      await o.zegar().przebieg();
      expect(o.atrapa.tokeny()).toEqual([TOKEN]);
      expect(o.atrapa.fabryka).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN, nip: NIP }));
      expect(o.atrapa.klienci[0].wolania).toEqual(expect.arrayContaining(['zaloguj', 'pobierzMetadane']));
      // Drugi przebieg z tym samym tokenem: ten sam klient i ta sama sesja (zero nowych logowań).
      await o.zegar().przebieg();
      expect(o.atrapa.fabryka).toHaveBeenCalledTimes(1);
      expect(o.atrapa.klienci[0].zaloguj).toHaveBeenCalledTimes(1);
      // „Odśwież teraz” na ekranie Koszty jedzie tym samym klientem.
      const odswiez = await o.post('/koszty/odswiez', { miesiac: '2026-10' });
      expect(odswiez.statusCode, odswiez.body).toBe(200);
      expect(o.atrapa.fabryka).toHaveBeenCalledTimes(1);

      // Zmiana tokenu: następny przebieg buduje nowego klienta i loguje się od nowa (stara sesja skasowana).
      expect((await o.post(ADRES, { token: TOKEN_2 })).statusCode).toBe(303);
      await o.zegar().przebieg();
      expect(o.atrapa.tokeny()).toEqual([TOKEN, TOKEN_2]);
      expect(o.atrapa.klienci[1].zaloguj).toHaveBeenCalledTimes(1);

      const zdrowie = (await o.get('/health')).json();
      expect(zdrowie.czuwaczKosztow.wlaczony).toBe(true);
    } finally { await o.zamknij(); }
  });

  it('sekret nie wraca na żaden ekran, do odpowiedzi, logu zdarzeń ani logu procesu', async () => {
    const o = await oms();
    try {
      await o.post(ADRES, { token: TOKEN });
      await o.zegar().przebieg();
      await o.post(`${ADRES}/sprawdz`);
      for (const adres of [ADRES, '/ustawienia/integracje', '/koszty', '/health']) {
        const e = await o.get(adres);
        expect(e.body.includes(TOKEN), `token na ekranie ${adres}`).toBe(false);
      }
      const ekran = await o.get(ADRES);
      expect(ekran.body).toContain('Podłączony');
      expect(formularz(ekran.body)).toMatch(/<input id="ksef-token"[^>]* value=""[^>]* placeholder="zapisany — wpisz nowy, żeby zmienić">/u);
      expect(JSON.stringify(o.db.prepare('SELECT * FROM log').all()).includes(TOKEN)).toBe(false);
      expect(o.logi.join('\n').includes(TOKEN)).toBe(false);
      expect(siec).not.toHaveBeenCalled();
    } finally { await o.zamknij(); }
  });

  it('usunięcie tokenu: czuwacz nic nie robi, /health jak bez tokenu, „Odśwież teraz” 503', async () => {
    const o = await oms({ zapisPrzedStartem: TOKEN });
    try {
      await o.zegar().przebieg();
      expect(o.atrapa.tokeny()).toEqual([TOKEN]);
      const stron = o.atrapa.klienci[0].pobierzMetadane.mock.calls.length;
      expect(stron).toBeGreaterThan(0);
      const r = await o.post(`${ADRES}/odlacz`);
      expect(r.statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(o.db, 'ksef')).toBeNull();
      await o.zegar().przebieg();
      expect(o.atrapa.klienci[0].pobierzMetadane).toHaveBeenCalledTimes(stron);
      expect(o.atrapa.fabryka).toHaveBeenCalledTimes(1);
      const zdrowie = (await o.get('/health')).json();
      expect(zdrowie.czuwaczKosztow).toMatchObject({ wlaczony: false, zdrowy: true });
      expect((await o.post('/koszty/odswiez', { miesiac: '2026-10' })).statusCode).toBe(503);
    } finally { await o.zamknij(); }
  });

  it('token w pliku: ekran tylko informuje, zapis 409, czuwacz pobiera tokenem z pliku — także przy starym zapisie z ekranu', async () => {
    const o = await oms({ env: { KSEF_TOKEN: TOKEN_PLIKU }, zapisPrzedStartem: TOKEN });
    try {
      const r = await o.post(ADRES, { token: TOKEN_2 });
      expect(r.statusCode).toBe(409);
      expect(r.body).toContain('KSEF_TOKEN');
      expect(wczytajKonfiguracjeIntegracji(o.db, 'ksef').sekrety).toEqual({ token: TOKEN });
      const ekran = await o.get(ADRES);
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).toContain('pliku konfiguracji');
      expect(formularz(ekran.body)).toBe('');
      for (const t of [TOKEN, TOKEN_PLIKU]) expect(ekran.body.includes(t)).toBe(false);
      await o.zegar().przebieg();
      expect(o.atrapa.tokeny()).toEqual([TOKEN_PLIKU]);
    } finally { await o.zamknij(); }
  });

  it('„Sprawdź połączenie” loguje się zapisanym tokenem i tylko czyta; zły token = czytelna odmowa bez tokenu', async () => {
    const atrapa = atrapaKsef({ odrzucaToken: TOKEN_2 });
    const o = await oms({ atrapa });
    try {
      const bez = await o.post(`${ADRES}/sprawdz`);
      expect(bez.body).toContain('Najpierw zapisz token');
      expect(atrapa.fabryka).not.toHaveBeenCalled();
      await o.post(ADRES, { token: TOKEN });
      const ok = await o.post(`${ADRES}/sprawdz`);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toContain('Działa.');
      expect(atrapa.klienci[0].wolania).toEqual(['zaloguj', 'pobierzMetadane']);
      expect(atrapa.klienci[0].pobierzXml).not.toHaveBeenCalled();
      // Sprawdzenie nie dopisuje kosztów i nie przesuwa kursora pobierania.
      expect(o.db.prepare('SELECT COUNT(*) AS n FROM koszty').get().n).toBe(0);
      await o.post(ADRES, { token: TOKEN_2 });
      const zle = await o.post(`${ADRES}/sprawdz`);
      expect(zle.body).toContain('Nie działa.');
      expect(zle.body).toContain('token nieważny');
      expect(zle.body.includes(TOKEN_2)).toBe(false);
    } finally { await o.zamknij(); }
  });

  it('błędy formularza: pusty, ze spacją, za krótki, NIP inny niż sprzedawcy — nic nie zapisane, wartość nie wraca', async () => {
    const o = await oms();
    try {
      for (const [body, tekst] of [[{ token: '' }, 'Podaj token'], [{ token: 'ab cd ef gh ij kl mn op qr st' }, 'spacji'],
        [{ token: 'krotki' }, 'za krótkie'], [{ token: TOKEN, nip: '1111111111' }, 'OMS_SPRZEDAWCA_NIP']]) {
        const r = await o.post(ADRES, body);
        expect(r.statusCode, JSON.stringify(body)).toBe(400);
        expect(r.body).toContain('Nie zapisano.');
        expect(r.body).toContain(tekst);
        if (body.token) expect(formularz(r.body).includes(body.token)).toBe(false);
      }
      expect(wczytajKonfiguracjeIntegracji(o.db, 'ksef')).toBeNull();
      // NIP zgodny ze sprzedawcą (z przedrostkiem i kreskami) przechodzi.
      expect((await o.post(ADRES, { token: TOKEN, nip: 'PL 123-456-32-18' })).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(o.db, 'ksef').ustawienia).toEqual({ nip: NIP });
    } finally { await o.zamknij(); }
  });

  // Recenzja PRZ-102.22 (WAŻNE 1): przebieg na tokenie A trwa, admin zapisuje token B. Stary zestaw loguje się A
  // PO skasowaniu sesji i zapisuje parę A z powrotem — zestaw B nie może jej przejąć (zły B = odmowa, nie „działa”).
  it('nowy token nie przejmuje sesji starego, także gdy stary przebieg zaloguje się po zapisie nowego', async () => {
    const atrapa = atrapaKsef({ odrzucaToken: TOKEN_2 });
    let zwolnij; const brama = new Promise((r) => { zwolnij = r; });
    const createCzuwaczKosztow = ({ sesja }) => ({ przebieg: async () => { await sesja.accessToken(); await brama; await sesja.accessToken(); return { nowych: 0, przeczytanych: 0, okien: 1 }; } });
    const o = await oms({ atrapa, fabryki: { createCzuwaczKosztow } });
    try {
      await o.post(ADRES, { token: TOKEN });
      const stary = o.zegar().przebieg();
      await new Promise((r) => setTimeout(r, 20));
      expect((await o.post(ADRES, { token: TOKEN_2 })).statusCode).toBe(303);
      zwolnij();
      await stary;
      const zle = await o.post(`${ADRES}/sprawdz`);
      expect(zle.body).toContain('Nie działa.');
      expect(atrapa.tokeny()).toEqual([TOKEN, TOKEN_2]);
      expect(atrapa.klienci[1].zaloguj).toHaveBeenCalledTimes(1);
    } finally { await o.zamknij(); }
  });

  // Ten sam efekt bez wyścigu: token z pliku usunięty z oms.env + restart, a w bazie leży starszy zapis z ekranu.
  it('po zdjęciu tokenu z pliku token z ekranu nie dziedziczy sesji tokenu z pliku', async () => {
    const { openOmsDb } = await import('../../../src/oms/db/db.ts');
    const db = openOmsDb(':memory:', { moduly: modulyDla({ ...ENV }) });
    zapiszKonfiguracjeIntegracji(db, 'ksef', { ustawienia: {}, sekrety: { token: TOKEN_2 } });
    const zPliku = atrapaKsef();
    const pierwszy = await oms({ env: { KSEF_TOKEN: TOKEN_PLIKU }, atrapa: zPliku, db });
    await pierwszy.zegar().przebieg();
    expect(zPliku.tokeny()).toEqual([TOKEN_PLIKU]);
    await pierwszy.app.close();
    const atrapa = atrapaKsef({ odrzucaToken: TOKEN_2 });
    const drugi = await oms({ atrapa, db });
    try {
      zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
      const zle = await drugi.post(`${ADRES}/sprawdz`);
      expect(zle.body).toContain('Nie działa.');
      expect(atrapa.tokeny()).toEqual([TOKEN_2]);
    } finally { await drugi.zamknij(); }
  });

  it('nie-admin (bez uprawnienia „ustawienia”) dostaje 403 na ekranie, zapisie, sprawdzeniu i usunięciu', async () => {
    const o = await oms({ zapisPrzedStartem: TOKEN });
    try {
      expect((await o.get(ADRES, 'ewa')).statusCode).toBe(403);
      expect((await o.post(ADRES, { token: TOKEN_2 }, 'ewa')).statusCode).toBe(403);
      expect((await o.post(`${ADRES}/sprawdz`, {}, 'ewa')).statusCode).toBe(403);
      expect((await o.post(`${ADRES}/odlacz`, {}, 'ewa')).statusCode).toBe(403);
      expect(wczytajKonfiguracjeIntegracji(o.db, 'ksef').sekrety).toEqual({ token: TOKEN });
      expect(o.atrapa.fabryka).not.toHaveBeenCalled();
    } finally { await o.zamknij(); }
  });
});
