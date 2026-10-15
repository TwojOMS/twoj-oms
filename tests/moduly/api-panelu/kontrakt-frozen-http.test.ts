import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import * as klientFrozen from '../../pomoc/klient-oms-frozen.js';
import * as zamowieniaDb from '../../../src/oms/db/zamowienia.js';
import * as platnosciDb from '../../../src/oms/db/platnosci.js';
import * as okresyDb from '../../../src/oms/db/okresy.js';
import * as proformyDb from '../../../src/moduly/faktury/db/proformy.js';
import * as zamowienieReczne from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import * as zKarty from '../../../src/domena/zamowienie-z-karty.js';
import * as statusReczny from '../../../src/domena/status-reczny.js';
import * as konta from '../../../src/core/bezpieczenstwo/konta.js';
import * as sekretSesji from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import * as sesja from '../../../src/core/bezpieczenstwo/sesja.js';

// PRZ-031 — kontrakt NIEZMIENIONEGO klienta panelu :3000 (frozen 5b9cd765, src/oms-api/client.js)
// z prawdziwym produktem: bootstrap z src/oms/bootstrap.ts, app.listen na 127.0.0.1:0, global fetch,
// plikowa baza SQLite w katalogu tymczasowym, prawdziwa usługa proform i prawdziwy PDF.
// Bez atrap odpowiedzi HTTP. Jedyna podmiana to synchronizacja ze sklepem (fake bez sieci)
// i — w jednym przypadku — brak usługi proform, aby dojść do gałęzi 503.
// Ten plik NIE importuje modułu api-panelu: RED ma być porażką asercji (404 braku tras).

const any = (m: unknown) => m as any;
const { createOmsClient } = any(klientFrozen);
const Z = any(zamowieniaDb); const P = any(platnosciDb); const O = any(okresyDb); const PF = any(proformyDb);
const ZR = any(zamowienieReczne); const ZK = any(zKarty); const SR = any(statusReczny);
const K = any(konta); const SS = any(sekretSesji); const S = any(sesja);

const SHA_KLIENTA_FROZEN = '1e6f4d35942c7da916bc44fe9f65d4d4b8541c0f1d15614685145d877b2b8c68';
const METODY = ['createFromCard', 'getForCard', 'getByShopOrder', 'getDostawa', 'wystawProforme',
  'pobierzProformePdf', 'oznaczWRealizacji', 'getStanWysylki'];
const LOGIN = 'panel-api';
const HASLO = 'haslo-api-testowe';
// Numer proformy niesie miesiąc i rok — zegar produktu jest wstrzyknięty.
const ZEGAR = () => new Date('2026-08-18T10:00:00.000Z');
const prawdziwyFetch = globalThis.fetch;

// Jawne, neutralne dane sprzedawcy i nadawcy; żadnych danych firmy.
const envBazowe = (katalog: string): Record<string, string> => ({
  OMS_USER: LOGIN, OMS_PASS: HASLO,
  OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_BANK: 'Bank Testowy',
  OMS_PROFORMY_KATALOG: join(katalog, 'proformy'), OMS_ETYKIETY_KATALOG: join(katalog, 'etykiety'),
  DPD_NADAWCA_NAZWA: 'Sprzedawca Testowy', DPD_NADAWCA_ULICA: 'ul. Przykładowa 1',
  DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Miasto Testowe', DPD_NADAWCA_KRAJ: 'PL',
  OMS_DB_PATH: join(katalog, 'oms.sqlite'),
});

type Srodowisko = Awaited<ReturnType<typeof uruchom>>;
const doSprzatniecia: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (doSprzatniecia.length) await doSprzatniecia.pop()!();
  vi.restoreAllMocks();
});

async function uruchom(o: { bezProform?: boolean; katalog?: string } = {}) {
  const katalog = o.katalog ?? mkdtempSync(join(tmpdir(), 'oms-prz031-'));
  const siec = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zewnętrzna zabroniona w teście'));
  const sync = { odeslijStatus: vi.fn(async () => undefined) };
  const nadpisania: Record<string, unknown> = { 'zamowienia.syncSklep': sync };
  // Dopuszczone zleceniem: nadpisanie istniejącej usługi na null wyłącznie dla gałęzi 503.
  if (o.bezProform) nadpisania['faktury.proforma'] = null;
  const z = await zbudujOms({ env: envBazowe(katalog), teraz: ZEGAR, nadpisania });
  await z.app.listen({ host: '127.0.0.1', port: 0 });
  const baseUrl = `http://127.0.0.1:${(z.app.server.address() as AddressInfo).port}`;
  const lokalne: string[] = [];
  // Klient frozen dostaje prawdziwy fetch, ale wyłącznie do tego serwera.
  const fetchLokalny = (url: string, opcje: unknown) => {
    if (!String(url).startsWith(`${baseUrl}/`)) throw new Error(`Test: żądanie poza lokalny OMS: ${url}`);
    lokalne.push(String(url));
    return prawdziwyFetch(url, opcje as RequestInit);
  };
  const klient = (pass = HASLO) => createOmsClient({ baseUrl, user: LOGIN, pass, fetchImpl: fetchLokalny });
  let zamkniete = false;
  const zamknij = async () => {
    if (zamkniete) return; zamkniete = true;
    await z.app.close(); z.db.close();
  };
  doSprzatniecia.push(async () => {
    await zamknij();
    expect(siec).not.toHaveBeenCalled();
    if (!o.katalog) rmSync(katalog, { recursive: true, force: true });
  });
  return { z, db: z.db as any, baseUrl, katalog, klient, oms: klient(), sync, lokalne, zamknij, siec };
}

