import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { zl } from '../../../domena/kwoty.js';
import { fmtDataCzasKrotko } from '../../../domena/format-daty.js';
import { MIESIACE } from '../../../domena/okres-rozliczeniowy.js';

// Zestawienie dokumentow miesiaca dla biura rachunkowego (spec 2026-09-02, Czesc D) —
// pierwsze strony paczki: osobne dla sprzedazy i osobne dla kosztow, bo od 2026-09-02
// wieczorem sa to DWA OSOBNE PLIKI do pobrania (decyzja wlasciciela). To jest kartka, po
// ktorej ksiegowa sprawdza, CZY DOSTALA CALY MIESIAC: numery po kolei, kwoty i sumy per
// waluta, a przy wierszach „z pogranicza" zdanie, dlaczego lezy w tej paczce.
//
// A4 POZIOMO, bo dwanascie kolumn (w tym 35-znakowy numer KSeF, ktory jest JEDYNYM
// identyfikatorem laczacym wiersz z oryginalem w systemie Ministerstwa) nie miesci sie
// w pionie w czcionce, ktora da sie czytac.
//
// ⚠️ TEN MODUL TYLKO RYSUJE — tak samo jak koszt-pdf.js. Wiersze, kolejnosc, uwagi, sumy
// per waluta i ostrzezenia przychodza gotowe z domain/paczka-dla-biura.js. Ani jednego
// dodawania tutaj: suma, ktora rozeszlaby sie z sumami z domeny, jest gorsza niz jej brak,
// bo to wlasnie ta liczba idzie do deklaracji.

const KATALOG = path.dirname(fileURLToPath(import.meta.url));

// ⚠️ CICHA AWARIA, KTORA KONCZY SIE W KSIEGOWOSCI (ta sama, co w koszt-pdf.js): wbudowane
// fonty PDF nie maja polskich znakow, a pdfkit nie protestuje — dokument powstaje bez
// jednego ostrzezenia, z dziurami zamiast polskich liter z ogonkami i kreskami. Dlatego
// kazdy napis idzie przez FONT/FONT_GRUBY, a nazwa wbudowanego fontu nie pada w tym pliku
// ani razu.
const FONT = 'DejaVu';
const FONT_GRUBY = 'DejaVu-Bold';
const PLIKI_FONTOW = {
  [FONT]: path.join(KATALOG, '../../faktury/pdf/fonty', 'DejaVuSans.ttf'),
  [FONT_GRUBY]: path.join(KATALOG, '../../faktury/pdf/fonty', 'DejaVuSans-Bold.ttf'),
};

const SZER = 841.89; // A4 poziomo
const WYS = 595.28;
const M = 30;
const L = M;
const R = SZER - M;
const ODSTEP = 4; // odstep miedzy kolumnami

const ROZMIAR = 7;
const WIERSZ_H = 13; // wysokosc wiersza bez uwag
const WYS_LINII = 8.5; // jedna linia tekstu 7 pkt (zmierzone: 8.15) z zapasem
const DOL = WYS - M - 12; // ostatnia linia bazowa tresci; nizej jest juz stopka

const CZARNY = '#1a1a1a';
const SZARY_TEKST = '#666666';
const SZARY_WIERSZ = '#f1f1f1';
const SZARY_LINIA = '#bbbbbb';

