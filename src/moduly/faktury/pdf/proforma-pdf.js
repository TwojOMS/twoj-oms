import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { zl } from '../../../domena/suma-pozycji.js';

// Generator PDF-a faktury proforma. Układ jest KALKĄ dokumentu, który właściciel wysyła dziś
// klientom z Apilo (wzór: PRO_1_08_2026-4131.pdf, obejrzany 2026-08-04) — ta sama kolejność
// sekcji, te same kolumny, ten sam charakter. Klient dostanie oba dokumenty w tym samym roku,
// więc nie mają wyglądać jak z dwóch różnych firm.
//
// ⚠️ TEN MODUŁ TYLKO RYSUJE. Nie liczy VAT-u (domain/podsumowanie-vat.js), nie odmienia kwoty
// słownie (domain/kwota-slownie.js) i nie składa pozycji (domain/pozycje-faktury.js) — dostaje
// wszystko gotowe od serwisu. Powód jest prosty: arytmetyka dokumentu ma być testowalna bez
// czytania PDF-a, a to, że coś trzeba wydrukować, nigdy nie jest powodem, żeby policzyć to
// drugi raz obok.

const KATALOG = path.dirname(fileURLToPath(import.meta.url));

// ⚠️ CICHA AWARIA, KTÓRA KOŃCZY SIĘ U KLIENTA. Wbudowane fonty PDF (Helvetica i spółka) NIE
// MAJĄ polskich znaków, a pdfkit nie protestuje — dokument powstaje bez jednego ostrzeżenia,
// tylko z dziurami zamiast `ł ą ę ż ś ć ń ó ź`. „Zak ad Us ug", „ ód ", „sze set".
// Dlatego KAŻDY napis w tym module idzie przez `zwykly()`/`gruby()` niżej, a nazwy wbudowanych
// fontów nie pojawiają się w tym pliku ani razu. Jedyny test, który złamanie tej zasady
// wyłapie, to odczyt powrotny `pdftotext`-em — bo Buffer wygląda tak samo w obu przypadkach.
const FONT = 'DejaVu';
const FONT_GRUBY = 'DejaVu-Bold';
const PLIKI_FONTOW = {
  [FONT]: path.join(KATALOG, 'fonty', 'DejaVuSans.ttf'),
  [FONT_GRUBY]: path.join(KATALOG, 'fonty', 'DejaVuSans-Bold.ttf'),
};

const A4_SZER = 595.28;
const MARGINES = 40;
const L = MARGINES;                 // lewa krawędź treści
const R = A4_SZER - MARGINES;       // prawa krawędź treści (555.28)
const PRAWA_KOLUMNA = 320;          // początek kolumny „NABYWCA" i bloków dosuniętych w prawo

const CZARNY = '#1a1a1a';
const SZARY_TEKST = '#666666';
const SZARY_PASEK = '#c9c9c9';      // prostokąt przed nagłówkiem sekcji
const SZARY_WIERSZ = '#eeeeee';     // co drugi wiersz tabeli
const SZARY_LINIA = '#cccccc';

// Kolumny tabeli pozycji. Trzymane jako DANE, a nie rozsypane po kodzie, bo nagłówek i wiersze
// muszą stać w tych samych miejscach — a nagłówek rysuje się jeszcze raz po każdym łamaniu
// strony. Suma `x + w` ostatniej kolumny to dokładnie `R`: tabela nie ma prawa wyjechać poza
// margines, bo drukarka utnie właśnie kolumnę z kwotą.
// Szerokości nie są dobrane „na oko": kolumna nazwy mieści 47-znakową nazwę produktu ze wzoru
// w jednej linii (225 pkt zmierzone `widthOfString`), a każda kolumna kwotowa mieści
// „12345.67 PLN" — pięciocyfrowa kwota nie ma prawa zawinąć się na dokumencie dla klienta.
const KOLUMNY = {
  lp: { x: L, w: 24, align: 'left' },
  nazwa: { x: 66, w: 234, align: 'left' },
  ilosc: { x: 304, w: 42, align: 'right' },
  cena: { x: 350, w: 72, align: 'right' },
  // „Stawka VAT" (56 pkt) świadomie NIE mieści się w 48 i łamie się na dwie linie — dokładnie
  // tak, jak w nagłówku wzoru z Apilo. Dotyczy TYLKO nagłówka; wartość to zawsze „23%".
  stawka: { x: 426, w: 48, align: 'right' },
  wartosc: { x: 477, w: R - 477, align: 'right' },
};

