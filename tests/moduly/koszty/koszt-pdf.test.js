import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { zbudujKosztPdf } from '../../../src/moduly/koszty/pdf/koszt-pdf.js';
import { dokumentZXml } from '../../../src/domena/koszt-xml.js';

// ⚠️ ODCZYT POWROTNY `pdftotext`-em TO JEDYNY TEST, KTORY ZLAPIE BRAK POLSKICH ZNAKOW.
// Wbudowane fonty PDF nie maja `ł ą ę ż ś ć ń ó ź`, a pdfkit nie protestuje — Buffer wyglada
// identycznie w obu przypadkach, wiec sprawdzenie samego bufora nie chroni przed niczym.
//
// ⚠️ WYKRYCIE BINARKI — TA SAMA KONSTRUKCJA, CO W proforma-pdf.test.js I specyfikacja-pdf.test.js
// (i z tego samego powodu): poppler NIE STOI w kontenerze na NAS-ie, a suita ma tam byc zielona.
// Brak binarki POMIJA te testy z glosnym ostrzezeniem, nigdy nie wywraca suity.
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
    '[koszt-pdf] pdftotext (poppler) nie znaleziony — testy odczytu tekstu z PDF-a POMINIETE. '
    + 'Nie oznacza to, ze dokument jest poprawny: test polskich znakow, ktory jako jedyny lapie '
    + 'brak osadzonego fontu, NIE zostal uruchomiony.',
  );
}

// ⚠️ `-enc UTF-8` JEST TU OBOWIAZKOWE, a nie ozdobne. Bez niego `pdftotext` (xpdf 4.06 na
// maszynie wlasciciela) oddaje tekst w Latin-1 i sam WYCINA `ł ą ę ż ś ć ń` — czyli test
// polskich znakow padalby na KAZDYM dokumencie, takze poprawnym, a po „naprawieniu" go
// oczekiwaniem bez ogonkow przestalby chronic przed czymkolwiek.
const tekstZPdf = (buf) => {
  const kat = mkdtempSync(join(tmpdir(), 'koszt-pdf-'));
  const plik = join(kat, 'a.pdf');
  writeFileSync(plik, buf);
  return execFileSync(PDFTOTEXT, ['-layout', '-enc', 'UTF-8', plik, '-'], { encoding: 'utf8' });
};

const gdyJestPdftotext = PDFTOTEXT ? it : it.skip;

// Zdanie stopki widoczne na KAŻDEJ stronie — do sprawdzania, czy TREŚĆ nie weszła na nie
// literami (patrz test długiej uwagi pod tabelą). `-layout` trzyma kolejność pionową, więc
// tekst narysowany na wysokości stopki wychodzi w TEJ SAMEJ linii co stopka.
//
// ⚠️ DECYZJA WŁAŚCICIELA (03.09.2026) — zdanie „Wizualizacja dokumentu z KSeF — oryginałem
// jest plik XML." zostało ZDJĘTE z wydruku (pod tytułem i w stopce). Biuro księgowe pracuje
// z dokumentami z KSeF na co dzień i samo wie, że to wizualizacje. Testy niżej sprawdzają, że
// zdanie NIE STOI już na żadnej stronie — patrz uzasadnienie w src/oms/pdf/koszt-pdf.js.
const NAPIS_ODROZNIAJACY = 'Wizualizacja dokumentu z KSeF — oryginałem jest plik XML.';
const STOPKA_ZRODLA = 'Wyrysowana w panelu zamówień z pliku pobranego z KSeF.';

/** Linia wydruku zawierająca podany napis (pierwsza) — do sprawdzania, co stoi OBOK. */
const liniaZ = (tekst, czego) => tekst.split('\n').find((l) => l.includes(czego)) ?? '';

// Kwoty jako NAPISY z dwoma miejscami po przecinku — dokladnie taki ksztalt oddaje `naWiersz`
// (domain/koszt-metadane.js) i taki lezy w kolumnach TEXT tabeli `koszty`.
const wiersz = {
  numer_dokumentu: 'FV/2026/06/12',
  sprzedawca_nazwa: 'Księgarnia Świąteczna sp. z o.o.',
  sprzedawca_nip: '5252674798',
  data_wystawienia: '2026-06-05',
  netto: '100.00',
  vat: '23.00',
  brutto: '123.00',
  waluta: 'PLN',
  rodzaj: 'Vat',
  ksef_number: '1000001193-20260605-0100AB-CD',
};

const pozycja = (n = {}) => ({
  lp: '1',
  nazwa: 'Papier ksero A4 80g „Śnieżka"',
  jednostka: 'ryza',
  ilosc: '2',
  cenaNetto: '18.50',
  wartoscNetto: '37.00',
  stawkaVat: '23%',
  ...n,
});