// Kolumny: [naglowek, szerokosc, wyrownanie, klucz wiersza]. Szerokosc `0` znaczy „reszta
// wiersza" i przysluguje WYLACZNIE ostatniej kolumnie (Uwagi).
//
// ⚠️ SZEROKOSCI SA ZMIERZONE, NIE OSZACOWANE (pdfkit `widthOfString`, DejaVu 7 pkt):
// numer KSeF = 155 pkt, data „05.08.2026" = 41, „-1 234 567,89" = 50, naglowek „Wystawiona"
// pogrubiony = 48, numer korekty „1234/KOR/08/2026" = 67. Kolumna wezsza od swojej
// zawartosci nie wyglada na blad — po prostu gubi koncowke numeru KSeF, po ktorym ksiegowa
// szuka dokumentu w systemie Ministerstwa.
//
// ⚠️ NUMER KSeF MIERZYC NA LITERACH, NIE NA CYFRACH. Pierwsza wersja miala 152 pkt, bo
// zmierzyla „1234563218-20260805-50FE6D800008-06" (151). Segment srodkowy jest SZESNASTKOWY,
// wiec bywa sama litera — „…-AAAABBBBCCC8-01" to juz 154,4 pkt i na probnym wydruku kosztow
// KAZDY numer konczyl sie wielokropkiem. Stad 156: najszerszy zmierzony numer plus zapas.
//
// ⚠️ NIP MIERZYC NA UNIJNYM NUMERZE VAT, NIE NA POLSKIM NIP-IE. Pierwsza wersja miala 47 pkt
// (dokladnie „1234563218" = 44,5 pkt) — dobre dla 10-cyfrowego NIP-u, ale faktury WDT nosza
// numer VAT kontrahenta z innego kraju UE, ktory bywa dluzszy i ma litery w srodku:
// „NL123456789B01" (14 znakow) = 62,9 pkt. Kolumna wezsza od tego numeru go ucina
// wielokropkiem — ksiegowa traci mozliwosc porownania z deklaracja VIES. Stad 65 pkt.
//
// ⚠️ ODSTEPY LICZA SIE DO SZEROKOSCI STRONY. Uklad z briefu zadania rozdzielal reszte
// wiersza bez uwzglednienia jedenastu odstepow po 4 pkt i kolumna Uwagi wyjezdzala 44 pkt
// ZA prawy margines — na ekranie widac tam tekst, na wydruku juz nie. Pilnuje tego teraz
// `kolumnyZ` nizej, przy imporcie modulu.
const KOLUMNY = {
  sprzedaz: [
    ['Lp.', 16, 'right', 'lp'],
    ['Numer', 68, 'left', 'numer'],
    ['Kontrahent', 100, 'left', 'kontrahent'],
    ['NIP', 65, 'left', 'nip'],
    ['Wystawiona', 48, 'left', 'wystawiona'],
    ['Sprzedaż', 44, 'left', 'sprzedaz'],
    ['Netto', 50, 'right', 'nettoGr'],
    ['VAT', 46, 'right', 'vatGr'],
    ['Brutto', 50, 'right', 'bruttoGr'],
    ['Wal.', 18, 'left', 'waluta'],
    ['Nr KSeF', 156, 'left', 'ksef'],
    ['Uwagi', 0, 'left', 'uwagi'],
  ],
  koszty: [
    ['Lp.', 16, 'right', 'lp'],
    ['Numer', 68, 'left', 'numer'],
    ['Sprzedawca', 74, 'left', 'kontrahent'],
    ['NIP', 65, 'left', 'nip'],
    ['Wystawiona', 48, 'left', 'wystawiona'],
    ['Otrzymana', 44, 'left', 'otrzymana'],
    ['Netto', 50, 'right', 'nettoGr'],
    ['VAT', 46, 'right', 'vatGr'],
    ['Brutto', 50, 'right', 'bruttoGr'],
    ['Wal.', 18, 'left', 'waluta'],
    ['Rodzaj', 28, 'left', 'rodzaj'],
    ['Nr KSeF', 156, 'left', 'ksef'],
    ['Uwagi', 0, 'left', 'uwagi'],
  ],
};

// Ponizej tej szerokosci kolumna Uwagi przestaje byc kolumna, a staje sie pionowym slupkiem
// sylab — „dokument papierowy poza KSeF — dołącz oryginał" ma 177 pkt i musi sie zlozyc
// najwyzej na trzy linie, bo o tyle rosnie caly wiersz.
const MIN_UWAGI = 60;

const TYTUL = {
  sprzedaz: 'SPRZEDAŻ — faktury i korekty',
  koszty: 'KOSZTY — faktury zakupowe',
};

// ⚠️ CZESC STOI W NAGLOWKU PIERWSZEJ LINII, bo od 2026-09-02 wieczorem paczka to DWA OSOBNE
// PLIKI (decyzja wlasciciela: „podzial — dwa pliki do pobrania, jeden kosztowy, drugi
// przychodowy"). Dwa wydruki o identycznej pierwszej linii mieszaja sie na biurku, a rozniaca
// je linia druga jest o polowe mniejsza — ta jedna klatka na oku ksiegowej jest tansza niz
// telefon „ktory to plik".
const CZESC_W_NAGLOWKU = { sprzedaz: 'SPRZEDAŻ', koszty: 'KOSZTY' };

