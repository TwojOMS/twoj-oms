import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zbudujSpecyfikacjePdf, zbudujSpecyfikacjeWieluPdf } from '../../../src/moduly/zamowienia/pdf/specyfikacja-pdf.js';

// Dokument "Specyfikacja zamowienia" - kartka wkladana do KAZDEJ paczki. Przy zamowieniach
// firmowych zastepuje wydruk faktury (ta i tak dociera przez KSeF), przy indywidualnych idzie
// obok paragonu z kasy fiskalnej. Ten modul TYLKO RYSUJE dane z Zadania 6
// (domain/specyfikacja.js, funkcja daneSpecyfikacji) — zadnego liczenia kwot tutaj.

// ─────────────────────────────────────────────────────────────────────────────
// Wykrycie poppera. SKOPIOWANE z tests/oms/proforma-pdf.test.js (linie 11-45) — testy
// tekstowe czytaja wygenerowany PDF `pdftotext`-em, bo tylko odczyt POWROTNY dowodzi, ze
// w dokumencie siedza prawdziwe litery, a nie dziury po fontach bez polskich znakow. Ale
// poppera NIE MA w kontenerze na NAS-ie, a suita ma tam byc zielona — wiec brak binarki ma
// POMINAC te testy z czytelnym komunikatem, nigdy wywrocic suite.
// ─────────────────────────────────────────────────────────────────────────────
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
  console.warn(
    '[specyfikacja-pdf] pdftotext (poppler) nie znaleziony — testy odczytu tekstu z PDF-a POMINIETE. '
    + 'Nie oznacza to, ze dokument jest poprawny: test polskich znakow, ktory jako jedyny lapie '
    + 'brak osadzonego fontu, NIE zostal uruchomiony.',
  );
}

/** Strony dokumentu jako osobne napisy — `pdftotext` rozdziela je znakiem wysuwu (\f). */
function strony(tekst) {
  return tekst.split('\f').filter((s) => s.trim() !== '');
}

/** 30 pozycji z dwuwierszowymi nazwami — komplet, ktory NA PEWNO lamie sie na trzy strony. */
function duzoPozycji(ile = 30) {
  return Array.from({ length: ile }, (_, i) => ({
    nazwa: `Pozycja numer ${i + 1} — dlugi opis produktu, ktory na pewno zawinie sie na dwie linie w kolumnie nazwy`,
    symbol: `SYM-${String(i + 1).padStart(3, '0')}`,
    ilosc: 1,
    cenaZl: '10.00',
    wartoscZl: '10.00',
  }));
}