// Podsumowanie VAT — dosunięte do prawej, tak jak we wzorze. Osobne kolumny, bo to inna tabela,
// a nie te same kolumny co wyżej (we wzorze też się nie pokrywają).
//
// Kolumny kwotowe mają po 76–77 pkt, bo najszerszy realny napis („999999.99 PLN" pogrubione 9 pkt
// = 77 pkt) MUSI się zmieścić W CAŁOŚCI. Przy 62 pkt wiersz „Suma" rozpadał się na dwie linie
// i wjeżdżał w sąsiednią kolumnę — złapane na renderze z 40 pozycjami, nie przez test tekstowy.
const KOLUMNY_VAT = {
  stawka: { x: 268, w: 58, align: 'left' },
  netto: { x: 326, w: 76, align: 'right' },
  vat: { x: 402, w: 76, align: 'right' },
  brutto: { x: 478, w: R - 478, align: 'right' },
};

// Lewa krawędź bloku „PODSUMOWANIE" — WSPÓLNA z tabelą VAT, żeby oba prawe bloki stały w jednej
// osi. Prawa kolumna ma wtedy 177 pkt, czyli mieści 26-cyfrowy numer rachunku (149 pkt) BEZ
// ZAWIJANIA: numer konta przełamany w połowie to numer, który klient przepisze z błędem.
const PODSUMOWANIE_X = KOLUMNY_VAT.stawka.x;

const kwota = (gr) => `${zl(gr)} PLN`;

function zwykly(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT).fontSize(rozmiar).fillColor(kolor);
}

function gruby(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT_GRUBY).fontSize(rozmiar).fillColor(kolor);
}

function linia(doc, y) {
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(SZARY_LINIA).stroke();
}

// Nagłówek sekcji ze wzoru: szary prostokąt, potem napis kapitalikami (duża pierwsza litera,
// reszta wersalikami w mniejszym stopniu). Pdfkit nie ma kapitalików, więc składamy je z dwóch
// napisów na wspólnej linii bazowej — mnożnik 0,72 to odległość podstawy od górnej krawędzi
// pola tekstu w DejaVu, dobrany na oko i sprawdzony na renderze.
function naglowekSekcji(doc, x, y, tekst) {
  const DUZA = 12;
  const MALA = 9;
  doc.rect(x, y + 4, 28, 6).fillColor(SZARY_PASEK).fill();
  const napis = String(tekst);
  zwykly(doc, DUZA).text(napis.slice(0, 1).toUpperCase(), x + 34, y, { lineBreak: false });
  const szerPierwszej = doc.widthOfString(napis.slice(0, 1).toUpperCase());
  zwykly(doc, MALA).text(
    napis.slice(1).toUpperCase(),
    x + 34 + szerPierwszej,
    y + (DUZA - MALA) * 0.72,
    { lineBreak: false },
  );
  return y + DUZA + 8;
}

/**
 * Blok adresowy jednej strony transakcji. Zwraca `y` pod ostatnią linią.
 *
 * Nazwa firmy MOŻE się tu zawinąć i tak ma być — „Przedsiębiorstwo Produkcyjno-Handlowo-Usługowe
 * …" nie zmieści się w żadnej kolumnie, a ucięcie nazwy nabywcy na dokumencie jest gorsze niż
 * dwie linie. Dlatego kolejna linia idzie o ZMIERZONĄ wysokość niżej, a nie o stałe 13 pkt:
 * przy stałym skoku zawinięta nazwa nachodziłaby na ulicę.
 */
function blokStrony(doc, x, y, szerokosc, strona = {}) {
  let biezace = naglowekSekcji(doc, x, y, strona.tytul ?? '');
  const linie = [
    strona.nazwa,
    strona.ulica,
    [strona.kod, strona.miasto].filter(Boolean).join(' '),
    strona.kraj,
    strona.nip ? `NIP: ${strona.nip}` : '',
  ].map((s) => String(s ?? '').trim()).filter((s) => s !== '');
  zwykly(doc, 9);
  for (const l of linie) {
    doc.text(l, x, biezace, { width: szerokosc });
    biezace += Math.max(doc.heightOfString(l, { width: szerokosc }), 12) + 1;
  }
  return biezace;
}

