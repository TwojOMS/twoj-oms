import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zbudujProformePdf } from '../../../src/moduly/faktury/pdf/proforma-pdf.js';
import { podsumowanieVat } from '../../../src/domena/podsumowanie-vat.js';
import { kwotaSlownie } from '../../../src/domena/kwota-slownie.js';

// ─────────────────────────────────────────────────────────────────────────────
// Wykrycie poppera. Testy tekstowe czytają wygenerowany PDF `pdftotext`-em, bo tylko
// odczyt POWROTNY dowodzi, że w dokumencie siedzą prawdziwe litery, a nie dziury.
// Ale poppera NIE MA w kontenerze na NAS-ie, a suita ma tam być zielona — więc brak
// binarki ma POMINĄĆ te testy z czytelnym komunikatem, nigdy wywrócić suitę.
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
    // brak na PATH — próbujemy instalacji winget właściciela
  }
  return process.env.LOCALAPPDATA && existsSync(POPPLER_WINGET) ? POPPLER_WINGET : null;
}

const PDFTOTEXT = znajdzPdftotext();
if (!PDFTOTEXT) {
  // eslint-disable-next-line no-console
  console.warn(
    '[proforma-pdf] pdftotext (poppler) nie znaleziony — testy odczytu tekstu z PDF-a POMINIĘTE. '
    + 'Nie oznacza to, że dokument jest poprawny: test polskich znaków, który jako jedyny łapie '
    + 'brak osadzonego fontu, NIE został uruchomiony.',
  );
}

