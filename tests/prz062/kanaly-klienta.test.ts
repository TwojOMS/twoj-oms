// PRZ-062: cały panel na kanałach pod nazwami klienta (allegro_zetaklient, woo_zetaklient) — tak, jak klient je
// skonfiguruje według docs/instalacja-docker.md, sekcja „Przejście na pracę”: definicje w OMS_KANALY
// z etykietą i identyfikatorem raportu, fałszywe klucze (bez sieci), granice raportu założone skryptem
// inicjalizuj-granice-bez-historii.mjs, nazwy raportowe w OMS_RAPORTY_NAZWY_KANALOW.
// Zamówienia przechodzą przez prawdziwe mapery kanałów (Allegro, WooCommerce) i zapis pollera.
// Każdy ekran: 200, kanał klienta widoczny tam, gdzie ma być, zero nazw firmy autora i jej kanałów.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { zapiszProduktSklepowy, utworzWzoryZNiepowiazanych } from '../../src/oms/db/magazyn.js';
import { mapujZamowienieAllegro } from '../../src/domena/allegro-mapowanie.js';
import { metodaZId } from '../../src/domena/allegro-dostawa.js';
import { mapujZamowienie } from '../../src/domena/mapowanie.js';
import { wykonaj as zalozGranice } from '../../scripts/inicjalizuj-granice-bez-historii.mjs';
import { definicjeKanalowHistoryczne } from '../pomoc/kanaly-historyczne-fixture.js';

export const KANALY_KLIENTA = [
  { klucz: 'allegro_zetaklient', typ: 'allegro', prefiks: 'ALLEGRO_ZETAKLIENT', etykieta: 'Allegro Zetaklient', raport: 'ALLEGRO_ZETAKLIENT' },
  { klucz: 'woo_zetaklient', typ: 'woo', prefiks: 'WOO_ZETAKLIENT', etykieta: 'sklep.zetaklient.example', raport: 'SKLEP_ZETAKLIENT' },
];
// Fałszywe klucze: każda integracja „włączona”, żadna nie ma jak się połączyć (fetch odrzuca).
const KLUCZE = {
  ALLEGRO_ZETAKLIENT_CLIENT_ID: 'falszywy-id', ALLEGRO_ZETAKLIENT_CLIENT_SECRET: 'falszywy-sekret',
  ALLEGRO_ZETAKLIENT_USER_AGENT: 'ZetaklientOMS/1.0 (+https://zetaklient.example)', ALLEGRO_ZETAKLIENT_OD: '2026-10-01',
  WOO_ZETAKLIENT_URL: 'https://sklep.zetaklient.example', WOO_ZETAKLIENT_CK: 'ck_falszywy', WOO_ZETAKLIENT_CS: 'cs_falszywy',
  WOO_ZETAKLIENT_MAPOWANIE: JSON.stringify({ instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }),
  DPD_URL: 'https://dpd.zetaklient.example', DPD_LOGIN: 'falszywy', DPD_PASSWORD: 'falszywe', DPD_FID: '1',
  DPD_INFO_URL: 'https://dpdinfo.zetaklient.example', DPD_INFO_CHANNEL: 'falszywy',
  DPD_NADAWCA_NAZWA: 'Zetaklient sp. z o.o.', DPD_NADAWCA_ULICA: 'Klockowa 1', DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Warszawa',
  INFAKT_API_KEY: 'falszywy-infakt',
};
const NAZWY_RAPORTU = { ALLEGRO_ZETAKLIENT: 'Allegro Zetaklient', SKLEP_ZETAKLIENT: 'sklep.zetaklient.example' };