function surowe(baseUrl: string, method: string, sciezka: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: Record<string, unknown>; bajty: Buffer; json: () => any }>((ok, blad) => {
    const r = request(new URL(sciezka, baseUrl), { method, headers }, (res) => {
      const czesci: Buffer[] = [];
      res.on('data', (c: Buffer) => czesci.push(c));
      res.on('end', () => {
        const bajty = Buffer.concat(czesci);
        ok({ status: res.statusCode ?? 0, headers: res.headers, bajty, json: () => JSON.parse(bajty.toString('utf8')) });
      });
    });
    r.on('error', blad);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const basic = (pass = HASLO) => `Basic ${Buffer.from(`${LOGIN}:${pass}`).toString('base64')}`;

const cialoKarty = (kartaId = 'karta-031') => ({
  kartaId,
  klient: { first_name: 'Jan', last_name: 'Testowy', email: 'jan@example.test', phone: '600000001' },
  dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Testowa 5', postcode: '00-950', city: 'Miasto Testowe' },
  nip: null, chceFakture: false, kosztDostawyBrutto: '19.00',
  pozycje: [{ nazwa: 'Szablon testowy 70x100', ilosc: 1, cena_brutto: '250.00' }],
  uwagi: 'Zamówienie indywidualne — karta testowa',
});
// Seed przez prawdziwą usługę produktu (nie przez trasę), aby przypadki były niezależne.
const zalozZKarty = (db: any, kartaId = 'karta-031', znacznik = new Date().toISOString()) =>
  ZR.zalozZamowienieReczne({ db, dane: ZK.parsujZamowienieZKarty(cialoKarty(kartaId)), znacznik, okresId: null });

const zeSklepu = (nad: Record<string, unknown> = {}) => ({
  zrodlo_id: 9001, numer: 'A-100',
  klient: { first_name: 'Anna', last_name: 'Testowa', email: 'anna@example.test', phone: '600000002',
    address_1: 'Polna 1', postcode: '00-001', city: 'Miasto Testowe' },
  dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', status_woo: 'processing', metoda_platnosci: 'Przelew',
  indywidualne: 0, oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-18T10:00:00',
  pozycje: [{ nazwa: 'Produkt testowy', sku: 'TEST-1', ilosc: 2, cena_brutto: '61.50', vat: null }],
  ...nad,
});
const liczbaZamowien = (db: any) => db.prepare('SELECT COUNT(*) c FROM zamowienia').get().c;
// Odrzucenie przez klienta frozen i brak pola w JSON-ie mają być porażką ASERCJI, nie wyjątkiem w teście.
async function udane<T>(p: Promise<T>): Promise<T> {
  await expect(p).resolves.toBeDefined();
  return p;
}
const zPowodem = (r: { json: () => any }, wzor: RegExp) => expect(r.json()).toMatchObject({ powod: expect.stringMatching(wzor) });

describe('PRZ-031 wyrocznia — niezmieniony klient frozen', () => {
  it('kopia klienta ma bajty frozen i dokładnie 8 metod', () => {
    const tekst = readFileSync(resolve('tests/pomoc/klient-oms-frozen.js'), 'utf8').replaceAll('\r\n', '\n');
    expect(createHash('sha256').update(tekst).digest('hex')).toBe(SHA_KLIENTA_FROZEN);
    const oms = createOmsClient({ baseUrl: 'http://127.0.0.1:9', user: 'x', pass: 'y', fetchImpl: async () => { throw new Error('nieużywane'); } });
    expect(Object.keys(oms).sort()).toEqual([...METODY].sort());
  });
});

describe('PRZ-031 createFromCard / getForCard przez HTTP produktu', () => {
  it('createFromCard zakłada zamówienie ręczne z karty, bez opłaty zbiorczej', async () => {
    const { db, oms } = await uruchom();
    const wynik = await udane(oms.createFromCard(cialoKarty())) as any;
    expect(wynik).toMatchObject({ konflikt: false });
    expect(wynik.numer).toMatch(/^R\/\d{4}\/\d+$/);
    const z = Z.pobierzZamowienie(db, wynik.id);
    expect(z).toMatchObject({ numer: wynik.numer, karta_id: 'karta-031', indywidualne: 1, sklep: 'reczne', kwota_brutto: '269.00' });
    expect(z.pozycje).toHaveLength(1);
  });

  it('409 idempotencji oddaje pierwsze zamówienie i nie zakłada nowego', async () => {
    const { db, oms } = await uruchom();
    const pierwsze = ZR.zalozZamowienieReczne({ db, dane: ZK.parsujZamowienieZKarty(cialoKarty()), znacznik: new Date().toISOString(), okresId: null });
    expect(liczbaZamowien(db)).toBe(1);
    await expect(oms.createFromCard(cialoKarty())).resolves.toEqual({ id: pierwsze.id, numer: pierwsze.numer, konflikt: true });
    await expect(oms.createFromCard(cialoKarty())).resolves.toEqual({ id: pierwsze.id, numer: pierwsze.numer, konflikt: true });
    expect(liczbaZamowien(db)).toBe(1);
  });

  it('400 walidacji niesie powód i nie zapisuje niczego', async () => {
    const { db, oms } = await uruchom();
    zalozZKarty(db, 'karta-inna');
    await expect(oms.createFromCard({ ...cialoKarty(), pozycje: [{ nazwa: 'Bez ceny', ilosc: 1 }] }))
      .rejects.toThrow(/\(400\).*cen/i);
    expect(liczbaZamowien(db)).toBe(1);
  });

  it('getForCard liczy płatności efektywnie: część → false, pełna kwota → true; anulowanie ręczne', async () => {
    const { db, oms } = await uruchom();
    const { id, numer } = zalozZKarty(db);
    expect(await oms.getForCard('karta-031')).toEqual({ id, numer, oplacone: false, anulowane: false, kwotaBrutto: '269.00' });
    P.dodajWplateReczna(db, id, { kwota: '100.00', data: '2026-08-05' });
    expect((await oms.getForCard('karta-031')).oplacone).toBe(false);
    P.dodajWplateReczna(db, id, { kwota: '169.00', data: '2026-08-06' });
    expect((await oms.getForCard('karta-031')).oplacone).toBe(true);
    Z.zapiszFaktyStatusu(db, id, SR.faktyDlaStatusu(Z.pobierzZamowienie(db, id), 'anulowane'));
    expect((await oms.getForCard('karta-031')).anulowane).toBe(true);
  });

  it('getForCard: nieznana karta → null, a powód 404 jest kontraktem trasy, nie domyślnym 404', async () => {
    const { baseUrl, oms } = await uruchom();
    expect(await oms.getForCard('karta-nieznana')).toBeNull();
    const r = await surowe(baseUrl, 'GET', '/api/zamowienia-z-karty/karta-nieznana', { authorization: basic() });
    expect(r.status).toBe(404);
    zPowodem(r, /karta.*nie ma zamówienia w OMS-ie/i);
  });
});

describe('PRZ-031 getByShopOrder — sklep wymagany, kolizje numerów', () => {
  it('ten sam numer w dwóch sklepach oddaje zamówienie wskazanego sklepu z efektywną płatnością', async () => {
    const { db, oms } = await uruchom();
    const a = Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9001, indywidualne: 1, oplacone_at: '2026-08-18T11:00:00' }), {});
    const b = Z.zapiszZamowienie(db, 'sklep-b', zeSklepu({ zrodlo_id: 9002, kwota_brutto: '456.00',
      pozycje: [{ nazwa: 'Inny', sku: 'TEST-2', ilosc: 1, cena_brutto: '456.00', vat: null }] }), {});
    expect(await oms.getByShopOrder('A-100', 'sklep-a')).toEqual({ id: a, numer: 'A-100', sklep: 'sklep-a',
      oplacone: true, anulowane: false, kwotaBrutto: '123.00', indywidualne: true });
    expect(await oms.getByShopOrder('A-100', 'sklep-b')).toEqual({ id: b, numer: 'A-100', sklep: 'sklep-b',
      oplacone: false, anulowane: false, kwotaBrutto: '456.00', indywidualne: false });
  });

  it('brak, pusty albo biały sklep → 400 bez id; klient frozen odmawia u siebie', async () => {
    const { db, baseUrl, oms, lokalne } = await uruchom();
    const id = Z.zapiszZamowienie(db, 'sklep-a', zeSklepu(), {});
    for (const q of ['', '?sklep=', '?sklep=%20']) {
      const r = await surowe(baseUrl, 'GET', `/api/zamowienia/po-numerze/A-100${q}`, { authorization: basic() });
      expect(r.status, q).toBe(400);
      expect(r.json(), q).toMatchObject({ powod: expect.stringMatching(/sklep/i) });
      expect(r.json().id, q).toBeUndefined();
    }
    const przed = lokalne.length;
    await expect(oms.getByShopOrder('A-100', ' ')).rejects.toThrow(/sklep/i);
    expect(lokalne.length).toBe(przed);
    expect((await oms.getByShopOrder('A-100', 'sklep-a')).id).toBe(id);
  });

  it('nieznany numer i numer z innego sklepu → 404 z powodem; dwa w tym samym sklepie → 409 bez id', async () => {
    const { db, baseUrl, oms } = await uruchom();
    Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9001 }), {});
    expect(await oms.getByShopOrder('A-999', 'sklep-a')).toBeNull();
    expect(await oms.getByShopOrder('A-100', 'sklep-b')).toBeNull();
    const inny = await surowe(baseUrl, 'GET', '/api/zamowienia/po-numerze/A-100?sklep=sklep-b', { authorization: basic() });
    expect(inny.status).toBe(404);
    zPowodem(inny, /nie ma zamówienia/i);
    expect(inny.json().id).toBeUndefined();
    Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9003 }), {});
    await expect(oms.getByShopOrder('A-100', 'sklep-a')).rejects.toThrow(/\(409\).*więcej niż jedn/i);
    const kolizja = await surowe(baseUrl, 'GET', '/api/zamowienia/po-numerze/A-100?sklep=sklep-a', { authorization: basic() });
    expect(kolizja.json().id).toBeUndefined();
  });
});

