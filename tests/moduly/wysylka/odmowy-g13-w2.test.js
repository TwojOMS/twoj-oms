// PRZ-152.G13w2: odmowy nadania, podjazdów, przesyłek i ustawień DPD/InPost w układzie OMS.
// Status i tekst odmowy bez zmian (znak w znak) — zmienia się tylko opakowanie: strona OMS z paskiem uwagi
// i drogą powrotu zamiast gołego text/plain. Żadne żądanie nie wychodzi do DPD, InPost ani Allegro
// (fetch podmieniony na rzucanie, fabryki kurierów podmienione).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { nowyPanel, jako, post as postKonta } from '../../pomoc/konta-prz068.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
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

const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test: zakaz sieci'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function odmowa(r, status, tekst, tytul, wroc, napisWroc) {
  expect(r.statusCode, r.body).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">${napisWroc}</a>`);
}

function serwer(opcje = {}) {
  const db = openOmsDb(':memory:');
  const server = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [] },
    poller: { stan: () => ({}) }, ...opcje });
  return { db, server };
}

describe('nadanie: zamówienia nie ma', () => {
  let s;
  afterEach(async () => { await s.server.close(); s.db.close(); });
  const LISTA = ['Nie ma takiego zamówienia', 'Nie udało się przygotować przesyłki', '/', 'Wróć do listy zamówień'];

  it('POST /zamowienia/:id/dosylka', async () => {
    s = serwer();
    const r = await s.server.inject({ method: 'POST', url: '/zamowienia/99999/dosylka', headers, payload: 'numer_zrodlowy=X-1' });
    odmowa(r, 404, 'Nie ma takiego zamówienia', 'Nie udało się zapisać dosyłki', '/', 'Wróć do listy zamówień');
  });
  it('POST /zamowienia/:id/przesylki/reczna', async () => {
    s = serwer();
    const r = await s.server.inject({ method: 'POST', url: '/zamowienia/99999/przesylki/reczna', headers, payload: 'numer_listu=X-1' });
    odmowa(r, 404, ...LISTA);
  });
  it('GET /zamowienia/:id/nadaj', async () => {
    s = serwer();
    const r = await s.server.inject({ method: 'GET', url: '/zamowienia/99999/nadaj', headers: { authorization: headers.authorization } });
    odmowa(r, 404, ...LISTA);
  });
  it('POST /zamowienia/:id/nadaj', async () => {
    s = serwer();
    const r = await s.server.inject({ method: 'POST', url: '/zamowienia/99999/nadaj', headers, payload: 'masa=1' });
    odmowa(r, 404, ...LISTA);
  });
});

describe('podjazdy Allegro', () => {
  let s;
  afterEach(async () => { await s.server.close(); s.db.close(); });
  const NIEDOSTEPNE = ['Konta Allegro są niedostępne.', 'Podjazdy Allegro są niedostępne', '/przesylki', 'Wróć do listy przesyłek'];
  const rzuca = (tekst) => () => { throw new Error(tekst); };
  const zepsute = {
    zlec: async () => { throw new Error('Allegro odrzuciło termin'); },
    pobierzPodglad: rzuca('Nie ma takiego podglądu podjazdu.'),
    sprawdz: async () => { throw new Error('Allegro nie odpowiada'); },
  };

  it('bez kont Allegro: zlecenie, podgląd i sprawdzenie dają stronę OMS z 503', async () => {
    s = serwer({ podjazdy: null });
    odmowa(await s.server.inject({ method: 'POST', url: '/przesylki/podjazdy/zlec', headers, payload: 'podgladId=1' }), 503, ...NIEDOSTEPNE);
    odmowa(await s.server.inject({ method: 'GET', url: '/przesylki/podjazdy/podglad/1', headers: { authorization: headers.authorization } }), 503, ...NIEDOSTEPNE);
    odmowa(await s.server.inject({ method: 'GET', url: '/przesylki/podjazdy/7', headers: { authorization: headers.authorization } }), 503, ...NIEDOSTEPNE);
  });
  it('POST /przesylki/podjazdy/zlec: zlecenie odrzucone i podglądu brak', async () => {
    s = serwer({ podjazdy: zepsute });
    const r = await s.server.inject({ method: 'POST', url: '/przesylki/podjazdy/zlec', headers, payload: 'podgladId=1&termin=null' });
    odmowa(r, 400, 'Nie zamówiono podjazdu: Allegro odrzuciło termin', 'Nie zamówiono podjazdu', '/przesylki', 'Wróć do listy przesyłek');
  });
  it('GET /przesylki/podjazdy/podglad/:id: podglądu nie ma', async () => {
    s = serwer({ podjazdy: zepsute });
    const r = await s.server.inject({ method: 'GET', url: '/przesylki/podjazdy/podglad/abc', headers: { authorization: headers.authorization } });
    odmowa(r, 404, 'Nie ma takiego podglądu podjazdu.', 'Nie ma takiego podglądu podjazdu', '/przesylki', 'Wróć do listy przesyłek');
  });
  it('GET /przesylki/podjazdy/:id: sprawdzenie nieudane', async () => {
    s = serwer({ podjazdy: zepsute });
    const r = await s.server.inject({ method: 'GET', url: '/przesylki/podjazdy/7', headers: { authorization: headers.authorization } });
    odmowa(r, 400, 'Nie można sprawdzić podjazdu: Allegro nie odpowiada', 'Nie można sprawdzić podjazdu', '/przesylki/podjazdy/historia', 'Wróć do historii podjazdów');
  });
});

