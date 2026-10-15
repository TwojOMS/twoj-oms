// PRZ-080: produkcja (:3001) i piaskownica (:3005, OMS_TRYB=proba) stoją na TYM SAMYM gospodarzu
// 192.168.0.10. Przeglądarka nie dzieli ciasteczek po porcie (RFC 6265 §8.5), więc przy wspólnej
// nazwie `sesja_oms` zalogowanie do piaskownicy nadpisywało ciasteczko produkcji, a produkcja
// (inny sekret, inna baza) odsyłała operatora na /login. Test odgrywa przeglądarkę z JEDNYM
// słoikiem na gospodarza, tak jak robi to Chrome, i chodzi między dwiema kompozycjami.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { NAZWA_CIASTECZKA_OMS, nazwaCiasteczkaOms } from '../../../src/core/bezpieczenstwo/sesja.js';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const wspolne = { OMS_USER: 'serwis', OMS_PASS: 'serwis-haslo', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const envProba = { ...ENV_DEMO, ...wspolne, OMS_TRYB: 'proba' };
const envProdukcja = { ...ENV_DEMO, ...wspolne, OMS_TRYB: 'produkcja' };
const origin = { origin: 'http://localhost' };
const HASLO = 'haslo-operatora-123';

afterEach(() => vi.unstubAllGlobals());

async function kompozycja(env) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
  const a = await zbudujOms({ env });
  zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: HASLO, rola: 'administrator', admin: true });
  return a;
}

/** Słoik jednego gospodarza: nazwa → wartość. Max-Age=0 kasuje, jak w przeglądarce. */
function sloik() {
  const c = new Map();
  return {
    przyjmij(r) {
      for (const linia of [].concat(r.headers['set-cookie'] ?? [])) {
        const [para, ...atrybuty] = linia.split(';');
        const i = para.indexOf('=');
        const nazwa = para.slice(0, i).trim();
        if (atrybuty.some((a) => a.trim() === 'Max-Age=0')) c.delete(nazwa);
        else c.set(nazwa, para.slice(i + 1).trim());
      }
      return r;
    },
    naglowek: () => [...c].map(([n, w]) => `${n}=${w}`).join('; '),
    nazwy: () => [...c.keys()],
  };
}

const zaloguj = async (a, s, haslo = HASLO) => {
  const r = s.przyjmij(await a.app.inject({ method: 'POST', url: '/login', headers: { ...origin, cookie: s.naglowek() },
    payload: { uzytkownik: 'adam', haslo, powrot: '/' } }));
  expect(r.statusCode, r.body).toBe(302);
};
const wejdz = async (a, s) => s.przyjmij(await a.app.inject({ method: 'GET', url: '/konto', headers: { accept: 'text/html', cookie: s.naglowek() } }));
const post = async (a, s, url, payload = {}) => s.przyjmij(await a.app.inject({ method: 'POST', url, headers: { ...origin, cookie: s.naglowek() }, payload }));

describe('PRZ-080 ciasteczko sesji zależne od trybu', () => {
  it('produkcja zostaje na `sesja_oms` (wydanie nikogo nie wylogowuje), próba ma własną nazwę', () => {
    expect(nazwaCiasteczkaOms(false)).toBe('sesja_oms');
    expect(NAZWA_CIASTECZKA_OMS).toBe('sesja_oms');
    expect(nazwaCiasteczkaOms(true)).toBe('sesja_oms_proba');
  });

  it('logowanie do piaskownicy na tym samym gospodarzu NIE wylogowuje z produkcji (i odwrotnie)', async () => {
    const produkcja = await kompozycja(envProdukcja);
    const proba = await kompozycja(envProba);
    const s = sloik();

    await zaloguj(produkcja, s);
    expect((await wejdz(produkcja, s)).statusCode).toBe(200);

    await zaloguj(proba, s);
    expect((await wejdz(proba, s)).statusCode).toBe(200);
    const poPrzeskoku = await wejdz(produkcja, s);
    expect(poPrzeskoku.statusCode, 'produkcja po zalogowaniu do piaskownicy').toBe(200);
    expect(s.nazwy().sort()).toEqual(['sesja_oms', 'sesja_oms_proba']);

    await zaloguj(produkcja, s);
    expect((await wejdz(proba, s)).statusCode, 'piaskownica po ponownym logowaniu do produkcji').toBe(200);
  });

  it('wylogowanie, „wyloguj wszystkie” i zmiana hasła w piaskownicy dotykają tylko jej ciasteczka', async () => {
    const produkcja = await kompozycja(envProdukcja);
    const proba = await kompozycja(envProba);
    const s = sloik();
    await zaloguj(produkcja, s);
    await zaloguj(proba, s);

    const haslo = await post(proba, s, '/konto/haslo', { obecne: HASLO, nowe: 'nowe-haslo-proby-1', nowe2: 'nowe-haslo-proby-1' });
    expect(haslo.statusCode, haslo.body).toBe(302);
    expect(String(haslo.headers['set-cookie'])).toMatch(/^sesja_oms_proba=/);
    expect((await wejdz(proba, s)).statusCode, 'piaskownica po zmianie hasła').toBe(200);

    await post(proba, s, '/ustawienia/konta/wyloguj-wszystkie');
    expect(s.nazwy()).toEqual(['sesja_oms']);
    await zaloguj(proba, s, 'nowe-haslo-proby-1');
    await post(proba, s, '/wyloguj');
    expect(s.nazwy()).toEqual(['sesja_oms']);
    expect((await wejdz(produkcja, s)).statusCode).toBe(200);
  });
});