describe('PRZ-031 getDostawa — wartości efektywne', () => {
  const zDostawa = (nad: Record<string, unknown> = {}) => zeSklepu({
    numer: 'D-1', zrodlo_id: 9101, chce_fakture: 1, nip: '1234563218', oplacone_at: '2026-08-19T10:00:00', pozycje: [],
    kwota_brutto: '343.00',
    dostawa: { first_name: 'Anna', last_name: 'Testowa', company: 'Pracownia Testowa sp. z o.o.',
      address_1: 'Długa 45/2', postcode: '00-002', city: 'Miasto Testowe', country: 'PL' },
    klient: { first_name: 'Anna', last_name: 'Testowa', company: 'Pracownia Testowa sp. z o.o.', email: 'anna@example.test',
      phone: '600000003', address_1: 'Długa 45/2', postcode: '00-002', city: 'Miasto Testowe' },
    ...nad,
  });

  it('adres, metoda, dokument i dane faktury zamówienia bez karta_id', async () => {
    const { db, oms } = await uruchom();
    const id = Z.zapiszZamowienie(db, 'sklep-a', zDostawa(), {});
    const d = await oms.getDostawa(id);
    expect(d).not.toBeNull();
    expect(d.adres).toMatchObject({ ulica: 'Długa 45/2', kod: '00-002', miasto: 'Miasto Testowe', telefon: '600000003' });
    expect(d.adres.nazwa).toContain('Anna');
    expect(d.metoda).toMatch(/DPD/i);
    expect(d.dokument).toBe('faktura');
    expect(d.faktura).toMatchObject({ nip: '1234563218' });
    expect(d.faktura.firma).toContain('Pracownia Testowa');
  });

  it('ręczne nadpisania operatora wygrywają; paczkomat ma punkt; „nieznana" metoda → null; paragon', async () => {
    const { db, oms } = await uruchom();
    const id = Z.zapiszZamowienie(db, 'sklep-a', zDostawa(), {});
    db.prepare('UPDATE zamowienia SET dostawa_reczna_json = ?, wysylka_reczna_json = ? WHERE id = ?')
      .run(JSON.stringify({ ulica: 'Krótka 1', miasto: 'Inne Miasto', kod: '00-003' }), JSON.stringify({ metoda: 'inpost_paczkomat' }), id);
    expect(await oms.getDostawa(id)).toMatchObject({ adres: { ulica: 'Krótka 1', miasto: 'Inne Miasto' },
      metoda: expect.stringMatching(/InPost|Paczkomat/i) });
    const pk = Z.zapiszZamowienie(db, 'sklep-a', zDostawa({ zrodlo_id: 9102, numer: 'D-2', metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'TST01M' }), {});
    expect(await oms.getDostawa(pk)).toMatchObject({ punkt: 'TST01M' });
    const nz = Z.zapiszZamowienie(db, 'sklep-a', zDostawa({ zrodlo_id: 9103, numer: 'D-3', metoda_wysylki: 'nieznana', chce_fakture: 0 }), {});
    expect(await oms.getDostawa(nz)).toMatchObject({ metoda: null, dokument: 'paragon', faktura: null,
      adres: expect.objectContaining({ ulica: 'Długa 45/2' }) });
  });

  it('nieznane zamówienie i nieliczbowy id → null; surowo 404 z powodem trasy', async () => {
    const { baseUrl, oms } = await uruchom();
    expect(await oms.getDostawa(999999)).toBeNull();
    expect(await oms.getDostawa('abc')).toBeNull();
    const r = await surowe(baseUrl, 'GET', '/api/zamowienia/999999/dostawa', { authorization: basic() });
    expect(r.status).toBe(404);
    zPowodem(r, /Nie ma takiego zamówienia/);
  });
});