// Nazwy firmy autora (te same wzorce co strażnik paczki PRZ-060) i jej historyczne kanały z fixture testów.
const SLOWA_FIRMY = [/szkicownia/i, /lumina/i, /drugamarka/i, /trzeciamarka/i, /amarka/i, /zywiecki/i, /fundacja przyk/i, /\bGDD\b/];
function firmaW(tekst: string): string[] {
  const trafienia = SLOWA_FIRMY.filter(w => w.test(tekst)).map(String);
  for (const k of definicjeKanalowHistoryczne) {
    if (tekst.includes(k.etykieta)) trafienia.push(`etykieta ${k.etykieta}`);
    if (new RegExp(`(value="|kanal=|>)${k.klucz}("|&|<|$)`, 'm').test(tekst)) trafienia.push(`klucz ${k.klucz}`);
    if (k.raport && tekst.includes(k.raport)) trafienia.push(`raport ${k.raport}`);
  }
  return trafienia;
}

function pdftotext(): string | null {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return 'pdftotext'; } catch { /* poza PATH */ }
  const plik = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'poppler-25.07.0/Library/bin/pdftotext.exe');
  return process.env.LOCALAPPDATA && existsSync(plik) ? plik : null;
}

const surowyAllegro = {
  id: 'ab-062', updatedAt: '2026-10-05T07:00:00.000Z', status: 'READY_FOR_PROCESSING',
  buyer: { email: 'kupujacy@email.invalid', firstName: 'Kupujący', lastName: 'Syntetyczny', login: 'kupujacy062' },
  lineItems: [{ id: 'li-1', offer: { id: 'of-1', name: 'Klocek syntetyczny' }, quantity: 1, price: { amount: '50.00', currency: 'PLN' }, boughtAt: '2026-10-05T06:00:00.000Z' }],
  delivery: { method: { id: '03f26351-f683-4db2-8895-f2c599280e3c', name: 'Allegro Kurier DPD' }, cost: { amount: '0.00' },
    address: { firstName: 'Kupujący', lastName: 'Syntetyczny', street: 'Ulica 1', city: 'Miasto', zipCode: '00-001', countryCode: 'PL' } },
  payment: { type: 'ONLINE', finishedAt: '2026-10-05T06:01:00.000Z' },
  summary: { totalToPay: { amount: '50.00', currency: 'PLN' } },
};
const surowyWoo = {
  id: 701, number: 'W-701', status: 'processing', total: '123.00', date_paid: '2026-10-05T13:21:26', date_created: '2026-10-05T13:19:52',
  date_created_gmt: '2026-10-05T11:19:52', date_modified_gmt: '2026-10-05T11:19:52',
  billing: { first_name: 'Klient', last_name: 'Syntetyczny', email: 'k@email.invalid', phone: '', address_1: 'Ulica 2', postcode: '00-002', city: 'Miasto', country: 'PL' },
  shipping: { first_name: 'Klient', last_name: 'Syntetyczny', address_1: 'Ulica 2', postcode: '00-002', city: 'Miasto', country: 'PL' },
  shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }], shipping_total: '0.00', shipping_tax: '0.00',
  line_items: [{ id: 1, product_id: 55, name: 'Klocek sklepowy', sku: 'KL-1', quantity: 1, total: '100.00', total_tax: '23.00', subtotal: '100.00', subtotal_tax: '23.00' }],
  meta_data: [],
};

type Odp = { status: number; body: string; typ: string; surowe: Buffer };
async function zalogowany(srodowisko: Record<string, string>, przygotuj: (db: any) => void) {
  const a = await zbudujOms({ env: srodowisko });
  const db = a.db as any;
  zalozKonto(db, { login: 'operator062', imie: 'Operator', haslo: 'syntetyczne-haslo-062', rola: 'admin', admin: true });
  przygotuj(db);
  const login = await a.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'uzytkownik=operator062&haslo=syntetyczne-haslo-062&powrot=%2F' });
  expect(login.statusCode).toBe(302);
  const cookie = String(login.headers['set-cookie']).match(/sesja_oms=[^;]+/)![0];
  const get = async (url: string): Promise<Odp> => {
    const r = await a.app.inject({ url, headers: { cookie } });
    return { status: r.statusCode, body: r.body, typ: String(r.headers['content-type'] ?? ''), surowe: r.rawPayload };
  };
  const post = (url: string, pola: Record<string, string> = {}) => a.app.inject({ method: 'POST', url,
    headers: { cookie, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(pola).toString() });
  return { a, db, get, post };
}