/**
 * Komórka tabeli — JEDNA LINIA, zawsze.
 *
 * ⚠️ `lineBreak: false` TU NIE WYSTARCZA i to jest zmierzone, nie przypuszczane: gdy do
 * `doc.text()` poda się `width`, pdfkit 0.19 przepuszcza tekst przez łamacz linii NIEZALEŻNIE od
 * tej opcji („32526.67 PLN" w kolumnie 70 pkt rozpadało się na „32526.67" / „PLN" i wjeżdżało
 * w sąsiednią kolumnę). Dlatego wyrównanie liczymy sami i wołamy `text()` BEZ `width` — wtedy
 * pdfkit w ogóle nie uruchamia łamania. Kolumny są na tyle szerokie, żeby ta jedna linia się
 * mieściła; gdyby kiedyś nie starczyło, kwota wyjdzie w lewo, w puste miejsce, a nie pod spód.
 */
function komorka(doc, tekst, kol, y) {
  const napis = String(tekst ?? '');
  const szer = doc.widthOfString(napis);
  const x = kol.align === 'right' ? kol.x + kol.w - szer : kol.x;
  doc.text(napis, x, y, { lineBreak: false });
}

const NAGLOWKI_TABELI = [
  ['Lp.', KOLUMNY.lp],
  ['Nazwa towaru/usługi', KOLUMNY.nazwa],
  ['Ilość jm.', KOLUMNY.ilosc],
  ['Cena brutto', KOLUMNY.cena],
  ['Stawka VAT', KOLUMNY.stawka],
  ['Wartość brutto', KOLUMNY.wartosc],
];

/**
 * Nagłówek tabeli pozycji. Rysowany od nowa na KAŻDEJ stronie — inaczej druga strona jest gołą
 * listą liczb bez informacji, która kolumna jest ceną, a która wartością.
 *
 * ⚠️ Napisy nagłówków są DOSUNIĘTE DO DOŁU, a wysokość bloku bierze się z najwyższego z nich.
 * Bez tego „Stawka VAT" (szersza niż swoja kolumna, więc łamiąca się na dwie linie — tak samo
 * jak we wzorze z Apilo) wychodziła drugą linią POD kreskę i pod pierwszy wiersz tabeli. Testu
 * tekstowego to nie ruszało: `pdftotext` widział „Stawka" i „VAT" jak gdyby nic. Złapane
 * dopiero na obejrzanym renderze — i dlatego oglądanie obrazu jest tu warunkiem, nie ozdobą.
 */
function naglowekTabeli(doc, y) {
  gruby(doc, 8.5);
  const wysokosci = NAGLOWKI_TABELI.map(([napis, kol]) => doc.heightOfString(napis, { width: kol.w }));
  const wysBloku = Math.max(...wysokosci);
  NAGLOWKI_TABELI.forEach(([napis, kol], i) => {
    doc.text(napis, kol.x, y + wysBloku - wysokosci[i], { width: kol.w, align: kol.align });
  });
  const dol = y + wysBloku + 4;
  linia(doc, dol);
  return dol + 6;
}

/**
 * ⚠️ CENA JEDNOSTKOWA JEST TU WYŁĄCZNIE OZDOBĄ, A WARTOŚĆ LINII JEST PRAWDĄ — i to nie jest
 * kwestia gustu, tylko jedyny układ, który nie kłamie o kwocie do zapłaty.
 *
 * `gross_price` pozycji to SUMA LINII (tak jak wszędzie w tym repo, patrz nagłówek
 * domain/pozycje-faktury.js), a wzór z Apilo ma kolumnę „Cena brutto" — cenę ZA SZTUKĘ.
 * Trzeba ją więc wyliczyć dzieleniem, a dzielenie przy rabacie NIE ODWRACA SIĘ mnożeniem:
 *   3 szt., linia 100,00 zł (rabat 10%) → 33,33 zł/szt → 33,33 × 3 = 99,99 zł ≠ 100,00 zł.
 * To dokładnie ten grosz, o który panel rozbijał się na barierze arytmetycznej faktury.
 *
 * Dlatego kolumna „Wartość brutto" bierze `gross_price` WPROST i nigdy nie jest iloczynem.
 * Suma pod tabelą, podsumowanie VAT i „Do zapłaty" liczą się z tych samych wartości linii, więc
 * dokument zgadza się sam ze sobą — cena jednostkowa może się o grosz nie domnożyć i to jest
 * zachowanie ZAMIERZONE (tak samo robi wzór z Apilo), a nie usterka do „naprawienia".
 */
