// PRZ-075: demo publiczne (demo.twojoms.pl) — wspólne konto gościa, którego dane stoją na ekranie logowania.
// Trzy rzeczy, które bez tego zadania psują demo w internecie:
//  1. hasło demo na ekranie logowania produkcji — panel ma ODMÓWIĆ startu, nie pokazać;
//  2. gość zmienia hasło wspólnego konta → demo zamknięte dla wszystkich do nocnego resetu;
//  3. „Brak synchronizacji — poller nie wykonał…” w trybie próby wygląda jak awaria.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { kontoDemo } from '../../src/core/demo.ts';
import { zalozKonto, kontoPoLoginie } from '../../src/core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../src/domena/hasla.js';
import { NAZWA_CIASTECZKA_OMS, NAZWA_CIASTECZKA_OMS_PROBA } from '../../src/core/bezpieczenstwo/sesja.js';
import { ENV_DEMO } from '../../scripts/demo-dane.mjs';

const LOGIN = 'gosc';
const HASLO = 'pokaz-demo-2026';
const wspolne = { OMS_USER: 'serwis', OMS_PASS: 'serwis-haslo', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const envDemo = { ...ENV_DEMO, ...wspolne, OMS_DEMO_LOGIN: LOGIN, OMS_DEMO_HASLO: HASLO };
const envProdukcja = { ...ENV_DEMO, ...wspolne, OMS_TRYB: 'produkcja' };
const origin = { origin: 'http://localhost' };

afterEach(() => vi.unstubAllGlobals());

async function panel(env) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
  const a = await zbudujOms({ env });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'admin-haslo-123', rola: 'administrator', admin: true });
  zalozKonto(a.db, { login: LOGIN, imie: 'Gość demo', haslo: HASLO, rola: 'sprzedaz' });
  return a;
}
async function zaloguj(a, uzytkownik, haslo) {
  const r = await a.app.inject({ method: 'POST', url: '/login', headers: origin, payload: { uzytkownik, haslo, powrot: '/' } });
  expect(r.statusCode, r.body).toBe(302);
  return [].concat(r.headers['set-cookie']).find((c) => [NAZWA_CIASTECZKA_OMS, NAZWA_CIASTECZKA_OMS_PROBA].some((n) => c.startsWith(`${n}=`))).split(';')[0];
}
const post = (a, url, cookie, payload) => a.app.inject({ method: 'POST', url, headers: { ...origin, cookie }, payload });

describe('PRZ-075 kontoDemo — konfiguracja', () => {
  it('bez zmiennych: brak konta demo (produkcja i piaskownica bez zmian)', () => {
    expect(kontoDemo({})).toBeNull();
    expect(kontoDemo({ OMS_TRYB: 'proba' })).toBeNull();
    expect(kontoDemo({ OMS_TRYB: 'proba', OMS_DEMO_LOGIN: '', OMS_DEMO_HASLO: '' })).toBeNull();
  });
  it('w trybie próby oddaje login i hasło', () => {
    // PRZ-082: obok loginu i hasła opis resetu dla ekranu logowania (z DEMO_RESET_CO_MIN, domyślnie 60 min).
    expect(kontoDemo({ OMS_TRYB: 'proba', OMS_DEMO_LOGIN: LOGIN, OMS_DEMO_HASLO: HASLO })).toEqual({ login: LOGIN, haslo: HASLO, reset: 'co godzinę',
      // PRZ-083: termin resetu instancji (DEMO_RESET_PLANOWY ustawia cykl demo) — bez zmiennej brak terminu.
      resetPlanowy: null, resetGodzina: null });
  });
  it('produkcja z hasłem demo ODMAWIA startu — hasło nie może stanąć na ekranie logowania firmy', () => {
    for (const tryb of [undefined, '', 'produkcja']) {
      expect(() => kontoDemo({ OMS_TRYB: tryb, OMS_DEMO_LOGIN: LOGIN, OMS_DEMO_HASLO: HASLO }), String(tryb)).toThrow(/OMS_TRYB=proba/);
      expect(() => kontoDemo({ OMS_TRYB: tryb, OMS_DEMO_LOGIN: LOGIN }), String(tryb)).toThrow(/OMS_TRYB=proba/);
    }
  });
  it('tylko jedna z dwóch zmiennych = błąd konfiguracji', () => {
    expect(() => kontoDemo({ OMS_TRYB: 'proba', OMS_DEMO_LOGIN: LOGIN })).toThrow(/OMS_DEMO_HASLO/);
    expect(() => kontoDemo({ OMS_TRYB: 'proba', OMS_DEMO_HASLO: HASLO })).toThrow(/OMS_DEMO_LOGIN/);
  });
  it('kompozycja produkcji z hasłem demo nie wstaje', async () => {
    await expect(zbudujOms({ env: { ...envProdukcja, OMS_DEMO_LOGIN: LOGIN, OMS_DEMO_HASLO: HASLO } })).rejects.toThrow(/OMS_TRYB=proba/);
  });
});