describe('lista przesyłek', () => {
  let s;
  afterEach(async () => { await s.server.close(); s.db.close(); });

  it('GET /przesylki ze złym filtrem daty', async () => {
    s = serwer();
    const r = await s.server.inject({ method: 'GET', url: '/przesylki?od=2026-13-40&do=2026-01-01', headers: { authorization: headers.authorization } });
    odmowa(r, 400, 'Niepoprawna data: parametry od, do muszą być poprawnymi datami w formacie RRRR-MM-DD.',
      'Zły filtr listy przesyłek', '/przesylki', 'Wróć do listy przesyłek');
  });
  it('POST /przesylki/:id/ukryj i /przywroc: przesyłki nie ma — powrót na ten sam widok listy', async () => {
    s = serwer();
    const r = await s.server.inject({ method: 'POST', url: '/przesylki/99999/ukryj', headers, payload: 'pokaz=wszystkie' });
    odmowa(r, 404, 'Nie ma takiej przesyłki.', 'Nie udało się ukryć przesyłki', '/przesylki?pokaz=wszystkie', 'Wróć do listy przesyłek');
    const p = await s.server.inject({ method: 'POST', url: '/przesylki/99999/przywroc', headers, payload: '' });
    expect(p.statusCode).toBe(404);
    expect(p.body).toContain('<p class="pasek-uwaga" role="alert">Nie ma takiej przesyłki.</p>');
    expect(p.body).toContain('<h1>Nie udało się przywrócić przesyłki</h1>');
  });
});

describe('ustawienia DPD i InPost z pliku konfiguracji (409)', () => {
  const NADAWCA = { DPD_NADAWCA_NAZWA: 'Pracownia Testowa', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950',
    DPD_NADAWCA_MIASTO: 'Warszawa', DPD_NADAWCA_TELEFON: '000000000', DPD_NADAWCA_EMAIL: 'nadawca@example.invalid' };
  function panel(env) {
    const createDpd = vi.fn(() => ({ nadaj: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn() }));
    const createInpost = vi.fn(() => ({ nadaj: vi.fn(), sprawdzPrzesylke: vi.fn(), pobierzEtykiete: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn() }));
    const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
      createModulWysylka({ fabryki: { createDpd, createInpost } }), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
    const p = nowyPanel({ moduly, env: { ...NADAWCA, ...env } });
    zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    return { ...p, admin: jako(p.db, 'adam') };
  }

  it('DPD: strona OMS, powrót na ekran DPD, bez loginu i hasła z pliku', async () => {
    const env = { DPD_URL: 'https://dpd.invalid/ws', DPD_LOGIN: 'LOGIN-Z-PLIKU-7731', DPD_PASSWORD: 'HASLO-Z-PLIKU-9152', DPD_FID: '4455',
      DPD_INFO_URL: 'https://dpd.invalid/info', DPD_INFO_CHANNEL: 'KANAL-Z-PLIKU-3307' };
    const { app, admin } = panel(env);
    const r = await postKonta(app, '/ustawienia/integracje/dpd', admin, { nazwa: 'DPD', login: '1', fid: '2', haslo: 'wpisane-haslo-1', typEtykiety: 'A4', kanal: '' });
    odmowa(r, 409, 'Kurier DPD jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.',
      'Kurier DPD jest ustawiony w pliku konfiguracji', '/ustawienia/integracje/dpd', 'Wróć do ustawień DPD');
    for (const sekret of ['LOGIN-Z-PLIKU-7731', 'HASLO-Z-PLIKU-9152', 'KANAL-Z-PLIKU-3307', 'wpisane-haslo-1']) expect(r.body).not.toContain(sekret);
  });

  it('InPost: strona OMS, powrót na ekran InPost, bez tokenu z pliku', async () => {
    const env = { INPOST_TOKEN: 'eyJ.TOKEN-Z-PLIKU-6620.zmyslony', INPOST_ORGANIZACJA: '1' };
    const { app, admin } = panel(env);
    const r = await postKonta(app, '/ustawienia/integracje/inpost', admin, { nazwa: 'InPost', organizacja: '4242', token: 'eyJ.WPISANY-TOKEN-1.x', paczkomatNadawczy: 'abc01m' });
    odmowa(r, 409, 'Kurier InPost jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.',
      'Kurier InPost jest ustawiony w pliku konfiguracji', '/ustawienia/integracje/inpost', 'Wróć do ustawień InPost');
    for (const sekret of ['TOKEN-Z-PLIKU-6620', 'WPISANY-TOKEN-1']) expect(r.body).not.toContain(sekret);
  });
});
