import { describe, it, expect } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wierszArchiwum, zapiszWiersz } from '../../../src/moduly/faktury/db/archiwum-sprzedazy.js';
import { odciskDokumentu } from '../../../src/domena/archiwum-sprzedazy.js';
import { zarchiwizujDokument, oznaczSkasowanyDokument } from '../../../src/moduly/faktury/services/archiwum-sprzedazy.js';

const PDF = Buffer.from('%PDF-1.4 tresc');
const teraz = () => new Date('2026-09-02T02:05:00Z');
const dok = (n = {}) => ({
  uuid: 'u1', number: '12/08/2026', invoice_date: '2026-08-03', sale_date: '2026-08-01',
  gross_price: 29300, client_tax_code: '1234563218', ksef_number: 'KS-1', kind: 'vat', ...n,
});
const infaktAtrapa = (licznik = { vat: 0, korekta: 0 }) => ({
  pobierzPdf: async () => { licznik.vat += 1; return PDF; },
  pobierzPdfKorekty: async () => { licznik.korekta += 1; return PDF; },
});
const katalog = () => mkdtempSync(join(tmpdir(), 'arch-sprz-'));

// Chodzi po calym katalogu i sprawdza, ze nigdzie nie zostal plik `.tmp` — dowod, ze zapis
// atomowy sprzata po sobie, niezaleznie od tego, na jakim etapie sie wywrocil.
function bezTmp(sciezka) {
  for (const wpis of readdirSync(sciezka, { withFileTypes: true })) {
    const pelna = join(sciezka, wpis.name);
    if (wpis.isDirectory()) { if (!bezTmp(pelna)) return false; } else if (wpis.name.endsWith('.tmp')) return false;
  }
  return true;
}

