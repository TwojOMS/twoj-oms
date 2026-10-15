import { describe, it, expect } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKoszt, zapiszSciezki } from '../../../src/oms/db/koszty.js';
import { przerysujKoszty } from '../../../src/moduly/koszty/services/przerysowanie-kosztow.js';

// Przerysowanie istniejacych PDF-ow z XML-i, ktore JUZ LEZA na NAS-ie — po przebudowie
// wizualizacji (2026-09-03). Zadnego wywolania do KSeF w tej sciezce nie ma i nie moze byc:
// KSeF ma limit 64 pobran na godzine, a archiwum ma ponad sto dokumentow.

const XML = '<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"><Fa>'
  + '<KodWaluty>PLN</KodWaluty><P_1>2026-06-05</P_1><P_2>FV/1</P_2><P_15>123.00</P_15>'
  + '<FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Usługa</P_7><P_11>100.00</P_11>'
  + '<P_12>23</P_12></FaWiersz></Fa></Faktura>';

const wiersz = (nadpisz = {}) => ({
  ksefNumber: 'K-1',
  numerDokumentu: 'FV/1',
  sprzedawcaNip: '5252674798',
  sprzedawcaNazwa: 'Allegro',
  dataWystawienia: '2026-06-05',
  dataTrwalegoZapisu: '2026-06-05T14:00:00Z',
  netto: '100.00',
  vat: '23.00',
  brutto: '123.00',
  waluta: 'PLN',
  rodzaj: 'Vat',
  maZalacznik: 0,
  ...nadpisz,
});

const katalogTymczasowy = () => mkdtempSync(join(tmpdir(), 'przerysowanie-'));

/** Baza z jednym kosztem, ktorego XML leży na dysku, plus stary (albo żaden) PDF obok. */
function przygotuj({ zStarymPdf = true, zPlikiemXml = true, nadpisz = {} } = {}) {
  const db = openOmsDb();
  const katalog = katalogTymczasowy();
  zapiszKoszt(db, wiersz(nadpisz));
  const sciezkaXml = 'Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.xml';
  const sciezkaPdf = 'Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.pdf';
  zapiszSciezki(db, nadpisz.ksefNumber ?? 'K-1', {
    xml: sciezkaXml, pdf: zStarymPdf ? sciezkaPdf : null,
  });
  if (zPlikiemXml) {
    mkdirSync(dirname(join(katalog, sciezkaXml)), { recursive: true });
    writeFileSync(join(katalog, sciezkaXml), XML);
  }
  if (zStarymPdf) {
    mkdirSync(dirname(join(katalog, sciezkaPdf)), { recursive: true });
    writeFileSync(join(katalog, sciezkaPdf), 'STARA KARTKA');
  }
  return { db, katalog, sciezkaPdf };
}

