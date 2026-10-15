import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszHistorie } from '../../../src/oms/db/historia-sprzedazy.js';
import { zbudujSpecyfikacjePdf, zbudujSpecyfikacjeWieluPdf } from '../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js';

afterEach(() => vi.unstubAllGlobals());
const AUTH = { authorization: 'Basic ' + Buffer.from('operator:fikcyjne').toString('base64') };
const envBazowe = {
  OMS_SPRZEDAWCA_NIP: 'PL 123-456-32-18', OMS_RACHUNEK: '34109010140000000000000000',
  DPD_NADAWCA_NAZWA: 'Firma testowa Żółw', DPD_NADAWCA_ULICA: 'Testowa 1',
  DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Miasto', DPD_NADAWCA_KRAJ: 'PL',
  OMS_USER: 'operator', OMS_PASS: 'fikcyjne', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir(),
  OMS_KANALY: JSON.stringify([{ klucz: 'polnoc', typ: 'woo', prefiks: 'POLNOC', raport: 'POLNOC' }]),
  POLNOC_URL: 'https://polnoc.invalid', POLNOC_CK: 'fikcyjny', POLNOC_CS: 'fikcyjny',
  POLNOC_MAPOWANIE: JSON.stringify({ instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] }),
  POLNOC_OD: '2026-01-01', POLNOC_HISTORIA_KONTO_APILO: '17',
  OMS_HISTORIA_KLASYFIKACJA: JSON.stringify({ konta: [{ konto: 17, raport: 'POLNOC' }] }),
};
async function odczytajPdf(buf) {
  const katalog = mkdtempSync(join(tmpdir(), 'prz021-pdf-'));
  try {
    const fallback = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftotext.exe');
    const plik = join(katalog, 'dokument.pdf');
    writeFileSync(plik, buf);
    const tekst = execFileSync(existsSync(fallback) ? fallback : 'pdftotext', ['-layout', '-enc', 'UTF-8', plik, '-'], { encoding: 'utf8' });
    const pdf = await PDFDocument.load(buf);
    return { tekst, autor: pdf.getAuthor(), strony: tekst.split('\f').filter(s => s.trim()) };
  } finally { rmSync(katalog, { recursive: true, force: true }); }
}
function zamowienie(db, email = 'firma@wdt.invalid') {
  return zapiszZamowienie(db, 'polnoc', {
    zrodlo_id: 1, numer: 'WDT-TEST', klient: { email, first_name: 'Klient' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '123.00', koszt_dostawy_brutto: '0.00', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-08-01T12:00:00Z', status_woo: 'processing',
    pozycje: [{ nazwa: 'Towar', sku: 'TEST', ilosc: 1, cena_brutto: '123.00', brutto_linii: '123.00', vat: null }],
  }, {});
}
async function specyfikacja(a, email) {
  const id = zamowienie(a.db, email);
  const r = await a.app.inject({ url: `/zamowienia/${id}/specyfikacja.pdf`, headers: AUTH });
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toContain('application/pdf');
  return odczytajPdf(r.rawPayload);
}
function przygotujOdczytHistorii(email) {
  // Prawdziwy klient Woo i importer; podmieniona jest wyłącznie granica HTTP.
  const fetch = vi.fn(async () => new Response(JSON.stringify([{
    id: 1, number: 'WDT-TEST', status: 'completed', total: '123.00', currency: 'PLN',
    date_created_gmt: '2025-08-01T12:00:00', date_paid_gmt: '2025-08-01T12:00:00',
    billing: { email }, line_items: [], shipping_lines: [], fee_lines: [],
  }]), { headers: { 'X-WP-TotalPages': '1', 'X-WP-Total': '1' } }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
async function importuj(a, fetch) {
  zapiszHistorie(a.db, { apiloId: 'sufit-testowy', platformAccountId: 17, dzien: '2026-01-01',
    utworzoneAt: '2026-01-01T12:00:00Z', brutto: '1.00', pozycje: [] });
  const r = await a.usluga('kanaly', 'importySklepow').polnoc.przebieg({ od: '2025-08-01', doDnia: '2025-08-01' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0][0])).toContain('polnoc.invalid/wp-json/wc/v3/orders');
  return r;
}

describe('PRZ-021: rzeczywisty PDF bez danych dawnej firmy', () => {
  it.each(['Firma testowa Żółw', 'Pracownia testowa Łódź'])('HTTP bierze stopkę, autora i znormalizowany NIP z konfiguracji: %s', async nazwa => {
    const a = await zbudujOms({ env: { ...envBazowe, DPD_NADAWCA_NAZWA: nazwa } });
    try {
      const p = await specyfikacja(a);
      expect(p.tekst).toContain(`Wystawiono w panelu zamówień ${nazwa}`);
      expect(p.tekst).not.toContain('Szkicownia');
      expect(p.autor).toBe(nazwa);
      expect(p.tekst).toContain('NIP: 1234563218');
      expect(p.tekst).not.toContain('PL 123-456-32-18');
    } finally { await a.app.close(); a.db.close(); }
  });
  it('stopka konfigurowana i zastrzeżenie pozostają na każdej stronie kontynuacji oraz kolejnego zamówienia', async () => {
    const dane = { numer: 'TEST', sprzedawca: { nazwa: 'Firma testowa Żółw' },
      pozycje: Array.from({ length: 35 }, (_, i) => ({ nazwa: `Towar ${i}`, ilosc: 1, cenaZl: '1.00', wartoscZl: '1.00' })) };
    const p = await odczytajPdf(await zbudujSpecyfikacjeWieluPdf([dane, { ...dane, numer: 'DRUGI', pozycje: [] }]));
    expect(p.strony.length).toBeGreaterThanOrEqual(3);
    for (const strona of p.strony) {
      expect(strona).toContain('Wystawiono w panelu zamówień Firma testowa Żółw');
      expect(strona).toContain('Dokument informacyjny — nie jest fakturą VAT ani paragonem fiskalnym.');
      expect(strona).not.toContain('Szkicownia');
    }
    expect(p.autor).toBe('Firma testowa Żółw');
  });
  it.each(['pojedynczy', 'wiele'])('brak nazwy nie przywraca dawnej marki: %s', async wariant => {
    const p = await odczytajPdf(await (wariant === 'pojedynczy' ? zbudujSpecyfikacjePdf({ numer: 'TEST' }) : zbudujSpecyfikacjeWieluPdf([{ numer: 'TEST' }])));
    expect(p.tekst).toContain('Wystawiono w panelu zamówień');
    expect(p.tekst).not.toContain('Szkicownia');
    expect(p.autor).toBe('Twój OMS');
  });
});

describe('PRZ-021: jedna lista WDT w kompozycji zamówień i historii', () => {
  it.each(['OMS_KLIENCI_WDT', 'OMS_HISTORIA_MAILE_WDT'])('%s ustawione pojedynczo: PDF netto 123,00 zł i import zatrzymany przed utratą klasyfikacji WDT', async zmienna => {
    const fetch = przygotujOdczytHistorii('firma@wdt.invalid');
    const a = await zbudujOms({ env: { ...envBazowe, [zmienna]: ' FIRMA@WDT.INVALID ' } });
    try {
      const p = await specyfikacja(a);
      expect(p.tekst).toMatch(/w tym netto\s+123\.00 PLN/);
      const r = await importuj(a, fetch);
      expect(r).toMatchObject({ zatrzymany: true, pobranych: 0, powod: expect.stringContaining('klient WDT') });
      expect(a.db.prepare("SELECT COUNT(*) AS ile FROM sprzedaz_historyczna WHERE zrodlo='woo:polnoc'").get().ile).toBe(0);
    } finally { await a.app.close(); a.db.close(); }
  });
  it('klient poza listą: rzeczywisty PDF netto 100,00 zł, a import zapisuje 123,00 zł brutto bez danych osobowych', async () => {
    const fetch = przygotujOdczytHistorii('inny@example.invalid');
    const a = await zbudujOms({ env: { ...envBazowe, OMS_KLIENCI_WDT: 'firma@wdt.invalid' } });
    try {
      const p = await specyfikacja(a, 'inny@example.invalid');
      expect(p.tekst).toMatch(/w tym netto\s+100\.00 PLN/);
      expect(await importuj(a, fetch)).toMatchObject({ zatrzymany: false, pobranych: 1 });
      expect(a.db.prepare("SELECT brutto,klient_email,klient_nazwa FROM sprzedaz_historyczna WHERE zrodlo='woo:polnoc'").get())
        .toEqual({ brutto: '123.00', klient_email: null, klient_nazwa: null });
    } finally { await a.app.close(); a.db.close(); }
  });
  it('równoważne listy po normalizacji, zmianie kolejności i usunięciu duplikatów nie są konfliktem', async () => {
    const a = await zbudujOms({ env: { ...envBazowe, OMS_KLIENCI_WDT: ' FIRMA@WDT.INVALID, drugi@wdt.invalid, firma@wdt.invalid ',
      OMS_HISTORIA_MAILE_WDT: 'drugi@wdt.invalid,firma@wdt.invalid' } });
    try {
      const k = a.usluga('zamowienia', 'config');
      const h = a.usluga('kanaly', 'config').sklepy.polnoc.historia;
      expect([...k.klienciWdt].sort()).toEqual(['drugi@wdt.invalid', 'firma@wdt.invalid']);
      expect([...h.klienciWdt].sort()).toEqual([...k.klienciWdt].sort());
    } finally { await a.app.close(); a.db.close(); }
  });
  it.each([
    ['firma@wdt.invalid', 'inny@wdt.invalid'], ['', 'firma@wdt.invalid'], ['firma@wdt.invalid', ''],
  ])('konflikt canonical=%j i legacy=%j odmawia kompozycji, zamiast zgadywać listę', async (canonical, legacy) => {
    let aplikacja; let blad;
    try {
      aplikacja = await zbudujOms({ env: { ...envBazowe, OMS_KLIENCI_WDT: canonical, OMS_HISTORIA_MAILE_WDT: legacy } });
    } catch (e) { blad = e; }
    finally { if (aplikacja) { await aplikacja.app.close(); aplikacja.db.close(); } }
    // Nie przekazujemy do Chai obiektu Fastify, również gdy mutant błędnie wystartuje.
    expect(blad).toBeInstanceOf(Error);
    expect(blad?.message).toMatch(/Konflikt OMS_KLIENCI_WDT i OMS_HISTORIA_MAILE_WDT/);
  });
});