// Skad wzielo sie to zestawienie — plik sprzedazowy powstaje z inFaktu, kosztowy z KSeF
// (przez baze panelu). Wspolne „inFakt + KSeF" na obu wydrukach kazaloby ksiegowej szukac
// w kosztach dokumentow, ktorych panel nigdy tam nie pytal.
const ZRODLO = { sprzedaz: 'inFakt', koszty: 'KSeF' };

// Kryterium doboru na wydruku, bo to pierwsze pytanie ksiegowej przy dokumencie, ktorego
// data wystawienia nie pasuje do miesiaca paczki (art. 19a i art. 86 ust. 10b ustawy o VAT
// — patrz komentarz w domain/paczka-dla-biura.js).
const KRYTERIUM = {
  sprzedaz: 'wg daty sprzedaży (korekty wg daty wystawienia); dokumenty wystawione w innym miesiącu oznaczone w Uwagach',
  koszty: 'wg daty otrzymania (KSeF: dzień pobrania dokumentu; ręczne: data wystawienia)',
};

const PUSTO = {
  sprzedaz: 'Brak dokumentów sprzedażowych w tym miesiącu.',
  koszty: 'Brak dokumentów kosztowych w tym miesiącu.',
};

const opisMiesiaca = (m) => {
  const nr = Number(String(m ?? '').slice(5, 7));
  const nazwa = MIESIACE[nr - 1];
  return nazwa ? `${nazwa} ${String(m).slice(0, 4)}` : String(m ?? '');
};

// Data po polsku, DD.MM.RRRR — TAKA SAMA, jak w uwagach skladanych przez domene
// („wystawiona 02.09.2026"). Dwa formaty daty na jednej kartce czyta sie jak dwa rozne
// zrodla danych.
const data = (iso) => {
  const s = String(iso ?? '').slice(0, 10);
  return s.length === 10 ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}` : s;
};

/**
 * Kwota z groszy na napis polski: `1 234,56`, ujemna z minusem z przodu.
 *
 * ⚠️ TYLKO FORMATOWANIE — `zl()` dzieli przez 100 i tyle. Zadnego sumowania, zadnego
 * zaokraglania stawek: kwoty wchodza tu jako CALKOWITE grosze policzone w domenie.
 * Spacja jako separator tysiecy, bo tak zapisuje kwoty polska norma i tak wygladaja
 * kwoty na fakturach z inFaktu.
 */
const kwota = (gr) => zl(gr).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Uklad kolumn: pozycje `x` z szerokosci i odstepow, ostatnia kolumna dostaje RESZTE
 * wiersza policzona PO odjeciu wszystkich odstepow.
 *
 * Rzuca przy imporcie modulu, gdy kolumny nie mieszcza sie na stronie — bo to jest blad
 * w stalych wyzej, a nie sytuacja, ktora moze zalezec od danych. Kazdy test importujacy
 * ten plik przewroci sie natychmiast, zamiast oddac PDF z tekstem za marginesem.
 */
function kolumnyZ(czesc) {
  const kol = KOLUMNY[czesc];
  const stale = kol.reduce((s, k) => s + k[1], 0);
  const odstepy = (kol.length - 1) * ODSTEP;
  const reszta = (R - L) - stale - odstepy;
  if (reszta < MIN_UWAGI) {
    throw new Error(`Kolumny zestawienia „${czesc}" nie mieszczą się na stronie: na Uwagi zostaje ${reszta.toFixed(1)} pkt (minimum ${MIN_UWAGI}).`);
  }
  let x = L;
  return kol.map(([naglowek, w, align, klucz]) => {
    const c = {
      naglowek, x, w: w || reszta, align, klucz,
    };
    x += c.w + ODSTEP;
    return c;
  });
}

/**
 * Gotowe uklady obu tabel. EKSPORTOWANE dla testu, i to nie jest furtka „na wszelki wypadek":
 * obie usterki tego modulu — kolumna Uwagi za prawym marginesem i numer KSeF ucinany
 * wielokropkiem — sa widoczne WYLACZNIE w tych liczbach. Z gotowego PDF-a nie da sie ich
 * odczytac zadnym narzedziem, ktore mamy w projekcie; da sie je tylko zobaczyc na wydruku.
 */