describe('zarchiwizujDokument', () => {
  it('nowy dokument: pobiera PDF, zapisuje plik i wiersz', async () => {
    const db = openOmsDb(); const k = katalog(); const l = { vat: 0, korekta: 0 };
    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(l), dokument: dok(), katalogBazowy: k, teraz });
    expect(w.stan).toBe('pobrany');
    expect(w.sciezka).toBe('2026/Sierpien/2026-08-03_12-08-2026.pdf');
    expect(readFileSync(join(k, w.sciezka))).toEqual(PDF);
    expect(l.vat).toBe(1);
    const r = wierszArchiwum(db, 'u1');
    expect(r.rodzaj).toBe('vat'); expect(r.odcisk).toBe(odciskDokumentu(dok()));
    expect(r.zapisany_at).toBe('2026-09-02T02:05:00.000Z');
  });

  it('korekta idzie po zasob korekt', async () => {
    const db = openOmsDb(); const l = { vat: 0, korekta: 0 };
    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(l), dokument: dok({ kind: 'correction', number: '1/KOR/08/2026' }), katalogBazowy: katalog(), teraz });
    expect(w.sciezka).toContain('1-KOR-08-2026.pdf');
    expect(l).toEqual({ vat: 0, korekta: 1 });
    expect(wierszArchiwum(db, 'u1').rodzaj).toBe('korekta');
  });

  it('⚠️ ADOPCJA: plik o tej nazwie juz lezy (eksport z 1.08) — wiersz bez pobierania', async () => {
    const db = openOmsDb(); const k = katalog(); const l = { vat: 0, korekta: 0 };
    mkdirSync(join(k, '2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, '2026/Sierpien/2026-08-03_12-08-2026.pdf'), PDF);
    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(l), dokument: dok(), katalogBazowy: k, teraz });
    expect(w.stan).toBe('adoptowany');
    expect(l.vat).toBe(0);
    expect(wierszArchiwum(db, 'u1')).not.toBeNull();
  });

  it('pusty plik o tej nazwie NIE jest adoptowany — pobiera od nowa', async () => {
    const db = openOmsDb(); const k = katalog(); const l = { vat: 0, korekta: 0 };
    mkdirSync(join(k, '2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, '2026/Sierpien/2026-08-03_12-08-2026.pdf'), '');
    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(l), dokument: dok(), katalogBazowy: k, teraz });
    expect(w.stan).toBe('pobrany'); expect(l.vat).toBe(1);
  });

  it('znany, odcisk bez zmian: nic nie pobiera', async () => {
    const db = openOmsDb(); const k = katalog(); const l = { vat: 0, korekta: 0 };
    await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(l), dokument: dok(), katalogBazowy: k, teraz });
    expect(w.stan).toBe('bez_zmian'); expect(l.vat).toBe(0);
  });

  it('zmieniony odcisk z ta sama data: pobiera i NADPISUJE plik', async () => {
    const db = openOmsDb(); const k = katalog();
    await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    const nowyPdf = Buffer.from('%PDF-1.4 nowa');
    const w = await zarchiwizujDokument({ db, infakt: { pobierzPdf: async () => nowyPdf }, dokument: dok({ gross_price: 1 }), katalogBazowy: k, teraz });
    expect(w.stan).toBe('nadpisany');
    expect(readFileSync(join(k, w.sciezka))).toEqual(nowyPdf);
    expect(wierszArchiwum(db, 'u1').odcisk).toBe(odciskDokumentu(dok({ gross_price: 1 })));
  });

  it('zmieniona data wystawienia: nowa sciezka, stary plik znika', async () => {
    const db = openOmsDb(); const k = katalog();
    const a = await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok({ invoice_date: '2026-09-01' }), katalogBazowy: k, teraz });
    expect(w.sciezka).toBe('2026/Wrzesien/2026-09-01_12-08-2026.pdf');
    expect(existsSync(join(k, a.sciezka))).toBe(false);
    expect(existsSync(join(k, w.sciezka))).toBe(true);
    expect(bezTmp(k)).toBe(true);
  });

  it('⚠️ usuniecie starego pliku ma WLASNY try/catch — blad usuwania NIE cofa udanego zapisu', async () => {
    const db = openOmsDb(); const k = katalog(); const logi = [];
    await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    const w = await zarchiwizujDokument({
      db,
      infakt: infaktAtrapa(),
      dokument: dok({ invoice_date: '2026-09-01' }),
      katalogBazowy: k,
      teraz,
      log: (m) => logi.push(m),
      usun: () => { throw new Error('EBUSY: plik otwarty przez SMB'); },
    });
    expect(w.stan).toBe('nadpisany');
    expect(existsSync(join(k, w.sciezka))).toBe(true);
    const r = wierszArchiwum(db, 'u1');
    expect(r.sciezka_pdf).toBe(w.sciezka);
    expect(logi.join(' ')).toMatch(/12\/08\/2026/);
    expect(bezTmp(k)).toBe(true);
  });

  it('⚠️ dokument oznaczony jako skasowany, ktory wrocil w inFakcie (ten sam odcisk) — traktowany jak zmiana', async () => {
    const db = openOmsDb(); const k = katalog();
    await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    await oznaczSkasowanyDokument({ db, wiersz: wierszArchiwum(db, 'u1'), katalogBazowy: k, teraz });
    expect(wierszArchiwum(db, 'u1').skasowana_at).not.toBeNull();

    const w = await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    expect(w.stan).toBe('nadpisany');
    const r = wierszArchiwum(db, 'u1');
    expect(r.skasowana_at).toBeNull();
    expect(r.sciezka_pdf).toBe('2026/Sierpien/2026-08-03_12-08-2026.pdf');
    expect(existsSync(join(k, r.sciezka_pdf))).toBe(true);
    expect(bezTmp(k)).toBe(true);
  });

  it('blad pobrania z inFaktu RZUCA (czuwacz liczy bledy), wiersza nie ma', async () => {
    const db = openOmsDb();
    await expect(zarchiwizujDokument({
      db, infakt: { pobierzPdf: async () => { throw new Error('inFakt 500'); } }, dokument: dok(), katalogBazowy: katalog(), teraz,
    })).rejects.toThrow('inFakt 500');
    expect(wierszArchiwum(db, 'u1')).toBeNull();
  });

  it('⚠️ blad ZAPISU na dysk jest zjadany i logowany — bez wiersza, zeby wrocic nastepnej nocy', async () => {
    const db = openOmsDb(); const k = katalog(); const logi = [];
    // Podklada PLIK tam, gdzie trzeba zalozyc katalog ('2026') — mkdirSync z recursive na
    // takiej przeszkodzie rzuca (ENOTDIR); ten sam trik, co w archiwum-kosztow.test.js. Literalna
    // sciezka „nieistniejacego dysku" nie jest przenosna: na Windows `path.join('/nie/ma/...', x)`
    // liczy sie od biezacego dysku i mkdirSync potrafi ja po prostu zalozyc.
    writeFileSync(join(k, '2026'), 'to jest plik, nie katalog');
    const w = await zarchiwizujDokument({
      db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz, log: (m) => logi.push(m),
    });
    expect(w.stan).toBe('blad_zapisu');
    expect(wierszArchiwum(db, 'u1')).toBeNull();
    expect(logi.join(' ')).toMatch(/12\/08\/2026/);
    expect(existsSync(join(k, w.sciezka))).toBe(false);
    expect(bezTmp(k)).toBe(true);
  });

  it('⚠️ blad w trakcie zapisu (rename) sprzata plik .tmp — nie zostaje smiec na dysku', async () => {
    const db = openOmsDb(); const k = katalog(); const logi = [];
    // Docelowa sciezka jest juz niepustym katalogiem — `renameSync(tmp, pelna)` na pewno sie
    // nie uda (rozne kody bledu na roznych platformach), a `.tmp` musi mimo to zniknac.
    const docelowa = join(k, '2026/Sierpien/2026-08-03_12-08-2026.pdf');
    mkdirSync(docelowa, { recursive: true });
    writeFileSync(join(docelowa, 'przeszkoda.txt'), 'x');
    const w = await zarchiwizujDokument({
      db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz, log: (m) => logi.push(m),
    });
    expect(w.stan).toBe('blad_zapisu');
    expect(wierszArchiwum(db, 'u1')).toBeNull();
    expect(bezTmp(k)).toBe(true);
  });

  it('bajty, ktore nie zaczynaja sie od %PDF, nie sa zapisywane', async () => {
    const db = openOmsDb();
    await expect(zarchiwizujDokument({
      db, infakt: { pobierzPdf: async () => Buffer.from('<html>') }, dokument: dok(), katalogBazowy: katalog(), teraz,
    })).rejects.toThrow(/nie jest PDF/);
  });
});