function cenaJednostkowaGr(pozycja) {
  const ilosc = Number(pozycja?.quantity) || 1;
  return Math.round(Number(pozycja?.gross_price ?? 0) / ilosc);
}

function wierszPozycji(doc, y, pozycja, lp) {
  const nazwa = String(pozycja?.name ?? '');
  zwykly(doc, 9);
  // Wysokość wiersza z WYSOKOŚCI NAZWY, nie ze stałej: nazwy produktów potrafią mieć 60 znaków
  // i muszą się zawijać, a nie wychodzić na sąsiednią kolumnę.
  const wysNazwy = doc.heightOfString(nazwa, { width: KOLUMNY.nazwa.w });
  const wys = Math.max(wysNazwy, 11) + 10;

  if (lp % 2 === 1) {
    doc.rect(L, y - 4, R - L, wys).fillColor(SZARY_WIERSZ).fill();
  }

  zwykly(doc, 9);
  komorka(doc, `${lp}.`, KOLUMNY.lp, y);
  doc.text(nazwa, KOLUMNY.nazwa.x, y, { width: KOLUMNY.nazwa.w, align: 'left' });
  komorka(doc, pozycja?.quantity ?? '', KOLUMNY.ilosc, y);
  komorka(doc, kwota(cenaJednostkowaGr(pozycja)), KOLUMNY.cena, y);
  komorka(doc, `${String(pozycja?.tax_symbol ?? '')}%`, KOLUMNY.stawka, y);
  gruby(doc, 9);
  komorka(doc, kwota(pozycja?.gross_price ?? 0), KOLUMNY.wartosc, y);

  return y + wys;
}

function tabelaVat(doc, y, wiersze = []) {
  gruby(doc, 8.5);
  komorka(doc, 'Stawka VAT', KOLUMNY_VAT.stawka, y);
  komorka(doc, 'Netto', KOLUMNY_VAT.netto, y);
  komorka(doc, 'Kwota VAT', KOLUMNY_VAT.vat, y);
  komorka(doc, 'Brutto', KOLUMNY_VAT.brutto, y);
  let biezace = y + 14;
  doc.moveTo(KOLUMNY_VAT.stawka.x, biezace).lineTo(R, biezace)
    .lineWidth(0.5).strokeColor(SZARY_LINIA).stroke();
  biezace += 5;

  wiersze.forEach((w, i) => {
    if (i % 2 === 0) {
      doc.rect(KOLUMNY_VAT.stawka.x, biezace - 4, R - KOLUMNY_VAT.stawka.x, 18)
        .fillColor(SZARY_WIERSZ).fill();
    }
    // ⚠️ Etykieta „Suma" idzie z FLAGI `w.suma`, nigdy z pozycji w tablicy. Wiersz sumy ma
    // `stawka: null` i jest ostatni, ale rozpoznawanie go po indeksie byłoby drugą regułą na
    // tę samą rzecz — a przy jednej stawce oba warianty wyglądają identycznie, więc pomyłka
    // wyszłaby dopiero na dokumencie z dwiema stawkami.
    if (w.suma) gruby(doc, 9); else zwykly(doc, 9);
    komorka(doc, w.suma ? 'Suma' : `${w.stawka}%`, KOLUMNY_VAT.stawka, biezace);
    komorka(doc, kwota(w.nettoGr), KOLUMNY_VAT.netto, biezace);
    komorka(doc, kwota(w.vatGr), KOLUMNY_VAT.vat, biezace);
    komorka(doc, kwota(w.bruttoGr), KOLUMNY_VAT.brutto, biezace);
    biezace += 18;
  });
  return biezace;
}