export const UKLAD_KOLUMN = { sprzedaz: kolumnyZ('sprzedaz'), koszty: kolumnyZ('koszty') };

/** Rozmiar czcionki tabeli — eksportowany razem z ukladem, bo bez niego szerokosci nic nie znacza. */
export const ROZMIAR_TABELI = ROZMIAR;

/** Prawa krawedz tresci — granica, ktorej zadna kolumna nie ma prawa przekroczyc. */
export const PRAWA_KRAWEDZ = R;

const zwykly = (doc, rozmiar = ROZMIAR, kolor = CZARNY) => doc.font(FONT).fontSize(rozmiar).fillColor(kolor);
const gruby = (doc, rozmiar = ROZMIAR, kolor = CZARNY) => doc.font(FONT_GRUBY).fontSize(rozmiar).fillColor(kolor);

const linia = (doc, y) => doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(SZARY_LINIA).stroke();

/**
 * Skrocenie napisu do szerokosci kolumny, z wielokropkiem.
 *
 * ⚠️ WLASNE, A NIE `{ width, lineBreak: false, ellipsis: true }` PDFKITA — ta opcja NIE
 * dziala tak, jak wyglada. Zmierzone (pdfkit 0.19): nazwa sprzedawcy w kolumnie 60 pkt
 * z `lineBreak: false` zlozyla sie na PIEC linii, dokladnie tak samo jak bez tej opcji.
 * W tabeli, ktorej wysokosc wiersza jest policzona z gory, to znaczy pieciokrotne nadpisanie
 * wierszy ponizej — nie do wykrycia inaczej niz przez obejrzenie wydruku.
 */
function skroc(doc, napis, szer) {
  const s = String(napis ?? '');
  if (s === '' || doc.widthOfString(s) <= szer) return s;
  let i = s.length - 1;
  while (i > 0 && doc.widthOfString(`${s.slice(0, i)}…`) > szer) i -= 1;
  return `${s.slice(0, i)}…`;
}

/**
 * Komorka tabeli — ZAWSZE jedna linia. Wyrownanie liczone samemu i `text()` BEZ `width`
 * (wzorzec z koszt-pdf.js): pdfkit z podanym `width` lamie tekst nawet wtedy, gdy prosic
 * go o cos przeciwnego, a napis przyciety `skroc()` z definicji miesci sie w kolumnie.
 */
function komorka(doc, tekst, kol, y) {
  const napis = skroc(doc, tekst, kol.w);
  if (napis === '') return;
  const x = kol.align === 'right' ? kol.x + kol.w - doc.widthOfString(napis) : kol.x;
  doc.text(napis, x, y, { lineBreak: false });
}

/** Wartosc komorki: kwoty z groszy, daty po polsku, reszta doslownie. */
function tekstKomorki(wiersz, klucz) {
  const v = wiersz[klucz];
  if (klucz.endsWith('Gr')) return typeof v === 'number' ? kwota(v) : '';
  if (klucz === 'wystawiona' || klucz === 'sprzedaz' || klucz === 'otrzymana') return data(v);
  return String(v ?? '');
}

/**
 * Naglowek tabeli — rysowany od nowa na KAZDEJ stronie. Bez tego strona druga jest gola
 * lista liczb, po ktorej nie widac, ktora kolumna jest netto, a ktora brutto.
 */
function naglowekTabeli(doc, kol, y) {
  gruby(doc, ROZMIAR);
  for (const c of kol) komorka(doc, c.naglowek, c, y);
  linia(doc, y + WYS_LINII + 2);
  return y + WYS_LINII + 6;
}

/**
 * Stopka BIEZACEJ strony. Dolny margines zerujemy na czas pisania, bo pdfkit na tekst
 * ponizej marginesu odpowiada… dolozeniem kolejnej strony (ten sam trik, co w koszt-pdf.js).
 *
 * ⚠️ STOPKA STOI NA KAZDEJ STRONIE, bo strony tej paczki jada do biura jako JEDEN plik
 * i wypadnieta kartka bez tego napisu nie ma z czego powiedziec, czego jest zestawieniem.
 */
function stopka(doc, opis, nr, ile) {
  const dolny = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  zwykly(doc, 7, SZARY_TEKST).text(opis, L, WYS - 22, { lineBreak: false });
  const numeracja = `zestawienie str. ${nr}/${ile}`;
  doc.text(numeracja, R - doc.widthOfString(numeracja), WYS - 22, { lineBreak: false });
  doc.page.margins.bottom = dolny;
}