describe('oznaczSkasowanyDokument', () => {
  it('przemianowuje plik na SKASOWANA_ i zapisuje skasowana_at', async () => {
    const db = openOmsDb(); const k = katalog();
    await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    const w = await oznaczSkasowanyDokument({ db, wiersz: wierszArchiwum(db, 'u1'), katalogBazowy: k, teraz });
    expect(w.sciezka).toBe('2026/Sierpien/SKASOWANA_2026-08-03_12-08-2026.pdf');
    expect(existsSync(join(k, w.sciezka))).toBe(true);
    expect(existsSync(join(k, '2026/Sierpien/2026-08-03_12-08-2026.pdf'))).toBe(false);
    expect(wierszArchiwum(db, 'u1').skasowana_at).toBe('2026-09-02T02:05:00.000Z');
  });

  it('brak pliku na dysku nie przeszkadza w oznaczeniu (plik mogl byc skasowany recznie)', async () => {
    const db = openOmsDb(); const k = katalog();
    zapiszWiersz(db, { uuid: 'u9', rodzaj: 'vat', numer: '1/01/2026', invoiceDate: '2026-01-05', odcisk: '{}', sciezkaPdf: '2026/Styczen/x.pdf', zapisanyAt: 't' });
    const w = await oznaczSkasowanyDokument({ db, wiersz: wierszArchiwum(db, 'u9'), katalogBazowy: k, teraz, log: () => {} });
    expect(w.sciezka).toBe('2026/Styczen/SKASOWANA_x.pdf');
    expect(wierszArchiwum(db, 'u9').skasowana_at).not.toBeNull();
  });

  it('⚠️ przemianowanie sie nie udalo — sciezka w wierszu zostaje przy STAREJ nazwie, skasowana_at i tak zapisany', async () => {
    const db = openOmsDb(); const k = katalog(); const logi = [];
    await zarchiwizujDokument({ db, infakt: infaktAtrapa(), dokument: dok(), katalogBazowy: k, teraz });
    const w = await oznaczSkasowanyDokument({
      db,
      wiersz: wierszArchiwum(db, 'u1'),
      katalogBazowy: k,
      teraz,
      log: (m) => logi.push(m),
      przemianuj: () => { throw new Error('EBUSY: plik otwarty przez SMB'); },
    });
    expect(w.sciezka).toBe('2026/Sierpien/2026-08-03_12-08-2026.pdf');
    const r = wierszArchiwum(db, 'u1');
    expect(r.sciezka_pdf).toBe('2026/Sierpien/2026-08-03_12-08-2026.pdf');
    expect(r.skasowana_at).toBe('2026-09-02T02:05:00.000Z');
    expect(existsSync(join(k, r.sciezka_pdf))).toBe(true);
    expect(logi.join(' ')).toMatch(/12\/08\/2026/);
  });
});