describe('PRZ-031 proformy — realna usługa, realny PDF, numeracja', () => {
  const seed = (db: any, nad: Record<string, unknown> = {}) => {
    // Dwa zamówienia przed właściwym: id zamówienia ≠ id proformy.
    Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9201, numer: 'P-1' }), {});
    Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9202, numer: 'P-2' }), {});
    return Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9203, numer: 'P-3', ...nad }), {});
  };

  it('wystawProforme oddaje id dokumentu, numer i pdfUrl; pobierzProformePdf oddaje bajty z dysku', async () => {
    const { db, oms, baseUrl, katalog } = await uruchom();
    const id = seed(db);
    const p = await udane(oms.wystawProforme(id)) as any;
    expect(p.numer).toBe('PF/1/08/2026');
    expect(p.id).not.toBe(id);
    expect(p.pdfUrl).toBe(`/api/proformy/${p.id}/pdf`);
    const [wiersz] = PF.proformyZamowienia(db, id);
    expect(wiersz.id).toBe(p.id);
    expect(resolve(wiersz.plik_sciezka).startsWith(resolve(katalog))).toBe(true);
    const bajty = await oms.pobierzProformePdf(p.pdfUrl);
    expect(bajty.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bajty.toString('latin1').trimEnd().endsWith('%%EOF')).toBe(true);
    expect(bajty.length).toBeGreaterThan(1000);
    expect(bajty.equals(readFileSync(wiersz.plik_sciezka))).toBe(true);
    const r = await surowe(baseUrl, 'GET', p.pdfUrl, { authorization: basic() });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('application/pdf');
    expect(r.headers['content-disposition']).toBeUndefined();
  });

  it('kolejna proforma dostaje następny numer i unieważnia poprzednią; obie pozostają do pobrania', async () => {
    const { db, oms } = await uruchom();
    const id = seed(db);
    const p1 = await udane(oms.wystawProforme(id)) as any;
    const p2 = await udane(oms.wystawProforme(id)) as any;
    expect([p1.numer, p2.numer]).toEqual(['PF/1/08/2026', 'PF/2/08/2026']);
    const wiersze = PF.proformyZamowienia(db, id);
    expect(wiersze.find((w: any) => w.id === p1.id).uniewazniona_at).toBeTruthy();
    expect(wiersze.find((w: any) => w.id === p2.id).uniewazniona_at).toBeNull();
    const b1 = await oms.pobierzProformePdf(p1.pdfUrl);
    const b2 = await oms.pobierzProformePdf(p2.pdfUrl);
    expect(b1.equals(b2)).toBe(false);
  });

  it('odmowa operatorska → 400 z powodem, bez zużytego numeru', async () => {
    const { db, oms } = await uruchom();
    const id = seed(db, { anulowane: 1 });
    await expect(oms.wystawProforme(id)).rejects.toThrow(/\(400\).*anulowane/i);
    expect(PF.proformyZamowienia(db, id)).toHaveLength(0);
  });

  it('nieznane zamówienie → 404 z powodem; nieznana proforma → 404 z powodem', async () => {
    const { oms } = await uruchom();
    await expect(oms.wystawProforme(999999)).rejects.toThrow(/\(404\).*Nie ma takiego zamówienia/);
    await expect(oms.pobierzProformePdf('/api/proformy/999999/pdf')).rejects.toThrow(/Nie ma takiej proformy/);
  });

  it('brak usługi proform → 503 na obu trasach, ale 404 nieznanego zamówienia ma pierwszeństwo', async () => {
    const { db, oms, baseUrl } = await uruchom({ bezProform: true });
    const id = seed(db);
    await expect(oms.wystawProforme(999999)).rejects.toThrow(/\(404\).*Nie ma takiego zamówienia/);
    await expect(oms.wystawProforme(id)).rejects.toThrow(/nie ma skonfigurowanych proform/);
    const post = await surowe(baseUrl, 'POST', `/api/zamowienia/${id}/proforma`, { authorization: basic(), origin: baseUrl });
    expect(post.status).toBe(503);
    zPowodem(post, /proform/i);
    const get = await surowe(baseUrl, 'GET', '/api/proformy/1/pdf', { authorization: basic() });
    expect(get.status).toBe(503);
    zPowodem(get, /proform/i);
    expect(PF.proformyZamowienia(db, id)).toHaveLength(0);
  });
});

