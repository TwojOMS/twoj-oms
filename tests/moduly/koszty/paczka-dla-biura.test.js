import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKoszt, zapiszSciezki } from '../../../src/oms/db/koszty.js';
import { zapiszWiersz } from '../../../src/moduly/faktury/db/archiwum-sprzedazy.js';
import { odciskDokumentu } from '../../../src/domena/archiwum-sprzedazy.js';
import { createPaczkaDlaBiura } from '../../../src/moduly/koszty/services/paczka-dla-biura.js';

async function pdfZ(stron, tekst = 'x') {
  const d = await PDFDocument.create();
  for (let i = 0; i < stron; i += 1) d.addPage([200, 200]).drawText(`${tekst} ${i}`, { x: 10, y: 100, size: 12 });
  return Buffer.from(await d.save());
}
const f = (n = {}) => ({
  uuid: 'u1', id: 1, number: '5/08/2026', kind: 'vat', invoice_date: '2026-08-05', sale_date: '2026-08-05',
  net_price: 10000, tax_price: 2300, gross_price: 12300, currency: 'PLN', client_company_name: 'Firma', client_tax_code: '1', ksef_number: 'KS', ...n,
});
const koszt = (n = {}) => ({
  ksefNumber: 'K-1', numerDokumentu: 'FV/1', sprzedawcaNip: '1', sprzedawcaNazwa: 'OVH', dataWystawienia: '2026-08-04',
  dataTrwalegoZapisu: '2026-08-04T10:00:00Z', netto: '100.00', vat: '23.00', brutto: '123.00', waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...n,
});
const infaktAtrapa = (n = {}) => ({
  wolan: { pdf: 0, kor: 0 },
  listaFaktur: async () => [f()].map((d) => ({ ...d, rodzaj: 'vat' })),
  listaKorekt: async () => [],
  async pobierzPdf() { this.wolan.pdf += 1; return pdfZ(2, 'faktura'); },
  async pobierzPdfKorekty() { this.wolan.kor += 1; return pdfZ(1, 'korekta'); },
  ...n,
});
const teraz = () => new Date('2026-09-02T10:00:00Z');