describe('PRZ-062 panel na kanałach pod nazwami klienta', () => {
  let dir: string; let s: Awaited<ReturnType<typeof zalogowany>>; let idA: number; let idW: number;
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  beforeAll(async () => {
    fetchSpy.mockRejectedValue(new Error('Sieć zabroniona w teście PRZ-062'));
    dir = mkdtempSync(join(tmpdir(), 'prz062-kanaly-'));
    for (const k of ['proformy', 'etykiety']) mkdirSync(join(dir, k));
    const env: Record<string, string> = { OMS_TRYB: 'produkcja', OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
      OMS_USER: 'serwis062', OMS_PASS: 'syntetyczne-serwisowe-062', OMS_DB_PATH: join(dir, 'oms.sqlite'),
      OMS_PROFORMY_KATALOG: join(dir, 'proformy'), OMS_ETYKIETY_KATALOG: join(dir, 'etykiety'),
      OMS_KANALY: JSON.stringify(KANALY_KLIENTA), OMS_RAPORTY_NAZWY_KANALOW: JSON.stringify(NAZWY_RAPORTU), ...KLUCZE };
    s = await zalogowany(env, (db) => {
      // Krok instrukcji: granica raportu każdego kanału przed pierwszą sprzedażą (świeża baza bez historii).
      for (const r of ['ALLEGRO_ZETAKLIENT', 'SKLEP_ZETAKLIENT', 'RECZNE']) zalozGranice([env.OMS_DB_PATH, r, '2026-09-30'], env);
      idA = zapiszZamowienie(db, 'allegro_zetaklient', mapujZamowienieAllegro(surowyAllegro, { metodaZId }), surowyAllegro);
      idW = zapiszZamowienie(db, 'woo_zetaklient', mapujZamowienie(surowyWoo, { instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }), surowyWoo);
      const at = '2026-10-05T10:00:00Z';
      zapiszProduktSklepowy(db, { kanal: 'woo_zetaklient', produkt_id: 55, nazwa: 'Klocek sklepowy', sku_sklepu: 'KL-1', cena_gr: 12300, adres: 'https://sklep.zetaklient.example/klocek', odczytane_at: at });
      zapiszProduktSklepowy(db, { kanal: 'allegro_zetaklient', produkt_id: 'of-1', nazwa: 'Klocek syntetyczny', cena_gr: 5000, odczytane_at: at });
      utworzWzoryZNiepowiazanych(db, { kanalySklepow: ['woo_zetaklient'] } as any);
    });
  }, 120_000);
  afterAll(async () => {
    await s?.a.app.close(); s?.db.close(); fetchSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  const czysty = (url: string, o: Odp) => expect({ url, firma: firmaW(o.body) }).toEqual({ url, firma: [] });

  it('lista i menu filtra: oba kanały pod etykietami klienta, filtr zawęża do właściwego kanału', async () => {
    const lista = await s.get('/?wszystkie=1');
    expect(lista.status).toBe(200); czysty('/', lista);
    expect(lista.body).toContain('<option value="allegro_zetaklient">Allegro Zetaklient</option>');
    expect(lista.body).toContain('<option value="woo_zetaklient">sklep.zetaklient.example</option>');
    for (const numer of ['ab-062', 'W-701']) expect(lista.body).toContain(numer);
    for (const [kanal, jest, nieMa] of [['allegro_zetaklient', 'ab-062', 'W-701'], ['woo_zetaklient', 'W-701', 'ab-062']]) {
      const r = await s.get(`/?wszystkie=1&kanal=${kanal}`);
      expect(r.status).toBe(200); czysty(kanal, r);
      expect(r.body).toContain(`<option value="${kanal}" selected`);
      expect(r.body).toContain(jest); expect(r.body).not.toContain(`>${nieMa}<`);
    }
  });

  it('karta zamówienia każdego kanału: 200, kanał klienta, bez firmy autora', async () => {
    for (const [id, kanal, numer] of [[idA, 'allegro_zetaklient', 'ab-062'], [idW, 'woo_zetaklient', 'W-701']] as const) {
      const r = await s.get(`/zamowienia/${id}`);
      expect(r.status).toBe(200); czysty(`karta ${kanal}`, r);
      expect(r.body).toContain(numer); expect(r.body).toContain(kanal);
    }
  });

  it('proforma (PDF) i ekran nadania: dane sprzedawcy i nadawcy klienta, zero firmy autora', async () => {
    const wyst = await s.post(`/zamowienia/${idW}/proforma`);
    expect(wyst.statusCode).toBe(302);
    const pdf = await s.get('/proformy/1/pdf');
    expect(pdf.status).toBe(200); expect(pdf.typ).toContain('pdf');
    expect(pdf.surowe.subarray(0, 4).toString()).toBe('%PDF');
    const nadaj = await s.get(`/zamowienia/${idW}/nadaj`);
    expect(nadaj.status).toBe(200); czysty('nadaj woo', nadaj);
    expect(nadaj.body).toContain('https://sklep.zetaklient.example/?post_type=product&amp;p=55');
  });

  // Treść PDF jest skompresowana: bez pdftotext ta część jest JAWNIE pominięta (recenzja D8 r1), nie zielona.
  it.skipIf(!pdftotext())('treść proformy (pdftotext): sprzedawca klienta, zero firmy autora', async () => {
    const pdf = await s.get('/proformy/1/pdf');
    const plik = join(dir, 'proforma.pdf'); writeFileSync(plik, pdf.surowe);
    const tekst = execFileSync(pdftotext()!, ['-layout', '-enc', 'UTF-8', plik, '-'], { encoding: 'utf8' });
    expect(firmaW(tekst)).toEqual([]);
    for (const f of ['Zetaklient sp. z o.o.', 'Klockowa 1', 'NIP: 1234563218', 'Klocek sklepowy']) expect(tekst).toContain(f);
  });

  it('cennik „Dodaj z magazynu”: sklep klienta jako cennik, ceny z jego katalogu (Allegro nigdy cennikiem)', async () => {
    const nowe = await s.get('/zamowienia/nowe');
    expect(nowe.status).toBe(200); czysty('nowe', nowe);
    expect(nowe.body).toContain('<option value="woo_zetaklient" selected>sklep.zetaklient.example</option>');
    expect(nowe.body).not.toContain('<option value="allegro_zetaklient"');
    const wyniki = await s.get('/zamowienia/nowe/magazyn/wyniki?magazyn=Klocek');
    expect(wyniki.status).toBe(200); czysty('wyniki nowe', wyniki);
    expect(wyniki.body).toContain('Klocek sklepowy'); expect(wyniki.body).toContain("123.00 zł");
    const karta = await s.get(`/zamowienia/${idA}/magazyn/wyniki?magazyn=Klocek`);
    expect(karta.status).toBe(200); czysty('wyniki karty allegro', karta);
    expect(karta.body).toContain('Klocek sklepowy');
  });

  it('raport sprzedaży, eksport CSV i statystyki liczą oba kanały pod nazwami klienta', async () => {
    const r = await s.get('/raporty?od=2026-10-01&do=2026-10-31');
    expect(r.status, r.body.slice(0, 300)).toBe(200); czysty('raporty', r);
    expect(r.body).toContain('<span class="kanal-nazwa">Allegro Zetaklient</span>');
    expect(r.body).toContain('<span class="kanal-nazwa">sklep.zetaklient.example</span>');
    const csv = await s.get('/raporty/eksport.csv?od=2026-10-01&do=2026-10-31');
    expect(csv.status).toBe(200); czysty('csv', csv);
    const wiersze = csv.body.replace(/^﻿/, '').trim().split(/\r?\n/);
    expect(wiersze.slice(1).sort()).toEqual([
      '2026-10-05;ALLEGRO_ZETAKLIENT;ab-062;OMS;50,00;40,65;nie;tak',
      '2026-10-05;SKLEP_ZETAKLIENT;W-701;OMS;123,00;100,00;nie;tak',
    ]);
    const st = await s.get('/statystyki?od=2026-10-01&do=2026-10-31');
    expect(st.status).toBe(200); czysty('statystyki', st);
    // Zamówienie z allegro_zetaklient rozpoznane jako Allegro (rozkład płatności je pomija).
    expect(st.body).toMatch(/<strong>1<\/strong> zamówień tego kanału stoi poza/);
  });

  it('magazyn: lista, karta wzoru i powiązania pokazują kanały klienta pod etykietami', async () => {
    for (const url of ['/magazyn', '/magazyn/1', '/magazyn/powiazania', '/magazyn/pominiete']) {
      const r = await s.get(url);
      expect(r.status).toBe(200); czysty(url, r);
    }
    const lista = await s.get('/magazyn');
    expect(lista.body).toContain('<option value="woo_zetaklient">sklep.zetaklient.example</option>');
    expect(lista.body).toContain('<option value="allegro_zetaklient">Allegro Zetaklient</option>');
    expect(lista.body).toContain('Klocek sklepowy');
    const wzor = await s.get('/magazyn/1');
    expect(wzor.body).toMatch(/sklep\.zetaklient\.example · KL-1/);
    const pow = await s.get('/magazyn/powiazania');
    expect(pow.body).toContain('Klocek syntetyczny'); expect(pow.body).toContain('Allegro Zetaklient');
  });

  it('przesyłki, faktury, integracje i /health: kanały klienta, alarmy łączności bez 500', async () => {
    for (const url of ['/przesylki', '/faktury', '/ustawienia/integracje', '/ustawienia/zamowienia-i-wysylka']) {
      const r = await s.get(url);
      expect(r.status, url).toBe(200); czysty(url, r);
    }
    expect((await s.get('/ustawienia/integracje')).body).toContain('/ustawienia/kanaly/allegro_zetaklient/wiazanie');
    const h = await s.get('/health');
    expect(h.status).toBe(200); czysty('health', h);
    const j = JSON.parse(h.body);
    expect(JSON.stringify(j.alarmy)).not.toMatch(/OMS_KANALY|brak kompletnej konfiguracji/);
  });
});

describe('PRZ-062 instalacja bez kanałów: pusto jawnie, nie po firmie autora', () => {
  it('menu, cennik, magazyn i raport bez definicji kanałów nie pokazują kanałów firmy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const dir = mkdtempSync(join(tmpdir(), 'prz062-pusto-'));
    const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'serwis062', OMS_PASS: 'syntetyczne-serwisowe-062',
      OMS_PROFORMY_KATALOG: dir, OMS_ETYKIETY_KATALOG: dir, OMS_KANALY: '[]' };
    const s = await zalogowany(env, () => {});
    try {
      const lista = await s.get('/');
      expect(lista.status).toBe(200); expect(firmaW(lista.body)).toEqual([]);
      const opcje = [...lista.body.matchAll(/<option value="([^"]*)"[^>]*>[^<]*<\/option>/g)].map(m => m[1]);
      // PRZ-089: „Indywidualne” (panel zamówień indywidualnych autora) tylko z OMS_KANAL_INDYWIDUALNY.
      expect(opcje).toContain('reczne'); expect(opcje).not.toContain('indywidualne');
      expect(opcje.filter(o => definicjeKanalowHistoryczne.some(k => k.klucz === o))).toEqual([]);
      const nowe = await s.get('/zamowienia/nowe');
      expect(nowe.status).toBe(200); expect(firmaW(nowe.body)).toEqual([]);
      const magazyn = await s.get('/magazyn');
      expect(magazyn.status).toBe(200); expect(firmaW(magazyn.body)).toEqual([]);
      expect(magazyn.body).toContain('nie ma podpiętego żadnego sklepu');
      const raport = await s.get('/raporty?od=2026-10-01&do=2026-10-31');
      expect(raport.status).toBe(200); expect(firmaW(raport.body)).toEqual([]);
    } finally { await s.a.app.close(); s.db.close(); fetchSpy.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