describe('PRZ-031 oznaczWRealizacji — idempotencja, odmowy, delegacja syncSklep', () => {
  it('indywidualne → w realizacji; powtórka nie zmienia czasu ani logu; delegacja do syncSklep', async () => {
    const { db, oms, sync } = await uruchom();
    const { id, numer } = zalozZKarty(db);
    const w1 = await oms.oznaczWRealizacji(id);
    expect(w1).toEqual({ zmienione: true, numer, status: 'w_realizacji' });
    const czas = Z.pobierzZamowienie(db, id).w_realizacji_at;
    expect(czas).toBeTruthy();
    expect(sync.odeslijStatus).toHaveBeenCalledWith(id);
    const w2 = await oms.oznaczWRealizacji(id);
    expect(w2).toEqual({ zmienione: true, numer, status: 'w_realizacji' });
    expect(Z.pobierzZamowienie(db, id).w_realizacji_at).toBe(czas);
    const logi = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'status.automat'").all(id);
    expect(logi).toHaveLength(1);
    expect(logi[0].wynik).toMatch(/zaakceptował projekt/);
    expect(sync.odeslijStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wysłanego', 'UPDATE zamowienia SET wyslane_at = ? WHERE id = ?', ['2026-08-20T10:00:00.000Z'], /wysłan/i],
    ['anulowanego', 'UPDATE zamowienia SET anulowane_recznie = 1 WHERE id = ?', [], /anulowan/i],
    ['ze zwrotem', 'UPDATE zamowienia SET zwrot_at = ? WHERE id = ?', ['2026-08-20T10:00:00.000Z'], /zwrot/i],
  ] as const)('odmowa dla zamówienia %s: 409 → zmienione:false z powodem, bez zmian i bez sync', async (_n, sql, arg, powod) => {
    const { db, oms, sync } = await uruchom();
    const { id } = zalozZKarty(db);
    db.prepare(sql).run(...arg, id);
    const przed = Z.pobierzZamowienie(db, id);
    const w = await oms.oznaczWRealizacji(id);
    expect(w.zmienione).toBe(false);
    expect(w.powod).toMatch(powod);
    const po = Z.pobierzZamowienie(db, id);
    expect(po.w_realizacji_at).toBe(przed.w_realizacji_at);
    expect(po.wyslane_at).toBe(przed.wyslane_at);
    expect(sync.odeslijStatus).not.toHaveBeenCalled();
    const logi = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'status.automat'").all(id);
    expect(logi.map((l: any) => l.wynik).join('\n')).toMatch(/ODMOWA/);
  });

  it('nieznane zamówienie → 404 obsłużone przez klienta bez sync', async () => {
    const { baseUrl, oms, sync } = await uruchom();
    expect(await oms.oznaczWRealizacji(999999)).toEqual({ zmienione: false, powod: 'OMS nie zna tego zamówienia (404).' });
    const r = await surowe(baseUrl, 'POST', '/api/zamowienia/999999/w-realizacji', { authorization: basic(), origin: baseUrl });
    zPowodem(r, /Nie ma takiego zamówienia/);
    expect(sync.odeslijStatus).not.toHaveBeenCalled();
  });
});

describe('PRZ-031 getStanWysylki — fakty efektywne', () => {
  it('świeże, wysłane z datą z bazy, anulowane ręcznie; nieznane → null', async () => {
    const { db, oms, baseUrl } = await uruchom();
    const { id, numer } = zalozZKarty(db);
    expect(await oms.getStanWysylki(id)).toEqual({ id, numer, wyslane: false, wyslaneAt: null, anulowane: false });
    Z.oznaczWyslane(db, id, '2026-08-25T10:00:00.000Z');
    expect(await oms.getStanWysylki(id)).toEqual({ id, numer, wyslane: true, wyslaneAt: '2026-08-25T10:00:00.000Z', anulowane: false });
    const drugie = zalozZKarty(db, 'karta-druga');
    Z.zapiszFaktyStatusu(db, drugie.id, SR.faktyDlaStatusu(Z.pobierzZamowienie(db, drugie.id), 'anulowane'));
    expect((await oms.getStanWysylki(drugie.id)).anulowane).toBe(true);
    expect(await oms.getStanWysylki(999999)).toBeNull();
    const r = await surowe(baseUrl, 'GET', '/api/zamowienia/999999/stan-wysylki', { authorization: basic() });
    zPowodem(r, /zamówieni/i);
  });
});

describe('PRZ-031 autoryzacja, CSRF i uprawnienie api', () => {
  it('Basic Auth: bez nagłówka 401, złe hasło 401 bez cytowania sekretu, prawidłowe 200', async () => {
    const { db, baseUrl, klient, oms } = await uruchom();
    const { id } = zalozZKarty(db);
    for (const [m, s] of [['GET', `/api/zamowienia/${id}/stan-wysylki`], ['GET', '/api/zamowienia-z-karty/karta-031'],
      ['GET', '/api/sprzedaz?od=2026-08-01&do=2026-08-31'], ['GET', `/api/zamowienia/${id}/dostawa`]] as const) {
      expect((await surowe(baseUrl, m, s, { accept: 'application/json' })).status, s).toBe(401);
    }
    const zly = klient('zle-haslo');
    let blad: any;
    try { await zly.getStanWysylki(id); } catch (e) { blad = e; }
    expect(blad?.message).toMatch(/odrzucił login/);
    expect(blad.message).not.toContain('zle-haslo');
    expect(blad.message).not.toContain(Buffer.from(`${LOGIN}:zle-haslo`).toString('base64'));
    expect(((await udane(oms.getStanWysylki(id))) as any)?.id).toBe(id);
  });

  it('POST bez Origin i z obcym Origin → 403 bez skutków; zgodny Origin klienta działa', async () => {
    const { db, baseUrl, oms, sync } = await uruchom();
    const { id } = zalozZKarty(db, 'karta-bazowa');
    const cialo = JSON.stringify(cialoKarty('karta-csrf'));
    const json = { authorization: basic(), 'content-type': 'application/json' };
    for (const origin of [undefined, 'https://obcy.example']) {
      const h: Record<string, string> = origin ? { ...json, origin } : { ...json };
      expect((await surowe(baseUrl, 'POST', '/api/zamowienia-z-karty', h, cialo)).status).toBe(403);
      expect((await surowe(baseUrl, 'POST', `/api/zamowienia/${id}/proforma`, h)).status).toBe(403);
      expect((await surowe(baseUrl, 'POST', `/api/zamowienia/${id}/w-realizacji`, h)).status).toBe(403);
    }
    expect(liczbaZamowien(db)).toBe(1);
    expect(PF.proformyZamowienia(db, id)).toHaveLength(0);
    expect(Z.pobierzZamowienie(db, id).w_realizacji_at).toBeFalsy();
    expect(sync.odeslijStatus).not.toHaveBeenCalled();
    await expect(oms.createFromCard(cialoKarty('karta-csrf'))).resolves.toMatchObject({ konflikt: false });
    expect(liczbaZamowien(db)).toBe(2);
  });

  it('konto serwisowe zachowuje api po pierwszym czynnym administratorze', async () => {
    const { db, oms } = await uruchom();
    K.zalozKonto(db, { login: 'admin-testowy', imie: 'Admin', haslo: 'haslo-admina', rola: 'sprzedaz', admin: true });
    expect(K.czyIstniejeCzynnyAdmin(db)).toBe(true);
    const { id } = zalozZKarty(db);
    expect(((await udane(oms.getStanWysylki(id))) as any)?.id).toBe(id);
  });

  it('konto z api ma dostęp; po odebraniu ptaszka api → 403, także po ponownym starcie na tej samej bazie', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-prz031-konta-'));
    doSprzatniecia.unshift(async () => rmSync(katalog, { recursive: true, force: true }));
    const pierwszy = await uruchom({ katalog });
    const kontoId = K.zalozKonto(pierwszy.db, { login: 'pracownik', imie: 'Pracownik', haslo: 'haslo-pracownika', rola: 'produkcja', ekrany: ['zamowienia', 'api'] });
    const { id } = zalozZKarty(pierwszy.db);
    const ciastko = (db: any) => `${S.NAZWA_CIASTECZKA_OMS}=${S.podpisz('pracownik', SS.odczytajSekret(db), Date.now(), 0)}`;
    const zSesja = (s: Srodowisko) => surowe(s.baseUrl, 'GET', `/api/zamowienia/${id}/stan-wysylki`, { cookie: ciastko(s.db), accept: 'application/json' });
    const dozwolone = await zSesja(pierwszy);
    expect(dozwolone.status).toBe(200);
    expect(dozwolone.json()).toMatchObject({ id, wyslane: false });
    K.ustawUprawnienia(pierwszy.db, kontoId, ['zamowienia']);
    expect((await zSesja(pierwszy)).status).toBe(403);
    await pierwszy.zamknij();
    const drugi = await uruchom({ katalog });
    expect(existsSync(join(katalog, 'oms.sqlite'))).toBe(true);
    expect(K.kontoPoLoginie(drugi.db, 'pracownik').uprawnienia.has('api')).toBe(false);
    expect((await zSesja(drugi)).status).toBe(403);
  });
});