describe('PDF wizualizacji kosztu', () => {
  gdyJestPdftotext('⚠️ polskie znaki OCALAJA — wbudowane fonty PDF ich nie maja i nie protestuja', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({ wiersz, pozycje: [] }));
    expect(tekst).toContain('Księgarnia Świąteczna');
    expect(tekst).not.toContain('Ksi garnia');
  });

  gdyJestPdftotext('⚠️ zdanie odrozniajace wizualizacje od dokumentu NIE STOI na wydruku (decyzja wlasciciela 03.09.2026)', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({ wiersz, pozycje: [] }));
    expect(tekst).not.toContain(NAPIS_ODROZNIAJACY);
    expect(tekst).not.toContain('oryginałem jest plik XML');
    // Stopka zostaje — tylko krotsze zdanie o pochodzeniu wydruku.
    expect(tekst).toContain(STOPKA_ZRODLA);
  });

  gdyJestPdftotext('niesie numer KSeF, numer dokumentu, sprzedawce i kwoty', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({ wiersz, pozycje: [] }));
    for (const oczekiwane of ['1000001193-20260605-0100AB-CD', 'FV/2026/06/12', '5252674798', '123,00']) {
      expect(tekst).toContain(oczekiwane);
    }
  });

  gdyJestPdftotext('rysuje pozycje dokumentu wprost z podanych danych', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({
      wiersz,
      pozycje: [pozycja(), pozycja({
        lp: '2', nazwa: 'Usługa hostingu', jednostka: 'szt', ilosc: '1.5', cenaNetto: '42.00', wartoscNetto: '63.00', stawkaVat: 'zw',
      })],
    }));
    expect(tekst).toContain('Papier ksero A4 80g');
    expect(tekst).toContain('Usługa hostingu');
    expect(tekst).toContain('18,50');
    expect(tekst).toContain('63,00');
    expect(tekst).toContain('zw');
  });

  gdyJestPdftotext('⚠️ dokument BEZ pozycji mowi o tym wprost — pusta tabela wyglada jak blad wydruku', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({ wiersz, pozycje: [] }));
    expect(tekst).toContain('XML z KSeF nie zawiera pozycji');
  });

  gdyJestPdftotext('⚠️ zdanie odrozniajace jest NIEOBECNE na KAZDEJ stronie, nie tylko na pierwszej', async () => {
    const duzo = Array.from({ length: 60 }, (_, i) => pozycja({ lp: String(i + 1) }));
    const buf = await zbudujKosztPdf({ wiersz, pozycje: duzo });
    const strony = tekstZPdf(buf).split('\f').filter((s) => s.trim() !== '');
    expect(strony.length).toBeGreaterThan(1);
    for (const strona of strony) {
      expect(strona).not.toContain(NAPIS_ODROZNIAJACY);
      expect(strona).not.toContain('oryginałem jest plik XML');
      // Stopka zostaje na kazdej stronie — tylko krotsze zdanie.
      expect(strona).toContain(STOPKA_ZRODLA);
      // Strona kontynuacji bez numeru dokumentu to kartka, ktorej nie ma jak przypisac
      // do faktury — ta sama lekcja, co przy specyfikacji do paczki.
      expect(strona).toContain('FV/2026/06/12');
    }
  });

  gdyJestPdftotext('⚠️ waluta dokumentu idzie z wiersza, a nie z zalozenia „zawsze PLN"', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({
      wiersz: {
        ...wiersz, waluta: 'CZK', netto: '900.00', vat: '0.00', brutto: '900.00',
      },
      pozycje: [],
    }));
    expect(tekst).toContain('CZK');
    expect(tekst).toContain('900,00');
  });

  gdyJestPdftotext('⚠️ brakujaca kwota daje pusta komorke, a nie „NaN" ani zero na dokumencie', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({
      wiersz: { ...wiersz, vat: null },
      pozycje: [pozycja({ cenaNetto: null })],
    }));
    expect(tekst).not.toContain('NaN');
    expect(tekst).not.toContain('null');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KOMPLET ELEMENTOW art. 106e — czyli odpowiedz na pytanie wlasciciela z 02.09.2026:
