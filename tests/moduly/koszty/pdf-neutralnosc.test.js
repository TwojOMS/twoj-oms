import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { zbudujKosztPdf } from '../../../src/moduly/koszty/pdf/koszt-pdf.js';

const STOPKA = 'Wyrysowana w panelu zamówień z pliku pobranego z KSeF.';
function pdftotext() {
  try { execFileSync('pdftotext', ['-v'], { stdio:'ignore' }); return 'pdftotext'; }
  catch { /* instalacja winget poza PATH */ }
  const plik = join(process.env.LOCALAPPDATA ?? '',
    'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'poppler-25.07.0/Library/bin/pdftotext.exe');
  if (process.env.LOCALAPPDATA && existsSync(plik)) return plik;
  throw new Error('Brak pdftotext: neutralność PDF nie została zmierzona');
}
function stronyZPdf(buf) {
  const binarka = pdftotext();
  const katalog = mkdtempSync(join(tmpdir(), 'prz025-pdf-neutralne-'));
  try {
    const plik = join(katalog, 'koszt.pdf'); writeFileSync(plik, buf);
    return execFileSync(binarka, ['-layout','-enc','UTF-8',plik,'-'], {encoding:'utf8'})
      .split('\f').filter(s => s.trim() !== '');
  } finally {
    const cel = resolve(katalog);
    if (dirname(cel) !== resolve(tmpdir()) || !basename(cel).startsWith('prz025-pdf-neutralne-'))
      throw new Error('Nieprawidłowy katalog fixture');
    rmSync(cel, {recursive:true,force:true});
  }
}
const wiersz = { numer_dokumentu:'FV/FIXTURE',sprzedawca_nazwa:'Dostawca fixture',
  sprzedawca_nip:'1111111111',data_wystawienia:'2026-06-05',netto:'100.00',vat:'23.00',
  brutto:'123.00',waluta:'PLN',rodzaj:'Vat',ksef_number:'K-FIXTURE' };
describe('PRZ-025 neutralność wydruku kosztu', () => {
  it('jedna strona zawiera neutralną stopkę bez Szkicownia', async () => {
    const strony = stronyZPdf(await zbudujKosztPdf({wiersz,pozycje:[]}));
    expect(strony).toHaveLength(1);
    expect(strony[0]).not.toContain('Szkicownia');
    expect(strony[0]).toContain(STOPKA);
  });
  it('każda strona, także ostatnia, zawiera neutralną stopkę bez Szkicownia', async () => {
    const pozycje = Array.from({length:60}, (_,i) => ({lp:String(i+1),nazwa:'Papier fixture',
      jednostka:'szt',ilosc:'2',cenaNetto:'18.50',wartoscNetto:'37.00',stawkaVat:'23%'}));
    const strony = stronyZPdf(await zbudujKosztPdf({wiersz,pozycje}));
    expect(strony.length).toBeGreaterThan(1);
    for (const strona of strony) {
      expect(strona).not.toContain('Szkicownia');
      expect(strona).toContain(STOPKA);
    }
  });
});