describe('PRZ-075 demo publiczne — ekrany', () => {
  it('ekran logowania demo pokazuje login i hasło gościa; produkcja nie', async () => {
    const demo = await panel(envDemo);
    const r = await demo.app.inject('/login');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`<code>${LOGIN}</code>`);
    expect(r.body).toContain(`<code>${HASLO}</code>`);
    expect(r.body).not.toContain('wyłącznie w sieci lokalnej');
    const prod = await panel(envProdukcja);
    const p = await prod.app.inject('/login');
    expect(p.body).not.toContain(HASLO);
    expect(p.body).not.toContain('logowanie-demo');
    expect(p.body).toContain('wyłącznie w sieci lokalnej');
  });

  it('gość nie zmieni hasła ani imienia wspólnego konta (403), konto zostaje jak było', async () => {
    const a = await panel(envDemo);
    const c = await zaloguj(a, LOGIN, HASLO);
    const nowe = 'przejete-haslo-123';
    const h = await post(a, '/konto/haslo', c, { obecne: HASLO, nowe, nowe2: nowe });
    expect(h.statusCode).toBe(403);
    expect(h.body).toContain('Konto demo');
    const i = await post(a, '/konto/imie', c, { imie: 'Przejęte' });
    expect(i.statusCode).toBe(403);
    const konto = kontoPoLoginie(a.db, LOGIN);
    const hash = a.db.prepare('SELECT hash_hasla FROM konta WHERE login = ?').get(LOGIN).hash_hasla;
    expect(zgodneHaslo(HASLO, hash)).toBe(true);
    expect(konto.wersja_hasla).toBe(0);
    expect(konto.imie).toBe('Gość demo');
    // Inne konto w tej samej instancji nadal zmienia swoje hasło — blokada dotyczy wyłącznie gościa.
    const t = await zaloguj(a, 'adam', 'admin-haslo-123');
    const ok = await post(a, '/konto/haslo', t, { obecne: 'admin-haslo-123', nowe: 'nowe-admin-123', nowe2: 'nowe-admin-123' });
    expect(ok.statusCode, ok.body).toBe(302);
  });

  it('gość nie wejdzie w Ustawienia (konta, role) ani w Finanse', async () => {
    const a = await panel(envDemo);
    const c = await zaloguj(a, LOGIN, HASLO);
    for (const url of ['/ustawienia/konta', '/ustawienia/role']) {
      const r = await a.app.inject({ url, headers: { cookie: c } });
      expect(r.statusCode, url).toBe(403);
    }
  });

  it('lista w trybie próby: komunikat demo zamiast alarmu synchronizacji; produkcja bez zmian', async () => {
    const a = await panel(envDemo);
    const r = await a.app.inject({ url: '/', headers: { cookie: await zaloguj(a, LOGIN, HASLO) } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain('Wersja demonstracyjna');
    expect(r.body).not.toContain('Brak synchronizacji');
    const p = await panel(envProdukcja);
    const rp = await p.app.inject({ url: '/', headers: { cookie: await zaloguj(p, 'adam', 'admin-haslo-123') } });
    expect(rp.statusCode, rp.body).toBe(200);
    expect(rp.body).toContain('Brak synchronizacji');
    expect(rp.body).not.toContain('Wersja demonstracyjna');
  });
});
