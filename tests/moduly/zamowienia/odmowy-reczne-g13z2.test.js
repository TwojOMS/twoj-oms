// PRZ-152.G13z2 — odmowy ręcznych pozycji/danych zamówienia (reczne.js) i klucza GUS w pliku konfiguracji
// (ustawienia-gus.js): ekran w układzie OMS z komunikatem i drogą powrotu zamiast gołego text/plain.
// Status i tekst bez zmian. Baza :memory:, fetch podmieniony na funkcję rzucającą (żadnej sieci).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, post } from '../../pomoc/konta-prz068.js';
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

const headers = { authorization: `Basic ${Buffer.from('operator:x').toString('base64')}`, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
let db, server;
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sieć wyłączona w teście'); }));
  db = openOmsDb(':memory:');
  server = buildOmsServer({ db, config: {
    auth: { user: 'operator', pass: 'x' }, sklepy: {}, kanaly: {}, definicje: [],
    nadawca: { nazwa: 'Pracownia Półcień', ulica: 'Przykładowa 7', kod: '00-000', miasto: 'Testowo', kraj: 'PL' },
    proforma: { nip: '1234563218' },
  }, poller: { stan: () => ({}) } });
});
afterEach(async () => { await server?.close(); db?.close(); vi.unstubAllGlobals(); });

function ekran(r, status, tekst, wroc, napis, ogolna = false) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toContain('<html');
  expect(r.body).toContain(ogolna ? `<p class="pasek-uwaga" role="alert">${tekst}</p>` : `<p>${tekst}</p>`);
  expect(r.body).toContain(ogolna ? `<a class="btn" href="${wroc}">${napis}</a>` : `<a href="${wroc}">${napis}</a>`);
}

// 404 = zamówienia nie ma, więc powrót to lista zamówień (ekranOdmowyKarty), nie karta.
const TRASY_404 = [
  ['dane/wysylka (251)', 'POST', '/zamowienia/999/dane/wysylka'],
  ['dane/faktura (251)', 'POST', '/zamowienia/999/dane/faktura'],
  ['dane/przywroc (251)', 'POST', '/zamowienia/999/dane/przywroc'],
  ['pozycje/zapisz (252)', 'POST', '/zamowienia/999/pozycje/zapisz'],
  ['pozycje/z-magazynu (255)', 'POST', '/zamowienia/999/pozycje/z-magazynu'],
  ['pozycje (256)', 'POST', '/zamowienia/999/pozycje'],
  ['wysylka/kwota/przywroc (258)', 'POST', '/zamowienia/999/wysylka/kwota/przywroc'],
];
for (const [nazwa, method, url] of TRASY_404) {
  it(`${nazwa}: brak zamówienia — 404 w układzie OMS z powrotem na listę`, async () => {
    const r = await server.inject({ method, url, headers, payload: '' });
    ekran(r, 404, 'Nie ma takiego zamówienia', '/', 'Wróć do listy zamówień');
  });
}

it('GET magazyn/wyniki (254) zostaje gołym tekstem — htmx, fragment bez układu', async () => {
  const r = await server.inject({ url: '/zamowienia/999/magazyn/wyniki', headers });
  expect(r.statusCode).toBe(404);
  expect(r.body).toBe('Nie ma takiego zamówienia');
});

it('klucz GUS w pliku konfiguracji (263): 409 w układzie OMS z powrotem na ekran GUS', async () => {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  const p = nowyPanel({ moduly, env: { GUS_KLUCZ: 'zmyslony0plik0gus0c3' } });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'adam').id, ['ustawienia']);
  const r = await post(p.app, '/ustawienia/integracje/gus', jako(p.db, 'adam'), { klucz: 'zmyslony0drugi0gus0b2' });
  ekran(r, 409, 'Klucz GUS jest ustawiony w pliku konfiguracji (oms.env, GUS_KLUCZ) — tam go zmień. Formularz niczego nie zapisał.',
    '/ustawienia/integracje/gus', 'Wróć', true);
  expect(r.body).not.toContain('zmyslony0drugi0gus0b2');
});