describe('paczka dla biura', () => {
  it('zestawienie przychodów zawiera wyłącznie listę i nie pobiera PDF-ów dokumentów', async () => {
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz })
      .zbudujZestawieniePrzychodow('2026-08');

    expect(w.nazwa).toBe('zestawienie-przychodow-2026-08.pdf');
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1);
    expect((await PDFDocument.load(w.bajty)).getTitle()).toBe('Zestawienie przychodów — sierpień 2026');
    expect(inf.wolan).toEqual({ pdf: 0, kor: 0 });
  });

  // ⚠️⚠️ DWA PLIKI, NIE JEDEN (decyzja wlasciciela 2026-09-02 wieczorem: „podzial — dwa pliki
  // do pobrania, jeden kosztowy, drugi przychodowy"). Kazda czesc jest OSOBNYM pobraniem
  // i osobnym plikiem: zestawienie tej czesci + jej dokumenty, stopka liczy strony TEGO pliku.
  it('czesc „sprzedaz": zestawienie sprzedazy + faktury, wlasna nazwa i liczba stron', async () => {
    const db = openOmsDb();
    zapiszKoszt(db, koszt());
    let kosztowych = 0;
    const wiz = { pdf: async () => { kosztowych += 1; return { bajty: await pdfZ(3, 'koszt') }; } };
    const p = createPaczkaDlaBiura({
      db, infakt: infaktAtrapa(), wizualizacjaKosztu: wiz, teraz,
    });
    const w = await p.zbuduj('2026-08', 'sprzedaz');
    expect(w.nazwa).toBe('paczka-dla-biura-2026-08-sprzedaz.pdf');
    expect(w.dokumentow).toBe(1);
    const doc = await PDFDocument.load(w.bajty);
    expect(doc.getPageCount()).toBe(1 + 2); // zestawienie sprzedazy + faktura 2 str.
    expect(w.stron).toBe(3);
    // ⚠️ ANI JEDNEGO SIEGNIECIA DO KSeF: plik sprzedazowy nie niesie kosztow, wiec pytanie
    // o wizualizacje kosztu byloby tu czystym kosztem czasu i sztucznym ryzykiem 429.
    expect(kosztowych).toBe(0);
  });

  it('czesc „koszty": zestawienie kosztow + koszty, bez ani jednego pobrania z inFaktu', async () => {
    const db = openOmsDb();
    zapiszKoszt(db, koszt());
    const wiz = { pdf: async () => ({ bajty: await pdfZ(3, 'koszt') }) };
    const inf = infaktAtrapa({
      listaFaktur: async () => { throw new Error('plik kosztowy nie ma po co pytać inFaktu'); },
      listaKorekt: async () => { throw new Error('plik kosztowy nie ma po co pytać inFaktu'); },
    });
    const w = await createPaczkaDlaBiura({
      db, infakt: inf, wizualizacjaKosztu: wiz, teraz,
    }).zbuduj('2026-08', 'koszty');
    expect(w.nazwa).toBe('paczka-dla-biura-2026-08-koszty.pdf');
    expect(w.dokumentow).toBe(1);
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 3);
    expect(w.stron).toBe(4);
    expect(inf.wolan).toEqual({ pdf: 0, kor: 0 });
  });

  it('nieznana czesc = odmowa z wymienieniem obu plikow', async () => {
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: infaktAtrapa(), teraz }).zbuduj('2026-08', 'wszystko'))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/sprzedaz.*koszty/) });
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: infaktAtrapa(), teraz }).zbuduj('2026-08'))
      .rejects.toMatchObject({ dlaOperatora: true });
  });

  // ⚠️ STOPKA LICZY STRONY TEGO PLIKU, a nie obu razem — po tej liczbie ksiegowa sprawdza
  // kompletnosc wydruku, ktory trzyma w rece. Liczba z drugiego pliku bylaby tu klamstwem.
  it('stopka zestawienia dostaje liczbe stron WLASNEGO pliku', async () => {
    const db = openOmsDb();
    const wolania = [];
    const zbudujZestawienie = async (a) => {
      wolania.push({ czesc: a.czesc, liczbaStron: a.liczbaStron, liczbaDokumentow: a.liczbaDokumentow });
      return pdfZ(1, 'zest');
    };
    const w = await createPaczkaDlaBiura({
      db, infakt: infaktAtrapa(), teraz, zbudujZestawienie,
    }).zbuduj('2026-08', 'sprzedaz');
    expect(w.stron).toBe(3); // zestawienie 1 str. + faktura 2 str.
    // Pierwszy przebieg jest POMIAREM (idzie do kosza), drugi rysuje z prawdziwa liczba.
    expect(wolania).toEqual([
      { czesc: 'sprzedaz', liczbaStron: 0, liczbaDokumentow: 1 },
      { czesc: 'sprzedaz', liczbaStron: 3, liczbaDokumentow: 1 },
    ]);
  });

  it('lista sprzedazy pobierana po DACIE SPRZEDAZY, korekty po dacie wystawienia', async () => {
    const zakresy = [];
    const inf = infaktAtrapa({
      listaFaktur: async (z) => { zakresy.push(['f', z]); return []; },
      listaKorekt: async (z) => { zakresy.push(['k', z]); return []; },
    });
    await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz }).zbuduj('2026-08', 'sprzedaz');
    expect(zakresy).toEqual([
      ['f', { od: '2026-08-01', do: '2026-08-31', pole: 'sale_date' }],
      ['k', { od: '2026-08-01', do: '2026-08-31', pole: 'invoice_date' }],
    ]);
  });

  it('⚠️ bajty sprzedazy z DYSKU, gdy wiersz archiwum ma zgodny odcisk i plik istnieje', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-'));
    mkdirSync(join(k, '2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, '2026/Sierpien/2026-08-05_5-08-2026.pdf'), await pdfZ(4, 'dysk'));
    zapiszWiersz(db, {
      uuid: 'u1', rodzaj: 'vat', numer: '5/08/2026', invoiceDate: '2026-08-05', odcisk: odciskDokumentu(f()), sciezkaPdf: '2026/Sierpien/2026-08-05_5-08-2026.pdf', zapisanyAt: 't',
    });
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({
      db, infakt: inf, katalogSprzedazy: k, teraz,
    }).zbuduj('2026-08', 'sprzedaz');
    expect(inf.wolan.pdf).toBe(0);
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 4);
  });

  it('odcisk niezgodny = z sieci, nie z dysku', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-'));
    mkdirSync(join(k, '2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, '2026/Sierpien/2026-08-05_5-08-2026.pdf'), await pdfZ(4, 'dysk'));
    zapiszWiersz(db, {
      uuid: 'u1', rodzaj: 'vat', numer: '5/08/2026', invoiceDate: '2026-08-05', odcisk: '{"stary":1}', sciezkaPdf: '2026/Sierpien/2026-08-05_5-08-2026.pdf', zapisanyAt: 't',
    });
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({
      db, infakt: inf, katalogSprzedazy: k, teraz,
    }).zbuduj('2026-08', 'sprzedaz');
    expect(inf.wolan.pdf).toBe(1);
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 2);
  });

  it('wiersz archiwum oznaczony jako skasowany = z sieci, nie z dysku', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-'));
    mkdirSync(join(k, '2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, '2026/Sierpien/2026-08-05_5-08-2026.pdf'), await pdfZ(4, 'dysk'));
    zapiszWiersz(db, {
      uuid: 'u1', rodzaj: 'vat', numer: '5/08/2026', invoiceDate: '2026-08-05', odcisk: odciskDokumentu(f()), sciezkaPdf: '2026/Sierpien/2026-08-05_5-08-2026.pdf', zapisanyAt: 't',
    });
    db.prepare("UPDATE archiwum_sprzedazy SET skasowana_at = 'kiedys' WHERE uuid = 'u1'").run();
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({
      db, infakt: inf, katalogSprzedazy: k, teraz,
    }).zbuduj('2026-08', 'sprzedaz');
    expect(inf.wolan.pdf).toBe(1);
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 2);
  });

  it('zgodny odcisk, ale pliku na dysku NIE MA = z sieci, bez odmowy', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-'));
    zapiszWiersz(db, {
      uuid: 'u1', rodzaj: 'vat', numer: '5/08/2026', invoiceDate: '2026-08-05', odcisk: odciskDokumentu(f()), sciezkaPdf: '2026/Sierpien/2026-08-05_5-08-2026.pdf', zapisanyAt: 't',
    });
    const inf = infaktAtrapa();
    const w = await createPaczkaDlaBiura({
      db, infakt: inf, katalogSprzedazy: k, teraz,
    }).zbuduj('2026-08', 'sprzedaz');
    expect(inf.wolan.pdf).toBe(1);
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 2);
  });

  it('korekta idzie po pobierzPdfKorekty, nie po pobierzPdf', async () => {
    const inf = infaktAtrapa({
      listaFaktur: async () => [],
      listaKorekt: async () => [f({ uuid: 'k1', number: '1/KOR/08/2026', kind: 'correction' })],
    });
    const w = await createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz }).zbuduj('2026-08', 'sprzedaz');
    expect(inf.wolan).toEqual({ pdf: 0, kor: 1 });
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 1);
  });

  it('koszt z pliku sciezka_pdf na dysku — bez KSeF', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-k-'));
    zapiszKoszt(db, koszt());
    mkdirSync(join(k, 'Kosztowe 2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, 'Kosztowe 2026/Sierpien/2026-08-04_OVH_FV-1.pdf'), await pdfZ(2, 'k'));
    zapiszSciezki(db, 'K-1', { xml: 'Kosztowe 2026/Sierpien/2026-08-04_OVH_FV-1.xml', pdf: 'Kosztowe 2026/Sierpien/2026-08-04_OVH_FV-1.pdf' });
    const inf = infaktAtrapa({ listaFaktur: async () => [] });
    const w = await createPaczkaDlaBiura({
      db, infakt: inf, wizualizacjaKosztu: null, katalogKosztow: k, teraz,
    }).zbuduj('2026-08', 'koszty');
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 2);
  });

  it('koszt reczny nie ma strony i nie wola KSeF', async () => {
    const db = openOmsDb();
    zapiszKoszt(db, koszt({ ksefNumber: 'RECZNY-1' }));
    db.prepare("UPDATE koszty SET zrodlo = 'reczne' WHERE ksef_number = 'RECZNY-1'").run();
    let wolan = 0;
    const w = await createPaczkaDlaBiura({
      db,
      infakt: infaktAtrapa({ listaFaktur: async () => [] }),
      wizualizacjaKosztu: { pdf: async () => { wolan += 1; return { bajty: await pdfZ(1) }; } },
      teraz,
    }).zbuduj('2026-08', 'koszty');
    expect(wolan).toBe(0);
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1);
  });

  it('⚠️ JEDNO niepowodzenie przerywa CALOSC — odmowa z numerem dokumentu, bez pliku', async () => {
    const inf = infaktAtrapa({
      listaFaktur: async () => [f({ uuid: 'a', number: '1/08/2026' }), f({ uuid: 'b', number: '2/08/2026' })].map((d) => ({ ...d, rodzaj: 'vat' })),
      pobierzPdf: async (u) => { if (u === 'b') throw new Error('inFakt 500'); return pdfZ(1); },
    });
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz }).zbuduj('2026-08', 'sprzedaz'))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/2\/08\/2026.*inFakt 500/) });
  });

  it('koszt z KSeF bez pliku i bez wizualizacji = odmowa z numerem', async () => {
    const db = openOmsDb(); zapiszKoszt(db, koszt());
    await expect(createPaczkaDlaBiura({
      db, infakt: infaktAtrapa({ listaFaktur: async () => [] }), wizualizacjaKosztu: null, teraz,
    }).zbuduj('2026-08', 'koszty')).rejects.toThrow(/FV\/1.*KSeF/);
  });

  it('odmowa wizualizacji kosztu przerywa calosc, z numerem dokumentu', async () => {
    const db = openOmsDb(); zapiszKoszt(db, koszt());
    await expect(createPaczkaDlaBiura({
      db,
      infakt: infaktAtrapa({ listaFaktur: async () => [] }),
      wizualizacjaKosztu: { pdf: async () => { throw new Error('KSeF 503'); } },
      teraz,
    }).zbuduj('2026-08', 'koszty')).rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/FV\/1.*KSeF 503/) });
  });

  it('⚠️ limit 16/min KSeF = poczekaj i ponow, a nie odmowa (paczka powstaje)', async () => {
    const db = openOmsDb(); zapiszKoszt(db, koszt());
    const spanie = [];
    const logi = [];
    let wolan = 0;
    const wiz = {
      pdf: async () => {
        wolan += 1;
        if (wolan === 1) throw Object.assign(new Error('limit'), { status: 429, retryAfterS: 1 });
        return { bajty: await pdfZ(1, 'koszt') };
      },
    };
    const w = await createPaczkaDlaBiura({
      db,
      infakt: infaktAtrapa({ listaFaktur: async () => [] }),
      wizualizacjaKosztu: wiz,
      spij: async (ms) => { spanie.push(ms); },
      log: (m) => { logi.push(m); },
      teraz,
    }).zbuduj('2026-08', 'koszty');
    expect(wolan).toBe(2);
    expect(spanie).toEqual([2000]); // 1 s od KSeF + sekunda zapasu (ksef/limit.js)
    expect(logi).toHaveLength(1); // czekanie zostawia slad w logu, a nie dzieje sie po cichu
    expect((await PDFDocument.load(w.bajty)).getPageCount()).toBe(1 + 1);
  });

  it('bajty, ktorych pdf-lib nie wczyta = odmowa z numerem, nie 500', async () => {
    const inf = infaktAtrapa({ pobierzPdf: async () => Buffer.from('%PDF-1.4 zepsute') });
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz }).zbuduj('2026-08', 'sprzedaz'))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/5\/08\/2026/) });
  });

  it('zly miesiac = odmowa', async () => {
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: infaktAtrapa(), teraz }).zbuduj('2026-8', 'sprzedaz'))
      .rejects.toThrow(/RRRR-MM/);
  });

  it('⚠️ blad ODCZYTU sprzedazy z archiwum (plik jest, ale nie da sie go przeczytac) = odmowa z numerem, nie ucieczka bledu', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-'));
    mkdirSync(join(k, '2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, '2026/Sierpien/2026-08-05_5-08-2026.pdf'), await pdfZ(4, 'dysk'));
    zapiszWiersz(db, {
      uuid: 'u1', rodzaj: 'vat', numer: '5/08/2026', invoiceDate: '2026-08-05', odcisk: odciskDokumentu(f()), sciezkaPdf: '2026/Sierpien/2026-08-05_5-08-2026.pdf', zapisanyAt: 't',
    });
    const inf = infaktAtrapa();
    const czytajPlik = () => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
    await expect(createPaczkaDlaBiura({
      db, infakt: inf, katalogSprzedazy: k, teraz, czytajPlik,
    }).zbuduj('2026-08', 'sprzedaz')).rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/5\/08\/2026.*EBUSY/) });
  });

  it('⚠️ blad ODCZYTU kosztu z archiwum (plik jest, ale nie da sie go przeczytac) = odmowa z numerem', async () => {
    const db = openOmsDb(); const k = mkdtempSync(join(tmpdir(), 'paczka-k-'));
    zapiszKoszt(db, koszt());
    mkdirSync(join(k, 'Kosztowe 2026/Sierpien'), { recursive: true });
    writeFileSync(join(k, 'Kosztowe 2026/Sierpien/2026-08-04_OVH_FV-1.pdf'), await pdfZ(2, 'k'));
    zapiszSciezki(db, 'K-1', { xml: 'Kosztowe 2026/Sierpien/2026-08-04_OVH_FV-1.xml', pdf: 'Kosztowe 2026/Sierpien/2026-08-04_OVH_FV-1.pdf' });
    const inf = infaktAtrapa({ listaFaktur: async () => [] });
    const czytajPlik = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
    await expect(createPaczkaDlaBiura({
      db, infakt: inf, wizualizacjaKosztu: null, katalogKosztow: k, teraz, czytajPlik,
    }).zbuduj('2026-08', 'koszty')).rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/FV\/1.*EACCES/) });
  });

  it('⚠️ liczba stron w stopce niezgodna z plikiem = odmowa (straznik przed cichym klamstwem stopki)', async () => {
    const db = openOmsDb();
    let wolan = 0;
    // Przebieg pomiarowy oddaje jedna strone, rysujacy — dwie: stopka obiecalaby wtedy plik
    // krotszy, niz on jest.
    const zbudujZestawienie = async () => { wolan += 1; return pdfZ(wolan <= 1 ? 1 : 2, 'zest'); };
    const inf = infaktAtrapa({ listaFaktur: async () => [] });
    await expect(createPaczkaDlaBiura({
      db, infakt: inf, teraz, zbudujZestawienie,
    }).zbuduj('2026-08', 'sprzedaz')).rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/liczba stron/) });
  });

  it('⚠️ ta sama uuid na fakturze i korekcie = odmowa, nie cicha podmiana dokumentu', async () => {
    const inf = infaktAtrapa({
      listaFaktur: async () => [f({ uuid: 'dup', number: '1/08/2026' })].map((d) => ({ ...d, rodzaj: 'vat' })),
      listaKorekt: async () => [f({ uuid: 'dup', number: '1/KOR/08/2026', kind: 'correction' })],
    });
    await expect(createPaczkaDlaBiura({ db: openOmsDb(), infakt: inf, teraz }).zbuduj('2026-08', 'sprzedaz'))
      .rejects.toMatchObject({ dlaOperatora: true, message: expect.stringMatching(/1\/08\/2026|1\/KOR\/08\/2026/) });
  });

  it('rownolegle: 0 nie zawiesza budowy paczki — klamrowane do minimum 1', async () => {
    const w = await createPaczkaDlaBiura({
      db: openOmsDb(), infakt: infaktAtrapa(), teraz, rownolegle: 0,
    }).zbuduj('2026-08', 'sprzedaz');
    expect(w.dokumentow).toBe(1);
  });
});