describe('przerysujKoszty', () => {
  it('rysuje PDF od nowa z XML-a na dysku i nadpisuje stary plik', async () => {
    const { db, katalog, sciezkaPdf } = przygotuj();

    const wynik = await przerysujKoszty({ db, katalog, log: () => {} });

    expect(wynik).toMatchObject({
      wszystkie: 1, przerysowane: 1, brakXml: 0, bledy: 0,
    });
    expect(readFileSync(join(katalog, sciezkaPdf)).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('⚠️ NIE WOŁA KSeF — źródłem jest wyłącznie plik XML z archiwum', async () => {
    const { db, katalog } = przygotuj();
    let widzianyXml = null;
    await przerysujKoszty({
      db,
      katalog,
      log: () => {},
      pdf: async ({ dokument }) => {
        widzianyXml = dokument;
        return Buffer.from('%PDF-1.4');
      },
    });
    // Dokument doszedl do generatora WYPARSOWANY — czyli z pliku, nie z sieci.
    expect(widzianyXml.numer).toBe('FV/1');
    expect(widzianyXml.pozycje).toHaveLength(1);
  });

  it('⚠️ zapis jest atomowy: po przebiegu nie zostaje żaden plik `.tmp`', async () => {
    const { db, katalog, sciezkaPdf } = przygotuj();
    await przerysujKoszty({ db, katalog, log: () => {} });
    const pliki = readdirSync(dirname(join(katalog, sciezkaPdf)));
    expect(pliki.some((n) => n.endsWith('.tmp'))).toBe(false);
  });

  it('⚠️ przerwane rysowanie NIE NISZCZY starej kartki — plik zostaje nietknięty', async () => {
    const { db, katalog, sciezkaPdf } = przygotuj();
    const wynik = await przerysujKoszty({
      db,
      katalog,
      log: () => {},
      pdf: async () => { throw new Error('pdfkit sie wywrocil'); },
    });
    expect(wynik).toMatchObject({ przerysowane: 0, bledy: 1 });
    expect(readFileSync(join(katalog, sciezkaPdf), 'utf8')).toBe('STARA KARTKA');
    expect(existsSync(`${join(katalog, sciezkaPdf)}.tmp`)).toBe(false);
  });

  // ⚠️⚠️ SPRZĄTANIE PO NIEUDANYM `rename` SZUKAŁO PLIKU POD ZŁĄ NAZWĄ. Ścieżka `.tmp`
  // powstaje ze ścieżki DOCELOWEJ — a ta bywa WYLICZONA (`sciezkaArchiwum`), gdy w bazie
  // jeszcze jej nie ma. Sprzątanie sklejało nazwę z `wiersz.sciezka_pdf`, czyli przy pustej
  // kolumnie celowało w „<katalog>/.tmp" i zostawiało prawdziwy plik tymczasowy w archiwum
  // księgowym — obok dokumentów, które ktoś potem pakuje dla biura.
  it('⚠️ nieudane przeniesienie sprząta `.tmp` także przy ścieżce WYLICZONEJ', async () => {
    const { db, katalog } = przygotuj({ zStarymPdf: false });
    // Katalog w miejscu docelowego pliku — `writeFileSync` przejdzie, `renameSync` padnie.
    const cel = join(katalog, 'Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.pdf');
    mkdirSync(cel, { recursive: true });

    const wynik = await przerysujKoszty({ db, katalog, log: () => {} });

    expect(wynik).toMatchObject({ przerysowane: 0, bledy: 1 });
    expect(existsSync(`${cel}.tmp`)).toBe(false);
  });

  it('dokument bez ścieżki PDF dostaje ją wyliczoną i dopisaną do bazy', async () => {
    const { db, katalog } = przygotuj({ zStarymPdf: false });

    const wynik = await przerysujKoszty({ db, katalog, log: () => {} });

    expect(wynik.przerysowane).toBe(1);
    const po = db.prepare('SELECT sciezka_pdf FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(po.sciezka_pdf).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.pdf');
    expect(existsSync(join(katalog, po.sciezka_pdf))).toBe(true);
  });

  it('⚠️ brak pliku XML na dysku jest LICZONY i mówiony, a nie przemilczany', async () => {
    const { db, katalog } = przygotuj({ zPlikiemXml: false });
    const linie = [];

    const wynik = await przerysujKoszty({ db, katalog, log: (l) => linie.push(l) });

    expect(wynik).toMatchObject({ wszystkie: 1, przerysowane: 0, brakXml: 1 });
    expect(linie.join('\n')).toContain('brak pliku XML');
  });

  it('⚠️ błąd jednego dokumentu nie przerywa przebiegu — reszta się przerysowuje', async () => {
    const { db, katalog } = przygotuj();
    zapiszKoszt(db, wiersz({ ksefNumber: 'K-2', numerDokumentu: 'FV/2' }));
    zapiszSciezki(db, 'K-2', { xml: 'Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-2.xml' });
    writeFileSync(join(katalog, 'Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-2.xml'), XML);

    let ile = 0;
    const wynik = await przerysujKoszty({
      db,
      katalog,
      log: () => {},
      pdf: async () => {
        ile += 1;
        if (ile === 1) throw new Error('pierwszy sie wywrocil');
        return Buffer.from('%PDF-1.4');
      },
    });

    expect(wynik).toMatchObject({ wszystkie: 2, przerysowane: 1, bledy: 1 });
  });

  it('koszt bez zarchiwizowanego XML-a nie wchodzi do kolejki (ręczne wpisy też nie)', async () => {
    const db = openOmsDb();
    zapiszKoszt(db, wiersz());
    const wynik = await przerysujKoszty({ db, katalog: katalogTymczasowy(), log: () => {} });
    expect(wynik).toMatchObject({ wszystkie: 0, przerysowane: 0 });
  });

  it('⚠️ brak katalogu archiwum odmawia zdaniem, zamiast pisać PDF-y w losowe miejsce', async () => {
    const db = openOmsDb();
    await expect(przerysujKoszty({ db, katalog: '', log: () => {} })).rejects.toThrow(/katalog/i);
  });
});