describe('PRZ-031 /api/sprzedaz — nowy kontrakt na prawdziwej bazie', () => {
  const sprzedaz = (s: Srodowisko, q: string) => surowe(s.baseUrl, 'GET', `/api/sprzedaz${q}`, { authorization: basic() });
  const reczne = (db: any, numer: string, utworzone: string, okresId: number | null = null) => db.prepare(
    "INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, anulowane, utworzone_at, indywidualne) VALUES ('reczne', ?, ?, '100.00', ?, 0, ?, 0)",
  ).run(Math.floor(Math.random() * 1e9), numer, okresId, utworzone);

  it('dzień warszawski, domknięte granice, kolejność, klasyfikacja i anulowanie efektywne', async () => {
    const s = await uruchom();
    const { db } = s;
    const okres = O.zapewnijOkres(db, { klientKlucz: 'klient-testowy', rok: 2026, miesiac: 7 });
    // 2026-07-01 00:30 w Warszawie (UTC+2) — zamówienie z karty przez usługę produktu.
    const karta = zalozZKarty(db, 'karta-sprzedaz', '2026-06-30T22:30:00.000Z');
    Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9301, numer: 'S-1', utworzone_at: '2026-07-01T00:00:00' }), {});
    Z.zapiszZamowienie(db, 'sklep-a', zeSklepu({ zrodlo_id: 9302, numer: 'S-0', utworzone_at: '2026-06-30T23:59:59' }), {});
    reczne(db, 'R-DROP', '2026-07-10T10:00:00.000Z', okres.id);
    reczne(db, 'R-B2B', '2026-07-31T21:59:59.999Z');
    reczne(db, 'R-SIERPIEN', '2026-07-31T22:00:00.000Z');
    db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, anulowane, utworzone_at, indywidualne) VALUES ('allegro_konto-testowe', 9303, 'AL-1', '50.00', 0, '2026-07-15T12:00:00', 0)").run();
    const anulowane = zalozZKarty(db, 'karta-anulowana', '2026-07-12T10:00:00.000Z');
    Z.zapiszFaktyStatusu(db, anulowane.id, SR.faktyDlaStatusu(Z.pobierzZamowienie(db, anulowane.id), 'anulowane'));

    const r = await sprzedaz(s, '?od=2026-07-01&do=2026-07-31');
    expect(r.status).toBe(200);
    expect(r.json().zamowienia.map((z: any) => [z.numer, z.kanal, z.dzien])).toEqual([
      ['S-1', 'SKLEP', '2026-07-01'],
      [karta.numer, 'SKLEP_INDYWIDUALNE', '2026-07-01'],
      ['R-DROP', 'DROPSHIPPING', '2026-07-10'],
      ['AL-1', 'ALLEGRO', '2026-07-15'],
      ['R-B2B', 'B2B', '2026-07-31'],
    ]);
    const pierwszaKarta = r.json().zamowienia[1];
    expect(pierwszaKarta).toEqual({ numer: karta.numer, kanal: 'SKLEP_INDYWIDUALNE', kwotaBrutto: '269.00',
      dataZlozenia: '2026-06-30T22:30:00.000Z', dzien: '2026-07-01' });
    const sierpien = await sprzedaz(s, '?od=2026-08-01&do=2026-08-01');
    expect(sierpien.json().zamowienia.map((z: any) => z.numer)).toEqual(['R-SIERPIEN']);
  });

  it('400 z komunikatem dla braku, złego formatu, nieistniejącej daty, znacznika czasu i odwróconego okna', async () => {
    const s = await uruchom();
    for (const q of ['', '?od=2026-07-01', '?od=abc&do=2026-07-31', '?od=2026-02-30&do=2026-03-31',
      '?od=2026-07-01T05:00&do=2026-07-31', '?od=2026-07-31&do=2026-07-01']) {
      const r = await sprzedaz(s, q);
      expect(r.status, q).toBe(400);
      expect(r.json(), q).toMatchObject({ blad: expect.stringMatching(/od.*do|do.*od/i) });
    }
    expect((await sprzedaz(s, '?od=2026-07-10&do=2026-07-10')).status).toBe(200);
  });
});