/** PDF → tekst. Zapis do pliku, bo pdftotext czyta plik, nie stdin. */
function pdfNaTekst(buf) {
  const kat = mkdtempSync(path.join(tmpdir(), 'specyfikacja-'));
  try {
    const plik = path.join(kat, 'p.pdf');
    writeFileSync(plik, buf);
    return execFileSync(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', plik, '-'], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    rmSync(kat, { recursive: true, force: true });
  }
}

const SPRZEDAWCA = { nazwa: 'Lumina Marek Zywiecki', adres: 'ul. 1 Maja 5, 00-650 Pęki', bdo: '000123456' };
const dane = (n = {}) => ({
  numer: '3001',
  dataZamowienia: '2026-08-05',
  sprzedawca: SPRZEDAWCA,
  nabywca: {
    firma: 'Firma X', ulica: 'Długa 1', kod: '00-001', miasto: 'Warszawa',
  },
  pozycje: [{
    nazwa: 'STOP 70x100', symbol: 'STOP-70', ilosc: 2, cenaZl: '50.00', wartoscZl: '100.00',
  }],
  dostawaZl: '10.00',
  razemZl: '110.00',
  nettoZl: '89.43',
  // ⚠️ WARTOSCI JUZ GOTOWE DO DRUKU — ten modul TYLKO RYSUJE. Sklada je `daneSpecyfikacji`
  // (domain/specyfikacja.js): `dostawa` przechodzi przez `etykietaWysylki`, wiec tu stoi
  // „DPD", a nie klucz `dpd`; `platnosc` niesie metode RAZEM ZE STANEM. Do 12.08.2026
  // fixture mial tu `'dpd'` — czyli utrwalal na papierze wewnetrzny kod, ktory na kartce
  // dla klienta byl usterka do zgloszenia.
  platnosc: 'Przelewy24 — opłacone',
  dostawa: 'DPD',
  faktura: null,
  ...n,
});

describe('PDF specyfikacji — dokument', () => {
  it('zwraca Buffer z naglowkiem PDF-a', async () => {
    const buf = await zbudujSpecyfikacjePdf(dane());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(500);
  });

  it('pusta lista nie daje pliku, tylko odmowe', async () => {
    await expect(zbudujSpecyfikacjeWieluPdf([])).rejects.toThrow();
  });
});

describe.skipIf(!PDFTOTEXT)('PDF specyfikacji — tresc odczytana z gotowego dokumentu', () => {
  // ⚠️ CICHA AWARIA, KTORA KONCZY SIE U KLIENTA: wbudowane fonty PDF nie maja polskich
  // znakow, a pdfkit NIE PROTESTUJE — dokument powstaje bez jednego ostrzezenia, tylko z
  // dziurami zamiast `l a e z s c n o z`. Jedyny test, ktory to lapie, to odczyt POWROTNY:
  // Buffer wyglada tak samo w obu razach.
  it('wypisuje polskie znaki, a nie dziury', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toContain('Zywiecki');
    expect(tekst).toContain('Pęki');
    expect(tekst).not.toContain('�');
  });

  // ⚠️ CALA STAWKA TEGO DOKUMENTU. Bez tej linijki kartka z pozycjami, cenami i VAT-em
  // laduje w ksiegowosci firmy obok faktury z KSeF i zostaje zaksiegowana DRUGI RAZ.
  it('niesie stopke odcinajaca dokument od faktury', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toMatch(/nie jest fakturą VAT/i);
    expect(tekst).toMatch(/paragonem fiskalnym/i);
  });

  it('drukuje symbol wzoru, bo obiecuje go wrzutka prawna (GPSR)', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toContain('STOP-70');
  });

  it('drukuje numer faktury z adnotacja o KSeF, gdy faktura istnieje', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({ faktura: { numer: '24/08/2026' } })));
    expect(tekst).toContain('24/08/2026');
    expect(tekst).toMatch(/KSeF/);
  });

  it('bez faktury nie drukuje tej linijki wcale', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).not.toMatch(/KSeF/);
  });

  it('drukuje numer i date zamowienia, platnosc ze stanem i sposob dostawy', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toContain('3001');
    expect(tekst).toContain('2026-08-05');
    // ⚠️ CALY napis platnosci, nie sama metoda: spec wymienial „metode platnosci ZE STANEM",
    // a `toContain('Przelewy24')` przechodzilo takze wtedy, gdy stan gubil sie po drodze.
    expect(tekst).toMatch(/Płatność:\s*Przelewy24 — opłacone/);
    // ⚠️ NAZWA DLA CZLOWIEKA. `not.toMatch` na goly kod pilnuje, ze stary napis nie wraca —
    // przy zamowieniu z paczkomatem kod brzmial `inpost_paczkomat`, a przy nierozpoznanej
    // metodzie „Sposób dostawy: nieznana", co klient zglaszal jako usterke.
    expect(tekst).toMatch(/Sposób dostawy:\s*DPD/);
    expect(tekst).not.toMatch(/Sposób dostawy:\s*dpd/);
  });

  it('drukuje kwote dostawy i kwote razem', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toContain('10.00');
    expect(tekst).toContain('110.00');
  });

  it('drukuje dane nabywcy', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toContain('Firma X');
    expect(tekst).toContain('Długa 1');
    expect(tekst).toContain('Warszawa');
  });

  it('wielu zamowien daje tyle stron, ile zamowien', async () => {
    const buf = await zbudujSpecyfikacjeWieluPdf([
      dane({ numer: '3001' }), dane({ numer: '3002' }), dane({ numer: '3003' }),
    ]);
    const tekst = pdfNaTekst(buf);
    expect(tekst).toContain('3001');
    expect(tekst).toContain('3002');
    expect(tekst).toContain('3003');
    // `pdftotext` rozdziela strony znakiem wysuwu strony (\f) — liczymy je nim.
    expect(tekst.split('\f').filter((s) => s.trim()).length).toBe(3);
  });

  // Numer BDO jest wymogiem ustawowym na tym dokumencie (ta sama wrzutka prawna, co symbol
  // wzoru) — fixture go niesie, kod go rysuje, ale zaden test dotad tego nie sprawdzal.
  it('drukuje numer BDO sprzedawcy (wymog ustawowy)', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toContain('000123456');
  });

  // ⚠️ REGRESJA NA UTRACIE DANYCH — zlapana na renderze zamowienia hurtowego, nie przez
  // ktorykolwiek test wyzej: kazda fabryka danych w tym pliku miala dotad JEDNA pozycje, wiec
  // laczenie stron nigdy nie bylo cwiczone. `komorka()` (Symbol/Ilosc/Cena/Wartosc) rysuje
  // BEZ `width` i nie sprawdza granicy strony sama — pdfkit dokladal strone WYLACZNIE przy
  // komorce „Nazwa" (jedyna z `width`), w SRODKU wiersza. Efekt: reszta kolumn wiersza
  // zostawala na starej stronie, a `y` dla RAZEM/kosztu dostawy dziedziczylo rozjechana
  // wspolrzedna i te linie znikaly z dokumentu BEZ WYJATKU — Buffer wygladal poprawnie.
  // Test sprawdza UTRATE DANYCH (suma, kazda pozycja, koszt dostawy), nie uklad strony.
  it('30 pozycji z dwuwierszowymi nazwami: RAZEM, koszt dostawy i kazda pozycja przetrwaja lamanie stron', async () => {
    const pozycje = duzoPozycji();
    const d = dane({ pozycje, dostawaZl: '15.00', razemZl: '315.00' });
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(d));

    // Suma i jej kwota musza byc GDZIES w dokumencie.
    expect(tekst).toMatch(/RAZEM/);
    expect(tekst).toContain('315.00 PLN');

    // Koszt dostawy tez nie ma prawa zniknac.
    expect(tekst).toContain('15.00 PLN');

    // Zadna z 30 pozycji nie ma prawa zginac — liczymy symbole, bo sa unikalne.
    const brakujace = pozycje.filter((p) => !tekst.includes(p.symbol));
    expect(brakujace, `brakujace symbole: ${brakujace.map((p) => p.symbol).join(', ')}`).toEqual([]);
  });

  // ⚠️ REGRESJA ZLAPANA W RECENZJI 12.08.2026, TA SAMA KLASA CO LAMANIE STRON WYZEJ: kazdy
  // test stopki mial dotad JEDNA pozycje, czyli JEDNA strone — i przy jednej stronie „stopka
  // na ostatniej" jest nieodroznialne od „stopki na kazdej". Zmierzony rozklad przed poprawka:
  // str. 1 false, str. 2 false, str. 3 true. Strony 1-2 niosly komplet pozycji, symboli i cen
  // bez ani jednego zdania odcinajacego kartke od faktury — czyli dokladnie tej kartki, ktora
  // ksiegowosc firmy zaksieguje drugi raz obok faktury z KSeF.
  //
  // Test porownuje LICZBE stopek z LICZBA STRON, a nie „czy stopka gdzies jest": ta druga
  // asercja przechodzila przed poprawka i to jest cala roznica.
  it('stopka odcinajaca od faktury stoi na KAZDEJ stronie, nie tylko na ostatniej', async () => {
    const d = dane({ pozycje: duzoPozycji(), dostawaZl: '15.00', razemZl: '315.00' });
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(d));
    const s = strony(tekst);
    expect(s.length).toBeGreaterThan(1); // fixture MA sie lamac — inaczej test nic nie mierzy
    const bezStopki = s
      .map((strona, i) => ({ nr: i + 1, ma: /nie jest fakturą VAT/i.test(strona) }))
      .filter((x) => !x.ma)
      .map((x) => x.nr);
    expect(bezStopki, `strony bez stopki: ${bezStopki.join(', ')}`).toEqual([]);
  });

  // Strona kontynuacji bez tytulu i bez numeru zamowienia jest kartka z cenami bez tozsamosci:
  // wypadnie z paczki i nie ma po czym poznac, do czego nalezy. Przed poprawka strona 2 i 3
  // nie mialy ANI numeru, ANI tytulu — zaczynaly sie od golego naglowka tabeli.
  it('kazda strona niesie numer zamowienia, a strony kontynuacji takze swoj numer', async () => {
    const d = dane({ numer: '3001', pozycje: duzoPozycji(), dostawaZl: '15.00', razemZl: '315.00' });
    const s = strony(pdfNaTekst(await zbudujSpecyfikacjePdf(d)));
    expect(s.length).toBeGreaterThan(1);
    const bezNumeru = s.map((strona, i) => ({ nr: i + 1, ma: strona.includes('3001') }))
      .filter((x) => !x.ma).map((x) => x.nr);
    expect(bezNumeru, `strony bez numeru zamowienia: ${bezNumeru.join(', ')}`).toEqual([]);
    // Strony od drugiej w gore maja wiersz „… — str. n" z WLASCIWYM numerem strony.
    s.slice(1).forEach((strona, i) => {
      expect(strona, `strona ${i + 2}`).toContain(`Specyfikacja zamówienia nr 3001 — str. ${i + 2}`);
    });
  });

  // Numeracja stron liczy sie W OBREBIE ZAMOWIENIA, nie pliku — czlowiek trzymajacy kartki
  // JEDNEJ paczki ma widziec „str. 2", a nie „str. 5". Przy dokumencie zbiorczym to jedyny
  // sposob, zeby kartki dalo sie rozdzielic po paczkach.
  it('w dokumencie zbiorczym kazda strona ma stopke, a numeracja stron wraca do 1 przy kolejnym zamowieniu', async () => {
    const buf = await zbudujSpecyfikacjeWieluPdf([
      dane({ numer: '3001', pozycje: duzoPozycji(), dostawaZl: '15.00', razemZl: '315.00' }),
      dane({ numer: '3002', pozycje: duzoPozycji(), dostawaZl: '15.00', razemZl: '315.00' }),
    ]);
    const s = strony(pdfNaTekst(buf));
    expect(s.length).toBeGreaterThan(3);
    const bezStopki = s.map((strona, i) => ({ nr: i + 1, ma: /nie jest fakturą VAT/i.test(strona) }))
      .filter((x) => !x.ma).map((x) => x.nr);
    expect(bezStopki, `strony bez stopki: ${bezStopki.join(', ')}`).toEqual([]);
    // Drugie zamowienie ma WLASNA „str. 2", a nie ciag dalszy numeracji pliku.
    const drugie = s.filter((strona) => strona.includes('3002'));
    expect(drugie.some((strona) => strona.includes('Specyfikacja zamówienia nr 3002 — str. 2'))).toBe(true);
    expect(s.some((strona) => /str\. [4-9]/.test(strona))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cztery uzupelnienia kartki z 24.08.2026 (prosba wlasciciela). Wszystkie sprawdzane
// ODCZYTEM POWROTNYM z gotowego PDF-a — asercja na danych wejsciowych nie dowiodlaby,
// ze cokolwiek naprawde trafilo na papier.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!PDFTOTEXT)('PDF specyfikacji — paragon, data platnosci i uwagi klienta', () => {
  it('podpisuje date u gory jako date ZAMOWIENIA', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane()));
    expect(tekst).toMatch(/Data zamówienia:\s*2026-08-05/);
  });

  it('drukuje date platnosci, gdy platnosc byla', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({ dataPlatnosci: '2026-08-06' })));
    expect(tekst).toMatch(/Data płatności:\s*2026-08-06/);
  });

  // ⚠️ Przy pobraniu daty platnosci NIE MA — pusty wiersz „Data płatności:" sugerowalby
  // klientowi, ze cos poszlo nie tak.
  it('nie drukuje pustego wiersza daty platnosci przy pobraniu', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({
      dataPlatnosci: null,
      platnosc: 'Za pobraniem — do zapłaty kurierowi przy odbiorze',
    })));
    expect(tekst).not.toMatch(/Data płatności/);
  });

  it('sprzedaz bez faktury dostaje informacje o paragonie', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({ paragon: true, faktura: null })));
    expect(tekst).toMatch(/Dokument sprzedaży:\s*paragon fiskalny — w przesyłce/);
  });

  it('wybrana faktura bez numeru jest widoczna na gotowym PDF', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({
      fakturaWybrana: true, paragon: false, faktura: null,
    })));
    expect(tekst).toMatch(/Wybrany dokument sprzedaży:\s*faktura VAT/);
    expect(tekst).not.toMatch(/Dokument sprzedaży:\s*paragon/);
    expect(tekst).not.toMatch(/doręczona przez KSeF/);
  });

  it('zamowienie z faktura NIE dostaje informacji o paragonie', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({
      paragon: false, faktura: { numer: 'FV/1/2026' },
    })));
    expect(tekst).toContain('FV/1/2026');
    // ⚠️ ASERCJA NA CALA LINIE, nie na slowo „paragon" — STOPKA kazdej strony niesie
    // „nie jest fakturą VAT ani paragonem fiskalnym", wiec `not.toMatch(/paragon/i)`
    // bylo czerwone ZAWSZE, niezaleznie od tresci dokumentu (zlapane przy pisaniu testu).
    expect(tekst).toMatch(/Dokument sprzedaży:\s*faktura VAT nr FV\/1\/2026/);
    expect(tekst).not.toMatch(/Dokument sprzedaży:\s*paragon/);
  });

  // ⚠️ NUMER DOKUMENTU, KTORY JUZ ISTNIEJE, JEST TWARDSZYM FAKTEM niz flaga „chce fakture".
  // Bez tej kolejnosci kartka potrafilaby obiecac paragon zamowieniu, na ktore poszla faktura.
  it('faktura wygrywa z paragonem, gdyby oba znaczniki stanely naraz', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({
      paragon: true, faktura: { numer: 'FV/2/2026' },
    })));
    expect(tekst).toContain('FV/2/2026');
    expect(tekst).not.toMatch(/Dokument sprzedaży:\s*paragon/);
  });

  it('drukuje kwote netto pod kwota RAZEM', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({ nettoZl: '89.43' })));
    expect(tekst).toMatch(/w tym netto\s+89\.43 PLN/);
    // Brutto ZOSTAJE najmocniejsza liczba — obie sa na kartce, kazda w swoim wierszu.
    expect(tekst).toMatch(/RAZEM\s+110\.00 PLN/);
  });

  it('drukuje uwagi klienta pod podsumowaniem', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({
      uwagiKlienta: 'Proszę zapakować na prezent, bez cennika w środku.',
    })));
    expect(tekst).toContain('Uwagi klienta');
    expect(tekst).toContain('Proszę zapakować na prezent');
  });

  it('bez uwag nie ma naglowka nad niczym', async () => {
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({ uwagiKlienta: null })));
    expect(tekst).not.toContain('Uwagi klienta');
  });

  // ⚠️⚠️ JEDYNE POLE TEGO DOKUMENTU O DLUGOSCI NIEOGRANICZONEJ Z GORY. Staly budzet punktow
  // uciąlby dlugi tekst albo nadpisal nim stopke, ktora odcina kartke od faktury. Test
  // sprawdza jedno i drugie: caly tekst jest w dokumencie ORAZ stopka przetrwala.
  it('dluga uwaga nie ucina sie i nie zjada stopki', async () => {
    const dlugaUwaga = Array.from({ length: 40 }, (_, i) => `Zdanie numer ${i + 1} w bardzo długiej uwadze klienta, która na pewno nie zmieści się w jednym wierszu.`).join(' ');
    const tekst = pdfNaTekst(await zbudujSpecyfikacjePdf(dane({ uwagiKlienta: dlugaUwaga })));
    expect(tekst).toContain('Zdanie numer 1 ');
    expect(tekst).toContain('Zdanie numer 40 ');
    expect(tekst).toMatch(/nie jest fakturą/i);
  });
});
