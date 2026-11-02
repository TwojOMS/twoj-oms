// AS4 (PRZ-122): nabywca bez adresu nigdzie nie daje zlepka „—, — —, PL”. Ekran faktury TwojeFaktury ma własny test (B14f2);
// tu PDF proformy (drugi z kodu, który składa adres nabywcy): puste części znikają, nie zamieniają się w „—”.
// Dane zmyślone, bez sieci.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zbudujProformePdf } from '../../../src/moduly/faktury/pdf/proforma-pdf.js';

function tekstPdf(dane) {
  const katalog = mkdtempSync(path.join(tmpdir(), 'as4-'));
  try {
    const plik = path.join(katalog, 'p.pdf');
    writeFileSync(plik, zbudujProformePdf(dane));
    return execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', plik, '-'], { encoding: 'utf8' });
  } finally { rmSync(katalog, { recursive: true, force: true }); }
}

describe('AS4: nabywca bez adresu w PDF proformy', () => {
  it('nie wypisuje „—, —” ani samotnego „—” w bloku nabywcy; nazwa i kraj zostają', () => {
    const tekst = tekstPdf({
      numer: 'PF/1/2026', dataWystawienia: '2026-10-28',
      sprzedawca: { nazwa: 'Pracownia Półcień', ulica: 'Lampowa 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL', nip: '1234563218' },
      nabywca: { nazwa: 'Jan Przykładowy', kraj: 'PL' },
      pozycje: [], podsumowanieVat: [],
    });
    expect(tekst).toContain('Jan Przykładowy');
    expect(tekst).not.toMatch(/—,\s*—/);
    expect(tekst).not.toContain('—');
  });
});