// Testy dopisane po przebiegu mutacji (docs/prz031-mutacje.md): każdy zabija mutanta, który
// przeżył dotychczasowy kontrakt i porty frozen. Pilnują zachowania frozen, nie nowego.
describe('PRZ-031 uzupełnienia po mutacjach', () => {
  it('powtórzone 409 idempotencji nie dopisuje dziennika i nie zużywa numeru', async () => {
    const { db, oms } = await uruchom();
    const pierwsze = zalozZKarty(db);
    const liczbaLogow = () => db.prepare('SELECT COUNT(*) c FROM log').get().c;
    const przed = liczbaLogow();
    for (let i = 0; i < 2; i++) {
      await expect(oms.createFromCard(cialoKarty())).resolves.toEqual({ id: pierwsze.id, numer: pierwsze.numer, konflikt: true });
    }
    expect(liczbaLogow()).toBe(przed);
    expect(db.prepare("SELECT COUNT(*) c FROM log WHERE wynik LIKE 'BŁĄD%'").get().c).toBe(0);
    const nastepne = await udane(oms.createFromCard(cialoKarty('karta-nastepna'))) as any;
    const kolejny = pierwsze.numer.replace(/\d+$/, (n: string) => String(Number(n) + 1).padStart(n.length, '0'));
    expect(nastepne.numer).toBe(kolejny);
  });

  it('klucz sklepu porównywany dokładnie: inna wielkość liter → 404 bez id, nie cudze zamówienie', async () => {
    const { db, baseUrl, oms } = await uruchom();
    const id = Z.zapiszZamowienie(db, 'sklep-a', zeSklepu(), {});
    expect(await oms.getByShopOrder('A-100', 'SKLEP-A')).toBeNull();
    const r = await surowe(baseUrl, 'GET', '/api/zamowienia/po-numerze/A-100?sklep=Sklep-A', { authorization: basic() });
    expect(r.status).toBe(404);
    expect(r.json().id).toBeUndefined();
    expect(((await udane(oms.getByShopOrder('A-100', 'sklep-a'))) as any).id).toBe(id);
  });

  it('D5: start na bazie sprzed api-panelu nie rozdaje api istniejącym kontom', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms-prz031-d5-'));
    doSprzatniecia.unshift(async () => rmSync(katalog, { recursive: true, force: true }));
    const pierwszy = await uruchom({ katalog });
    const loginy = [['pracownik-produkcji', 'produkcja'], ['pracownik-sprzedazy', 'sprzedaz']] as const;
    for (const [login, rola] of loginy) {
      K.zalozKonto(pierwszy.db, { login, imie: login, haslo: `haslo-${login}`, rola, ekrany: ['zamowienia'] });
    }
    // Baza produkcyjna sprzed PRZ-031 nie ma wpisu `api` w rejestrze rozdanych kluczy, bo żaden
    // manifest go nie deklarował. Pierwsza kompozycja testu ma już api-panelu, więc ten stan
    // odtwarzamy wprost. Przy obecnym manifeście DELETE nie ma czego usunąć.
    pierwszy.db.prepare("DELETE FROM uprawnienia_rozdane WHERE klucz = 'api'").run();
    const { id } = zalozZKarty(pierwszy.db);
    await pierwszy.zamknij();
    const drugi = await uruchom({ katalog });
    for (const [login] of loginy) {
      expect(K.kontoPoLoginie(drugi.db, login).uprawnienia.has('api'), login).toBe(false);
      const ciastko = `${S.NAZWA_CIASTECZKA_OMS}=${S.podpisz(login, SS.odczytajSekret(drugi.db), Date.now(), 0)}`;
      const r = await surowe(drugi.baseUrl, 'GET', `/api/zamowienia/${id}/stan-wysylki`, { cookie: ciastko, accept: 'application/json' });
      expect(r.status, login).toBe(403);
    }
  });

  it('/api/sprzedaz: priorytet klasyfikacji — indywidualne przed Allegro', async () => {
    const s = await uruchom();
    s.db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, anulowane, utworzone_at, indywidualne) VALUES ('allegro_konto-testowe', 9401, 'AL-IND', '70.00', 0, '2026-07-15T12:00:00', 1)").run();
    s.db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, anulowane, utworzone_at, indywidualne) VALUES ('allegro_konto-testowe', 9402, 'AL-ZW', '80.00', 0, '2026-07-15T13:00:00', 0)").run();
    const r = await surowe(s.baseUrl, 'GET', '/api/sprzedaz?od=2026-07-15&do=2026-07-15', { authorization: basic() });
    expect(r.status).toBe(200);
    expect(r.json().zamowienia.map((z: any) => [z.numer, z.kanal])).toEqual([['AL-IND', 'SKLEP_INDYWIDUALNE'], ['AL-ZW', 'ALLEGRO']]);
  });
});

