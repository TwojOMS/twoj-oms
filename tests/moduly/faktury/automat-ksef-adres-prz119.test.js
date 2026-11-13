// PRZ-119.07 — automat KSeF pod adresem programu fakturowego i stan Fakturowni na ekranie „Moduł faktur”.
// Prawdziwy serwer (buildOmsServer) z prawdziwym modułem faktur; globalny fetch podmieniony — nic nie wychodzi do sieci.
// Dane zmyślone („Pracownia Półcień”); tokeny to zmyślone ciągi.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszKonfiguracjeIntegracji, usunKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { wczytajAutomatKsef } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';

const STARY = '/ustawienia/integracje/infakt/ksef-automat';
const NOWY = '/ustawienia/integracje/program-fakturowy/ksef-automat';
const MODUL_FAKTUR = '/ustawienia/integracje/program-fakturowy';
const AUTOMATY = '/ustawienia/automatyzacje/systemowe';
const TOKEN = 'zmyslony0token0polcien0prz119';
const ZAPIS_FAKTUROWNI = { ustawienia: { domena: 'pracownia-polcien' }, sekrety: { token: TOKEN } };

let siec;
beforeEach(() => {
  siec = vi.fn(async () => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

function panel(env = {}, przedStartem = () => {}) {
  const db = openOmsDb(':memory:');
  przedStartem(db);
  const p = nowyPanel({ db, env });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'faktury', 'ustawienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const karta = (html, id) => [...html.matchAll(/<p[^>]*><label><input type="radio"[\s\S]*?<\/label><\/p>/gu)]
  .map((m) => m[0]).find((s) => s.includes(`value="${id}"`)) ?? '';
const bezczynny = (html) => /<p class="pas-uprzedzenie" id="ksef-automat-bezczynny">([^<]*)<\/p>/u.exec(html)?.[1] ?? null;

describe('PRZ-119.07 adres automatu KSeF', () => {
  it('GET starego adresu → 301 na nowy adres pod programem fakturowym', async () => {
    const { app, admin } = panel();
    try {
      const r = await get(app, STARY, admin);
      expect(r.statusCode).toBe(301);
      expect(r.headers.location).toBe(NOWY);
    } finally { await app.close(); }
  });

  it('GET nowego adresu → 200, ekran z sekcją automatu KSeF (tylko admin)', async () => {
    const { app, admin, ewa } = panel();
    try {
      const r = await get(app, NOWY, admin);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('id="ksef-automat"');
      expect((await get(app, NOWY, ewa)).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('POST nowego adresu zapisuje jak dotąd (303 na ekran automatów), błąd formularza → 400', async () => {
    const { app, db, admin } = panel();
    try {
      const r = await post(app, NOWY, admin, { wlaczony: ['0', '1'], godzina: '21:15' });
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe(`${AUTOMATY}?zapisano=ksef-automat#ksef-automat`);
      expect(wczytajAutomatKsef(db)).toMatchObject({ wlaczony: true, godzina: '21:15' });
      const zly = await post(app, NOWY, admin, { wlaczony: '1', godzina: '25:00' });
      expect(zly.statusCode).toBe(400);
      expect(zly.body).toContain('Nie zapisano');
    } finally { await app.close(); }
  });

  it('POST starego adresu dalej zapisuje (zakładki sprzed zmiany)', async () => {
    const { app, db, admin } = panel();
    try {
      const r = await post(app, STARY, admin, { wlaczony: ['0', '1'], godzina: '19:30' });
      expect(r.statusCode).toBe(303);
      expect(wczytajAutomatKsef(db)).toMatchObject({ wlaczony: true, godzina: '19:30' });
    } finally { await app.close(); }
  });
});

describe('PRZ-119.07 „Moduł faktur”: stan Fakturowni jednym zdaniem', () => {
  it.each([
    ['w pliku', { FAKTUROWNIA_API_TOKEN: TOKEN, FAKTUROWNIA_DOMENA: 'pracownia-polcien' }, () => {}, 'Token API Fakturowni: w pliku konfiguracji.'],
    ['zapisany', {}, (db) => zapiszKonfiguracjeIntegracji(db, 'fakturownia', ZAPIS_FAKTUROWNI), 'Token API Fakturowni: zapisany w Ustawieniach.'],
    ['brak', {}, () => {}, 'Token API Fakturowni: jeszcze nie podany.'],
  ])('%s', async (_n, env, przed, zdanie) => {
    const { app, admin } = panel(env, przed);
    try {
      const r = await get(app, MODUL_FAKTUR, admin);
      expect(r.statusCode).toBe(200);
      const k = karta(r.body, 'fakturownia');
      expect(k).toContain(zdanie);
      expect(k).toContain('<a href="/ustawienia/integracje/fakturownia">Ustawienia Fakturowni</a>');
      expect(k).not.toContain('wkrótce');
      expect(r.body).not.toContain(TOKEN);
    } finally { await app.close(); }
  });
});

describe('PRZ-119.07 automat przy wybranej Fakturowni czyta jej konfigurację (konfiguracjaProgramu)', () => {
  it('Fakturownia wybrana, bez domeny i tokenu → zdanie o Fakturowni, nie o inFakcie', async () => {
    const { app, admin } = panel({ OMS_PROGRAM_FAKTUROWY: 'fakturownia' });
    try {
      const zdanie = bezczynny((await get(app, AUTOMATY, admin)).body);
      expect(zdanie).toBe('Fakturownia nie jest podłączona — automat nic nie wyśle, dopóki jej nie podłączysz (potem potrzebne ponowne uruchomienie OMS-u).');
    } finally { await app.close(); }
  });

  it('Fakturownia z Ustawień przy starcie, potem odłączona → automat mówi o odłączeniu Fakturowni', async () => {
    const { app, db, admin } = panel({ OMS_PROGRAM_FAKTUROWY: 'fakturownia' },
      (baza) => zapiszKonfiguracjeIntegracji(baza, 'fakturownia', ZAPIS_FAKTUROWNI));
    try {
      expect(bezczynny((await get(app, AUTOMATY, admin)).body)).toBeNull();
      usunKonfiguracjeIntegracji(db, 'fakturownia');
      expect(bezczynny((await get(app, NOWY, admin)).body))
        .toBe('Fakturownia jest odłączona — automat nic nie wyśle, dopóki jej nie podłączysz i nie uruchomisz OMS-u ponownie.');
    } finally { await app.close(); }
  });

  it('Fakturownia wybrana, domena i token zapisane po starcie → automat czeka na restart', async () => {
    const { app, db, admin } = panel({ OMS_PROGRAM_FAKTUROWY: 'fakturownia' });
    try {
      zapiszKonfiguracjeIntegracji(db, 'fakturownia', ZAPIS_FAKTUROWNI);
      expect(bezczynny((await get(app, AUTOMATY, admin)).body))
        .toBe('Fakturownia jest już podłączona, ale automat ruszy dopiero po ponownym uruchomieniu OMS-u.');
    } finally { await app.close(); }
  });
});

// PRZ-119.07 (poprawka): ekran i automat czytają ten sam stan — program odłączony po starcie zatrzymuje automat,
// także gdy wybrana jest Fakturownia (wcześniej automat patrzył tylko na inFakt i dalej wysyłał klientem z pamięci).
describe('PRZ-119.07 automat KSeF a odłączenie wybranego programu', () => {
  async function aplikacja(zapis, env = {}) {
    const katalog = mkdtempSync(join(tmpdir(), 'automat-odlaczenie-prz119-'));
    const sciezka = join(katalog, 'oms.db');
    const przed = openOmsDb(sciezka);
    zapis(przed);
    przed.close();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Sieć zabroniona'); }));
    const a = await zbudujOms({ env: { OMS_DB_PATH: sciezka, OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog,
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'operator', OMS_PASS: 'fixture',
      ...env }, teraz: () => new Date('2026-10-27T10:00:00Z') });
    return { a, sprzataj: async () => { await a.app.close(); a.db.close(); rmSync(katalog, { recursive: true, force: true }); } };
  }

  it('Fakturownia z Ustawień przy starcie, potem odłączona → przebieg automatu pominięty z powodem o odłączeniu', async () => {
    const { a, sprzataj } = await aplikacja((db) => zapiszKonfiguracjeIntegracji(db, 'fakturownia', ZAPIS_FAKTUROWNI),
      { OMS_PROGRAM_FAKTUROWY: 'fakturownia' });
    try {
      const automat = a.usluga('faktury', 'automatKsef');
      expect(automat, 'automat powstał przy starcie').not.toBeNull();
      usunKonfiguracjeIntegracji(a.db, 'fakturownia');
      const w = await automat.przebieg();
      expect(w).toMatchObject({ pominiety: true });
      expect(w.powod).toContain('odłączon');
    } finally { await sprzataj(); }
  });

  it('kontrola: inFakt z Ustawień przy starcie, potem odłączony → dalej pominięty', async () => {
    const { a, sprzataj } = await aplikacja((db) => zapiszKonfiguracjeIntegracji(db, 'infakt',
      { ustawienia: {}, sekrety: { apiKey: 'zmyslony-klucz-polcien-prz119-0000000001' } }));
    try {
      const automat = a.usluga('faktury', 'automatKsef');
      expect(automat, 'automat powstał przy starcie').not.toBeNull();
      usunKonfiguracjeIntegracji(a.db, 'infakt');
      const w = await automat.przebieg();
      expect(w).toMatchObject({ pominiety: true });
      expect(w.powod).toContain('odłączon');
    } finally { await sprzataj(); }
  });
});
