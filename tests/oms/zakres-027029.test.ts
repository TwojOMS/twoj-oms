import { describe, it, expect, vi, beforeAll, afterAll, type MockInstance } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { rozdajNoweUprawnienia } from '../../src/core/uprawnienia.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';
import { modulRaporty } from '../../src/moduly/raporty/modul.ts';
import { modulWiadomosci } from '../../src/moduly/wiadomosci/modul.ts';
import { zalozKonto, uprawnieniaKonta } from '../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../src/domena/ekrany.js';
import { nawigacjaDla } from '../../src/domena/menu-stron.js';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';

// PRZ-027F/028C/028K przywracają Finanse, Cele i Kampanię. Bez skonfigurowanych
// klientów API zegar reklam jest zdefiniowany produkcyjnie, lecz test nie startuje timerów.
// Domyślny web config ma pustą listę odłożonych ekranów.
// Druga część: rzeczywiste role kont (administrator/sprzedaz/produkcja) dostają nowe prawa
// raportów i wiadomości przez prawdziwe rozdajNoweUprawnienia.

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture',
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  SMTP_HOST: 'smtp.fikcja.test', SMTP_USER: 'nadawca@fikcja.test', SMTP_PASS: 'fikcyjne' };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const ODLOZONE: string[] = [];
const HISTORYCZNIE_ODLOZONE = ['kampania', 'cele', 'finanse'];
const ODNOSNIK_ODLOZONY = /href=["']\/(kampania|cele|finanse)(?=["'?#/])/g;
// Rama renderuje menu w wariancie desktopowym i mobilnym — liczymy unikalne adresy.
const odnosnikiOdlozone = (html: string) => [...new Set([...html.matchAll(ODNOSNIK_ODLOZONY)].map(m => m[1]))];
const maOdnosnik = (html: string, adres: string) => new RegExp(`href=["']${adres}["']`).test(html);
const hrefyNawigacji = (n: ReturnType<typeof nawigacjaDla>) =>
  [...n.dzialy.map(d => d.href), ...(n.kontekst?.grupy ?? []).flatMap(g => g.pozycje.map(p => p.href))];

type Oms = Awaited<ReturnType<typeof zbudujOms>>;
let transport: MockInstance<typeof fetch>;
beforeAll(() => { transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona')); });
afterAll(() => { expect(transport).not.toHaveBeenCalled(); transport.mockRestore(); });

describe('PRZ-027/029 zakres — domyślny bootstrap bez odłożonych ekranów', () => {
  let a: Oms | undefined;
  beforeAll(async () => { a = await zbudujOms({ env }); });
  afterAll(async () => { try { if (a) await a.app.close(); } finally { a?.db.close(); } });

  for (const url of ['/raporty', '/statystyki']) {
    it(`GET ${url} — 200, menu z Raporty/Statystyki/Koszty, bez odnośników do odłożonych ekranów`, async () => {
      const odp = await a!.app.inject({ method: 'GET', url, headers });
      expect({ status: odp.statusCode, raporty: maOdnosnik(odp.body, '/raporty'),
        statystyki: maOdnosnik(odp.body, '/statystyki'), koszty: maOdnosnik(odp.body, '/koszty'), finanse: maOdnosnik(odp.body, '/finanse'),
        kampania: maOdnosnik(odp.body, '/kampania') })
        .toEqual({ status: 200, raporty: true, statystyki: true, koszty: true, finanse: true, kampania: true });
    });
  }

  it('Kampania wróciła w PRZ-028K; Finanse odmawiają bez podłogi kosztów', async () => {
    const wynik: Record<string, unknown> = {};
    for (const k of ['kampania']) {
      const odp = await a!.app.inject({ method: 'GET', url: `/${k}`, headers });
      wynik[k] = { status: odp.statusCode, trasa: a!.app.hasRoute({ method: 'GET', url: `/${k}` }) };
    }
    expect(wynik).toEqual({ kampania: { status: 200, trasa: true } });
    expect({ status: (await a!.app.inject({ method: 'GET', url: '/finanse', headers })).statusCode,
      trasa: a!.app.hasRoute({ method: 'GET', url: '/finanse' }) }).toEqual({ status: 400, trasa: true });
  });

  it('marketing zachowuje config, menu Kampanii i produkcyjną definicję zegara reklam', () => {
    expect({
      zegary: a!.zegary.map(z => z.nazwa).filter(n => /kampani|marketing|reklam|meta|ga4|cel/i.test(n)),
      menu: a!.menu.filter(p => p.adres === '/kampania').map(p => p.adres),
      usluga: (() => { try { a!.usluga('marketing', 'config'); return 'jest'; } catch { return 'brak'; } })(),
    }).toEqual({ zegary: ['czuwaczReklam'], menu: ['/kampania'], usluga: 'jest' });
  });

  it('web config domyślnie ma odlozoneEkrany = [], a zapis czyta bez restartu', () => {
    const config = a!.usluga<any>('web', 'config');
    expect(config.odlozoneEkrany).toEqual(ODLOZONE);
    try {
      a!.db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('moduly.wylaczone', ?, '2026-10-20')").run('["klienci"]');
      expect(config.odlozoneEkrany).toEqual(['klienci']);
    } finally {
      a!.db.prepare("DELETE FROM ustawienia WHERE klucz = 'moduly.wylaczone'").run();
    }
  });
});

describe('PRZ-027/029 zakres — nawigacjaDla z listą i bez listy odłożonych', () => {
  it('z odlozoneEkrany w sekcji Analiz zostają Raporty, Statystyki, Koszty', () => {
    const hrefy = hrefyNawigacji(nawigacjaDla({ sciezka: '/raporty', konto: null, odlozoneEkrany: ODLOZONE } as any));
    expect({ odlozone: hrefy.filter(h => ODLOZONE.some(k => h === `/${k}`)),
      zostaja: ['/raporty', '/statystyki', '/koszty'].every(h => hrefy.includes(h)) })
      .toEqual({ odlozone: [], zostaja: true });
  });

  it('kontrola: bez listy nawigacja zachowuje frozen pełne menu (zielona przed i po)', () => {
    const hrefy = hrefyNawigacji(nawigacjaDla({ sciezka: '/raporty', konto: null }));
    expect(HISTORYCZNIE_ODLOZONE.map(k => hrefy.includes(`/${k}`))).toEqual([true, true, true]);
  });

  it('kontrola: historyczny helper z jawnym web config bez listy renderuje pełne menu', async () => {
    const db = openOmsDb();
    const s = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } } });
    try {
      const odp = await s.inject({ method: 'GET', url: '/raporty', headers });
      expect({ status: odp.statusCode, odlozone: odnosnikiOdlozone(odp.body).toSorted() })
        .toEqual({ status: 200, odlozone: ['cele', 'finanse', 'kampania'] });
    } finally { try { await s.close(); } finally { db.close(); } }
  });
});