/** PDF → tekst. Zapis do pliku, bo pdftotext czyta plik, nie stdin. */
function tekstZPdf(buf) {
  const kat = mkdtempSync(path.join(tmpdir(), 'proforma-'));
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

// Liczba stron BEZ poppera — z drzewa stron w samym PDF-ie. PDFKit zapisuje słownik
// `/Type /Pages` nieskompresowany, więc `/Count N` da się przeczytać wprost z bajtów.
// Dzięki temu test łamania na strony działa też tam, gdzie poppera nie ma.
function liczbaStron(buf) {
  const m = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(buf.toString('latin1'))
    ?? /\/Count\s+(\d+)/.exec(buf.toString('latin1'));
  return m ? Number(m[1]) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dane ze WZORU z Apilo (PRO_1_08_2026-4131.pdf, obejrzany 2026-08-04). Te same
// pozycje i ta sama kwota — żeby wygenerowany dokument dało się położyć obok oryginału.
// ─────────────────────────────────────────────────────────────────────────────
const POZYCJE_WZORU = [
  { name: 'Realizacja priorytetowa', quantity: 1, gross_price: 5000, tax_symbol: '23' },
  { name: 'szablon malarski wielorazowy logo 1,2,3', quantity: 3, gross_price: 19500, tax_symbol: '23' },
  { name: 'szablon malarski wielorazowy logo mniejsze 4,5,6', quantity: 3, gross_price: 16500, tax_symbol: '23' },
  { name: 'szablon malarski wielorazowy logo większe 1,2,3', quantity: 3, gross_price: 22500, tax_symbol: '23' },
  { name: 'wysyłka kurierem DPD', quantity: 1, gross_price: 1900, tax_symbol: '23' },
];

function daneWzoru(nadpisania = {}) {
  const pozycje = nadpisania.pozycje ?? POZYCJE_WZORU;
  const doZaplatyGr = pozycje.reduce((a, p) => a + p.gross_price, 0);
  return {
    numer: 'PF/1/08/2026',
    dataWystawienia: '2026-08-04',
    sposobZaplaty: 'Przelew bankowy',
    sprzedawca: {
      nazwa: 'Lumina Marek Zywiecki',
      ulica: '1 Maja 5',
      kod: '00-650',
      miasto: 'Pęki',
      kraj: 'Polska',
      nip: '1234563218',
    },
    nabywca: {
      nazwa: 'Agencja Atom 2 Justyna Juszczak',
      ulica: 'Wiosenna 17/71',
      kod: '02-791',
      miasto: 'Warszawa',
      kraj: 'Polska',
      nip: '1000001135',
    },
    podsumowanieVat: podsumowanieVat(pozycje),
    doZaplatyGr,
    slownie: kwotaSlownie(doZaplatyGr),
    rachunek: '34109010140000000000000000',
    bank: 'Millennium',
    ...nadpisania,
    pozycje,
  };
}

const duzoPozycji = (ile) => Array.from({ length: ile }, (_, i) => ({
  name: `Pozycja numer ${i + 1} — szablon malarski wielorazowy`,
  quantity: 1,
  gross_price: 1000 + i,
  tax_symbol: '23',
}));

describe('zbudujProformePdf — dokument', () => {
  it('zwraca Buffer z nagłówkiem PDF-a', () => {
    const buf = zbudujProformePdf(daneWzoru());
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('mieści 5 pozycji na jednej stronie', () => {
    expect(liczbaStron(zbudujProformePdf(daneWzoru()))).toBe(1);
  });

  it('łamie 40 pozycji na kolejne strony', () => {
    const buf = zbudujProformePdf(daneWzoru({ pozycje: duzoPozycji(40) }));
    expect(liczbaStron(buf)).toBeGreaterThan(1);
  });
});

describe.skipIf(!PDFTOTEXT)('zbudujProformePdf — treść odczytana z gotowego PDF-a', () => {
  // ⚠️ NAJWAŻNIEJSZY TEST W TYM PLIKU. Wbudowane fonty PDF (Helvetica) NIE MAJĄ polskich
  // znaków, a pdfkit nie protestuje: dokument powstaje bez błędu, tylko z dziurami zamiast
  // `ł ą ę ż ś ć ń ó ź` — i zobaczy to dopiero klient. Żaden test na samym Bufferze tego nie
  // złapie; łapie to WYŁĄCZNIE odczyt powrotny liter z gotowego dokumentu.
  it('zwraca wszystkie polskie znaki w całości', () => {
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru()));

    expect(tekst).toContain('Lumina Marek Zywiecki');
    expect(tekst).toContain('Pęki');
    expect(tekst).toContain('Wiosenna 17/71');
    expect(tekst).toContain('wysyłka kurierem DPD');
    expect(tekst).toContain('sześćset pięćdziesiąt cztery złote');
    expect(tekst).toContain('Sposób zapłaty');
    expect(tekst).toContain('Ilość');
    expect(tekst).toContain('Wartość brutto');

    // Znak zastępczy „nie mam takiego glifu" nie ma prawa się pojawić.
    expect(tekst).not.toContain('�');
  });

  // Osobny dokument z PEŁNYM polskim alfabetem — dane ze wzoru nie zawierają `ź` ani wielkich
  // `Ą Ć Ź`, a font z niepełnym podzbiorem przeszedłby test na samym wzorze. Litera po literze,
  // żeby awaria mówiła KTÓREJ brakuje, a nie tylko że „napis się nie zgadza".
  it('ma w foncie każdą polską literę, także rzadkie ź i wielkie Ą Ć Ź', () => {
    const ALFABET = 'ąćęłńóśźżĄĆĘŁŃÓŚŹŻ';
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru({
      pozycje: [{ name: `Zdźbło ${ALFABET}`, quantity: 1, gross_price: 12300, tax_symbol: '23' }],
    })));
    for (const znak of ALFABET) {
      expect(tekst.includes(znak), `brak polskiej litery „${znak}" w dokumencie`).toBe(true);
    }
    expect(tekst).not.toContain('�');
  });

  it('drukuje numer, datę, kwotę, rachunek i bank', () => {
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru()));
    expect(tekst).toContain('PF/1/08/2026');
    expect(tekst).toContain('2026-08-04');
    expect(tekst).toContain('654.00');
    expect(tekst).toContain('34109010140000000000000000');
    expect(tekst).toContain('Millennium');
    // Wzór z Apilo pisze „Do dopłaty" — my świadomie piszemy „Do zapłaty" (plan, sekcja
    // „Wzór dokumentu"), bo „dopłata" sugeruje, że część pieniędzy już wpłynęła.
    expect(tekst).toContain('Do zapłaty');
    expect(tekst).not.toContain('Do dopłaty');
  });

  it('drukuje podsumowanie VAT z etykietą Suma', () => {
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru()));
    expect(tekst).toContain('531.71');
    expect(tekst).toContain('122.29');
    expect(tekst).toMatch(/Suma/);
  });

  it('drukuje wszystkie pozycje z nazwami i wartościami linii', () => {
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru()));
    for (const p of POZYCJE_WZORU) {
      expect(tekst, `brak pozycji „${p.name}"`).toContain(p.name);
    }
    for (const kwota of ['50.00', '195.00', '165.00', '225.00', '19.00']) {
      expect(tekst, `brak wartości linii ${kwota}`).toContain(kwota);
    }
  });

  // ⚠️ REGRESJA NA RABACIE — klasyka tego repo. Kolumna „Cena brutto" jest ceną JEDNOSTKOWĄ,
  // a `gross_price` to SUMA LINII, więc cenę jednostkową trzeba wyliczyć dzieleniem. Przy
  // rabacie ta zaokrąglona cena NIE PRZEMNOŻY SIĘ z powrotem do wartości linii:
  // 3 szt. za 100,00 zł → 33,33 × 3 = 99,99. Wartość linii MUSI iść z `gross_price` WPROST.
  it('wartość linii z rabatem bierze gross_price wprost, nie cenę × ilość', () => {
    const pozycje = [{ name: 'Szablon z rabatem', quantity: 3, gross_price: 10000, tax_symbol: '23' }];
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru({ pozycje })));
    expect(tekst).toContain('100.00');   // wartość linii — prawda dokumentu
    expect(tekst).toContain('33.33');    // cena jednostkowa — tylko wyświetlana
    expect(tekst).not.toContain('99.99'); // iloczyn, którego na dokumencie być NIE MOŻE
  });

  // ⚠️ REGRESJA ZŁAPANA NA OBEJRZANYM RENDERZE, nie przez test. Przy pięciocyfrowych kwotach
  // wiersz „Suma" rozpadał się na dwie linie („32526.67" / „PLN") i wjeżdżał w sąsiednią
  // kolumnę — bo pdfkit z podanym `width` łamie tekst NAWET przy `lineBreak: false`.
  // `pdftotext -layout` wstawia w miejscu złamania znak nowej linii, więc sprawdzenie kwoty
  // jako JEDNEGO ciągu jest tekstowym odpowiednikiem tego, co widać na obrazie.
  it('nie łamie pięciocyfrowych kwot w podsumowaniu VAT', () => {
    const pozycje = Array.from({ length: 40 }, (_, i) => ({
      name: `Pozycja ${i + 1}`, quantity: 2, gross_price: 100000 + i, tax_symbol: '23',
    }));
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru({ pozycje })));
    expect(tekst).toContain('40007.80 PLN');
    expect(tekst).toContain('32526.67 PLN');
    expect(tekst).toContain('7481.13 PLN');
  });

  // ⚠️ TEN TEST PILNUJE MECHANIZMU, NIE PRZYPADKU. Poprzedni test przechodzi także wtedy, gdy
  // komórki rysuje się przez `width` — bo kolumny poszerzono na tyle, że realne kwoty się
  // mieszczą (sprawdzone mutacją: podmiana `komorka` na wariant z `width` NIE czerwieni się).
  // Gwarancja „kwota nigdy nie łamie się na dwie linie" jest więc obserwowalna dopiero na
  // kwocie SZERSZEJ OD KOLUMNY. Bez tego testu pierwsza pozycja na 100 tys. zł wróciłaby do
  // rozsypywania kolumn, a suita nadal świeciłaby na zielono.
  it('nie łamie kwoty szerszej niż jej kolumna', () => {
    const pozycje = [{ name: 'Zlecenie hurtowe', quantity: 1, gross_price: 999999999, tax_symbol: '23' }];
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru({ pozycje })));
    // Kwota MUSI stać w tym samym wierszu, co nazwa pozycji. Samo `toContain('9999999.99 PLN')`
    // tu nie wystarcza: przy złamanej kolumnie ten sam ciąg dalej znajduje się w tabeli VAT.
    expect(tekst).toMatch(/Zlecenie hurtowe.*9999999\.99 PLN/);
    // Osierocone „PLN" w osobnym wierszu to podpis złamanej kwoty — po tym poznaje się awarię.
    const osierocone = tekst.split(/\r?\n/).filter((w) => w.trim() === 'PLN');
    expect(osierocone, 'wiersze z samym „PLN" — kwota złamała się na dwie linie').toEqual([]);
  });

  it('przy 40 pozycjach nie gubi ostatniej', () => {
    const pozycje = duzoPozycji(40);
    const tekst = tekstZPdf(zbudujProformePdf(daneWzoru({ pozycje })));
    expect(tekst).toContain('Pozycja numer 1 —');
    expect(tekst).toContain('Pozycja numer 40 —');
    // Numeracja Lp. musi biec dalej przez łamanie strony, a nie startować od nowa.
    expect(tekst).toMatch(/40\.\s+Pozycja numer 40/);
    // Podsumowanie ma trafić na ostatnią stronę, a nie wypaść razem z tabelą.
    expect(tekst).toContain('Do zapłaty');
    expect(tekst).toContain('34109010140000000000000000');
  });
});
