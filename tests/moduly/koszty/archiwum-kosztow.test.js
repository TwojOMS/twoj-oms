import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszKoszt } from '../../../src/oms/db/koszty.js';
import { sciezkaArchiwum, zarchiwizuj } from '../../../src/moduly/koszty/services/archiwum-kosztow.js';

describe('sciezka w archiwum kosztow', () => {
  it('trzyma istniejaca konwencje: Kosztowe <rok>/<Miesiac>/RRRR-MM-DD_SPRZEDAWCA_numer', () => {
    expect(sciezkaArchiwum({
      dataWystawienia: '2026-06-05', sprzedawcaNazwa: 'Allegro sp. z o.o.',
      numerDokumentu: 'FV/2026/06/12', rozszerzenie: 'xml',
    })).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO SP Z OO_FV-2026-06-12.xml');
  });

  it('⚠️ nazwy miesiecy BEZ polskich znakow — tak wygladaja istniejace katalogi', () => {
    expect(sciezkaArchiwum({ dataWystawienia: '2026-01-05', sprzedawcaNazwa: 'X', numerDokumentu: 'A', rozszerzenie: 'pdf' }))
      .toContain('/Styczen/');
    expect(sciezkaArchiwum({ dataWystawienia: '2026-04-05', sprzedawcaNazwa: 'X', numerDokumentu: 'A', rozszerzenie: 'pdf' }))
      .toContain('/Kwiecien/');
  });

  it('ukosnik w numerze faktury zamienia sie na myslnik — inaczej powstalby podkatalog', () => {
    expect(sciezkaArchiwum({ dataWystawienia: '2026-06-05', sprzedawcaNazwa: 'X', numerDokumentu: 'FV/1/2026', rozszerzenie: 'xml' }))
      .toContain('_FV-1-2026.xml');
  });

  // ⚠️⚠️ DATA ZE ZNACZNIKIEM CZASU (recenzja calej galezi, W3). Galaz JAWNIE zaklada, ze
  // `data_wystawienia` moze niesc godzine (`PO_KONCU_DNIA` w db/koszty.js istnieje wylacznie
  // po to). Surowa data w nazwie pliku dawala „2026-06-30T22:30:00Z_ALLEGRO...xml" —
  // a dwukropek jest na SMB i na Windowsie znakiem nielegalnym: zapis padal, byl polykany
  // (`zarchiwizuj` tylko loguje) i ponawiany CO NOC, za kazdym razem kosztujac pobranie
  // XML-a z KSeF.
  it('⚠️ data ze znacznikiem czasu skraca sie do dnia — dwukropek zabija zapis na SMB', () => {
    const sciezka = sciezkaArchiwum({
      dataWystawienia: '2026-06-30T22:30:00Z', sprzedawcaNazwa: 'Allegro',
      numerDokumentu: 'FV/1', rozszerzenie: 'xml',
    });
    expect(sciezka).toBe('Kosztowe 2026/Czerwiec/2026-06-30_ALLEGRO_FV-1.xml');
    expect(sciezka).not.toContain(':');
  });

  it('sprzedawca bez nazwy dostaje NIP zamiast pustego miejsca w nazwie pliku', () => {
    expect(sciezkaArchiwum({ dataWystawienia: '2026-06-05', sprzedawcaNazwa: null, sprzedawcaNip: '5252674798', numerDokumentu: 'A', rozszerzenie: 'xml' }))
      .toContain('_5252674798_A.xml');
  });
});

// ⚠️ `wiersz` w calym module kosztowym jest SUROWYM WIERSZEM Z TABELI `koszty` (nazwy kolumn
// snake_case) — dokladnie tak, jak czytaja go domain/lista-kosztow.js i kosztyMiesiaca (patrz
// db/koszty.js). Zadnego drugiego mapowania na camelCase tutaj nie ma.
const wiersz = (nadpisz = {}) => ({
  ksefNumber: 'K-1', numerDokumentu: 'FV/1', sprzedawcaNip: '5252674798',
  sprzedawcaNazwa: 'Allegro', dataWystawienia: '2026-06-05',
  dataTrwalegoZapisu: '2026-06-05T14:00:00Z', netto: '100.00', vat: '23.00', brutto: '123.00',
  waluta: 'PLN', rodzaj: 'Vat', maZalacznik: 0, ...nadpisz,
});

// Wiersz DOKLADNIE taki, jaki oddaje `SELECT * FROM koszty` — po wstawieniu przez `zapiszKoszt`.
function wstawKoszt(db, nadpisz = {}) {
  zapiszKoszt(db, wiersz(nadpisz));
  return db.prepare('SELECT * FROM koszty WHERE ksef_number = ?').get(nadpisz.ksefNumber ?? 'K-1');
}

const katalogTymczasowy = () => mkdtempSync(join(tmpdir(), 'archiwum-kosztow-'));