/**
 * Bajty gotowego dokumentu. `doc.end()` sklada caly plik (lacznie z osadzeniem podzbioru
 * fontu) synchronicznie i wypycha go do bufora strumienia, wiec wystarczy go oproznic.
 */
function bajty(doc) {
  doc.end();
  const kawalki = [];
  for (let k = doc.read(); k !== null; k = doc.read()) kawalki.push(k);
  return Buffer.concat(kawalki);
}

/**
 * Zestawienie dokumentow paczki dla biura jako gotowy PDF (A4 poziomo).
 *
 * Wejscie:
 *   `paczka`           — wynik `zlozPaczke` (domain/paczka-dla-biura.js): `sprzedaz`,
 *                        `koszty`, `sumy` per waluta, `ostrzezenia`.
 *   `czesc`            — 'sprzedaz' albo 'koszty'; kazda czesc jest OSOBNYM plikiem do
 *                        pobrania, a jej zestawienie stoi PRZED jej grupa dokumentow.
 *   `wygenerowano`     — znacznik ISO; na wydruk idzie czas WARSZAWSKI (fmtDataCzasKrotko).
 *   `liczbaStron`      — ile stron ma CALY PLIK tej czesci (nie samo zestawienie i nie oba
 *                        pliki razem) — po tej liczbie ksiegowa sprawdza kompletnosc wydruku.
 *   `liczbaDokumentow` — ile dokumentow niesie ta czesc paczki.
 *   `sekcje`, `sumyRazem`, `zrodlo` — tylko zestawienie KOSZTOW (PRZ-086): kilka tabel pod
 *                        wlasnymi naglowkami (`{ naglowek, opis, wiersze, sumy, pusto, etykietaSum }`),
 *                        suma laczna pod nimi i opis zrodla na wydruku. Bez nich — jedna tabela.
 */