// „czy te wizualizacje XML nadaja sie do dostarczenia do biura?".
//
// ⚠️ TE TESTY CZYTAJA WYDRUK Z POWROTEM, nie sprawdzaja obecnosci pol w obiekcie. Element
// obowiazkowy faktury, ktory jest w danych, ale nie zostal narysowany (albo wyjechal poza
// margines i drukarka go ucieta), przechodzi kazdy test na strukturze — i nie przechodzi tego.
// ─────────────────────────────────────────────────────────────────────────────
const XML_DO_WYDRUKU = `<?xml version="1.0" encoding="utf-8"?>
<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Naglowek><DataWytworzeniaFa>2026-08-04T09:20:10</DataWytworzeniaFa></Naglowek>
  <Podmiot1>
    <DaneIdentyfikacyjne><NIP>5252674798</NIP><Nazwa>Księgarnia Świąteczna sp. z o.o.</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>ul. Różana 7/3</AdresL1><AdresL2>00-001 Warszawa</AdresL2></Adres>
  </Podmiot1>
  <Podmiot2>
    <DaneIdentyfikacyjne><NIP>1234563218</NIP><Nazwa>Lumina Marek Zywiecki</Nazwa></DaneIdentyfikacyjne>
    <Adres><KodKraju>PL</KodKraju><AdresL1>1 Maja 5</AdresL1><AdresL2>00-650 Pęki</AdresL2></Adres>
  </Podmiot2>
  <Fa>
    <KodWaluty>PLN</KodWaluty>
    <P_1>2026-06-05</P_1><P_1M>Warszawa</P_1M><P_2>FV/2026/06/12</P_2><P_6>2026-06-01</P_6>
    <P_13_1>100.00</P_13_1><P_14_1>23.00</P_14_1>
    <P_13_7>29.00</P_13_7>
    <P_15>152.00</P_15>
    <Adnotacje>
      <P_16>1</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>1</P_18A>
      <Zwolnienie><P_19>1</P_19><P_19A>ZWOLNIENIE NA PODSTAWIE ART. 43, UST. 1, PKT 40 USTAWY O VAT</P_19A></Zwolnienie>
      <NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu>
      <P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy>
    </Adnotacje>
    <RodzajFaktury>VAT</RodzajFaktury>
    <FaWiersz>
      <NrWierszaFa>1</NrWierszaFa><P_7>Papier ksero A4 80g „Śnieżka"</P_7>
      <P_8A>ryza</P_8A><P_8B>2.0000</P_8B><P_9A>50.00</P_9A>
      <P_11>100.00</P_11><P_11Vat>23.00</P_11Vat><P_11A>123.00</P_11A><P_12>23</P_12>
    </FaWiersz>
    <FaWiersz>
      <NrWierszaFa>2</NrWierszaFa><P_7>Opłata aktywacyjna</P_7>
      <P_8A>szt</P_8A><P_8B>1</P_8B><P_9A>29.00</P_9A><P_11>29.00</P_11><P_12>zw</P_12>
    </FaWiersz>
    <Platnosc>
      <Zaplacono>1</Zaplacono><DataZaplaty>2026-06-07</DataZaplaty>
      <TerminPlatnosci><Termin>2026-06-19</Termin></TerminPlatnosci>
      <FormaPlatnosci>6</FormaPlatnosci>
      <RachunekBankowy><NrRB>77109010140000000000000002</NrRB></RachunekBankowy>
    </Platnosc>
  </Fa>
</Faktura>`;

const XML_KOREKTA = `<Faktura><Podmiot1><DaneIdentyfikacyjne><NIP>5252674798</NIP>
  <Nazwa>Księgarnia Świąteczna sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>1234563218</NIP><Nazwa>Lumina Marek Zywiecki</Nazwa>
  </DaneIdentyfikacyjne></Podmiot2>
  <Fa><KodWaluty>PLN</KodWaluty><P_1>2026-06-20</P_1><P_2>KOR/2026/06/1</P_2>
  <P_13_1>-100.00</P_13_1><P_14_1>-23.00</P_14_1><P_15>-123.00</P_15>
  <RodzajFaktury>KOR</RodzajFaktury>
  <PrzyczynaKorekty>Zwrot towaru przez nabywcę</PrzyczynaKorekty><TypKorekty>2</TypKorekty>
  <DaneFaKorygowanej><DataWystFaKorygowanej>2026-06-05</DataWystFaKorygowanej>
  <NrFaKorygowanej>FV/2026/06/12</NrFaKorygowanej>
  <NrKSeFFaKorygowanej>5252674798-20260605-0100AB-CD</NrKSeFFaKorygowanej></DaneFaKorygowanej>
  <Platnosc><FormaPlatnosci>6</FormaPlatnosci></Platnosc></Fa></Faktura>`;