// Zegar stały WYŁĄCZNIE dla `Date` i wyłącznie w ciele przypadku: timery, gniazda i transport HTTP
// zostają prawdziwe. Wynik nie zależy od tego, ile milisekund dzieli dwa żądania.
describe('PRZ-031 uzupełnienia — stały zegar Date', () => {
  it('ponowienie POST z identycznym znacznikiem czasu → 409 pierwszego zamówienia, nie 500 częściowego zapisu', async () => {
    const { db, baseUrl, oms } = await uruchom();
    const chwila = '2026-08-18T10:00:00.000Z';
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(chwila) });
    try {
      const pierwsze = await udane(oms.createFromCard(cialoKarty())) as any;
      expect(pierwsze).toMatchObject({ konflikt: false });
      // Warunek kontrprzykładu: wiersz nosi DOKŁADNIE znacznik, który dostanie ponowienie.
      expect(db.prepare('SELECT utworzone_at FROM zamowienia WHERE id = ?').get(pierwsze.id).utworzone_at).toBe(chwila);
      await new Promise((ok) => setTimeout(ok, 15));
      expect(new Date().toISOString()).toBe(chwila);
      await expect(oms.createFromCard(cialoKarty())).resolves.toEqual({ id: pierwsze.id, numer: pierwsze.numer, konflikt: true });
      const r = await surowe(baseUrl, 'POST', '/api/zamowienia-z-karty',
        { authorization: basic(), origin: baseUrl, 'content-type': 'application/json' }, JSON.stringify(cialoKarty()));
      expect(r.status).toBe(409);
      expect(r.json()).toEqual({ id: pierwsze.id, numer: pierwsze.numer, powod: 'Zamówienie z tej karty już istnieje.' });
      expect(liczbaZamowien(db)).toBe(1);
      expect(db.prepare("SELECT COUNT(*) c FROM log WHERE wynik LIKE 'BŁĄD%'").get().c).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('druga realizacja dzień później przez HTTP zachowuje pierwszy czas w_realizacji_at', async () => {
    const { db, baseUrl, oms } = await uruchom();
    const { id, numer } = zalozZKarty(db);
    const t1 = '2026-08-18T10:00:00.000Z';
    const t2 = '2026-08-19T10:00:00.000Z';
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(t1) });
    try {
      expect(await oms.oznaczWRealizacji(id)).toEqual({ zmienione: true, numer, status: 'w_realizacji' });
      expect(Z.pobierzZamowienie(db, id).w_realizacji_at).toBe(t1);
      vi.setSystemTime(new Date(t2));
      expect(new Date().toISOString()).toBe(t2);
      expect(await oms.oznaczWRealizacji(id)).toEqual({ zmienione: true, numer, status: 'w_realizacji' });
      expect(Z.pobierzZamowienie(db, id).w_realizacji_at).toBe(t1);
      const r = await surowe(baseUrl, 'POST', `/api/zamowienia/${id}/w-realizacji`, { authorization: basic(), origin: baseUrl });
      expect(r.status).toBe(200);
      expect(r.json().wRealizacjiAt).toBe(t1);
    } finally {
      vi.useRealTimers();
    }
  });
});
