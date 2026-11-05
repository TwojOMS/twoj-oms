// PRZ-152.G13u1: odmowy ekranów kont i ról w układzie OMS zamiast gołego tekstu.
// To UPRAWNIENIA: status, tekst i kolejność sprawdzeń bez zmian — zmienia się tylko opakowanie.
// Każdy przypadek sprawdza też, że po odmowie baza jest bajt w bajt ta sama. Dane zmyślone.
import { describe, expect, it } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { odciskMacierzy } from '../../../src/moduly/ustawienia/role.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const HASLO_TESTOWE = 'Polcien-Tajne-G13u1';

function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'bartek', imie: 'Bartek', haslo: 'h', rola: 'sprzedaz' });
  return { ...p, admin: jako(p.db, 'ola') };
}

/** Cała zawartość bazy (wszystkie tabele, wiersze po kolei) — do porównania przed i po odmowie. */
function zrzutBazy(db) {
  const tabele = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((t) => t.name);
  return Object.fromEntries(tabele.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()]));
}

function sprawdz(r, { status = 404, tekst, tytul, wroc, napis }) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">${napis}</a>`);
}

const KONTO = { tekst: 'Nie ma takiego konta', tytul: 'Nie znaleziono konta', wroc: '/ustawienia/konta', napis: 'Wróć do kont' };
const ROLA_KONTA = { tekst: 'Nie ma takiej roli', tytul: 'Nie znaleziono roli', wroc: '/ustawienia/konta', napis: 'Wróć do kont' };
const ROLA = { tekst: 'Nie ma takiej roli', tytul: 'Nie znaleziono roli', wroc: '/ustawienia/role', napis: 'Wróć do ról i uprawnień' };

describe('konta: brak konta → 404 w układzie OMS, baza bez zmian', () => {
  const przypadki = [
    ['POST', '/ustawienia/konta/9999/uprawnienia', { ekran: 'zamowienia', admin: '1' }],
    ['POST', '/ustawienia/konta/9999/rola', { rola: 'administrator' }],
    ['POST', '/ustawienia/konta/9999/haslo', { haslo: HASLO_TESTOWE }],
    ['POST', '/ustawienia/konta/9999/czynne', { czynne: '0' }],
    ['GET', '/ustawienia/konta/9999', null],
    ['POST', '/ustawienia/konta/9999/email', { email: 'nikt@pracownia.example.test' }],
    ['POST', '/ustawienia/konta/9999/link', { sposob: 'link' }],
    ['POST', '/ustawienia/konta/abc/czynne', { czynne: '1' }],
  ];
  for (const [metoda, url, dane] of przypadki) {
    it(`${metoda} ${url}`, async () => {
      const { db, app, admin } = panel();
      const przed = zrzutBazy(db);
      const r = metoda === 'GET' ? await get(app, url, admin) : await post(app, url, admin, dane);
      sprawdz(r, KONTO);
      expect(r.body).not.toContain(HASLO_TESTOWE);
      expect(zrzutBazy(db)).toEqual(przed);
    });
  }

  it('POST /ustawienia/konta/:id/rola: znane konto, nieznana rola → 404, rola konta bez zmian', async () => {
    const { db, app, admin } = panel();
    const id = kontoPoLoginie(db, 'bartek').id;
    const przed = zrzutBazy(db);
    const r = await post(app, `/ustawienia/konta/${id}/rola`, admin, { rola: 'nie-ma-takiej' });
    sprawdz(r, ROLA_KONTA);
    expect(zrzutBazy(db)).toEqual(przed);
  });

  it('kolejność bez zmian: konto bez flagi admin dostaje 403 (brak dostępu), nie 404', async () => {
    const { db, app } = panel();
    ustawUprawnienia(db, kontoPoLoginie(db, 'bartek').id, ['ustawienia']);
    const bartek = jako(db, 'bartek');
    const przed = zrzutBazy(db);
    for (const url of ['/ustawienia/konta/9999/rola', '/ustawienia/konta/9999/haslo', '/ustawienia/konta/9999/czynne', '/ustawienia/konta/9999/email', '/ustawienia/konta/9999/link', '/ustawienia/konta/9999/uprawnienia']) {
      const r = await post(app, url, bartek, { rola: 'administrator', haslo: HASLO_TESTOWE, czynne: '1', email: 'ktos@example.test' });
      expect(r.statusCode, url).toBe(403);
      expect(r.body, url).not.toContain('Nie ma takiego konta');
    }
    expect((await get(app, '/ustawienia/konta/9999', bartek)).statusCode).toBe(403);
    expect(zrzutBazy(db)).toEqual(przed);
  });
});

describe('role: nieznana rola → 404 w układzie OMS, baza bez zmian', () => {
  const przypadki = [
    ['/ustawienia/role/nie-ma-takiej/nazwa', () => ({ nazwa: 'Pakowanie' })],
    ['/ustawienia/role/nie-ma-takiej/usun', () => ({})],
    ['/ustawienia/role/nowa', () => ({ nazwa: 'Pakowanie', kopiujZ: 'nie-ma-takiej' })],
    ['/ustawienia/role', (db) => ({ rola: 'nie-ma-takiej', uprawnienie: 'nie-ma-takiej:zamowienia', odcisk: odciskMacierzy(db) })],
  ];
  for (const [url, dane] of przypadki) {
    it(`POST ${url}`, async () => {
      const { db, app, admin } = panel();
      const przed = zrzutBazy(db);
      const r = await post(app, url, admin, dane(db));
      sprawdz(r, ROLA);
      expect(zrzutBazy(db)).toEqual(przed);
    });
  }

  it('kolejność bez zmian: konto bez flagi admin dostaje 403, nie 404', async () => {
    const { db, app } = panel();
    ustawUprawnienia(db, kontoPoLoginie(db, 'bartek').id, ['ustawienia']);
    const bartek = jako(db, 'bartek');
    const przed = zrzutBazy(db);
    const r = await post(app, '/ustawienia/role/nie-ma-takiej/usun', bartek, {});
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('Nie ma takiej roli');
    expect(zrzutBazy(db)).toEqual(przed);
  });
});