function blokPodsumowania(doc, y, dane) {
  const x = PODSUMOWANIE_X;
  const prawa = { x: x + 105, w: R - (x + 105), align: 'right' }; // 182 pkt na wartości
  let biezace = naglowekSekcji(doc, x, y, 'Podsumowanie');

  // „Do zapłaty", nie „Do dopłaty" jak we wzorze z Apilo (świadoma zmiana, plan → „Wzór
  // dokumentu"): „dopłata" mówi klientowi, że część pieniędzy już wpłynęła, a proforma
  // poprzedza zwykle CAŁĄ płatność.
  gruby(doc, 10).text('Do zapłaty', x, biezace + 6, { lineBreak: false });
  gruby(doc, 18);
  komorka(doc, kwota(dane.doZaplatyGr), prawa, biezace);
  biezace += 30;

  zwykly(doc, 9).text('Słownie', x, biezace, { lineBreak: false });
  const slownie = String(dane.slownie ?? '');
  // ⚠️ Kwota słownie to JEDYNE pole tego bloku, któremu wolno się zawinąć („dwa tysiące trzysta
  // czterdzieści pięć złotych 50/100" nie zmieści się w żadnej rozsądnej kolumnie). Czyta się je
  // jak zdanie, a nie przepisuje jak numer konta — złamanie niczego tu nie psuje.
  const wysSlownie = doc.heightOfString(slownie, { width: prawa.w });
  doc.text(slownie, prawa.x, biezace, { width: prawa.w, align: 'right' });
  biezace += Math.max(wysSlownie, 12) + 3;

  zwykly(doc, 9).text('Przelew bankowy PLN, na rachunek', x, biezace, { width: 100 });
  komorka(doc, dane.bank ?? '', prawa, biezace);
  komorka(doc, dane.rachunek ?? '', prawa, biezace + 13);
  return biezace + 40;
}

// Stopka na KAŻDEJ stronie, dopisywana po złożeniu całości (`bufferPages`) — inaczej trzeba by
// zgadywać przy pierwszej stronie, ile ich w sumie będzie. Dolny margines zerujemy na czas
// pisania, bo pdfkit na tekst poniżej marginesu odpowiada… dołożeniem kolejnej strony.
function stopki(doc, nazwaSprzedawcy) {
  const zakres = doc.bufferedPageRange();
  for (let i = zakres.start; i < zakres.start + zakres.count; i += 1) {
    doc.switchToPage(i);
    const dolny = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    zwykly(doc, 8, SZARY_TEKST).text(
      `Wystawiono w panelu zamówień${nazwaSprzedawcy ? ` ${nazwaSprzedawcy}` : ''}`,
      L, doc.page.height - 42, { width: R - L, lineBreak: false },
    );
    if (zakres.count > 1) {
      doc.text(`Strona ${i - zakres.start + 1} z ${zakres.count}`, L, doc.page.height - 42, {
        width: R - L, align: 'right', lineBreak: false,
      });
    }
    doc.page.margins.bottom = dolny;
  }
}

/**
 * Bajty gotowego dokumentu, SYNCHRONICZNIE.
 *
 * `PDFDocument` jest strumieniem, ale `doc.end()` składa cały plik (łącznie z osadzeniem
 * podzbioru fontu) w jednym, synchronicznym przebiegu i wypycha wszystko do bufora strumienia.
 * Dlatego wystarczy go potem opróżnić `read()`-em, zamiast owijać generator w obietnicę
 * i zarażać asynchronicznością każdą trasę, która woła go po drodze do przeglądarki.
 */
function bajty(doc) {
  doc.end();
  const kawalki = [];
  for (let k = doc.read(); k !== null; k = doc.read()) kawalki.push(k);
  return Buffer.concat(kawalki);
}

/**
 * Faktura proforma jako gotowy PDF.
 *
 * Wejście (wszystko policzone WYŻEJ, ten moduł tylko rysuje):
 *   `numer`, `dataWystawienia` (RRRR-MM-DD), `sposobZaplaty`,
 *   `sprzedawca`/`nabywca` — `{ nazwa, ulica, kod, miasto, kraj, nip }`,
 *   `pozycje` — `services` z `domain/pozycje-faktury.js`: `{ name, quantity, gross_price, tax_symbol }`,
 *      gdzie `gross_price` to WARTOŚĆ CAŁEJ LINII w groszach,
 *   `podsumowanieVat` — wynik `domain/podsumowanie-vat.js` (wiersz sumy poznaje się po `suma`),
 *   `doZaplatyGr`, `slownie`, `rachunek`, `bank`.
 */