describe('PDF wizualizacji kosztu — komplet elementów art. 106e', () => {
  const zXml = (xml, nadpisz = {}) => zbudujKosztPdf({
    wiersz: { ...wiersz, ...nadpisz },
    dokument: dokumentZXml(xml),
  });

  gdyJestPdftotext('⚠️ NABYWCA jest na wydruku — bez niego kartka nie nadaje się do biura', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    // ⚠️ Nagłówki sekcji idą KAPITALIKAMI (tak samo jak w proformie i specyfikacji) — test
    // czyta wydruk, więc sprawdza to, co naprawdę stoi na papierze.
    expect(tekst).toContain('NABYWCA');
    expect(tekst).toContain('Lumina Marek Zywiecki');
    expect(tekst).toContain('1234563218');
  });

  gdyJestPdftotext('niesie adres sprzedawcy i nabywcy, a nie samą nazwę z NIP-em', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('ul. Różana 7/3');
    expect(tekst).toContain('00-001 Warszawa');
    expect(tekst).toContain('1 Maja 5');
    expect(tekst).toContain('00-650 Pęki');
  });

  gdyJestPdftotext('niesie datę sprzedaży i miejsce wystawienia', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('Data sprzedaży');
    expect(tekst).toContain('2026-06-01');
    expect(tekst).toContain('Miejsce wystawienia');
  });

  gdyJestPdftotext('rozpisuje VAT na stawki — z kodem pola FA do sprawdzenia wobec XML-a', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('W tym');
    expect(tekst).toContain('P_13_1');
    expect(tekst).toContain('P_13_7');
    expect(tekst).toContain('23% / 22%');
    expect(tekst).toContain('zw');
  });

  gdyJestPdftotext('⚠️ pozycja niesie kwotę VAT i wartość brutto — kolumn, których wcześniej nie było', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('Kwota VAT');
    expect(tekst).toContain('Wartość brutto');
    expect(tekst).toContain('123,00');
  });

  gdyJestPdftotext('⚠️ kwota WYLICZONA przez panel jest oznaczona gwiazdką i wyjaśniona krótkim przypisem (skrócony 03.09.2026)', async () => {
    // Pozycja druga (zw) nie ma ani `P_11A`, ani `P_11Vat` — brutto bierze się ze stawki.
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('29,00 *');
    expect(tekst).toContain('kwota wyliczona przez panel — brak pola w dokumencie');
    // Stary, dłuższy przypis nie ma prawa zostać na kartce.
    expect(tekst).not.toContain('Kwota wyliczona (netto + VAT lub ze stawki)');
  });

  gdyJestPdftotext('⚠️ przypis o kwocie wyliczonej NIE STOI, gdy na kartce nie ma ani jednej gwiazdki', async () => {
    // Sama tabela metadanych, bez `dokument` — bez pozycji i bez stawek nic nie jest wyliczone.
    const tekst = tekstZPdf(await zbudujKosztPdf({ wiersz, pozycje: [] }));
    expect(tekst).not.toContain('kwota wyliczona przez panel');
  });

  gdyJestPdftotext('niesie adnotacje z „Tak"/„Nie" i podstawę zwolnienia jako pole', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('ADNOTACJE');
    expect(tekst).toContain('Metoda kasowa');
    expect(tekst).toContain('Mechanizm podzielonej płatności');
    expect(tekst).toContain('Podstawa zwolnienia');
    expect(tekst).toContain('ART. 43, UST. 1, PKT 40');
  });

  gdyJestPdftotext('niesie informację o płatności: status, formę, termin i rachunek', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('Zapłacono');
    expect(tekst).toContain('przelew');
    expect(tekst).toContain('2026-06-19');
    expect(tekst).toContain('77109010140000000000000002');
  });

  gdyJestPdftotext('niesie kwotę należności ogółem (P_15) jako „do zapłaty"', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).toContain('Razem do zapłaty');
    expect(tekst).toContain('152,00 PLN');
  });

  gdyJestPdftotext('⚠️ napis odrozniajacy jest NIEOBECNY zarowno pod tytulem, jak i w stopce (decyzja wlasciciela 03.09.2026)', async () => {
    const strony = tekstZPdf(await zXml(XML_DO_WYDRUKU)).split('\f').filter((s) => s.trim() !== '');
    const pierwsza = strony[0];
    expect(pierwsza).toContain('e-Faktura');
    // Zero wystapien na pierwszej stronie — ani pod tytulem, ani w stopce.
    expect(pierwsza.split('oryginałem jest plik XML').length - 1).toBe(0);
    expect(pierwsza).toContain(STOPKA_ZRODLA);
  });

  gdyJestPdftotext('korekta mówi o tym w tytule i pokazuje dokument korygowany', async () => {
    const tekst = tekstZPdf(await zXml(XML_KOREKTA, { numer_dokumentu: 'KOR/2026/06/1' }));
    expect(tekst).toContain('e-Faktura korygująca');
    expect(tekst).toContain('DOKUMENT KORYGOWANY');
    expect(tekst).toContain('FV/2026/06/12');
    expect(tekst).toContain('Zwrot towaru przez nabywcę');
    expect(tekst).toContain('5252674798-20260605-0100AB-CD');
  });

  // ⚠️ ZNALEZIONE NA WYDRUKU, NIE W TESCIE (03.09.2026). OVH numeruje wiersze wlasnymi
  // identyfikatorami (`36228820`); `komorka()` rysuje bez `width`, wiec osmiocyfrowy numer
  // wychodzil z 16-punktowej kolumny „Lp." wprost NA NAZWE TOWARU. Zaden test na strukturze
  // tego nie widzial — obie wartosci byly w PDF-ie, tyle ze jedna na drugiej.
  gdyJestPdftotext('⚠️ własna numeracja wystawcy nie wchodzi w nazwę towaru — idzie pod tabelę', async () => {
    const xml = XML_DO_WYDRUKU
      .replace('<NrWierszaFa>1</NrWierszaFa>', '<NrWierszaFa>36228820</NrWierszaFa>')
      .replace('<NrWierszaFa>2</NrWierszaFa>', '<NrWierszaFa>36228822</NrWierszaFa>');
    const tekst = tekstZPdf(await zXml(xml));
    expect(tekst).toContain('Numeracja pozycji u wystawcy');
    expect(tekst).toContain('36228820');
    // Nazwa towaru czytelna w calosci, czyli numer nie zostal na niej narysowany.
    expect(tekst).toContain('Papier ksero A4 80g');
  });

  gdyJestPdftotext('rabat i data dostawy przy pozycji trafiają na wydruk', async () => {
    const xml = XML_DO_WYDRUKU
      .replace('<P_9A>50.00</P_9A>', '<P_9A>50.00</P_9A><P_10>3.50</P_10><P_6A>2026-05-30</P_6A>');
    const tekst = tekstZPdf(await zXml(xml));
    expect(tekst).toContain('Rabat przy pozycjach: 1 — 3,50');
    expect(tekst).toContain('Data dostawy przy pozycjach: 1 — 2026-05-30');
  });

  gdyJestPdftotext('⚠️ nic nie wyjeżdża poza margines — kwota w ostatniej kolumnie mieści się w całości', async () => {
    const xml = XML_DO_WYDRUKU
      .replace('<P_11A>123.00</P_11A>', '<P_11A>123456.78</P_11A>')
      .replace('<P_7>Papier ksero A4 80g „Śnieżka"</P_7>',
        '<P_7>Bardzo długa nazwa towaru, która musi się zawinąć w swojej kolumnie, '
        + 'a nie wyjechać na sąsiednią ani poza margines arkusza A4</P_7>');
    const tekst = tekstZPdf(await zXml(xml));
    expect(tekst).toContain('123456,78');
    expect(tekst).toContain('a nie wyjechać na sąsiednią');
  });

  it('⚠️ długa faktura łamie się na strony i każda ma stopkę', async () => {
    const wiersze = Array.from({ length: 30 }, (_, i) => `<FaWiersz><NrWierszaFa>${i + 1}</NrWierszaFa>`
      + `<P_7>Usługa kurierska krajowa — przesyłka numer ${i + 1}</P_7>`
      + '<P_8A>szt</P_8A><P_8B>1</P_8B><P_9A>13.16</P_9A><P_11>13.16</P_11>'
      + '<P_11Vat>3.03</P_11Vat><P_12>23</P_12></FaWiersz>').join('');
    const xml = XML_DO_WYDRUKU.replace('</Fa>', `${wiersze}</Fa>`);
    const buf = await zXml(xml);
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(buf)).getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('⚠️ dokument o nieznanym kształcie nie wywraca rysowania — kartka ma powstać', async () => {
    for (const xml of ['', '<nie-faktura/>', '<Faktura><Fa></Fa></Faktura>']) {
      const buf = await zXml(xml);
      expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  gdyJestPdftotext('⚠️ brak `dokument` (same metadane) nadal rysuje kartkę i nie pisze „undefined"', async () => {
    const tekst = tekstZPdf(await zbudujKosztPdf({ wiersz, pozycje: [pozycja()] }));
    expect(tekst).toContain('FV/2026/06/12');
    expect(tekst).toContain('Danych nabywcy nie ma w tym dokumencie');
    expect(tekst).not.toContain('undefined');
    expect(tekst).not.toContain('NaN');
  });

  // ⚠️ `DataWytworzeniaFa` TO ZNACZNIK CZASU SYSTEMU WYSTAWCY, a nie moment przyjęcia
  // dokumentu przez KSeF (ten jest zaszyty w numerze KSeF). Etykieta „Wytworzona w KSeF"
  // mówiła o cudzym dokumencie coś, czego dokument nie mówi — poprawka po drugiej recenzji.
  gdyJestPdftotext('niesie datę wytworzenia dokumentu w SYSTEMIE WYSTAWCY, a nie „w KSeF"', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    // ⚠️ ETYKIETA STOI W DWÓCH LINIACH (ma 151,5 pkt przy kolumnie 92) — łamie się ONA,
    // a nie wartość, bo znacznik czasu z prawdziwego archiwum („…58.8768733+02:00") mieści
    // się w swojej kolumnie z zapasem 0,8 pkt. Dlatego test czyta obie połówki osobno.
    expect(tekst).toContain('Data wytworzenia');
    expect(tekst).toContain('(system wystawcy)');
    expect(tekst).not.toContain('Wytworzona w KSeF');
    // Wartość surowa, w JEDNEJ linii — bez tego kartka gubi minuty w łamaniu.
    expect(liniaZ(tekst, '2026-08-04')).toContain('2026-08-04 09:20:10');
  });

  // ⚠️ ZNACZNIK CZASU Z PRAWDZIWEGO ARCHIWUM (ELMAS, Comarch ERP Optima) niesie ułamek
  // sekundy I strefę — 162,5 pkt przy kolumnie wartości 163,3 pkt, czyli zapas 0,8 pkt.
  // Pierwsza wersja tej poprawki poszerzyła kolumnę ETYKIETY i złamała ten znacznik
  // w połowie ułamka sekundy („…58.8" / „768733+02:00"). Odczyt powrotny to widzi.
  gdyJestPdftotext('⚠️ znacznik czasu z ułamkiem sekundy i strefą mieści się w JEDNEJ linii', async () => {
    const xml = XML_DO_WYDRUKU
      .replace('2026-08-04T09:20:10', '2026-08-26T14:45:58.8768733+02:00');
    const tekst = tekstZPdf(await zXml(xml));
    expect(liniaZ(tekst, '14:45:58')).toContain('2026-08-26 14:45:58.8768733+02:00');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POPRAWKI PO RECENZJI (2026-09-03) — każda z nich to zdanie, które kartka mówiła
// księgowej NIEPRAWDĘ albo przemilczała.
// ─────────────────────────────────────────────────────────────────────────────

// Allegro w EUR: `vatAmount` z metadanych KSeF jest ZAWSZE w złotych, a netto i brutto
// w walucie dokumentu (patrz `czyPLN` w domain/koszt-metadane.js). Blok „Razem" drukował
// wszystkie trzy kwoty z tą samą walutą — czyli podawał VAT w euro, którego nikt nie policzył.
const XML_EUR = `<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/">
  <Podmiot1><DaneIdentyfikacyjne><NIP>1000001170</NIP><Nazwa>Allegro sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot1>
  <Podmiot2><DaneIdentyfikacyjne><NIP>1234563218</NIP><Nazwa>Lumina Marek Zywiecki</Nazwa></DaneIdentyfikacyjne></Podmiot2>
  <Fa><KodWaluty>EUR</KodWaluty><P_1>2026-08-01</P_1><P_2>EUR/2026/8/1</P_2><P_6>2026-08-01</P_6>
  <P_13_1>9.60</P_13_1><P_14_1>2.21</P_14_1><P_14_1W>9.44</P_14_1W><P_15>11.81</P_15>
  <RodzajFaktury>VAT</RodzajFaktury>
  <FaWiersz><NrWierszaFa>1</NrWierszaFa><P_7>Prowizja od sprzedaży</P_7><P_8A>szt</P_8A>
  <P_8B>1</P_8B><P_9A>9.60</P_9A><P_11>9.60</P_11><P_11Vat>2.21</P_11Vat><P_12>23</P_12></FaWiersz>
  </Fa></Faktura>`;

// ELMAS (Comarch ERP Optima): pozycja bez netto — jest sama cena BRUTTO `P_9B` i `P_11A`.
const XML_TYLKO_BRUTTO = '<Faktura><Podmiot1><DaneIdentyfikacyjne><NIP>1234563218</NIP>'
  + '<Nazwa>ELMAS</Nazwa></DaneIdentyfikacyjne></Podmiot1>'
  + '<Fa><KodWaluty>PLN</KodWaluty><P_1>2026-08-10</P_1><P_2>FS 1/2026</P_2>'
  + '<RodzajFaktury>VAT</RodzajFaktury><FaWiersz><NrWierszaFa>1</NrWierszaFa>'
  + '<P_7>Piana niskoprężna</P_7><P_8A>szt</P_8A><P_8B>5.0000</P_8B>'
  + '<P_9B>19.99</P_9B><P_11A>99.95</P_11A><P_12>23</P_12></FaWiersz></Fa></Faktura>';

describe('PDF wizualizacji kosztu — poprawki po recenzji', () => {
  const zXml = (xml, nadpisz = {}) => zbudujKosztPdf({
    wiersz: { ...wiersz, ...nadpisz },
    dokument: dokumentZXml(xml),
  });

  const wierszEur = {
    numer_dokumentu: 'EUR/2026/8/1', waluta: 'EUR', netto: '9.60', vat: '9.44', brutto: '11.81',
  };

  gdyJestPdftotext('⚠️⚠️ „Razem VAT" na fakturze w EUR stoi W ZŁOTYCH — bo taki jest z KSeF', async () => {
    const tekst = tekstZPdf(await zXml(XML_EUR, wierszEur));
    const linia = liniaZ(tekst, 'Razem VAT');
    expect(linia).toContain('9,44 PLN');
    // ⚠️ TO JEST CAŁA STAWKA TEGO TESTU: kwota VAT-u NIE MA PRAWA nieść waluty dokumentu.
    expect(linia).not.toContain('EUR');
    // Netto i brutto zostają w walucie dokumentu — inaczej kartka kłamie w drugą stronę.
    expect(liniaZ(tekst, 'Razem netto')).toContain('9,60 EUR');
    expect(liniaZ(tekst, 'Razem brutto')).toContain('11,81 EUR');
  });

  // ⚠️ NOTA MA BYĆ PRAWDZIWA CO DO SŁOWA. „VAT wykazany w złotych; netto i brutto w walucie
  // dokumentu" przeczyło TABELI STAWEK STOJĄCEJ WYŻEJ NA TEJ SAMEJ KARTCE: kolumna „VAT"
  // w rozbiciu na stawki idzie w walucie dokumentu (`P_14_*`), a złotówki stoją dopiero
  // w wierszu „VAT przeliczony na złote" (`P_14_*W`). W złotych jest WYŁĄCZNIE „Razem VAT".
  gdyJestPdftotext('⚠️ dwie waluty w bloku sum są WYJAŚNIONE zdaniem, które zgadza się z tabelą stawek', async () => {
    const tekst = tekstZPdf(await zXml(XML_EUR, wierszEur));
    expect(tekst).toContain('Razem VAT w złotych (art. 106e ust. 11 ustawy o VAT)');
    expect(tekst).toContain('VAT w tabeli stawek podany w walucie');
    // Nota nie ma prawa mówić o VAT-cie „wykazanym w złotych" bez zastrzeżenia — bo tabela
    // stawek wyżej pokazuje ten sam podatek w euro.
    expect(tekst).not.toContain('VAT wykazany w złotych');
  });

  gdyJestPdftotext('faktura w złotych NIE dostaje tego zdania — nie ma czego wyjaśniać', async () => {
    const tekst = tekstZPdf(await zXml(XML_DO_WYDRUKU));
    expect(tekst).not.toContain('art. 106e ust. 11');
    expect(liniaZ(tekst, 'Razem VAT')).toContain('23,00 PLN');
  });

  // ── płatność ────────────────────────────────────────────────────────────────
  gdyJestPdftotext('⚠️⚠️ dokument BEZ węzła `Zaplacono` nie dostaje napisu „Nie zapłacono"', async () => {
    const xml = XML_DO_WYDRUKU.replace('<Zaplacono>1</Zaplacono>', '')
      .replace('<DataZaplaty>2026-06-07</DataZaplaty>', '');
    const tekst = tekstZPdf(await zXml(xml));
    expect(tekst).not.toContain('Nie zapłacono');
    expect(tekst).toContain('dokument nie zawiera informacji o zapłacie');
    // Reszta bloku płatności zostaje — termin i forma NA DOKUMENCIE SĄ.
    expect(tekst).toContain('przelew');
    expect(tekst).toContain('2026-06-19');
  });

  gdyJestPdftotext('`Zaplacono` = 2 to zdanie wystawcy — kartka pisze „Nie zapłacono"', async () => {
    const xml = XML_DO_WYDRUKU.replace('<Zaplacono>1</Zaplacono>', '<Zaplacono>2</Zaplacono>');
    const tekst = tekstZPdf(await zXml(xml));
    expect(tekst).toContain('Nie zapłacono');
    expect(tekst).not.toContain('dokument nie zawiera informacji o zapłacie');
  });

  gdyJestPdftotext('⚠️ dokument bez ŻADNEGO pola płatności nie dostaje pustej sekcji „Płatność"', async () => {
    const tekst = tekstZPdf(await zXml(XML_TYLKO_BRUTTO));
    expect(tekst).not.toContain('PŁATNOŚĆ');
    expect(tekst).not.toContain('Nie zapłacono');
  });

  gdyJestPdftotext('⚠️ zapłata częściowa idzie na wydruk z kwotą i datą — NIEZALEŻNIE od `Zaplacono`', async () => {
    const xml = XML_DO_WYDRUKU.replace(
      '<Zaplacono>1</Zaplacono>',
      '<ZnacznikZaplatyCzesciowej>1</ZnacznikZaplatyCzesciowej>'
      + '<ZaplataCzesciowa><KwotaZaplatyCzesciowej>50.00</KwotaZaplatyCzesciowej>'
      + '<DataZaplatyCzesciowej>2026-06-10</DataZaplatyCzesciowej></ZaplataCzesciowa>'
      + '<ZaplataCzesciowa><KwotaZaplatyCzesciowej>102.00</KwotaZaplatyCzesciowej>'
      + '<DataZaplatyCzesciowej>2026-06-18</DataZaplatyCzesciowej></ZaplataCzesciowa>',
    ).replace('<DataZaplaty>2026-06-07</DataZaplaty>', '');
    const tekst = tekstZPdf(await zXml(xml));
    // ⚠️ SZUKAMY LINII Z DWUKROPKIEM — od poprawki niżej „Zapłacono częściowo" stoi też
    // w wierszu statusu, a to jest INNA linia wydruku.
    const linia = liniaZ(tekst, 'Zapłacono częściowo:');
    expect(linia).toContain('50,00 PLN (2026-06-10)');
    expect(linia).toContain('102,00 PLN (2026-06-18)');

    // ⚠️⚠️ STATUS MUSI ZGADZAĆ SIĘ Z KWOTAMI STOJĄCYMI POD NIM. FA(3) przy zapłacie
    // częściowej zwykle NIE NIESIE `Zaplacono` (bo faktura nie jest zapłacona w całości),
    // więc kartka pisała „Status: dokument nie zawiera informacji o zapłacie" DOKŁADNIE NAD
    // listą wpłat, które wystawca na dokumencie potwierdził. Dwa sąsiednie zdania, z których
    // jedno przeczy drugiemu — a księgowa czyta tę kartkę zamiast XML-a.
    expect(tekst).toContain('Status: Zapłacono częściowo');
    expect(tekst).not.toContain('dokument nie zawiera informacji o zapłacie');
  });

  // FA(3) dopuszcza w cenie jednostkowej (`P_9A`/`P_9B`) do CZTERECH miejsc po przecinku —
  // tak wystawia się usługi liczone od sztuki przy tysiącach sztuk. `kwota()` przepuszczała
  // każdą kwotę przez grosze całkowite, czyli ZAOKRĄGLAŁA cenę po cichu: „0.4550" stawało się
  // „0,46", a mnożenie na kartce przestawało się zgadzać (0,455 × 1000 = 455,00, ale
  // 0,46 × 1000 = 460,00). Księgowa dostawała dokument, w którym trzy liczby w jednym wierszu
  // przeczą sobie nawzajem — i nie ma jak zgadnąć, która jest przepisana z oryginału.
  const XML_CENA_4_MIEJSCA = '<Faktura><Podmiot1><DaneIdentyfikacyjne><NIP>5252674798</NIP>'
    + '<Nazwa>Drukarnia sp. z o.o.</Nazwa></DaneIdentyfikacyjne></Podmiot1>'
    + '<Fa><KodWaluty>PLN</KodWaluty><P_1>2026-08-10</P_1><P_2>FS 7/2026</P_2>'
    + '<RodzajFaktury>VAT</RodzajFaktury><FaWiersz><NrWierszaFa>1</NrWierszaFa>'
    + '<P_7>Wydruk jednostronny A4</P_7><P_8A>szt</P_8A><P_8B>1000</P_8B>'
    + '<P_9A>0.4550</P_9A><P_11>455.00</P_11><P_12>23</P_12></FaWiersz></Fa></Faktura>';

  gdyJestPdftotext('⚠️ cena z czterema miejscami po przecinku NIE jest po cichu zaokrąglana do groszy', async () => {
    const tekst = tekstZPdf(await zXml(XML_CENA_4_MIEJSCA, { numer_dokumentu: 'FS 7/2026' }));
    const linia = liniaZ(tekst, 'Wydruk jednostronny A4');
    expect(linia).toContain('0,455');
    expect(linia).not.toContain('0,46');
    // Ilość i wartość pozycji zostają takie, jak w dokumencie — dwa miejsca to dwa miejsca.
    expect(linia).toContain('1000');
    expect(linia).toContain('455,00');
  });

  // ── korekta ─────────────────────────────────────────────────────────────────
  gdyJestPdftotext('⚠️ TypKorekty stoi na wydruku PO LUDZKU — sam kod nie mówi, w jakiej dacie ująć', async () => {
    const tekst = tekstZPdf(await zXml(XML_KOREKTA, { numer_dokumentu: 'KOR/2026/06/1' }));
    expect(tekst).toContain('Typ korekty: korekta skutkująca w dacie wystawienia faktury korygującej');
  });

  // ── cena jednostkowa ────────────────────────────────────────────────────────
  gdyJestPdftotext('⚠️ cena BRUTTO nie staje pod nagłówkiem „Cena netto" — idzie w uwagi pod tabelą', async () => {
    const tekst = tekstZPdf(await zXml(XML_TYLKO_BRUTTO, { numer_dokumentu: 'FS 1/2026' }));
    expect(tekst).toContain('Cena jedn. brutto przy pozycjach: 1 — 19,99');
    // ⚠️ Kwota stoi na kartce DOKŁADNIE RAZ — czyli nie została też wpisana do kolumny netto.
    expect(tekst.split('19,99').length - 1).toBe(1);
    // Wartość brutto z dokumentu (`P_11A`) zostaje w swojej kolumnie.
    expect(tekst).toContain('99,95');
  });

  // ── łamanie stron ───────────────────────────────────────────────────────────
  // ⚠️ ZNALEZIONE ODCZYTEM POWROTNYM: uwaga pod tabelą rezerwowała 22 punkty NIEZALEŻNIE
  // od tego, ile miejsca naprawdę zajmie. Ośmiolinijkowa „Numeracja pozycji u wystawcy"
  // (tak numeruje OVH) rysowała się WPROST NA STOPCE — litery uwagi i litery zdania stopki
  // nachodziły na siebie w tej samej linii.
  //
  // ⚠️ PO 03.09.2026 STOPKA NIESIE JUŻ TYLKO ZDANIE „Wyrysowana w panelu…" — zdanie
  // odróżniające zostało zdjęte, ale mechanizm testu (własna linia stopki, nienachodzenie
  // na nią) zostaje taki sam, tylko sprawdzany na krótszym zdaniu, które teraz jest jedyne.
  gdyJestPdftotext('⚠️⚠️ długa uwaga pod tabelą NIE WCHODZI w stopkę — rezerwa jest ZMIERZONA', async () => {
    const duzo = Array.from({ length: 66 }, (_, i) => pozycja({ lp: String(36228820 + i) }));
    const buf = await zbudujKosztPdf({ wiersz, pozycje: duzo });
    const strony = tekstZPdf(buf).split('\f').filter((s) => s.trim() !== '');
    expect(strony.length).toBeGreaterThan(1);
    for (const strona of strony) {
      // Zdanie stopki stoi w SWOJEJ WŁASNEJ linii (dzieli ją co najwyżej z licznikiem stron,
      // dosuniętym do prawej — `-layout` skleja oba w jedną linię wtedy, i to jest oczekiwane).
      // Gdy uwaga WJEDZIE na stopkę, zamiast tego skleja się z LITERAMI uwagi — dlatego
      // sprawdzamy, że jakaś linia niesie zdanie stopki w CAŁOŚCI, a nie wymieszane z uwagą.
      const linie = strona.split('\n').map((l) => l.trim());
      expect(linie.some((l) => l.includes(STOPKA_ZRODLA))).toBe(true);
      // Zdanie odróżniające jest zdjęte decyzją właściciela — nie ma prawa wrócić.
      expect(strona).not.toContain(NAPIS_ODROZNIAJACY);
    }
    // Cała uwaga jest na kartce — łamanie nie może jej uciąć.
    expect(strony.join('\n')).toContain('66 → 36228885');
  });
});
