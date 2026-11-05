// PRZ-152.G13k1: odmowy modułu koszty (trasy wołane linkiem albo formularzem) w układzie OMS — status i tekst
// bez zmian, zmienia się tylko opakowanie (strona z paskiem uwagi i drogą powrotu zamiast gołego text/plain).
// Bez sieci: KSeF to atrapy albo null, globalny fetch odmawia. Tokeny i NIP-y zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { przypnijKategorie } from '../../../src/oms/db/kategorie-kosztow.js';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };
const AUTH_POST = { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' };
// Ta sama ucieczka co `<%= %>` w EJS — tekst odmowy porównujemy znak w znak po ucieczce.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;');

let siec;
beforeEach(() => {
  siec = vi.fn(async () => { throw new Error('Sieć zabroniona w teście odmów kosztów'); });
  vi.stubGlobal('fetch', siec);
});
const zamkniete = [];
afterEach(async () => {
  for (const z of zamkniete.splice(0)) await z();
  vi.unstubAllGlobals();
  expect(siec).not.toHaveBeenCalled();
});

function serwer(opcje = {}) {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({
    db, config: { auth: { user: 't', pass: 'h' } }, czuwaczKosztow: { przebieg: async () => ({ nowych: 0 }) }, ...opcje,
  });
  zamkniete.push(async () => { await app.close(); db.close(); });
  return { app, db };
}

function stronaOdmowy(r, { status, tekst, tytul, wroc, napisWroc }) {
  expect(r.statusCode, r.body).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${esc(tekst)}</p>`);
  expect(r.body).toContain(`<h1>${esc(tytul)}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${esc(wroc)}">${esc(napisWroc)}</a>`);
}

const LISTA = { wroc: '/koszty', napisWroc: 'Wróć do kosztów' };
const ZLY_MIESIAC = (m) => `„${m}" to nie jest miesiąc w formacie RRRR-MM.`;

describe('PRZ-152.G13k1 odmowy kosztów w układzie OMS', () => {
  it('GET /koszty ze złym miesiącem (400)', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-6', headers: AUTH });
    stronaOdmowy(r, { status: 400, tekst: `Nie da się pokazać kosztów: ${ZLY_MIESIAC('2026-6')}`, tytul: 'Nie da się pokazać kosztów', ...LISTA });
  });

  it('GET /koszty/zestawienie: miesiąc nie w formacie (400) i odmowa zestawienia (400)', async () => {
    const { app } = serwer();
    const zly = await app.inject({ method: 'GET', url: '/koszty/zestawienie?miesiac=abc', headers: AUTH });
    stronaOdmowy(zly, { status: 400, tekst: ZLY_MIESIAC('abc'), tytul: 'Nie da się przygotować zestawienia', ...LISTA });
    const odmowa = await app.inject({ method: 'GET', url: '/koszty/zestawienie?miesiac=2026-13', headers: AUTH });
    stronaOdmowy(odmowa, { status: 400, tekst: ZLY_MIESIAC('2026-13'), tytul: 'Nie da się przygotować zestawienia', ...LISTA });
  });

  it('GET /koszty/:ksefNumber/pdf: bez KSeF (503) i odmowa przy pobraniu (400); PDF dalej binarny', async () => {
    const bez = serwer({ czuwaczKosztow: null, wizualizacjaKosztu: null });
    stronaOdmowy(await bez.app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH }), {
      status: 503, tekst: 'Panel nie ma podpiętego KSeF — nie ma skąd pobrać dokumentu.', tytul: 'Nie da się pobrać dokumentu', ...LISTA,
    });
    const powod = serwer({ wizualizacjaKosztu: { dostepny: () => false, powodNiedostepnosci: () => 'Brak NIP-u firmy — uzupełnij go w Ustawieniach.' } });
    stronaOdmowy(await powod.app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH }), {
      status: 503, tekst: 'Brak NIP-u firmy — uzupełnij go w Ustawieniach.', tytul: 'Nie da się pobrać dokumentu', ...LISTA,
    });
    const blad = serwer({ wizualizacjaKosztu: { pdf: async () => { throw Object.assign(new Error('KSeF nieosiągalny przy pobieraniu dokumentu K-1'), { dlaOperatora: true }); } } });
    stronaOdmowy(await blad.app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH }), {
      status: 400, tekst: 'Nie udało się przygotować dokumentu: KSeF nieosiągalny przy pobieraniu dokumentu K-1', tytul: 'Nie da się pobrać dokumentu', ...LISTA,
    });
    const ok = serwer({ wizualizacjaKosztu: { pdf: async () => ({ wiersz: { numer_dokumentu: 'FV/1' }, bajty: Buffer.from('%PDF-1.3 x') }) } });
    const pdf = await ok.app.inject({ method: 'GET', url: '/koszty/K-1/pdf', headers: AUTH });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.toString()).toBe('%PDF-1.3 x');
  });

  it('POST /koszty/kategoria: niepełne dane (400) i NIP bez cyfr (400) wracają na miesiąc z formularza', async () => {
    const { app, db } = serwer();
    const powrot = { wroc: '/koszty?miesiac=2026-06', napisWroc: 'Wróć do kosztów' };
    const brak = await app.inject({ method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST, payload: 'nip=9999999999&kategoria=X&typ=wymyslony&miesiac=2026-06' });
    stronaOdmowy(brak, {
      status: 400, tytul: 'Nie udało się przypiąć kategorii', ...powrot,
      tekst: 'Niepoprawne dane kategorii: potrzebny jest NIP sprzedawcy albo dokument, do którego kategoria ma się przypiąć, nazwa kategorii i typ z listy: zmienny, staly, drobne.',
    });
    let oczekiwany = null;
    try { przypnijKategorie(db, 'abc', 'Opakowania', 'zmienny'); } catch (e) { oczekiwany = e.message; }
    expect(oczekiwany).toBeTruthy();
    const nip = await app.inject({ method: 'POST', url: '/koszty/kategoria', headers: AUTH_POST, payload: 'nip=abc&kategoria=Opakowania&typ=zmienny&miesiac=2026-06' });
    stronaOdmowy(nip, { status: 400, tekst: oczekiwany, tytul: 'Nie udało się przypiąć kategorii', ...powrot });
  });

  it('POST /koszty/odswiez: bez KSeF (503) na miesiąc z formularza; zły miesiąc ekranu (400) na listę', async () => {
    const bez = serwer({ czuwaczKosztow: null });
    stronaOdmowy(await bez.app.inject({ method: 'POST', url: '/koszty/odswiez', headers: AUTH_POST, payload: 'miesiac=2026-06' }), {
      status: 503, tekst: 'Panel nie ma podpiętego KSeF — nie ma skąd pobrać kosztów.', tytul: 'Nie da się pobrać kosztów z KSeF',
      wroc: '/koszty?miesiac=2026-06', napisWroc: 'Wróć do kosztów',
    });
    const { app } = serwer();
    stronaOdmowy(await app.inject({ method: 'POST', url: '/koszty/odswiez', headers: AUTH_POST, payload: 'miesiac=2026-13' }), {
      status: 400, tekst: `Nie da się pokazać kosztów: ${ZLY_MIESIAC('2026-13')}`, tytul: 'Nie da się pokazać kosztów', ...LISTA,
    });
  });

  it('GET /koszty/reczne/:klucz nieznany (404)', async () => {
    const { app } = serwer();
    stronaOdmowy(await app.inject({ method: 'GET', url: '/koszty/reczne/NIE-MA', headers: AUTH }), {
      status: 404, tytul: 'Nie ma takiego kosztu', ...LISTA,
      tekst: 'Panel nie zna kosztu wpisanego ręcznie o takim numerze. Dokumentu pobranego z KSeF nie da się tu poprawić — panel jest lustrem KSeF-u.',
    });
  });

  it('POST Ustawienia → KSeF przy tokenie w pliku (409): strona odmowy bez tokenu, powrót do ustawień KSeF', async () => {
    const TOKEN_PLIKU = '20261020-EC-ZMYSLONYPLIK|nip-1234563218|cccccccccccccccc';
    const TOKEN_FORMULARZA = '20261020-EC-ZMYSLONY0002|nip-1234563218|bbbbbbbbbbbbbbbb';
    const fabryka = vi.fn(({ token, nip }) => ({
      token, nip,
      zaloguj: vi.fn(async () => ({ accessToken: 'a', accessDo: '2027-01-01T00:00:00Z', refreshToken: 'r', refreshDo: '2027-02-01T00:00:00Z' })),
      odswiez: vi.fn(async () => ({ accessToken: 'a', accessDo: '2027-01-01T00:00:00Z' })),
      pobierzMetadane: vi.fn(async () => ({ faktury: [], hasMore: false, isTruncated: false })),
      pobierzXml: vi.fn(async () => '<Faktura/>'),
    }));
    const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(), KSEF_TOKEN: TOKEN_PLIKU };
    const moduly = modulyDla(env).map((m) => (m.nazwa === 'koszty' ? createModulKoszty({ createKlient: fabryka }) : m));
    const z = await zbudujOms({ env, moduly, teraz: () => new Date('2026-10-20T10:00:00Z'), log: () => {} });
    zamkniete.push(async () => { await z.app.close(); z.db.close(); });
    zalozKonto(z.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const r = await z.app.inject({
      method: 'POST', url: '/ustawienia/integracje/ksef', payload: { token: TOKEN_FORMULARZA },
      headers: { accept: 'text/html', ...jako(z.db, 'adam'), origin: 'http://localhost' },
    });
    stronaOdmowy(r, {
      status: 409, tytul: 'Token KSeF jest w pliku konfiguracji', wroc: '/ustawienia/integracje/ksef', napisWroc: 'Wróć do ustawień KSeF',
      tekst: 'Token KSeF jest ustawiony w pliku konfiguracji (oms.env, KSEF_TOKEN) — tam go zmień. Formularz niczego nie zapisał.',
    });
    for (const t of [TOKEN_PLIKU, TOKEN_FORMULARZA]) expect(r.body.includes(t)).toBe(false);
  });
});