export function zbudujProformePdf(dane = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: {
      top: MARGINES, bottom: MARGINES, left: MARGINES, right: MARGINES,
    },
    bufferPages: true,
    info: {
      Title: `Faktura proforma ${dane.numer ?? ''}`.trim(),
      Author: dane.sprzedawca?.nazwa ?? 'Twój OMS',
    },
  });
  for (const [nazwa, plik] of Object.entries(PLIKI_FONTOW)) doc.registerFont(nazwa, plik);
  doc.font(FONT);

  // ── 1. Tytuł ──────────────────────────────────────────────────────────────
  let y = 48;
  gruby(doc, 18).text(`Pro forma nr ${dane.numer ?? ''}`, L, y, { width: R - L, align: 'center' });
  y += 34;

  // ── 2. Nazwa sprzedawcy z lewej, metryczka dokumentu z prawej ─────────────
  zwykly(doc, 9).text(dane.sprzedawca?.nazwa ?? '', L, y, { width: 300, lineBreak: false });
  const metryczka = [
    ['Data wystawienia:', dane.dataWystawienia ?? ''],
    ['Sposób zapłaty:', dane.sposobZaplaty ?? 'Przelew bankowy'],
  ];
  metryczka.forEach(([etykieta, wartosc], i) => {
    zwykly(doc, 9).text(etykieta, 370, y + i * 13, { width: 95, lineBreak: false });
    zwykly(doc, 9).text(String(wartosc), 468, y + i * 13, { width: R - 468, lineBreak: false });
  });
  y += 40;

  // ── 3. Linia + 4. strony transakcji ───────────────────────────────────────
  linia(doc, y);
  y += 18;
  const dolSprzedawcy = blokStrony(doc, L, y, PRAWA_KOLUMNA - L - 20, { ...dane.sprzedawca, tytul: 'Sprzedawca' });
  const dolNabywcy = blokStrony(doc, PRAWA_KOLUMNA, y, R - PRAWA_KOLUMNA, { ...dane.nabywca, tytul: 'Nabywca' });
  y = Math.max(dolSprzedawcy, dolNabywcy) + 22;

  // ── 5. Pozycje ────────────────────────────────────────────────────────────
  y = naglowekSekcji(doc, L, y, 'Pozycje faktury') + 8;
  y = naglowekTabeli(doc, y);

  const dolnaGranica = doc.page.height - MARGINES - 22; // 22 pkt rezerwy na stopkę
  (dane.pozycje ?? []).forEach((p, i) => {
    zwykly(doc, 9);
    const wys = Math.max(doc.heightOfString(String(p?.name ?? ''), { width: KOLUMNY.nazwa.w }), 11) + 10;
    // Łamiemy PRZED wierszem, nie po nim: wiersz wpisany do połowy na krawędzi strony traci
    // kwotę, a numeracja Lp. ma biec dalej, więc nagłówek tabeli wraca, a licznik nie.
    if (y + wys > dolnaGranica) {
      doc.addPage();
      y = naglowekTabeli(doc, MARGINES);
    }
    y = wierszPozycji(doc, y, p, i + 1);
  });

  // ── 6. Podsumowanie VAT + 7. blok płatności ───────────────────────────────
  const wierszeVat = dane.podsumowanieVat ?? [];
  // Obie sekcje trzymamy RAZEM na jednej stronie: „Do zapłaty" oderwane od tabeli VAT to
  // dokument, w którym klient widzi kwotę bez podstawy, z której ona wyszła.
  const potrzeba = 34 + wierszeVat.length * 18 + 130;
  if (y + potrzeba > dolnaGranica) {
    doc.addPage();
    y = MARGINES;
  } else {
    y += 14;
  }
  y = tabelaVat(doc, y, wierszeVat) + 26;
  linia(doc, y - 12);
  y = blokPodsumowania(doc, y, dane);
  linia(doc, y);

  stopki(doc, dane.sprzedawca?.nazwa);
  return bajty(doc);
}