// ---------------------------------------------------------------------------------------------
const NOWE = ['raporty', 'statystyki', 'wiadomosci', 'klienci'];
const MODULY = [modulRaporty, modulWiadomosci] as ModulOms[];
const teraz = () => new Date('2026-10-01T08:00:00.000Z');

describe('PRZ-027/029 dystrybucja praw raporty/statystyki/wiadomosci/klienci rzeczywistym rolom', () => {
  it('administrator i sprzedaż dostają 4 prawa, produkcja 0; odebrane prawa zostają odebrane', () => {
    const db = openOmsDb(':memory:');
    try {
      const admin = zalozKonto(db, { login: 'adm', imie: 'adm', haslo: 'x', rola: 'administrator', admin: true });
      const sprzedaz = zalozKonto(db, { login: 'spr', imie: 'spr', haslo: 'x', rola: 'sprzedaz', admin: false });
      const produkcja = zalozKonto(db, { login: 'pro', imie: 'pro', haslo: 'x', rola: 'produkcja', admin: false });
      // Stan „sprzed modułów”: tylko te cztery prawa i ich znaczniki D5 znikają.
      const lista = NOWE.map(() => '?').join(',');
      db.prepare(`DELETE FROM uprawnienia WHERE ekran IN (${lista})`).run(...NOWE);
      db.prepare(`DELETE FROM uprawnienia_rozdane WHERE klucz IN (${lista})`).run(...NOWE);
      // Świadome decyzje operatora poza tymi czterema kluczami.
      db.prepare("DELETE FROM uprawnienia WHERE konto_id = ? AND ekran = 'koszty'").run(admin);
      db.prepare("DELETE FROM uprawnienia WHERE konto_id = ? AND ekran = 'kampania'").run(sprzedaz);

      const rozdane = rozdajNoweUprawnienia(db, MODULY, teraz);
      const nowe = (id: number) => NOWE.filter(k => uprawnieniaKonta(db, id).has(k));
      expect({ rozdane: rozdane.toSorted(), admin: nowe(admin), sprzedaz: nowe(sprzedaz), produkcja: nowe(produkcja) })
        .toEqual({ rozdane: NOWE.toSorted(), admin: NOWE, sprzedaz: NOWE, produkcja: [] });
      expect({
        admin: [...uprawnieniaKonta(db, admin)].toSorted(),
        sprzedaz: [...uprawnieniaKonta(db, sprzedaz)].toSorted(),
        produkcja: [...uprawnieniaKonta(db, produkcja)].toSorted(),
      }).toEqual({
        admin: ekranyRoli('administrator').filter(k => k !== 'koszty').toSorted(),
        sprzedaz: ekranyRoli('sprzedaz').filter(k => k !== 'kampania').toSorted(),
        produkcja: ekranyRoli('produkcja').toSorted(),
      });
    } finally { db.close(); }
  });

  it('powtórzenie rozdania nie przywraca prawa odebranego po pierwszym rozdaniu', () => {
    const db = openOmsDb(':memory:');
    try {
      const sprzedaz = zalozKonto(db, { login: 'spr', imie: 'spr', haslo: 'x', rola: 'sprzedaz', admin: false });
      const lista = NOWE.map(() => '?').join(',');
      db.prepare(`DELETE FROM uprawnienia WHERE ekran IN (${lista})`).run(...NOWE);
      db.prepare(`DELETE FROM uprawnienia_rozdane WHERE klucz IN (${lista})`).run(...NOWE);
      rozdajNoweUprawnienia(db, MODULY, teraz);
      const poPierwszym = NOWE.filter(k => uprawnieniaKonta(db, sprzedaz).has(k));
      db.prepare("DELETE FROM uprawnienia WHERE konto_id = ? AND ekran = 'raporty'").run(sprzedaz);
      const drugie = rozdajNoweUprawnienia(db, MODULY, teraz);
      expect({ poPierwszym, drugie, poDrugim: NOWE.filter(k => uprawnieniaKonta(db, sprzedaz).has(k)) })
        .toEqual({ poPierwszym: NOWE, drugie: [], poDrugim: NOWE.filter(k => k !== 'raporty') });
    } finally { db.close(); }
  });
});
