import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wczytajFaktury } from '../../../src/moduly/faktury/modul.ts';
import { zbudujProformePdf } from '../../../src/moduly/faktury/pdf/proforma-pdf.js';
import { zbudujOswiadczenieWywozuPdf } from '../../../src/moduly/faktury/pdf/oswiadczenie-wywozu-pdf.js';
import { modelOswiadczenia } from '../../../src/domena/oswiadczenie-wywozu.js';
import { podsumowanieVat } from '../../../src/domena/podsumowanie-vat.js';
import { kwotaSlownie } from '../../../src/domena/kwota-slownie.js';

function tekst(buf, katalog, nazwa) {
  const fallback = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftotext.exe');
  const program = existsSync(fallback) ? fallback : 'pdftotext';
  const p = join(katalog, nazwa + '.pdf'); writeFileSync(p, buf);
  return execFileSync(program, ['-layout', '-enc', 'UTF-8', p, '-'], { encoding: 'utf8' });
}
function metadane(katalog, nazwa) {
  const fallback = join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdfinfo.exe');
  return execFileSync(existsSync(fallback) ? fallback : 'pdfinfo', ['-enc', 'UTF-8', join(katalog, nazwa + '.pdf')], { encoding: 'utf8' });
}
describe('PDF: dane sprzedawcy przez rzeczywistą konfigurację', () => {
  it('obie stopki i metadane biorą nazwę z wejścia, bez domyślnego Szkicownia', () => {
    const katalog = mkdtempSync(join(tmpdir(), 'pdf-konfig-'));
    try {
      const k = wczytajFaktury({ OMS_PROFORMY_KATALOG: katalog, OMS_SPRZEDAWCA_NIP: '1234563218',
        OMS_RACHUNEK: '34109010140000000000000000', DPD_NADAWCA_NAZWA: 'Firma testowa Żółw',
        DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Miasto' });
      const sprzedawca = { ...k.nadawca, nip: k.proforma.nip };
      const pozycje = [{ name: 'Towar', quantity: 1, gross_price: 12300, tax_symbol: '23' }];
      const proforma = zbudujProformePdf({ numer: 'PF/TEST', sprzedawca, nabywca: { nazwa: 'Nabywca' },
        pozycje, podsumowanieVat: podsumowanieVat(pozycje), doZaplatyGr: 12300,
        slownie: kwotaSlownie(12300), rachunek: k.proforma.rachunek });
      const model = modelOswiadczenia({ numer: 'WDT/TEST', nip: 'SK1000000001',
        klient: { company: 'Firma UE', address_1: 'Testowa 2' }, dostawa: {},
        pozycje: [{ nazwa: 'Towar', ilosc: 1 }] }, { sprzedawca });
      const wywoz = zbudujOswiadczenieWywozuPdf(model);
      for (const [nazwa, pdf] of [['proforma', proforma], ['wywoz', wywoz]]) {
        const t = tekst(pdf, katalog, nazwa);
        expect(t).toContain('Wystawiono w panelu zamówień Firma testowa Żółw');
        expect(t).not.toContain('Szkicownia');
        expect(metadane(katalog, nazwa)).toMatch(/Author:\s+Firma testowa Żółw/);
      }
      expect(tekst(wywoz, katalog, 'wywoz')).toContain('PL1234563218');
    } finally { rmSync(katalog, { recursive: true, force: true }); }
  });
});