export async function zbudujZestawieniePdf({
  paczka, czesc, wygenerowano, liczbaStron, liczbaDokumentow, tytul = null,
  sekcje: sekcjeWejscie = null, sumyRazem = null, zrodlo = null,
}) {
  const tytulWydruku = tytul
    ? `${tytul} — ${opisMiesiaca(paczka.miesiac)}`
    : `Paczka dla biura rachunkowego — ${opisMiesiaca(paczka.miesiac)} — część: ${CZESC_W_NAGLOWKU[czesc]}`;
  const opisSekcji = tytul ?? TYTUL[czesc];
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    // Strony trzymane w pamieci do `end()` — patrz przebieg po `bufferedPageRange()`
    // na koncu funkcji, ktory stempluje stopke.
    bufferPages: true,
    margins: {
      top: M, bottom: M, left: M, right: M,
    },
    info: { Title: tytulWydruku, Author: 'OMS' },
  });
  for (const [nazwa, plik] of Object.entries(PLIKI_FONTOW)) doc.registerFont(nazwa, plik);

  const kol = UKLAD_KOLUMN[czesc];
  const kolUwagi = kol[kol.length - 1];
  // Zwykle zestawienie to JEDNA tabela. Zestawienie kosztów (PRZ-086) podaje `sekcje` —
  // kilka tabel pod własnymi nagłówkami, każda z własnymi sumami, plus `sumyRazem` na końcu.
  const sekcje = sekcjeWejscie ?? [{
    naglowek: null,
    wiersze: paczka[czesc] ?? [],
    sumy: paczka.sumy?.[czesc] ?? {},
    pusto: PUSTO[czesc],
    etykietaSum: '',
  }];
  const liczbaWierszy = sekcje.reduce((n, sk) => n + sk.wiersze.length, 0);
  let y = M;

  // ── Naglowek pierwszej strony ─────────────────────────────────────────────
  gruby(doc, 13).text(tytulWydruku, L, y, { lineBreak: false });
  y += 19;
  gruby(doc, 10).text(TYTUL[czesc], L, y, { lineBreak: false });
  y += 15;
  const metryczka = `Kryterium: ${KRYTERIUM[czesc]}. Wygenerowano ${fmtDataCzasKrotko(wygenerowano)} w panelu OMS (${zrodlo ?? ZRODLO[czesc]}).`;
  zwykly(doc, 7.5, SZARY_TEKST).text(metryczka, L, y, { width: R - L });
  y += doc.heightOfString(metryczka, { width: R - L }) + 6;

  // ⚠️ OSTRZEZENIA PACZKI STOJA NAD TABELA, nie pod nia. Mowia o dokumentach, ktorych
  // w tej paczce NIE MA (kwarantanna) albo ktorych kwot nie znamy — czyli o jedynym
  // powodzie, dla ktorego zestawienie moze nie byc calym miesiacem.
  for (const o of paczka.ostrzezenia ?? []) {
    const napis = `UWAGA: ${o}`;
    gruby(doc, 8, CZARNY).text(napis, L, y, { width: R - L });
    y += doc.heightOfString(napis, { width: R - L }) + 2;
  }
  y += 6;

  // `zNaglowkiemTabeli = false` przed nagłówkiem NOWEJ części: tabela dostaje własny nagłówek
  // po tytule części, a nie dwa nagłówki kolumn jeden pod drugim.
  // Przy kilku częściach „ciąg dalszy” mówi, KTÓREJ części — inaczej strona druga części
  // ręcznej wygląda jak dalszy ciąg faktur z KSeF.
  let biezacaCzesc = null;
  const nowaStrona = (zNaglowkiemTabeli = true) => {
    doc.addPage();
    y = M;
    const czesc = zNaglowkiemTabeli && biezacaCzesc ? `${biezacaCzesc} — ` : '';
    gruby(doc, 8, SZARY_TEKST).text(`${opisSekcji} — ${opisMiesiaca(paczka.miesiac)} — ${czesc}ciąg dalszy`, L, y, { lineBreak: false });
    y += 12;
    if (zNaglowkiemTabeli) y = naglowekTabeli(doc, kol, y);
  };

  // ── Sumy per waluta ───────────────────────────────────────────────────────
  // ⚠️ `sumy` NIESIE OBOK KOSZYKOW WALUT KLUCZ `niepelne: true` (patrz komentarz
  // w domain/paczka-dla-biura.js). Petla po `Object.entries` bez tego sita wywrocilaby sie
  // na `s.nettoGr` albo — gorzej — wydrukowala wiersz „Razem" w walucie „niepelne".
  const netto = kol.find((c) => c.klucz === 'nettoGr');
  const etykieta = { x: L, w: netto.x - L - ODSTEP, align: 'left' };
  const blokSum = (sumy, nazwa, ileWierszy) => {
    const koszyki = Object.entries(sumy ?? {}).filter(([, s]) => s && typeof s === 'object' && typeof s.bruttoGr === 'number');
    if (y + WIERSZ_H * (koszyki.length + 1) > DOL) nowaStrona();
    y += 4;
    linia(doc, y);
    y += 5;
    for (const [waluta, s] of koszyki) {
      if (y + WIERSZ_H > DOL) nowaStrona();
      gruby(doc, ROZMIAR);
      komorka(doc, ['Razem', nazwa, waluta].filter(Boolean).join(' '), etykieta, y);
      for (const c of kol) {
        if (c.klucz.endsWith('Gr')) komorka(doc, kwota(s[c.klucz]), c, y);
        if (c.klucz === 'waluta') komorka(doc, waluta, c, y);
      }
      y += WIERSZ_H;
    }
    if (koszyki.length === 0 && ileWierszy > 0) {
      zwykly(doc, 8, SZARY_TEKST).text('Brak kompletnych dokumentów do zsumowania.', L, y, { lineBreak: false });
      y += WIERSZ_H;
    }
    // ⚠️ NIEPELNE SUMY MOWIA O TYM WPROST, przy samych kwotach. Ostrzezenie ze szczytu strony
    // stoi kilkadziesiat wierszy wyzej, a to jest miejsce, w ktorym ksiegowa przepisuje liczbe
    // do deklaracji — cicha suma zanizona o jedna fakture jest tu najdrozszym mozliwym bledem.
    if (sumy?.niepelne) {
      if (y + WIERSZ_H > DOL) nowaStrona();
      gruby(doc, 8, CZARNY).text('UWAGA: sumy NIEPEŁNE — patrz ostrzeżenia', L, y, { lineBreak: false });
      y += WIERSZ_H;
    }
  };

  // ── Tabele (jedna albo kilka części) ──────────────────────────────────────
  sekcje.forEach((sk, idx) => {
    if (sk.naglowek) {
      // Tytuł części + nagłówek tabeli + choć jeden wiersz muszą stać na jednej stronie —
      // tytuł osierocony na dole kartki wygląda jak część bez zawartości.
      // Zapas liczony ze WSZYSTKIM, co stoi przed pierwszym wierszem: odstęp od poprzedniej
      // części, tytuł, opis, nagłówek kolumn (recenzja: przy 28 fakturach z KSeF tytuł części
      // ręcznej zostawał sam na dole strony, bo zapas pomijał odstęp i opis).
      const zapas = (idx > 0 ? 10 : 0) + 16 + (sk.opis ? 10 : 0) + WYS_LINII + 6 + WIERSZ_H;
      if (y + zapas > DOL) nowaStrona(false);
      else if (idx > 0) y += 10;
      biezacaCzesc = sk.naglowek;
      gruby(doc, 10).text(sk.naglowek, L, y, { lineBreak: false });
      y += 16;
      if (sk.opis) {
        zwykly(doc, 7.5, SZARY_TEKST).text(sk.opis, L, y - 3, { lineBreak: false });
        y += 10;
      }
    }
    y = naglowekTabeli(doc, kol, y);
    if (sk.wiersze.length === 0) {
      // ⚠️ PUSTA TABELA WYGLADA JAK BLAD WYDRUKU, a nie jak informacja (lekcja z koszt-pdf.js).
      zwykly(doc, 8, SZARY_TEKST).text(sk.pusto, L, y, { lineBreak: false });
      y += 16;
    }
    sk.wiersze.forEach((w, i) => {
      const uwagi = (w.uwagi ?? []).join('; ');
      zwykly(doc, ROZMIAR);
      // Wysokosc wiersza z UWAG, bo tylko one sie zawijaja — reszta kolumn to jedna linia
      // przycieta do szerokosci. Lamiemy PRZED wierszem, nie po nim: `komorka()` rysuje bez
      // `width`, wiec sama granicy strony nie sprawdzi i po cichu napisze poza arkuszem.
      const wys = Math.max(WIERSZ_H, (uwagi ? doc.heightOfString(uwagi, { width: kolUwagi.w }) : 0) + 5);
      if (y + wys > DOL) nowaStrona();
      if (i % 2 === 1) {
        doc.rect(L, y - 3, R - L, wys).fillColor(SZARY_WIERSZ).fill();
      }
      zwykly(doc, ROZMIAR);
      for (const c of kol) {
        if (c.klucz === 'uwagi') {
          if (uwagi !== '') doc.text(uwagi, c.x, y, { width: c.w });
        } else {
          komorka(doc, tekstKomorki(w, c.klucz), c, y);
        }
      }
      y += wys;
    });
    blokSum(sk.sumy, sk.etykietaSum, sk.wiersze.length);
  });
  // Suma łączna tylko wtedy, gdy jest co sumować — przy pustym miesiącu zostawała sama kreska.
  if (sumyRazem && liczbaWierszy > 0) {
    y += 6;
    blokSum(sumyRazem, 'łącznie', liczbaWierszy);
  }

  // ── Stopka na kazdej stronie ──────────────────────────────────────────────
  // Po stronach, ktore NAPRAWDE POWSTALY, a nie przy kazdym `addPage()`: przy wywolaniu
  // „recznym" nowe miejsce lamania zostaje bez stopki i nikt tego nie widzi, dopoki kartka
  // nie trafi do biura (stad `bufferPages: true`).
  // ⚠️ „CAŁY PLIK", A NIE „CAŁA PACZKA" — od 2026-09-02 wieczorem paczka miesiaca to DWA
  // pliki, wiec liczba stron dotyczy TEGO wydruku. Napis „cała paczka: 42 stron" na jednym
  // z dwoch plikow kazalby ksiegowej liczyc kartki przeciw liczbie, ktora nigdy sie nie zgodzi.
  const opis = `${opisSekcji} · ${opisMiesiaca(paczka.miesiac)} · dokumentów: ${liczbaDokumentow ?? liczbaWierszy} · cały plik: ${liczbaStron ?? '?'} stron`;
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    stopka(doc, opis, i - start + 1, count);
  }

  return bajty(doc);
}
