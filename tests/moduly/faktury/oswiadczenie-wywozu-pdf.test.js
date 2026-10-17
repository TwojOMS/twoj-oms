import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zbudujOswiadczenieWywozuPdf } from '../../../src/moduly/faktury/pdf/oswiadczenie-wywozu-pdf.js';
import { modelOswiadczenia } from '../../../src/domena/oswiadczenie-wywozu.js';

// Testy odczytu POWROTNEGO pdftotext-em — wykrycie poppera SKOPIOWANE z
// tests/oms/specyfikacja-pdf.test.js (tam z proforma-pdf.test.js): tylko odczyt powrotny
// dowodzi, ze w dokumencie sa prawdziwe polskie litery, a nie dziury po wbudowanym foncie.
const POPPLER_WINGET = path.join(
  process.env.LOCALAPPDATA ?? '',
  'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe',
  'poppler-25.07.0/Library/bin/pdftotext.exe',
);

function znajdzPdftotext() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return 'pdftotext';
  } catch {
    // brak na PATH — probujemy instalacji winget wlasciciela
  }
  return process.env.LOCALAPPDATA && existsSync(POPPLER_WINGET) ? POPPLER_WINGET : null;
}

const PDFTOTEXT = znajdzPdftotext();
if (!PDFTOTEXT) {
  // eslint-disable-next-line no-console
  console.warn('[oswiadczenie-wywozu-pdf] pdftotext nie znaleziony — testy odczytu POMINIETE.');
}

function tekstZPdf(bajty) {
  const katalog = mkdtempSync(path.join(tmpdir(), 'oswiadczenie-'));
  try {
    const plik = path.join(katalog, 'dokument.pdf');
    writeFileSync(plik, bajty);
    execFileSync(PDFTOTEXT, ['-layout', plik, path.join(katalog, 'dokument.txt')]);
    return readFileSync(path.join(katalog, 'dokument.txt'), 'utf8');
  } finally {
    rmSync(katalog, { recursive: true, force: true });
  }
}

const SPRZEDAWCA = {
  nazwa: 'Lumina Marek Zywiecki', ulica: '1 Maja 5', kod: '00-650', miasto: 'Pęki', nip: '1234563218',
};

const model = (nad = {}) => modelOswiadczenia({
  numer: 'R/2026/031',
  nip: 'SK1000000001',
  klient: {
    company: 'Alfatrend s.r.o.', address_1: '1. mája 1', postcode: '01001', city: 'Žilina',
  },
  faktura: { numer: 'WDT/1/08/2026' },
  pozycje: [
    { nazwa: 'Lampa stołowa Kałamarz 30x45cm', ilosc: 2 },
    { nazwa: 'Kurier DPD', ilosc: 1 },
  ],
  ...nad,
}, { sprzedawca: SPRZEDAWCA, dzis: '2026-08-26' });

describe('zbudujOswiadczenieWywozuPdf', () => {
  it('oddaje poprawny PDF', () => {
    const bajty = zbudujOswiadczenieWywozuPdf(model());
    expect(bajty.subarray(0, 4).toString()).toBe('%PDF');
    expect(bajty.length).toBeGreaterThan(1000);
  });

  it.skipIf(!PDFTOTEXT)('dokument niesie strony, numery, państwo i pola do wypełnienia', () => {
    const tekst = tekstZPdf(zbudujOswiadczenieWywozuPdf(model()));
    expect(tekst).toContain('Potwierdzenie wywozu towarów');
    expect(tekst).toContain('art. 42 ust. 4');
    expect(tekst).toContain('PL1234563218');
    expect(tekst).toContain('SK1000000001');
    expect(tekst).toContain('WDT/1/08/2026');
    expect(tekst).toContain('R/2026/031');
    expect(tekst).toContain('Słowacji');
    expect(tekst).toContain('Lampa stołowa Kałamarz 30x45cm');
    expect(tekst).toContain('Nr rejestracyjny');
    expect(tekst).toContain('podpis nabywcy');
    // Polskie znaki — jedyny test, ktory lapie zgubiony font.
    expect(tekst).toContain('Pęki');
    expect(tekst).toContain('Zywiecki');
  });

  it.skipIf(!PDFTOTEXT)('długa tabela łamie się na strony, a każda strona ma stopkę z numerem zamówienia', () => {
    const duzo = Array.from({ length: 45 }, (_, i) => ({ nazwa: `Lampa stołowa model ${i + 1} — 30x45cm`, ilosc: i + 1 }));
    const tekst = tekstZPdf(zbudujOswiadczenieWywozuPdf(model({ pozycje: duzo })));
    const strony = tekst.split('\f').filter((s) => s.trim() !== '');
    expect(strony.length).toBeGreaterThan(1);
    for (const strona of strony) {
      expect(strona).toContain('art. 42 ust. 4');
      expect(strona).toContain('R/2026/031');
    }
    // Blok podpisow jest w CALOSCI na ostatniej stronie.
    expect(strony.at(-1)).toContain('podpis nabywcy');
  });
});
