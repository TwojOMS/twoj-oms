import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszKoszt, zapiszRecznyKoszt, zapiszOdrzuconyKoszt,
} from '../../../src/oms/db/koszty.js';
import { createZestawienieKosztow } from '../../../src/moduly/koszty/services/zestawienie-kosztow.js';

// ⚠️ Wykrycie `pdftotext` jak w koszt-pdf.test.js: brak binarki POMIJA tylko testy czytajace
// tekst z PDF-a (z glosnym ostrzezeniem). Podzial na dwie czesci pilnuje tez test domeny
// (tests/domena/zestawienie-kosztow-domena.test.js), ktory poppleru nie potrzebuje.
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
    return process.env.LOCALAPPDATA && existsSync(POPPLER_WINGET) ? POPPLER_WINGET : null;
  }
}
const PDFTOTEXT = znajdzPdftotext();
if (!PDFTOTEXT) {
  // eslint-disable-next-line no-console
  console.warn('[zestawienie-kosztow] pdftotext nie znaleziony — testy tekstu z PDF-a POMINIETE.');
}
const gdyJestPdftotext = PDFTOTEXT ? it : it.skip;
const tekstZPdf = (buf) => {
  const kat = mkdtempSync(join(tmpdir(), 'zest-kosztow-'));
  const plik = join(kat, 'a.pdf');
  writeFileSync(plik, buf);
  return execFileSync(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', plik, '-'], { encoding: 'utf8' });
};
const liniaZ = (tekst, czego) => tekst.split('\n').find((l) => l.includes(czego)) ?? '';

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}` };

const ksef = (n = {}) => ({
  ksefNumber: 'K-A', numerDokumentu: 'FV-KSEF-A', sprzedawcaNip: '5252674798', sprzedawcaNazwa: 'OVH',
  dataWystawienia: '2026-08-04', dataTrwalegoZapisu: '2026-08-04T10:00:00Z',
  netto: '100.00', vat: '23.00', brutto: '123.00', waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...n,
});
const reczny = (n = {}) => ({
  numerDokumentu: 'INV-META-1', sprzedawcaNip: '', sprzedawcaNazwa: 'Meta',
  dataWystawienia: '2026-08-10', netto: '50.00', vat: '0.00', brutto: '50.00', waluta: 'PLN', ...n,
});

// Sierpien: dwie z KSeF (369,00 brutto) i dwie reczne (80,00 brutto); poza miesiacem po jednej.
function zasiej(db) {
  zapiszKoszt(db, ksef());
  zapiszKoszt(db, ksef({
    ksefNumber: 'K-B', numerDokumentu: 'FV-KSEF-B', sprzedawcaNazwa: 'Plastics Group',
    dataTrwalegoZapisu: '2026-08-06T10:00:00Z', netto: '200.00', vat: '46.00', brutto: '246.00',
  }));
  zapiszKoszt(db, ksef({
    ksefNumber: 'K-LIP', numerDokumentu: 'FV-KSEF-LIP', dataWystawienia: '2026-07-20',
    dataTrwalegoZapisu: '2026-07-20T10:00:00Z',
  }));
  zapiszRecznyKoszt(db, reczny());
  zapiszRecznyKoszt(db, reczny({
    numerDokumentu: 'INV-GOOGLE-1', sprzedawcaNazwa: 'Google', dataWystawienia: '2026-08-15',
    netto: '30.00', brutto: '30.00',
  }));
  zapiszRecznyKoszt(db, reczny({ numerDokumentu: 'INV-WRZ', dataWystawienia: '2026-09-02' }));
}

describe('zestawienie kosztów — usługa', () => {
  it('buduje JEDEN PDF z dwiema częściami i liczy dokumenty każdej z nich', async () => {
    const db = openOmsDb(':memory:');
    zasiej(db);
    const w = await createZestawienieKosztow({ db, teraz: () => new Date('2026-09-03T10:00:00Z') }).zbuduj('2026-08');
    expect(w.nazwa).toBe('zestawienie-kosztow-2026-08.pdf');
    expect(w.ksef).toBe(2);
    expect(w.reczne).toBe(2);
    const pdf = await PDFDocument.load(w.bajty);
    expect(pdf.getTitle()).toBe('Zestawienie kosztów — sierpień 2026');
    expect(pdf.getPageCount()).toBe(w.stron);
  });

  it('⚠️ nie sięga po KSeF ani inFakt — wystarczy baza (żadnej usługi sieciowej w zależnościach)', async () => {
    const db = openOmsDb(':memory:');
    zasiej(db);
    // Fabryka dostaje WYLACZNIE `db` i zegar. Gdyby `zbuduj` siegal po cokolwiek innego,
    // rzucilby na `undefined`.
    await expect(createZestawienieKosztow({ db }).zbuduj('2026-08')).resolves.toBeTruthy();
  });

  it('⚠️ kryterium to dzień OTRZYMANIA (jak w paczce), nie data wystawienia: lipcowa faktura odebrana 2 sierpnia jest w sierpniu', async () => {
    const db = openOmsDb(':memory:');
    zapiszKoszt(db, ksef({
      ksefNumber: 'K-GRANICA', numerDokumentu: 'FV-31-LIP', dataWystawienia: '2026-07-31',
      dataTrwalegoZapisu: '2026-08-02T08:00:00Z',
    }));
    const z = createZestawienieKosztow({ db });
    expect((await z.zbuduj('2026-08')).ksef).toBe(1);
    expect((await z.zbuduj('2026-07')).ksef).toBe(0);
  });

  it('zły miesiąc odmawia zdaniem dla człowieka, a nie pustym PDF-em', async () => {
    const z = createZestawienieKosztow({ db: openOmsDb(':memory:') });
    await expect(z.zbuduj('2026-8')).rejects.toMatchObject({ dlaOperatora: true });
    await expect(z.zbuduj(undefined)).rejects.toMatchObject({ dlaOperatora: true });
  });

  gdyJestPdftotext('⚠️ w PDF-ie KSeF i ręczne stoją pod OSOBNYMI nagłówkami, w tej kolejności', async () => {
    const db = openOmsDb(':memory:');
    zasiej(db);
    const t = tekstZPdf((await createZestawienieKosztow({ db }).zbuduj('2026-08')).bajty);
    const poz = (s) => t.indexOf(s);
    const [hK, hR] = [poz('Faktury kosztowe z KSeF'), poz('Faktury dopisane ręcznie')];
    expect(hK).toBeGreaterThanOrEqual(0);
    expect(hR).toBeGreaterThan(hK);
    // KSeF-owe PRZED naglowkiem recznych, reczne ZA nim — i zadne nie przeskakuje.
    expect(poz('FV-KSEF-A')).toBeGreaterThan(hK);
    expect(poz('FV-KSEF-B')).toBeGreaterThan(hK);
    expect(poz('FV-KSEF-B')).toBeLessThan(hR);
    expect(poz('INV-META-1')).toBeGreaterThan(hR);
    expect(poz('INV-GOOGLE-1')).toBeGreaterThan(hR);
    // Dokumenty spoza miesiaca nie wchodza do zadnej czesci.
    expect(t).not.toContain('FV-KSEF-LIP');
    expect(t).not.toContain('INV-WRZ');
    // Zdanie o oryginałach stoi RAZ (pod nagłówkiem części ręcznej), a nie w każdym wierszu.
    expect(t.match(/dołącz/g)).toHaveLength(1);
    expect(poz('dołącz')).toBeGreaterThan(hR);
  });

  gdyJestPdftotext('sumy: osobno KSeF, osobno ręczne i łącznie', async () => {
    const db = openOmsDb(':memory:');
    zasiej(db);
    const t = tekstZPdf((await createZestawienieKosztow({ db }).zbuduj('2026-08')).bajty);
    expect(liniaZ(t, 'Razem KSeF PLN')).toContain('369,00');
    expect(liniaZ(t, 'Razem ręczne PLN')).toContain('80,00');
    expect(liniaZ(t, 'Razem łącznie PLN')).toContain('449,00');
  });

  gdyJestPdftotext('bez faktur ręcznych część ręczna mówi to wprost, zamiast znikać', async () => {
    const db = openOmsDb(':memory:');
    zapiszKoszt(db, ksef());
    const t = tekstZPdf((await createZestawienieKosztow({ db }).zbuduj('2026-08')).bajty);
    expect(t).toContain('Faktury dopisane ręcznie');
    expect(t).toContain('Brak faktur dopisanych ręcznie w tym miesiącu.');
  });

  // Recenzja PRZ-086 (P3): tytuł części ręcznej nie może zostać sam na dole strony — tytuł,
  // opis i pierwszy wiersz mają stać na tej samej kartce, przy KAŻDEJ długości części KSeF.
  gdyJestPdftotext('tytuł części ręcznej nigdy nie zostaje sam na dole strony', async () => {
    const osierocone = [];
    for (let n = 18; n <= 40; n += 1) {
      const db = openOmsDb(':memory:');
      for (let i = 0; i < n; i += 1) {
        zapiszKoszt(db, ksef({ ksefNumber: `K-${i}`, numerDokumentu: `FV-${i}`, dataTrwalegoZapisu: '2026-08-04T10:00:00Z' }));
      }
      zapiszRecznyKoszt(db, reczny());
      // eslint-disable-next-line no-await-in-loop
      const strony = tekstZPdf((await createZestawienieKosztow({ db }).zbuduj('2026-08')).bajty).split('\f');
      const s = strony.find((t) => t.includes('Faktury dopisane ręcznie'));
      if (!s || !s.includes('INV-META-1')) osierocone.push(n);
    }
    expect(osierocone).toEqual([]);
  });

  gdyJestPdftotext('długa część ręczna: strona „ciąg dalszy” mówi, której części dotyczy', async () => {
    const db = openOmsDb(':memory:');
    zapiszKoszt(db, ksef());
    for (let i = 0; i < 45; i += 1) zapiszRecznyKoszt(db, reczny({ numerDokumentu: `INV-${i}` }));
    const t = tekstZPdf((await createZestawienieKosztow({ db }).zbuduj('2026-08')).bajty);
    expect(t).toContain('Faktury dopisane ręcznie (45) — ciąg dalszy');
  });

  gdyJestPdftotext('pusty miesiąc: obie części mówią „Brak…”, bez sumy łącznej', async () => {
    const t = tekstZPdf((await createZestawienieKosztow({ db: openOmsDb(':memory:') }).zbuduj('2026-08')).bajty);
    expect(t).toContain('Brak faktur kosztowych z KSeF w tym miesiącu.');
    expect(t).toContain('Brak faktur dopisanych ręcznie w tym miesiącu.');
    expect(t).not.toContain('Razem');
  });

  gdyJestPdftotext('kwarantanna wchodzi jako ostrzeżenie nad zestawieniem', async () => {
    const db = openOmsDb(':memory:');
    zapiszKoszt(db, ksef());
    zapiszOdrzuconyKoszt(db, {
      ksefNumber: 'K-BRAK', invoiceNumber: 'FV/77', permanentStorageDate: '2026-08-07T10:00:00Z',
    }, 'Brak kwoty: netto (K-BRAK).');
    const t = tekstZPdf((await createZestawienieKosztow({ db }).zbuduj('2026-08')).bajty);
    expect(t).toMatch(/UWAGA: 1 dokument kosztowy leży w kwarantannie/);
  });
});

describe('zestawienie kosztów — trasa i przycisk', () => {
  function serwer(dodatkowe = {}) {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } }, ...dodatkowe });
    return { app, db };
  }

  it('GET /koszty/zestawienie oddaje PDF do pobrania', async () => {
    const { app, db } = serwer();
    zasiej(db);
    const r = await app.inject({ method: 'GET', url: '/koszty/zestawienie?miesiac=2026-08', headers: AUTH });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.headers['content-disposition']).toContain('zestawienie-kosztow-2026-08.pdf');
    expect(r.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('bez hasła 401; zły albo brakujący miesiąc 400 (plik dla księgowej nie ma domyślnego miesiąca)', async () => {
    const { app } = serwer();
    expect((await app.inject({ method: 'GET', url: '/koszty/zestawienie?miesiac=2026-08' })).statusCode).toBe(401);
    for (const url of ['/koszty/zestawienie', '/koszty/zestawienie?miesiac=2026-8', '/koszty/zestawienie?miesiac=abc']) {
      const r = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('RRRR-MM');
    }
  });

  it('⚠️ ekran KOSZTY ma przycisk z wybranym miesiącem — także bez KSeF i bez inFaktu', async () => {
    const { app } = serwer();
    const r = await app.inject({ method: 'GET', url: '/koszty?miesiac=2026-08', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('href="/koszty/zestawienie?miesiac=2026-08"');
    expect(r.body).toContain('Pobierz zestawienie (PDF)');
  });

  it('przycisk stoi też na ekranie po akcji (ten sam szablon)', async () => {
    const { app } = serwer({ czuwaczKosztow: { przebieg: async () => ({ nowych: 0 }) } });
    const r = await app.inject({
      method: 'POST',
      url: '/koszty/odswiez',
      headers: { ...AUTH, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'miesiac=2026-08',
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('href="/koszty/zestawienie?miesiac=2026-08"');
  });
});
