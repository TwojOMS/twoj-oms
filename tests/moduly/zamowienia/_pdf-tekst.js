import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Odczyt POWROTNY PDF-a `pdftotext`-em dla testow wydrukow z menu „Wydruki" (PRZ-084). Ta sama
// detekcja poppera, co w specyfikacja-pdf.test.js: tylko odczyt powrotny dowodzi, ze w pliku
// siedza prawdziwe litery (font z polskimi znakami), a poppera NIE MA w kontenerze na NAS-ie —
// brak binarki POMIJA testy tresci z ostrzezeniem, nie wywraca suity.
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

export const PDFTOTEXT = znajdzPdftotext();
if (!PDFTOTEXT) {
  // eslint-disable-next-line no-console
  console.warn('[wydruki] pdftotext (poppler) nie znaleziony — testy tresci PDF-a POMINIETE.');
}

/** PDF → tekst (bez `-layout`: kolejnosc czytania, komorki tabeli w osobnych liniach). */
export function pdfNaTekst(buf, { uklad = false } = {}) {
  const kat = mkdtempSync(path.join(tmpdir(), 'wydruki-'));
  try {
    const plik = path.join(kat, 'p.pdf');
    writeFileSync(plik, buf);
    return execFileSync(PDFTOTEXT, [...(uklad ? ['-layout'] : []), '-enc', 'UTF-8', plik, '-'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    rmSync(kat, { recursive: true, force: true });
  }
}

/** Liczba stron — `pdftotext` rozdziela je znakiem wysuwu (\f). */
export const liczbaStron = (tekst) => tekst.split('\f').filter((s) => s.trim() !== '').length;