describe('zarchiwizuj', () => {
  it('⚠️ dokument z JUZ ZAPISANA sciezka jest pomijany bez ani jednego wywolania KSeF', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db);
    db.prepare('UPDATE koszty SET sciezka_xml = ? WHERE ksef_number = ?').run('Kosztowe 2026/Czerwiec/juz-jest.xml', 'K-1');
    const wZeSciezka = db.prepare('SELECT * FROM koszty WHERE ksef_number = ?').get('K-1');

    const klient = { pobierzXml: async () => { throw new Error('nie wolno bylo tego wolac'); } };
    const sesja = { accessToken: async () => { throw new Error('nie wolno bylo tego wolac'); } };

    const wynik = await zarchiwizuj({
      db, klient, sesja, wiersz: wZeSciezka, katalogBazowy: katalogTymczasowy(),
    });

    expect(wynik).toEqual({ pominiete: true, powod: expect.any(String) });
  });

  it('pobiera XML z KSeF, zapisuje plik w konwencji katalogow i uzupelnia sciezke w bazie', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db);
    const katalogBazowy = katalogTymczasowy();
    let widzianyKsefNumber = null;
    const klient = {
      pobierzXml: async ({ accessToken, ksefNumber }) => {
        widzianyKsefNumber = ksefNumber;
        expect(accessToken).toBe('ACC-Z-BAZY');
        return '<Faktura>tresc</Faktura>';
      },
    };
    const sesja = { accessToken: async () => 'ACC-Z-BAZY' };

    const wynik = await zarchiwizuj({ db, klient, sesja, wiersz: w, katalogBazowy });

    expect(widzianyKsefNumber).toBe('K-1');
    expect(wynik.xml).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.xml');
    expect(readFileSync(join(katalogBazowy, wynik.xml), 'utf8')).toBe('<Faktura>tresc</Faktura>');

    const poZapisie = db.prepare('SELECT sciezka_xml FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(poZapisie.sciezka_xml).toBe(wynik.xml);
  });

  it('⚠️ AWARIA NAS-A NIE PRZERYWA PRACY: nieudany zapis na dysk nie rzuca, zostawia ostrzezenie i NIE zapisuje sciezki w bazie', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db);
    const katalogBazowy = katalogTymczasowy();
    // Podklada PLIK tam, gdzie zarchiwizuj potrzebuje ZALOZYC KATALOG ('Kosztowe 2026') —
    // mkdirSync z opcja recursive na takiej przeszkodzie rzuca (ENOTDIR), a to jest realny
    // odpowiednik awarii NAS-a: sciezka jest osiagalna, ale nie da sie na niej nic zapisac.
    writeFileSync(join(katalogBazowy, 'Kosztowe 2026'), 'to jest plik, nie katalog');

    const klient = { pobierzXml: async () => '<Faktura>tresc</Faktura>' };
    const sesja = { accessToken: async () => 'ACC' };
    const ostrzezenia = [];
    const log = (...czesci) => ostrzezenia.push(czesci.join(' '));

    const wynik = await zarchiwizuj({
      db, klient, sesja, wiersz: w, katalogBazowy, log,
    });

    expect(wynik.pominiete).toBeUndefined();
    expect(wynik.xml).toBeFalsy();
    expect(ostrzezenia.length).toBe(1);
    expect(ostrzezenia[0]).toContain('K-1');

    const poNieudanymZapisie = db.prepare('SELECT sciezka_xml FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(poNieudanymZapisie.sciezka_xml).toBeNull();
  });

  // ⚠️ PDF WIZUALIZACJI POWSTAJE OBOK XML-a (Zadanie 12) — ta sama nazwa pliku, inne
  // rozszerzenie. KSeF oddaje wylacznie XML, wiec kartka do obejrzenia jest jedynym sposobem,
  // zeby ktokolwiek zobaczyl pozycje cudzej faktury bez czytania znacznikow.
  it('rysuje PDF wizualizacji obok XML-a: ta sama nazwa, inne rozszerzenie', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db);
    const katalogBazowy = katalogTymczasowy();
    const klient = {
      pobierzXml: async () => '<Faktura><Fa><FaWiersz><NrWierszaFa>1</NrWierszaFa>'
        + '<P_7>Papier ksero</P_7><P_8A>ryza</P_8A><P_8B>2.0000</P_8B>'
        + '<P_9A>18.50</P_9A><P_11>37.00</P_11><P_12>23</P_12></FaWiersz></Fa></Faktura>',
    };
    const sesja = { accessToken: async () => 'ACC' };

    const wynik = await zarchiwizuj({ db, klient, sesja, wiersz: w, katalogBazowy });

    expect(wynik.pdf).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.pdf');
    expect(readFileSync(join(katalogBazowy, wynik.pdf)).subarray(0, 5).toString()).toBe('%PDF-');

    const poZapisie = db.prepare('SELECT sciezka_xml, sciezka_pdf FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(poZapisie.sciezka_pdf).toBe(wynik.pdf);
    expect(poZapisie.sciezka_xml).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.xml');
  });

  // ⚠️ ORYGINAL JEST WAZNIEJSZY NIZ JEGO OBRAZEK. XML z KSeF pobiera sie RAZ (bramka po
  // `sciezka_xml`), wiec awaria rysowania nie ma prawa zabrac archiwum oryginalu — inaczej
  // jedna niespodzianka w ksztalcie cudzego dokumentu kosztuje kolejne pobranie co noc.
  it('⚠️ awaria rysowania PDF-a NIE zabiera zarchiwizowanego XML-a', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db);
    const katalogBazowy = katalogTymczasowy();
    const klient = { pobierzXml: async () => '<Faktura/>' };
    const sesja = { accessToken: async () => 'ACC' };
    const ostrzezenia = [];

    const wynik = await zarchiwizuj({
      db,
      klient,
      sesja,
      wiersz: w,
      katalogBazowy,
      log: (...c) => ostrzezenia.push(c.join(' ')),
      pdf: async () => { throw new Error('pdfkit sie wywrocil'); },
    });

    expect(wynik.xml).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.xml');
    expect(wynik.pdf).toBeNull();
    expect(ostrzezenia.length).toBe(1);
    expect(ostrzezenia[0]).toContain('K-1');

    const poZapisie = db.prepare('SELECT sciezka_xml, sciezka_pdf FROM koszty WHERE ksef_number = ?').get('K-1');
    expect(poZapisie.sciezka_xml).toBe(wynik.xml);
    expect(poZapisie.sciezka_pdf).toBeNull();
  });

  // ⚠️⚠️ PONAWIA SIE SAMO POBRANIE XML-a, A NIE CALA FUNKCJA — I TO JEST WARUNEK POPRAWNOSCI,
  // A NIE UKLAD KODU (recenzja Task 16).
  //
  // `sesja.accessToken()` (ksef/sesja.js) robi PELNE logowanie do KSeF najwyzej RAZ, bo
  // `/auth/token/redeem` jest jednorazowe: drugie podejscie z tym samym challenge odbija sie
  // od MF. Gdyby ponowieniem po 429 objac cale `zarchiwizuj`, kazda odmowa z limitu wracalaby
  // NAD `accessToken()` i kazalaby powtorzyc logowanie — do czterech razy, kazde z wlasnym
  // ciagiem zadan. Dlatego token bierzemy RAZ, a w `zCzekaniemNa429` siedzi WYLACZNIE
  // `klient.pobierzXml`.
  it('⚠️ 429 przy pobraniu XML-a ponawia SAMO pobranie — logowanie do KSeF leci RAZ', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db);
    const katalogBazowy = katalogTymczasowy();
    let logowan = 0;
    let odmowil = false;
    const spania = [];
    const sesja = { accessToken: async () => { logowan += 1; return 'ACC'; } };
    const klient = {
      pobierzXml: async ({ accessToken }) => {
        expect(accessToken).toBe('ACC');
        if (!odmowil) {
          odmowil = true;
          throw Object.assign(new Error('KSeF odmówił: HTTP 429'), {
            status: 429, retryAfterS: 1, dlaOperatora: true,
          });
        }
        return '<Faktura/>';
      },
    };

    const wynik = await zarchiwizuj({
      db,
      klient,
      sesja,
      wiersz: w,
      katalogBazowy,
      limit: {
        spij: async (ms) => { spania.push(ms); },
        teraz: () => new Date(0),
        doKiedy: 10 * 60 * 1000,
      },
    });

    // JEDNO logowanie na caly dokument, mimo dwoch pobran XML-a.
    expect(logowan).toBe(1);
    // Sekunda z odmowy plus sekunda zapasu — i ani jednego spania wiecej.
    expect(spania).toEqual([2000]);
    expect(wynik.xml).toBe('Kosztowe 2026/Czerwiec/2026-06-05_ALLEGRO_FV-1.xml');
    expect(readFileSync(join(katalogBazowy, wynik.xml), 'utf8')).toBe('<Faktura/>');
    expect(db.prepare('SELECT sciezka_xml FROM koszty WHERE ksef_number = ?').get('K-1').sciezka_xml)
      .toBe(wynik.xml);
  });

  it('sprzedawca bez nazwy w bazie archiwizuje sie pod NIP-em, tak samo jak w sciezkaArchiwum', async () => {
    const db = openOmsDb();
    const w = wstawKoszt(db, { ksefNumber: 'K-2', sprzedawcaNazwa: null });
    const katalogBazowy = katalogTymczasowy();
    const klient = { pobierzXml: async () => '<Faktura/>' };
    const sesja = { accessToken: async () => 'ACC' };

    const wynik = await zarchiwizuj({ db, klient, sesja, wiersz: w, katalogBazowy });

    expect(wynik.xml).toContain('_5252674798_FV-1.xml');
  });
});
