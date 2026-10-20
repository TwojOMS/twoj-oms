// PRZ-102.22 — „Koszty” jako moduł do wyłączenia w Ustawienia → Moduły (wzór: PRZ-102.02 Stali klienci i Rozliczenia).
// Wyłączony moduł: znika z „Analizy i finanse ▾”, /koszty… = 404 „Moduł wyłączony”, czuwacz kosztów nie woła KSeF
// (sprawdzane przy każdym tyknięciu), /health mówi „koszty wyłączone” zamiast alarmu, Finanse liczą dalej koszty już
// zapisane w bazie i mówią o tym paskiem, paczka kosztów dla biura odmawia zdaniem (bez 500), paczka sprzedaży działa.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { createModulKoszty } from '../../../src/moduly/koszty/modul.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszKoszt } from '../../../src/oms/db/koszty.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { ustawGranice, zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';
import { zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';

const NIP = '1234563218';
const PASEK = 'Moduł Koszty jest wyłączony — rachunek pokazuje sprzedaż bez kosztów';
const PACZKA = 'Moduł Koszty jest wyłączony — paczka kosztów niedostępna';
const wylacz = (db, lista) => db.prepare("INSERT OR REPLACE INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('moduly.wylaczone', ?, '2026-10-20')")
  .run(JSON.stringify(lista));
const dzienTemu = (dni) => new Date(Date.now() - dni * 86400000).toISOString().slice(0, 10);
const koszt = (db, numer, dzien, netto = '100.00') => zapiszKoszt(db, {
  ksefNumber: numer, numerDokumentu: numer, sprzedawcaNip: '1111111111', sprzedawcaNazwa: 'Hurtownia Przykładowa',
  dataWystawienia: dzien, dataTrwalegoZapisu: `${dzien}T12:00:00Z`,
  netto, vat: '0.00', brutto: netto, waluta: 'PLN', rodzaj: 'VAT', maZalacznik: 0,
});

let siec;
beforeEach(() => {
  siec = vi.fn(async () => { throw new Error('Sieć zabroniona'); });
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

const panele = [];
afterEach(async () => { for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); } });
function panel(o = {}) {
  const p = nowyPanel(o);
  panele.push(p);
  zalozKonto(p.db, { login: 'admin', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, admin: jako(p.db, 'admin') };
}

describe('PRZ-102.22 moduł Koszty do wyłączenia', () => {
  it('Moduły mają przełącznik Koszty; wyłączenie: brak w menu analiz, /koszty… 404 „Moduł wyłączony”; włączenie przywraca bez restartu', async () => {
    const p = panel();
    const ekran = await get(p.app, '/ustawienia/moduly', p.admin);
    expect(ekran.body).toContain('Wyłącz Koszty');
    expect((await get(p.app, '/', p.admin)).body).toContain('href="/koszty"');
    const r = await post(p.app, '/ustawienia/moduly', p.admin, { modul: 'koszty', wlacz: '0' });
    expect(r.statusCode, r.body).toBe(303);
    expect((await get(p.app, '/', p.admin)).body).not.toContain('href="/koszty"');
    for (const adres of ['/koszty', '/koszty?miesiac=2026-10', '/koszty/zestawienie?miesiac=2026-10']) {
      const o = await get(p.app, adres, p.admin);
      expect(o.statusCode, adres).toBe(404);
      expect(o.body, adres).toContain('Moduł wyłączony');
    }
    expect((await post(p.app, '/koszty/odswiez', p.admin, { miesiac: '2026-10' })).statusCode).toBe(404);
    expect((await post(p.app, '/ustawienia/moduly', p.admin, { modul: 'koszty', wlacz: '1' })).statusCode).toBe(303);
    expect((await get(p.app, '/koszty', p.admin)).statusCode).toBe(200);
    expect((await get(p.app, '/', p.admin)).body).toContain('href="/koszty"');
  });

  it('bezpiecznik nie blokuje wyłączenia, ale podaje liczbę kosztów z ostatnich 60 dni', async () => {
    const p = panel();
    koszt(p.db, 'K-1', dzienTemu(3));
    koszt(p.db, 'K-2', dzienTemu(40));
    koszt(p.db, 'K-STARY', dzienTemu(90));
    // Klient rozliczany zbiorczo blokuje wyłączenie Rozliczeń i Stałych klientów — Kosztów nie.
    p.db.prepare("INSERT INTO klienci (klucz,nazwa,nip,rozliczenie_zbiorcze,rabat_procent,utworzone_at,zmienione_at) VALUES ('przyklad','Pracownia Przykładowa','1111111111',1,0,'2026-10-01','2026-10-01')").run();
    const ekran = await get(p.app, '/ustawienia/moduly', p.admin);
    expect(ekran.body).toContain('2 kosztów w bazie — zostaną, Finanse dalej je liczą; nowych panel nie pobierze');
    const sekcja = /<section class="ust-sekcja">\s*<h2>Koszty<\/h2>[\s\S]*?<\/section>/u.exec(ekran.body)?.[0] ?? '';
    expect(sekcja).toContain('Wyłącz Koszty');
    expect(sekcja).not.toContain('wyłączenie zablokowane');
    expect((await post(p.app, '/ustawienia/moduly', p.admin, { modul: 'koszty', wlacz: '0' })).statusCode).toBe(303);
    expect((await post(p.app, '/ustawienia/moduly', p.admin, { modul: 'okresy', wlacz: '0' })).statusCode).toBe(409);
  });

  // Recenzja PRZ-102.22 (WAŻNE 2): wiek pobrania liczony od późniejszej z chwil: ostatnie udane / włączenie.
  it('/health: włączenie modułu albo zapis tokenu po przegapionym oknie nie robi alarmu; stary zapis bez włączenia — robi', async () => {
    const p = panel();
    const godzinTemu = (h) => new Date(Date.now() - h * 3600000);
    p.db.prepare("INSERT INTO stan_kosztow (id, ostatnie_udane_at) VALUES (1, ?)").run(godzinTemu(27).toISOString());
    zapiszKonfiguracjeIntegracji(p.db, 'ksef', { ustawienia: {}, sekrety: { token: 'zmyslony-token-ksef-z-panelu-0001' } }, { teraz: godzinTemu(100) });
    const alarm = async () => (await p.app.inject('/health')).json().alarmy.filter((a) => a.includes('czuwacz kosztów'));
    expect(await alarm(), 'token zapisany 100 h temu, pobranie 27 h temu').toHaveLength(1);
    await post(p.app, '/ustawienia/moduly', p.admin, { modul: 'koszty', wlacz: '0' });
    await post(p.app, '/ustawienia/moduly', p.admin, { modul: 'koszty', wlacz: '1' });
    expect(await alarm(), 'moduł włączony przed chwilą').toEqual([]);
    // Ten sam stan bez świeżego włączenia modułu, ale z tokenem zapisanym przed chwilą.
    p.db.prepare("DELETE FROM ustawienia WHERE klucz LIKE 'moduly.%'").run();
    expect(await alarm()).toHaveLength(1);
    zapiszKonfiguracjeIntegracji(p.db, 'ksef', { ustawienia: {}, sekrety: { token: 'zmyslony-token-ksef-z-panelu-0002' } });
    expect(await alarm(), 'token zapisany przed chwilą').toEqual([]);
  });

  it('paczka dla biura przy wyłączonych kosztach: część kosztów odmawia zdaniem bez KSeF, część sprzedaży działa', async () => {
    const zbuduj = vi.fn(async (miesiac, czesc) => ({ nazwa: `paczka-${czesc}-${miesiac}.pdf`, bajty: Buffer.from('%PDF-1.4') }));
    const p = panel({ paczkaDlaBiura: { zbuduj, zbudujZestawieniePrzychodow: vi.fn() } });
    wylacz(p.db, ['koszty']);
    const koszty = await get(p.app, '/faktury/paczka?miesiac=2026-09&czesc=koszty', p.admin);
    expect(koszty.statusCode).toBe(409);
    expect(koszty.body).toContain(PACZKA);
    expect(zbuduj).not.toHaveBeenCalled();
    const sprzedaz = await get(p.app, '/faktury/paczka?miesiac=2026-09&czesc=sprzedaz', p.admin);
    expect(sprzedaz.statusCode).toBe(200);
    expect(zbuduj).toHaveBeenCalledWith('2026-09', 'sprzedaz');
    wylacz(p.db, []);
    expect((await get(p.app, '/faktury/paczka?miesiac=2026-09&czesc=koszty', p.admin)).statusCode).toBe(200);
    expect(zbuduj).toHaveBeenLastCalledWith('2026-09', 'koszty');
  });

  it('Finanse przy wyłączonych kosztach: 200, pasek u góry, koszty z bazy dalej w rachunku; bez kosztów też 200', async () => {
    const db = openOmsDb(':memory:');
    for (const k of KANALY) ustawGranice(db, k, '2026-07-02', 'test', null);
    zapiszHistorie(db, { apiloId: 'S1', platformAccountId: 9, dzien: '2026-06-10', utworzoneAt: '2026-06-10T10:00:00.000Z',
      brutto: '12300.00', tagi: [], status: 15, paymentStatus: 2, klientEmail: 'k@klient.invalid', pozycje: [] });
    const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
    const wejdz = async (url) => {
      const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] } });
      try { return await app.inject({ method: 'GET', url, headers: naglowek }); } finally { await app.close(); }
    };
    const URL = '/finanse?od=2026-06-01&do=2026-06-30';
    const bezKosztow = await wejdz(URL);
    expect(bezKosztow.statusCode, bezKosztow.body).toBe(200);
    expect(bezKosztow.body.includes(PASEK)).toBe(false);
    wylacz(db, ['koszty']);
    const pustyWylaczony = await wejdz(URL);
    expect(pustyWylaczony.statusCode, pustyWylaczony.body).toBe(200);
    expect(pustyWylaczony.body).toContain(PASEK);
    koszt(db, 'K-CZERWIEC', '2026-06-15', '1234.00');
    const zKosztem = await wejdz(URL);
    expect(zKosztem.statusCode).toBe(200);
    expect(zKosztem.body).toContain(PASEK);
    // Arytmetyka bez zmian: koszt zapisany w bazie dalej jest w rachunku.
    expect(zKosztem.body).toContain('1 234,00');
    db.close();
  });

  it('czuwacz kosztów przy wyłączonym module nie woła KSeF (sprawdzane przy każdym tyknięciu), /health: „koszty wyłączone”, nie alarm', async () => {
    const zaloguj = vi.fn(async () => ({ accessToken: 'a', accessDo: '2027-01-01T00:00:00Z', refreshToken: 'r', refreshDo: '2027-02-01T00:00:00Z' }));
    const klient = { zaloguj, odswiez: vi.fn(), pobierzMetadane: vi.fn(async () => ({ faktury: [], hasMore: false, isTruncated: false })), pobierzXml: vi.fn() };
    const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_SPRZEDAWCA_NIP: NIP, OMS_RACHUNEK: '34109010140000000000000000',
      OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(), KSEF_TOKEN: 'zmyslony-token-ksef-z-pliku-0001' };
    const moduly = modulyDla(env).map((m) => (m.nazwa === 'koszty' ? createModulKoszty({ createKlient: () => klient }) : m));
    // 03:30 czasu Warszawy — pora nocnego pobrania.
    const z = await zbudujOms({ env, moduly, teraz: () => new Date('2026-10-20T01:30:00Z'), log: () => {} });
    try {
      const zegar = z.zegary.find((x) => x.nazwa === 'czuwaczKosztow');
      wylacz(z.db, ['koszty']);
      await zegar.przebieg();
      expect(zaloguj).not.toHaveBeenCalled();
      expect(klient.pobierzMetadane).not.toHaveBeenCalled();
      const zdrowie = (await z.app.inject('/health')).json();
      expect(zdrowie.czuwaczKosztow).toMatchObject({ wlaczony: false, zdrowy: true, stan: 'koszty wyłączone' });
      expect(zdrowie.alarmy.some((a) => a.includes('czuwacz kosztów'))).toBe(false);
      // Włączenie bez restartu: następne tyknięcie pobiera.
      wylacz(z.db, []);
      await zegar.przebieg();
      expect(zaloguj).toHaveBeenCalledTimes(1);
      expect(klient.pobierzMetadane).toHaveBeenCalled();
      expect((await z.app.inject('/health')).json().czuwaczKosztow).toMatchObject({ wlaczony: true });
      expect(siec).not.toHaveBeenCalled();
    } finally { await z.app.close(); z.db.close(); }
  });
});
