import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { grosze, zl } from '../../../domena/kwoty.js';

// Generator PDF-a WIZUALIZACJI faktury kosztowej pobranej z KSeF. KSeF oddaje wylacznie XML,
// wiec kartke do obejrzenia (i do wpiecia do archiwum na NAS-ie obok oryginalu) rysujemy sami.
// Uklad KALKUJE pdf/proforma-pdf.js i pdf/specyfikacja-pdf.js — te same stale formatu, te same
// pomocnicze zwykly()/gruby(), ten sam naglowek sekcji i ta sama tabela pozycji. Dokumenty maja
// wygladac jak z jednej firmy.
//
// ⚠️ PRZEBUDOWA 2026-09-03 — POWOD: pytanie wlasciciela „czy te wizualizacje XML nadaja sie do
// dostarczenia do biura?". Nie nadawaly sie. Kartka niosla sprzedawce, numer, date wystawienia,
// pozycje i trzy kwoty — i to wszystko. Brakowalo NABYWCY, adresow, daty sprzedazy, rozbicia
// VAT na stawki, brutta pozycji, adnotacji, podstawy zwolnienia i informacji o platnosci, czyli
// wiekszosci elementow z art. 106e ust. 1 ustawy o VAT. Ksiegowa dostawala dokument, ktorego
// nie da sie sprawdzic. Wzorem ukladu jest wydruk z inFaktu, ktory wlasciciel pokazal.
//
// ⚠️ TEN MODUL TYLKO RYSUJE i nadal NIE ZNA ANI JEDNEJ NAZWY WEZLA FA(3). Wszystko, co wymaga
// wiedzy o schemie — etykiety stawek, „Tak"/„Nie" adnotacji, forma platnosci slownie, brutto
// wyprowadzone tam, gdzie FA go nie niesie — powstaje w domain/koszt-xml.js (`dokumentZXml`).
// Schema FA zmienia sie decyzja Ministerstwa; drugie mapowanie tutaj rozjechaloby sie
// z pierwszym przy pierwszej takiej zmianie.
//
// ⚠️ SUMA POZYCJI NIE JEST TU LICZONA I NIE MA BYC. Netto/VAT/brutto z metadanych KSeF (tabela
// `koszty`) to jedyna prawda tego dokumentu i to one stoja w bloku „Razem"; suma policzona
// z pozycji byla drugim zrodlem tej samej liczby i rozeszlaby sie z pierwszym przy pierwszym
// rabacie albo zaokragleniu stawki. Kwoty wyprowadzone przez `dokumentZXml` (brutto pozycji
// i brutto stawki) sa OZNACZONE gwiazdka i przypisem — patrz `PRZYPIS_BRUTTO`.
//
// ⚠️ KODU QR NA TEJ KARTCE NIE MA I NIE BEDZIE. Kod QR (`KSeF: weryfikacja`) niesie ORYGINAL
// dokumentu w systemie MF; nasza kartka oryginalem nie jest i kod na niej sugerowalby, ze jest.
// Kto chce zweryfikowac dokument, ma numer KSeF wydrukowany w calosci w metryczce.

const KATALOG = path.dirname(fileURLToPath(import.meta.url));

// ⚠️ CICHA AWARIA, KTORA KONCZY SIE W KSIEGOWOSCI. Wbudowane fonty PDF (Helvetica i spolka)
// NIE MAJA polskich znakow, a pdfkit nie protestuje — dokument powstaje bez jednego
// ostrzezenia, tylko z dziurami zamiast `l a e z s c n o z`: „Ksi garnia wi teczna".
// Dlatego KAZDY napis w tym module idzie przez zwykly()/gruby() nizej, a nazwy wbudowanych
// fontow nie pojawiaja sie w tym pliku ani razu. Jedyny test, ktory zlamanie tej zasady
// wylapie, to odczyt powrotny pdftotext-em — bo Buffer wyglada tak samo w obu przypadkach.
const FONT = 'DejaVu';
const FONT_GRUBY = 'DejaVu-Bold';
const PLIKI_FONTOW = {
  [FONT]: path.join(KATALOG, '../../faktury/pdf/fonty', 'DejaVuSans.ttf'),
  [FONT_GRUBY]: path.join(KATALOG, '../../faktury/pdf/fonty', 'DejaVuSans-Bold.ttf'),
};

const A4_SZER = 595.28;
const MARGINES = 40;
const L = MARGINES;                 // lewa krawedz tresci
const R = A4_SZER - MARGINES;       // prawa krawedz tresci (555.28)
const PRAWA_KOLUMNA = 300;          // poczatek prawego bloku (metryczka, nabywca, sumy)
const SZER_LEWEJ = PRAWA_KOLUMNA - L - 15;

const CZARNY = '#1a1a1a';
const SZARY_TEKST = '#666666';
const SZARY_PASEK = '#c9c9c9';
const SZARY_WIERSZ = '#eeeeee';
const SZARY_LINIA = '#cccccc';

// ⚠️ DECYZJA WLASCICIELA (03.09.2026) — ZDANIE ODROZNIAJACE WIZUALIZACJE OD DOKUMENTU ZOSTALO
// ZDJETE Z KARTKI. Do tego dnia stalo tutaj (pod tytulem, na pierwszej stronie) i w stopce
// KAZDEJ strony: „Wizualizacja dokumentu z KSeF — oryginałem jest plik XML.". Powod usuniecia
// (decyzja wlasciciela, NIE przeoczenie): biuro ksiegowe pracuje z dokumentami z KSeF na co
// dzien i samo wie, ze to wizualizacje — zdanie tlumaczylo adresatowi cos, co juz wiedzial.
//
// ⚠️⚠️ NIE PRZYWRACAC PRZY KOLEJNEJ PRZEBUDOWIE UKLADU bez nowej, wyraznej decyzji wlasciciela.
// To, ze kartka upodabnia sie do prawdziwej faktury (tytul „e-Faktura", nabywca, adnotacje,
// rozbicie VAT), NIE JEST powodem, zeby to zdanie samemu przywrocic „dla bezpieczenstwa" —
// wlasciciel widzial ten uklad i mimo to podjal te decyzje. Miejsca, w ktorych zdanie kiedys
// stalo, sa oznaczone nizej (`stopka`, sekcja „Tytul i metryczka").

// Przypis do kwot, ktorych FA(3) NIE NIESIE i ktore wyprowadzil `dokumentZXml` (brutto pozycji
// bez `P_11A`/`P_11Vat`, brutto w rozbiciu na stawki). Bez tego zdania ksiegowa nie ma jak
// odroznic liczby przepisanej z dokumentu od liczby policzonej przez nas.
//
// ⚠️ SKROCONY 03.09.2026 NA PROSBE WLASCICIELA (byl: „* Kwota wyliczona (netto + VAT lub ze
// stawki) — dokument źródłowy nie zawiera tego pola. Do księgowania służą kwoty z oryginalnego
// pliku XML."). Drukuje sie WYLACZNIE wtedy, gdy na kartce stoi choc jedna gwiazdka (patrz
// `jestWyliczone` przy uzyciu nizej) — bez gwiazdki na kartce ten przypis bylby zdaniem
// o niczym.
const PRZYPIS_BRUTTO = '* kwota wyliczona przez panel — brak pola w dokumencie';

// ⚠️⚠️ KWOTA VAT-u Z METADANYCH KSeF JEST ZAWSZE W ZLOTYCH, a netto i brutto — w walucie
// dokumentu (regula stoi przy `czyPLN` w domain/koszt-metadane.js). Blok „Razem" drukowal
// wszystkie trzy z ta sama waluta, czyli na fakturze Allegro w EUR podawal ksiegowej VAT
// w euro, ktorego nikt nigdy nie policzyl. Kartka z dwiema walutami w jednym bloku sum musi
// powiedziec, dlaczego sa dwie — inaczej wyglada na blad wydruku.
//
// ⚠️⚠️ NOTA MUSI BYC PRAWDZIWA CO DO SLOWA — poprawka po drugiej recenzji (03.09.2026).
// Zdanie „VAT wykazany w zlotych; netto i brutto w walucie dokumentu" PRZECZYLO TABELI
// STAWEK STOJACEJ WYZEJ NA TEJ SAMEJ KARTCE: w rozbiciu na stawki kolumna „VAT" idzie
// w walucie dokumentu (`P_14_*`), a zlotowki stoja dopiero w wierszu „VAT przeliczony
// na zlote" (`P_14_*W`). W zlotych jest WYLACZNIE wiersz „Razem VAT" z metadanych KSeF —
// i tylko o nim ta nota ma prawo mowic.
const NOTA_VAT_W_PLN = 'Razem VAT w złotych (art. 106e ust. 11 ustawy o VAT); pozostałe kwoty '
  + 'w walucie dokumentu — VAT w tabeli stawek podany w walucie, przeliczenie na PLN '
  + 'w wierszu „VAT przeliczony na złote".';

// Kolumny tabeli pozycji — DANE, a nie wartosci rozsypane po kodzie: naglowek rysuje sie od
// nowa po kazdym lamaniu strony i musi stanac dokladnie tam, gdzie wiersze. Suma `x + w`
// ostatniej kolumny to dokladnie `R` — kolumna z wartoscia brutto nie ma prawa wyjechac poza
// margines, bo drukarka utnie wlasnie ja.
//
// ⚠️ DZIEWIEC KOLUMN MIESCI SIE NA A4 TYLKO PRZY 8 PKT (i naglowku 7,5) — zmierzone, nie
// przyjete. Podniesienie czcionki „dla czytelnosci" wypcha kolumne brutto poza arkusz, a to
// jest kolumna, ktora ksiegowa czyta pierwsza.
const KOLUMNY = {
  lp: { x: L, w: 16, align: 'left' },
  nazwa: { x: 58, w: 150, align: 'left' },
  ilosc: { x: 210, w: 30, align: 'right' },
  jm: { x: 244, w: 22, align: 'left' },
  cena: { x: 268, w: 50, align: 'right' },
  netto: { x: 320, w: 54, align: 'right' },
  stawka: { x: 376, w: 32, align: 'right' },
  vat: { x: 410, w: 50, align: 'right' },
  brutto: { x: 462, w: R - 462, align: 'right' },
};

// Tabela „W tym" (podsumowanie VAT wg stawek) i blok sum — dosuniete do prawej, jak w proformie.
const STAWKI_KOL = {
  etykieta: { x: PRAWA_KOLUMNA, w: 52, align: 'left' },
  pole: { x: 352, w: 48, align: 'left' },
  netto: { x: 400, w: 50, align: 'right' },
  vat: { x: 452, w: 45, align: 'right' },
  brutto: { x: 499, w: R - 499, align: 'right' },
};

const PODSUMOWANIE = {
  etykieta: { x: PRAWA_KOLUMNA, w: 130, align: 'left' },
  wartosc: { x: 430, w: R - 430, align: 'right' },
};

function zwykly(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT).fontSize(rozmiar).fillColor(kolor);
}

function gruby(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT_GRUBY).fontSize(rozmiar).fillColor(kolor);
}

function linia(doc, y, od = L, do_ = R) {
  doc.moveTo(od, y).lineTo(do_, y).lineWidth(0.5).strokeColor(SZARY_LINIA).stroke();
}

/** Napis gotowy do wydruku — `null`/`undefined` NIE MA PRAWA trafic na papier jako slowo. */
const napis = (co) => String(co ?? '').trim();

/** Wartosc, ktora wolno formatowac jako kwote — wszystko inne idzie na wydruk DOSLOWNIE. */
const LICZBA_KWOTY = /^-?\d+(\.\d+)?$/;

/**
 * Kwota na dokument — Z PRZECINKIEM, bo tak zapisuje sie kwoty po polsku i tak pokazuje je
 * zakladka KOSZTY (views/koszty.ejs).
 *
 * ⚠️ PRZEZ `grosze()`/`zl()`, NIGDY PRZEZ `Number(x).toFixed(2)` (niezmiennik 4.5). Kwoty
 * przychodza tu NAPISAMI — kolumny `netto/vat/brutto` sa TEXT-em, a pozycje z XML-a to tekst
 * z dokumentu — i przez liczbe zmiennoprzecinkowa nie maja prawa przejsc nawet po drodze
 * na wydruk.
 *
 * ⚠️ BRAK KWOTY DAJE PUSTA KOMORKE, a wartosc, ktora nie jest liczba, idzie DOSLOWNIE. To jest
 * wizualizacja CUDZEGO dokumentu: „NaN" albo „0,00" w miejscu, gdzie wystawca czegos nie podal,
 * bylo zdaniem o pieniadzach, ktorego nikt nie napisal. `grosze()` na pustej wartosci rzuca
 * (i slusznie — przy WYSTAWIANIU faktury), wiec pusta wartosc odsiewamy przed nim.
 */
function kwota(surowa, waluta = '') {
  const tekst = napis(surowa);
  if (tekst === '') return '';
  if (!LICZBA_KWOTY.test(tekst)) return tekst;
  const zlotowki = zl(grosze(tekst, 'kwota na dokumencie kosztowym')).replace('.', ',');
  return waluta ? `${zlotowki} ${waluta}` : zlotowki;
}

/**
 * Kwota Z TYLOMA MIEJSCAMI PO PRZECINKU, ILE NIESIE DOKUMENT — do cen jednostkowych i innych
 * kwot PRZY POZYCJI.
 *
 * ⚠️⚠️ POPRAWKA PO DRUGIEJ RECENZJI (03.09.2026): `kwota()` wyzej przepuszcza kazda liczbe
 * przez GROSZE CALKOWITE, czyli po cichu ZAOKRAGLA. FA(3) dopuszcza w `P_9A`/`P_9B` cztery
 * miejsca po przecinku (tak wystawia sie uslugi liczone od sztuki przy tysiacach sztuk),
 * wiec cena „0.4550" stawala na kartce jako „0,46" — i mnozenie w wierszu przestawalo sie
 * zgadzac: 0,455 × 1000 = 455,00, ale 0,46 × 1000 = 460,00. Ksiegowa widziala trzy liczby
 * w jednym wierszu, z ktorych dwie przecza trzeciej, i nie miala jak zgadnac, ktora zostala
 * przepisana z oryginalu.
 *
 * ⚠️ TO JEST WYLACZNIE FORMATOWANIE NAPISU — zadnej arytmetyki, zadnego `Number` w wyniku
 * (niezmiennik 4.5). Ogon zer przycinamy tylko PONIZEJ dwoch miejsc („0,4550" → „0,455",
 * „19,9900" → „19,99"), a krotsza kwote dopelniamy do dwoch („5" → „5,00"), zeby kolumna
 * kwot na wydruku nie mieszala „5" z „5,00". Wartosc, ktora nie jest liczba, idzie DOSLOWNIE
 * — tak samo jak w `kwota()`, bo to jest wizualizacja cudzego dokumentu.
 *
 * ⚠️ GRUPOWANIA TYSIECY NIE MA — ani tutaj, ani w `kwota()` wyzej, i to jest ta sama zasada
 * w obu miejscach: na jednej kartce nie moga stac dwa rozne zapisy tej samej liczby.
 */
function kwotaDokladna(surowa, waluta = '') {
  const tekst = napis(surowa);
  if (tekst === '') return '';
  if (!LICZBA_KWOTY.test(tekst)) return tekst;
  const [calosc, ulamek = ''] = tekst.split('.');
  const przyciety = ulamek.length > 2 ? ulamek.replace(/0+$/, '') : ulamek;
  const miejsca = przyciety.padEnd(2, '0');
  const zlotowki = `${calosc},${miejsca}`;
  return waluta ? `${zlotowki} ${waluta}` : zlotowki;
}

// Naglowek sekcji: szary prostokat + kapitaliki zlozone z dwoch napisow na wspolnej linii
// bazowej (pdfkit nie ma kapitalikow). Identyczne z proforma-pdf.js i specyfikacja-pdf.js.
function naglowekSekcji(doc, x, y, tekst) {
  const DUZA = 11;
  const MALA = 8.5;
  doc.rect(x, y + 4, 24, 5).fillColor(SZARY_PASEK).fill();
  const t = String(tekst);
  zwykly(doc, DUZA).text(t.slice(0, 1).toUpperCase(), x + 30, y, { lineBreak: false });
  const szerPierwszej = doc.widthOfString(t.slice(0, 1).toUpperCase());
  zwykly(doc, MALA).text(
    t.slice(1).toUpperCase(),
    x + 30 + szerPierwszej,
    y + (DUZA - MALA) * 0.72,
    { lineBreak: false },
  );
  return y + DUZA + 7;
}

/**
 * Blok sekcji — naglowek i lista gotowych linii. Linia moze sie zawinac (nazwa sprzedawcy
 * potrafi byc dluga) i wtedy nastepna idzie o ZMIERZONA wysokosc nizej, a nie o staly skok.
 */
function blokSekcja(doc, x, y, szerokosc, tytul, linieTekstu, { pierwszaGruba = false } = {}) {
  let biezace = naglowekSekcji(doc, x, y, tytul);
  linieTekstu.forEach((l, i) => {
    if (i === 0 && pierwszaGruba) gruby(doc, 9); else zwykly(doc, 8.5);
    doc.text(l, x, biezace, { width: szerokosc });
    biezace += Math.max(doc.heightOfString(l, { width: szerokosc }), 11) + 1;
  });
  return biezace;
}

/**
 * Para „etykieta: wartosc" w jednej linii siatki. Etykieta szara i waska, wartosc czarna
 * i zawijalna — numer KSeF ma 35 znakow i musi sie zmiescic w CALOSCI (patrz nizej).
 *
 * ⚠️⚠️ ETYKIETY IDA Z `lineBreak: false`, wiec dluzsza niz kolumna NIE ZAWIJA SIE — rysuje
 * sie WPROST NA WARTOSCI OBOK (ta sama pulapka, co przy `komorka()`). `lamanaEtykieta`
 * pozwala jej sie zlamac w SWOJEJ kolumnie i podnosi wysokosc wiersza o zmierzona roznice.
 *
 * ⚠️ KOLUMNA ETYKIETY MA 92 PKT I MA TAKA ZOSTAC — poszerzenie jej dla jednego wiersza
 * bylo pierwsza proba i ZEPSULO wydruk z archiwum: `DataWytworzeniaFa` ELMAS-a to
 * „2026-08-26 14:45:58.8768733+02:00", czyli 162,5 pkt ZMIERZONE, a na wartosc zostaje
 * dokladnie 163,3 pkt. Kazdy punkt zabrany tej kolumnie lamie znacznik czasu w polowie
 * ulamka sekundy. Etykieta lamie sie taniej niz wartosc.
 */
function para(doc, x, y, szerCalosci, etykieta, wartosc, { mocna = false, lamanaEtykieta = false } = {}) {
  const SZER_ETYKIETY = 92;
  const tekst = napis(wartosc);
  if (tekst === '') return y;
  zwykly(doc, 8, SZARY_TEKST)
    .text(etykieta, x, y, { width: SZER_ETYKIETY, lineBreak: lamanaEtykieta });
  // Wysokosc etykiety mierzona PRZY JEJ WLASNYM ROZMIARZE (8 pkt) — czyli tutaj, zanim
  // ponizej ustawimy font wartosci.
  const wysEtykiety = lamanaEtykieta ? doc.heightOfString(etykieta, { width: SZER_ETYKIETY }) : 0;
  const szerWartosci = szerCalosci - SZER_ETYKIETY;
  if (mocna) gruby(doc, 8.5); else zwykly(doc, 8.5);
  doc.text(tekst, x + SZER_ETYKIETY, y, { width: szerWartosci });
  return y + Math.max(doc.heightOfString(tekst, { width: szerWartosci }), wysEtykiety, 11) + 1.5;
}

/**
 * Komorka tabeli — JEDNA LINIA, zawsze. Wyrownanie liczone samemu i `text()` BEZ `width`,
 * bo pdfkit z podanym `width` lamie tekst NAWET przy `lineBreak: false` (zmierzone
 * w proforma-pdf.js — patrz tam komentarz przy `komorka()`).
 */
function komorka(doc, tekst, kol, y) {
  const t = String(tekst ?? '');
  const szer = doc.widthOfString(t);
  const x = kol.align === 'right' ? kol.x + kol.w - szer : kol.x;
  doc.text(t, x, y, { lineBreak: false });
}

const NAGLOWKI_TABELI = [
  ['Lp.', KOLUMNY.lp],
  ['Nazwa towaru/usługi', KOLUMNY.nazwa],
  ['Ilość', KOLUMNY.ilosc],
  ['J.m.', KOLUMNY.jm],
  ['Cena netto', KOLUMNY.cena],
  ['Wartość netto', KOLUMNY.netto],
  ['Stawka', KOLUMNY.stawka],
  ['Kwota VAT', KOLUMNY.vat],
  ['Wartość brutto', KOLUMNY.brutto],
];

/**
 * Naglowek tabeli pozycji, rysowany od nowa na KAZDEJ stronie — inaczej strona druga jest gola
 * lista liczb bez informacji, ktora kolumna jest cena, a ktora wartoscia. Napisy dosuniete do
 * dolu, a wysokosc bloku z najwyzszego z nich: czesc naglowkow jest szersza niz swoja kolumna
 * i lamie sie na dwie linie (tak samo jak w proformie), wiec bez tego druga linia wychodzila
 * pod kreske, w pierwszy wiersz tabeli.
 */
function naglowekTabeli(doc, y) {
  gruby(doc, 7.5);
  const wysokosci = NAGLOWKI_TABELI.map(([t, kol]) => doc.heightOfString(t, { width: kol.w }));
  const wysBloku = Math.max(...wysokosci);
  NAGLOWKI_TABELI.forEach(([t, kol], i) => {
    doc.text(t, kol.x, y + wysBloku - wysokosci[i], { width: kol.w, align: kol.align });
  });
  const dol = y + wysBloku + 3;
  linia(doc, dol);
  return dol + 5;
}

/** Wysokosc, jaka zajmie wiersz pozycji — liczona PRZED narysowaniem (patrz lamanie stron). */
function wysokoscPozycji(doc, pozycja) {
  zwykly(doc, 8);
  const nazwa = napis(pozycja?.nazwa);
  return Math.max(doc.heightOfString(nazwa, { width: KOLUMNY.nazwa.w }), 10) + 8;
}

function wierszPozycji(doc, y, pozycja, lp) {
  const nazwa = napis(pozycja?.nazwa);
  const wys = wysokoscPozycji(doc, pozycja);

  if (lp % 2 === 1) {
    doc.rect(L, y - 3, R - L, wys).fillColor(SZARY_WIERSZ).fill();
  }

  zwykly(doc, 8);
  // ⚠️ W KOLUMNIE „Lp." STOI POZYCJA W TABELI, A NIE `NrWierszaFa` Z DOKUMENTU — i to jest
  // POPRAWKA PO OBEJRZENIU WYDRUKU (03.09.2026), nie uproszczenie. OVH numeruje wiersze
  // wlasnymi identyfikatorami (`36228820`), a `komorka()` rysuje BEZ `width`: osmiocyfrowy
  // numer wychodzil z 16-punktowej kolumny wprost NA NAZWE TOWARU i nakladal sie na nia
  // literami. Numeracja wystawcy nie ginie — idzie w uwadze pod tabela (patrz `uwagiPozycji`),
  // czyli w miejscu, gdzie ma tyle miejsca, ile potrzebuje.
  komorka(doc, `${lp}.`, KOLUMNY.lp, y);
  doc.text(nazwa, KOLUMNY.nazwa.x, y, { width: KOLUMNY.nazwa.w, align: 'left' });
  komorka(doc, napis(pozycja?.ilosc), KOLUMNY.ilosc, y);
  komorka(doc, napis(pozycja?.jednostka), KOLUMNY.jm, y);
  // ⚠️ W KOLUMNIE „Cena netto" STOI WYLACZNIE CENA NETTO — i to jest POPRAWKA PO RECENZJI
  // (03.09.2026). Wczesniej brak `P_9A` wpisywal tu cene BRUTTO (`P_9B`, tak wystawia Comarch
  // ERP Optima) z dopiskiem „br.": kwota brutto stala pod naglowkiem mowiacym „netto", a caly
  // dopisek mial dziewiec punktow szerokosci. Cena brutto nie ginie — idzie w uwage pod tabela
  // (patrz `uwagiPozycji`), gdzie ma miejsce na pelne slowo „brutto". Dopisanie go TUTAJ nie
  // wchodzi w gre: „19,99 (brutto)" ma 56 pkt ZMIERZONE, a kolumna 50 — wyjechaloby na J.m.
  //
  // ⚠️ KWOTY PRZY POZYCJI IDA PRZEZ `kwotaDokladna()`, NIE PRZEZ `kwota()` — bo tylko one
  // moga miec w FA(3) wiecej niz dwa miejsca po przecinku (patrz komentarz przy tej funkcji).
  // Kwoty PODSUMOWANIA (tabela stawek, blok „Razem") zostaja przy `kwota()`: przychodza
  // z pol dwumiejscowych i z metadanych KSeF, wiec dokladnosc nie ma tam czego uratowac.
  komorka(doc, kwotaDokladna(pozycja?.cenaNetto), KOLUMNY.cena, y);
  komorka(doc, kwotaDokladna(pozycja?.wartoscNetto), KOLUMNY.netto, y);
  komorka(doc, napis(pozycja?.stawkaVat), KOLUMNY.stawka, y);
  komorka(doc, kwotaDokladna(pozycja?.kwotaVat), KOLUMNY.vat, y);
  gruby(doc, 8);
  // ⚠️ BEZ WALUTY PRZY KAZDEJ POZYCJI, i to nie jest oszczednosc miejsca „na oko": kolumna ma
  // 93 pkt, a „123456,78 PLN" pogrubione nie zawinie sie (`komorka()` rysuje BEZ `width`),
  // tylko wyjdzie w LEWO, wprost na kolumne VAT-u. Waluta dokumentu stoi w metryczce i przy
  // kazdej kwocie podsumowania, wiec nic sie nie gubi.
  const brutto = kwotaDokladna(pozycja?.wartoscBrutto);
  komorka(doc, brutto && pozycja?.bruttoWyliczone ? `${brutto} *` : brutto, KOLUMNY.brutto, y);

  return y + wys;
}

/**
 * Stopka BIEZACEJ strony. Dolny margines zerujemy na czas pisania, bo pdfkit na tekst ponizej
 * marginesu odpowiada… dolozeniem kolejnej strony (ten sam trik, co w proforma-pdf.js).
 *
 * ⚠️ TU STALO ZDANIE ODROZNIAJACE WIZUALIZACJE OD DOKUMENTU, NA KAZDEJ STRONIE — decyzja
 * wlasciciela z 03.09.2026 je zdjela (uzasadnienie przy dawnej definicji `NAPIS_ODROZNIAJACY`
 * powyzej w pliku). NIE PRZYWRACAC bez nowej decyzji wlasciciela.
 */
function stopka(doc, nrStrony, ileStron) {
  const dolny = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  zwykly(doc, 8, SZARY_TEKST).text(
    'Wyrysowana w panelu zamówień z pliku pobranego z KSeF.',
    L, doc.page.height - 36, { width: R - L, lineBreak: false },
  );
  if (ileStron > 1) {
    zwykly(doc, 8, SZARY_TEKST).text(`Strona ${nrStrony} z ${ileStron}`, L, doc.page.height - 36, {
      width: R - L, align: 'right', lineBreak: false,
    });
  }
  doc.page.margins.bottom = dolny;
}

/**
 * Stopka na KAZDEJ stronie — przebieg po stronach, ktore NAPRAWDE POWSTALY, a nie wywolanie
 * po kazdym `addPage()`. Ta sama konstrukcja, co w specyfikacja-pdf.js i z tego samego powodu:
 * przy wywolaniu „recznym" nowe miejsce lamania strony zostaje bez stopki i nikt tego nie widzi,
 * dopoki kartka nie trafi do ksiegowosci. Stad `bufferPages: true` przy tworzeniu dokumentu.
 */
function stopkaNaKazdejStronie(doc) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    stopka(doc, i - start + 1, count);
  }
}

/**
 * Bajty gotowego dokumentu. `doc.end()` sklada caly plik (lacznie z osadzeniem podzbioru fontu)
 * w jednym, synchronicznym przebiegu i wypycha go do bufora strumienia, wiec wystarczy go
 * oproznic `read()`-em. Stopke stemplujemy TUTAJ — po narysowaniu calej tresci, przed `end()`.
 */
function bajty(doc) {
  stopkaNaKazdejStronie(doc);
  doc.end();
  const kawalki = [];
  for (let k = doc.read(); k !== null; k = doc.read()) kawalki.push(k);
  return Buffer.concat(kawalki);
}

/**
 * Wiersz identyfikujacy na STRONIE KONTYNUACJI: co to za dokument, ktorej faktury dotyczy
 * i ktora to strona. Bez niego strona druga to gola lista pozycji i kwot — wypadnie z pliku
 * i nie ma po czym poznac, do ktorej faktury nalezy (ta sama lekcja, co przy specyfikacji).
 */
function wierszKontynuacji(doc, wiersz, nrStrony) {
  const y = MARGINES;
  gruby(doc, 9).text(
    `Wizualizacja faktury nr ${napis(wiersz?.numer_dokumentu)} — str. ${nrStrony}`,
    L, y, { width: R - L, lineBreak: false },
  );
  linia(doc, y + 13);
  return y + 20;
}

/**
 * Uwagi pod tabela pozycji — gotowe zdania, w kolejnosci wydruku. Puste, gdy nie ma o czym
 * mowic: naglowek „Uwagi" nad pustka bylby informacja, ze cos przepadlo.
 */
function uwagiPozycji(pozycje) {
  const opisy = [];
  const zNumeracja = pozycje
    .map((p, i) => ({ poz: i + 1, lp: napis(p?.lp) }))
    .filter((p) => p.lp !== '' && p.lp !== String(p.poz));
  if (zNumeracja.length > 0) {
    opisy.push(`Numeracja pozycji u wystawcy: ${zNumeracja
      .map((p) => `${p.poz} → ${p.lp}`).join('; ')}`);
  }
  const zData = pozycje
    .map((p, i) => ({ poz: i + 1, data: napis(p?.dataDostawy) }))
    .filter((p) => p.data !== '');
  if (zData.length > 0) {
    opisy.push(`Data dostawy przy pozycjach: ${zData
      .map((p) => `${p.poz} — ${p.data}`).join('; ')}`);
  }
  const zRabatem = pozycje
    .map((p, i) => ({ poz: i + 1, rabat: kwotaDokladna(p?.rabat) }))
    .filter((p) => p.rabat !== '');
  if (zRabatem.length > 0) {
    opisy.push(`Rabat przy pozycjach: ${zRabatem
      .map((p) => `${p.poz} — ${p.rabat}`).join('; ')}`);
  }
  // Cena jednostkowa BRUTTO (`P_9B`) — wylacznie tam, gdzie wystawca NIE PODAL ceny netto.
  // Slowo „brutto" musi stac przy kwocie: bez niego liczba pod naglowkiem „Cena netto" byla
  // po prostu nieprawda (patrz komentarz przy kolumnie ceny w `wierszPozycji`).
  const zCenaBrutto = pozycje
    .map((p, i) => ({
      poz: i + 1, netto: napis(p?.cenaNetto), cena: kwotaDokladna(p?.cenaBrutto),
    }))
    .filter((p) => p.netto === '' && p.cena !== '');
  if (zCenaBrutto.length > 0) {
    opisy.push(`Cena jedn. brutto przy pozycjach: ${zCenaBrutto
      .map((p) => `${p.poz} — ${p.cena}`).join('; ')}`);
  }
  return opisy;
}

/** Dolna granica tresci — z rezerwa na dwuliniowa stopke. */
const dolnaGranica = (doc) => doc.page.height - MARGINES - 30;

/**
 * Miejsce na blok o zadanej wysokosci: albo biezace `y`, albo gora nowej strony.
 *
 * ⚠️ LAMIEMY PRZED BLOKIEM, NIE PO NIM. `komorka()` rysuje bez `width`, wiec sama granicy
 * strony nie sprawdzi i po cichu napisze poza arkuszem (mechanizm przeniesiony 1:1
 * z proforma-pdf.js i specyfikacja-pdf.js).
 */
function miejsceNa(doc, stan, wiersz, y, potrzeba) {
  if (y + potrzeba <= dolnaGranica(doc)) return y;
  doc.addPage();
  stan.strona += 1;
  return wierszKontynuacji(doc, wiersz, stan.strona);
}

/** Data w postaci samego dnia — `data_wystawienia` z bazy potrafi niesc znacznik czasu. */
const dzien = (co) => napis(co).slice(0, 10);

/**
 * Wizualizacja faktury kosztowej z KSeF jako gotowy PDF.
 *
 * Wejscie (wszystko gotowe, ten modul TYLKO RYSUJE):
 *   `wiersz`   — SUROWY wiersz tabeli `koszty` (kolumny snake_case: `numer_dokumentu`,
 *                `sprzedawca_nazwa`, `sprzedawca_nip`, `data_wystawienia`, `netto`, `vat`,
 *                `brutto`, `waluta`, `rodzaj`, `ksef_number`) — ten sam ksztalt, ktory oddaje
 *                `kosztyMiesiaca` (db/koszty.js) i ktory bierze `zarchiwizuj`. Kwoty NAPISAMI.
 *   `dokument` — wynik `dokumentZXml` (domain/koszt-xml.js): komplet elementow art. 106e
 *                z oryginalnego XML-a, gotowy do wydruku.
 *   `pozycje`  — pozycje do tabeli; domyslnie te z `dokument`. Osobny parametr zostaje dla
 *                wolajacych, ktorzy maja same pozycje (`pozycjeZXml`) — i dla testow ukladu.
 *
 * ⚠️ BRAK `dokument` TO POPRAWNE WEJSCIE, a nie powod do odmowy: kartka powstaje wtedy
 * z samych metadanych KSeF (sprzedawca, numer, daty, kwoty), bo tyle panel wie na pewno.
 * ⚠️ PUSTA LISTA POZYCJI TAK SAMO — dokument mowi wtedy wprost, ze pozycji w XML-u nie bylo.
 */
export async function zbudujKosztPdf({ wiersz = {}, dokument = null, pozycje } = {}) {
  const doc = new PDFDocument({
    size: 'A4',
    // Strony trzymane w pamieci do `end()` — patrz `stopkaNaKazdejStronie`.
    bufferPages: true,
    margins: {
      top: MARGINES, bottom: MARGINES, left: MARGINES, right: MARGINES,
    },
    info: {
      Title: `Wizualizacja faktury ${napis(wiersz.numer_dokumentu)}`.trim(),
      Author: napis(wiersz.sprzedawca_nazwa) || 'OMS',
    },
  });
  for (const [nazwa, plik] of Object.entries(PLIKI_FONTOW)) doc.registerFont(nazwa, plik);
  doc.font(FONT);

  const stan = { strona: 1 };
  const d = dokument ?? {};
  const listaPozycji = pozycje ?? d.pozycje ?? [];
  const waluta = napis(d.waluta) || napis(wiersz.waluta);

  // ── 1. Tytul i metryczka ──────────────────────────────────────────────────
  // ⚠️ TYTUL BRZMI JAK NA FAKTURZE („e-Faktura"), bo o parytet z wydrukiem inFaktu prosil
  // wlasciciel. Do 03.09.2026 ZARAZ POD NIM stalo zdanie odrozniajace wizualizacje od
  // dokumentu — decyzja wlasciciela z tego samego dnia je zdjela (uzasadnienie przy dawnej
  // definicji `NAPIS_ODROZNIAJACY` na poczatku pliku). NIE PRZYWRACAC bez nowej decyzji
  // wlasciciela.
  let y = MARGINES;
  gruby(doc, 17).text(d.czyKorekta ? 'e-Faktura korygująca' : 'e-Faktura', L, y, {
    width: SZER_LEWEJ, lineBreak: false,
  });
  y += 22;
  const dolTytulu = y + 4;

  // Metryczka po prawej. Numer KSeF stoi W CALOSCI — jest JEDYNYM identyfikatorem, ktory laczy
  // te kartke z oryginalem w systemie Ministerstwa, wiec nie ma prawa byc skrocony.
  const szerMetryczki = R - PRAWA_KOLUMNA;
  let yM = MARGINES;
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Numer', napis(wiersz.numer_dokumentu) || d.numer, { mocna: true });
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Numer KSeF', wiersz.ksef_number);
  // `DataWytworzeniaFa` — moment zlozenia dokumentu przez wystawce. Stoi tez na wydruku
  // z inFaktu, ktory byl wzorem tego ukladu, a przy sporze o termin bywa jedyna godzina,
  // jaka na dokumencie w ogole jest. „T" ze znacznika ISO zamieniamy na spacje — to jedyna
  // typografia w tym module, a nie odczyt schemy (patrz naglowek pliku).
  //
  // ⚠️⚠️ ETYKIETA MOWI „SYSTEM WYSTAWCY", A NIE „W KSeF" — poprawka po drugiej recenzji
  // (03.09.2026). `DataWytworzeniaFa` jest znacznikiem czasu PROGRAMU WYSTAWCY, ustawianym
  // zanim dokument w ogole pojedzie do Ministerstwa; moment przyjecia przez KSeF stoi
  // w numerze KSeF, w wierszu wyzej. Stara etykieta przypisywala KSeF-owi godzine, ktorej
  // KSeF nie nadal — czyli mowila o cudzym dokumencie cos, czego dokument nie mowi.
  //
  // ⚠️ ETYKIETA LAMIE SIE NA DWIE LINIE („Data wytworzenia" / „(system wystawcy)") — ma
  // 151,5 pkt przy kolumnie 92 pkt. Lamie sie ETYKIETA, a nie wartosc: patrz `para()`.
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Data wytworzenia (system wystawcy)',
    napis(d.dataWytworzenia).replace('T', ' '), { lamanaEtykieta: true });
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Data wystawienia', d.dataWystawienia || dzien(wiersz.data_wystawienia));
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Miejsce wystawienia', d.miejsceWystawienia);
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Data sprzedaży', d.dataSprzedazy);
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Okres rozliczeniowy',
    d.okresOd || d.okresDo ? `${napis(d.okresOd)} – ${napis(d.okresDo)}` : '');
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Rodzaj', d.rodzajOpis || napis(wiersz.rodzaj));
  yM = para(doc, PRAWA_KOLUMNA, yM, szerMetryczki, 'Waluta', waluta);

  y = Math.max(dolTytulu, yM) + 8;
  linia(doc, y);
  y += 12;

  // ── 2. Sprzedawca i nabywca ───────────────────────────────────────────────
  // ⚠️ NABYWCA JEST OBOWIAZKOWYM ELEMENTEM FAKTURY (art. 106e ust. 1 pkt 3) i do 03.09.2026
  // NIE BYLO GO NA TEJ KARTCE. Powod byl dobry — wiersz tabeli `koszty` danych nabywcy nie
  // niesie, a dopisanie ich „z konfiguracji" byloby wstawieniem do cudzego dokumentu tresci,
  // ktorej nikt nie sprawdzil. Rozwiazanie NIE ZNOSI tej zasady: nabywca idzie WYLACZNIE
  // z `Podmiot2` oryginalnego XML-a, a gdy dokumentu nie ma — pole zostaje puste.
  const linieSprzedawcy = [
    napis(d.sprzedawca?.nazwa) || napis(wiersz.sprzedawca_nazwa),
    ...(d.sprzedawca?.adres ?? []),
    napis(d.sprzedawca?.identyfikator)
      || (napis(wiersz.sprzedawca_nip) ? `NIP: ${napis(wiersz.sprzedawca_nip)}` : ''),
  ].filter((s) => s !== '');
  const linieNabywcy = [
    napis(d.nabywca?.nazwa),
    ...(d.nabywca?.adres ?? []),
    napis(d.nabywca?.identyfikator),
  ].filter((s) => s !== '');
  if (linieNabywcy.length === 0) {
    linieNabywcy.push('Danych nabywcy nie ma w tym dokumencie.');
  }

  const dolSprzedawcy = blokSekcja(doc, L, y, SZER_LEWEJ, 'Sprzedawca', linieSprzedawcy, { pierwszaGruba: true });
  const dolNabywcy = blokSekcja(doc, PRAWA_KOLUMNA, y, szerMetryczki, 'Nabywca', linieNabywcy, { pierwszaGruba: true });
  y = Math.max(dolSprzedawcy, dolNabywcy) + 12;

  // ── 3. Platnosc ───────────────────────────────────────────────────────────
  // ⚠️⚠️ KARTKA MOWI O ZAPLACIE TYLKO TYLE, ILE MOWI XML — poprawka po recenzji (03.09.2026).
  // Przedtem kazdy dokument bez `Zaplacono` dostawal napis „Nie zapłacono", bo `zaplacono`
  // bylo dwustanowe. To bylo WSTAWIENIE W CUDZY DOKUMENT faktu, ktorego wystawca tam nie
  // napisal — a ksiegowa czyta te kartke zamiast XML-a. Dzis sa trzy stany (patrz
  // `platnoscZFa` w domain/koszt-xml.js), a blok bez ANI JEDNEGO pola w ogole nie powstaje:
  // naglowek „Płatność" nad pustka tez jest zdaniem, tylko trudniejszym do zauwazenia.
  const p = d.platnosc ?? {};
  const czesciowe = p.zaplatyCzesciowe ?? [];
  // Dokument MOWI o zaplacie czesciowej, gdy niesie wplaty albo sam znacznik `= 1`.
  const maCzesciowa = czesciowe.length > 0 || p.czesciowa === true;
  const maCoPowiedziec = p.zaplacono === true || p.zaplacono === false
    || maCzesciowa
    || [p.dataZaplaty, p.termin, p.forma, p.opis, p.rachunek].some((s) => napis(s) !== '');
  if (dokument && maCoPowiedziec) {
    let status;
    if (p.zaplacono === true) {
      status = `Zapłacono${napis(p.dataZaplaty) ? ` — ${napis(p.dataZaplaty)}` : ''}`;
    } else if (p.zaplacono === false) {
      status = 'Nie zapłacono';
    } else if (maCzesciowa) {
      // ⚠️⚠️ STATUS MUSI ZGADZAC SIE Z KWOTAMI STOJACYMI POD NIM — poprawka po drugiej
      // recenzji (03.09.2026). FA(3) przy zaplacie czesciowej zwykle NIE NIESIE `Zaplacono`
      // (bo faktura nie jest zaplacona w calosci), tylko `ZnacznikZaplatyCzesciowej`
      // i bloki `ZaplataCzesciowa`. Kartka pisala wtedy „Status: dokument nie zawiera
      // informacji o zaplacie" DOKLADNIE NAD lista wplat, ktore wystawca na dokumencie
      // potwierdzil — dwa sasiednie zdania, z ktorych jedno przeczy drugiemu.
      status = 'Zapłacono częściowo';
    } else {
      status = 'dokument nie zawiera informacji o zapłacie';
    }
    // Zaplata czesciowa jest NIEZALEZNA od `Zaplacono` — FA(3) pozwala oznaczyc raty na
    // fakturze, ktora statusu zaplaty w ogole nie niesie. Wplat bywa kilka i ida wszystkie.
    let czesciowaTekst = '';
    if (czesciowe.length > 0) {
      czesciowaTekst = czesciowe
        .map((z) => {
          const k = kwota(z?.kwota, waluta);
          const data = napis(z?.data);
          if (k === '') return data;
          return data ? `${k} (${data})` : k;
        })
        .filter((s) => s !== '')
        .join('; ');
    } else if (p.czesciowa === true && status !== 'Zapłacono częściowo') {
      // Sam znacznik bez kwot — wiersz ma sens TYLKO wtedy, gdy status mowi co innego
      // (`Zaplacono` = 1 albo 2 przy podniesionym znaczniku). Gdy status juz brzmi
      // „Zaplacono czesciowo", zdanie „Zaplacono czesciowo: tak" powtarzaloby je slowo
      // w slowo — a kazde zdanie na tej kartce ma cos wnosic.
      czesciowaTekst = 'tak — dokument nie podaje kwoty';
    }

    // ⚠️ STATUS IDZIE PELNA SZEROKOSCIA, nie jako para „etykieta: wartosc" w lewej kolumnie.
    // Zdanie „dokument nie zawiera informacji o zapłacie" ma 193 punkty, a kolumna na wartosc
    // 153 — w parze lamalo sie na „…informacji o" / „zapłacie", z numerem rachunku wcisnietym
    // miedzy obie polowki. Zdanie o tym, czy faktura jest zaplacona, ma sie czytac za jednym
    // spojrzeniem, a nie skladac z kawalkow rozrzuconych miedzy kolumnami.
    let yStart = naglowekSekcji(doc, L, y, 'Płatność');
    const zdanieStatusu = `Status: ${status}`;
    zwykly(doc, 8.5);
    doc.text(zdanieStatusu, L, yStart, { width: R - L });
    yStart += doc.heightOfString(zdanieStatusu, { width: R - L }) + 3;

    let yL = yStart;
    yL = para(doc, L, yL, SZER_LEWEJ, 'Sposób zapłaty', p.forma);
    yL = para(doc, L, yL, SZER_LEWEJ, 'Termin zapłaty', p.termin);
    let yP = yStart;
    yP = para(doc, PRAWA_KOLUMNA, yP, szerMetryczki, 'Rachunek', p.rachunek);
    yP = para(doc, PRAWA_KOLUMNA, yP, szerMetryczki, 'Uwagi wystawcy', p.opis);
    y = Math.max(yL, yP);

    // ⚠️ RATY IDA PELNA SZEROKOSCIA, POD OBIEMA KOLUMNAMI — nie jako para „etykieta: wartosc".
    // Trzy wplaty z kwota i data to ponad 200 punktow, a kolumna na wartosc ma 153: w parze
    // lista lamalaby sie w srodku kwoty i ostatnia rata wygladalaby na osobne zdanie.
    if (czesciowaTekst !== '') {
      const tekst = `Zapłacono częściowo: ${czesciowaTekst}`;
      zwykly(doc, 8);
      y += 2;
      doc.text(tekst, L, y, { width: R - L });
      y += doc.heightOfString(tekst, { width: R - L });
    }
    y += 10;
  }

  // ── 4. Dokument korygowany ────────────────────────────────────────────────
  if (d.korekta) {
    const yStart = naglowekSekcji(doc, L, y, 'Dokument korygowany');
    let yK = yStart;
    yK = para(doc, L, yK, SZER_LEWEJ, 'Numer faktury', d.korekta.numer);
    yK = para(doc, L, yK, SZER_LEWEJ, 'Data wystawienia', d.korekta.data);
    let yKP = yStart;
    yKP = para(doc, PRAWA_KOLUMNA, yKP, szerMetryczki, 'Numer KSeF', d.korekta.ksef);
    yKP = para(doc, PRAWA_KOLUMNA, yKP, szerMetryczki, 'Przyczyna korekty', d.korekta.przyczyna);
    y = Math.max(yK, yKP);

    // ⚠️ `TypKorekty` ROZSTRZYGA MIESIAC UJECIA korekty w ksiegach — i do 03.09.2026 nie bylo
    // go na kartce w ogole. Opis idzie PELNA SZEROKOSCIA, bo zdanie ma 290 punktow (zmierzone)
    // i w kolumnie na wartosc (153 pkt) lamaloby sie w polowie na dwie linie.
    if (napis(d.korekta.typOpis) !== '') {
      const tekst = `Typ korekty: ${napis(d.korekta.typOpis)}`;
      zwykly(doc, 8);
      y += 2;
      doc.text(tekst, L, y, { width: R - L });
      y += doc.heightOfString(tekst, { width: R - L });
    }
    y += 10;
  }

  // ── 5. Pozycje ────────────────────────────────────────────────────────────
  y = naglowekSekcji(doc, L, y, 'Pozycje') + 6;
  y = naglowekTabeli(doc, y);

  if (listaPozycji.length === 0) {
    // ⚠️ PUSTA TABELA WYGLADA JAK BLAD WYDRUKU, a nie jak informacja. Zdanie stoi w JEDNYM
    // wywolaniu bez zawijania, zeby dalo sie je odczytac z powrotem w calosci.
    zwykly(doc, 8.5, SZARY_TEKST).text(
      'XML z KSeF nie zawiera pozycji — kwoty poniżej pochodzą z metadanych dokumentu.',
      L, y, { width: R - L, lineBreak: false },
    );
    y += 18;
  }
  listaPozycji.forEach((p, i) => {
    const przed = y;
    y = miejsceNa(doc, stan, wiersz, y, wysokoscPozycji(doc, p));
    if (y !== przed) y = naglowekTabeli(doc, y);
    y = wierszPozycji(doc, y, p, i + 1);
  });

  // ⚠️ UWAGI POD TABELA, A NIE KOLEJNE KOLUMNY. Data dostawy przy pozycji (`P_6A`), rabat
  // (`P_10`) i wlasna numeracja wystawcy (`NrWierszaFa`) sa elementami dokumentu i musza byc
  // widoczne — ale kazde z nich pojawia sie na garstce faktur, a siatka dziewieciu kolumn na
  // A4 jest juz pelna. Trzy dodatkowe kolumny zwezilyby nazwe towaru na KAZDEJ fakturze po to,
  // zeby na jednej na dwadziescia cos w nich stalo.
  // ⚠️⚠️ REZERWA JEST ZMIERZONA, A NIE PRZYJETA — poprawka po recenzji (03.09.2026). Wczesniej
  // kazda uwaga rezerwowala 22 punkty niezaleznie od tego, ile naprawde zajmie. Numeracja
  // wystawcy przy 66 pozycjach (OVH) to OSIEM LINII: `miejsceNa` przepuszczalo ja przy dolnej
  // krawedzi, a tekst rysowal sie WPROST NA STOPCE — litery uwagi nachodzily na zdanie
  // odrozniajace wizualizacje od faktury. ODCZYT POWROTNY to widzi, sprawdzenie bufora nie.
  for (const opis of uwagiPozycji(listaPozycji)) {
    zwykly(doc, 7.5, SZARY_TEKST);
    const wysUwagi = doc.heightOfString(opis, { width: R - L });
    y = miejsceNa(doc, stan, wiersz, y + 3, wysUwagi);
    zwykly(doc, 7.5, SZARY_TEKST).text(opis, L, y, { width: R - L });
    y += wysUwagi + 2;
  }

  // ── 6. Podsumowanie VAT wg stawek + sumy dokumentu ────────────────────────
  // Trzymane RAZEM na jednej stronie: kwota oderwana od pozycji, z ktorych wyszla, to kwota
  // bez podstawy (ta sama zasada, co przy tabeli VAT w proformie).
  const stawki = d.stawki ?? [];
  // ⚠️ WIERSZ `P_14_xW` („VAT przeliczony na złote") TEZ ZAJMUJE MIEJSCE — a rezerwa go nie
  // liczyla. Na fakturze Allegro w EUR z trzema stawkami to trzydziesci punktow, o ktore blok
  // sum wjezdzal w stopke. Tak samo nota o dwoch walutach pod sumami.
  const wierszeVatPln = stawki.filter((s) => napis(s?.vatPln) !== '').length;
  const obcaWaluta = waluta !== '' && waluta !== 'PLN';
  // ⚠️ REZERWA NA NOTE O DWOCH WALUTACH TO DWIE LINIE, NIE JEDNA: po przeredagowaniu
  // (03.09.2026) nota ma 190 znakow i przy 7 pkt lamie sie na dwie linie pelnej szerokosci.
  const potrzeba = 18 + stawki.length * 13 + wierszeVatPln * 10
    + 4 * 16 + 24 + (obcaWaluta ? 32 : 0);
  y = miejsceNa(doc, stan, wiersz, y + 10, potrzeba);
  linia(doc, y);
  y += 8;

  if (stawki.length > 0) {
    gruby(doc, 8, SZARY_TEKST);
    komorka(doc, 'W tym', STAWKI_KOL.etykieta, y);
    komorka(doc, 'Pole FA', STAWKI_KOL.pole, y);
    komorka(doc, 'Netto', STAWKI_KOL.netto, y);
    komorka(doc, 'VAT', STAWKI_KOL.vat, y);
    komorka(doc, 'Brutto *', STAWKI_KOL.brutto, y);
    y += 11;
    linia(doc, y - 2, PRAWA_KOLUMNA, R);
    stawki.forEach((s) => {
      zwykly(doc, 8);
      komorka(doc, napis(s.etykieta), STAWKI_KOL.etykieta, y);
      // ⚠️ KOD POLA FA IDZIE NA WYDRUK — patrz uzasadnienie w domain/koszt-xml.js. Czesc pol
      // jest wieloznaczna z nazwy i to jest jedyny sposob, zeby ksiegowa sprawdzila kartke
      // wobec oryginalnego XML-a, zamiast wierzyc naszej etykiecie.
      zwykly(doc, 7, SZARY_TEKST);
      komorka(doc, napis(s.kod), STAWKI_KOL.pole, y);
      zwykly(doc, 8);
      komorka(doc, kwota(s.netto), STAWKI_KOL.netto, y);
      komorka(doc, kwota(s.vat), STAWKI_KOL.vat, y);
      komorka(doc, kwota(s.brutto), STAWKI_KOL.brutto, y);
      y += 13;
      if (napis(s.vatPln) !== '') {
        zwykly(doc, 7, SZARY_TEKST).text(
          `VAT przeliczony na złote: ${kwota(s.vatPln, 'PLN')}`,
          STAWKI_KOL.etykieta.x, y - 3, { width: R - STAWKI_KOL.etykieta.x },
        );
        y += 10;
      }
    });
    y += 4;
  }

  // ⚠️ „RAZEM" TO KWOTY Z METADANYCH KSeF (tabela `koszty`), a NIE suma wierszy wyzej — to ta
  // sama trojka liczb, ktora wchodzi do sumy miesiaca na zakladce KOSZTY, wiec dokument i ekran
  // nie maja jak sie rozejsc. Suma policzona tutaj bylaby drugim zrodlem tej samej prawdy.
  //
  // ⚠️⚠️ KWOTA VAT-u IDZIE Z WALUTA „PLN" NA KAZDEJ FAKTURZE W OBCEJ WALUCIE — patrz
  // `NOTA_VAT_W_PLN` wyzej i regula przy `czyPLN` (domain/koszt-metadane.js). To nie jest
  // przeliczenie: KSeF oddaje `vatAmount` w zlotych i tak go tu przepisujemy. Doklejenie
  // do tej kwoty „EUR" bylo zdaniem o pieniadzach, ktorego nikt nie policzyl.
  const sumy = [
    ['Razem netto', wiersz.netto, waluta],
    ['Razem VAT', wiersz.vat, obcaWaluta ? 'PLN' : waluta],
    ['Razem brutto', wiersz.brutto, waluta],
  ];
  sumy.forEach(([etykieta, wartosc, walutaKwoty], i) => {
    if (i % 2 === 0) {
      doc.rect(PODSUMOWANIE.etykieta.x, y - 4, R - PODSUMOWANIE.etykieta.x, 16)
        .fillColor(SZARY_WIERSZ).fill();
    }
    zwykly(doc, 8.5);
    komorka(doc, etykieta, PODSUMOWANIE.etykieta, y);
    komorka(doc, kwota(wartosc, walutaKwoty), PODSUMOWANIE.wartosc, y);
    y += 16;
  });

  // Kwota naleznosci ogolem (`P_15`) — to ona jest na fakturze „do zapłaty". Gdy dokumentu
  // nie ma, nie zmyslamy jej z brutta: brak wiersza mowi prawde, kwota wzieta skadinad nie.
  if (napis(d.naleznoscOgolem) !== '') {
    y += 4;
    gruby(doc, 11);
    komorka(doc, 'Razem do zapłaty', PODSUMOWANIE.etykieta, y);
    komorka(doc, kwota(d.naleznoscOgolem, waluta), PODSUMOWANIE.wartosc, y);
    y += 18;
  }

  // Nota o dwoch walutach w bloku sum — tylko na fakturze w obcej walucie, bo tylko tam
  // sa dwie. Na fakturze zlotowkowej byloby to zdanie o niczym.
  if (obcaWaluta) {
    zwykly(doc, 7, SZARY_TEKST);
    const wysNoty = doc.heightOfString(NOTA_VAT_W_PLN, { width: R - L });
    y = miejsceNa(doc, stan, wiersz, y + 4, wysNoty);
    zwykly(doc, 7, SZARY_TEKST).text(NOTA_VAT_W_PLN, L, y, { width: R - L });
    y += wysNoty + 4;
  }

  // Przypis do kwot wyliczonych — tylko wtedy, gdy na kartce jakas taka kwota stoi.
  const jestWyliczone = stawki.length > 0 || listaPozycji.some((p) => p?.bruttoWyliczone);
  if (jestWyliczone) {
    zwykly(doc, 7, SZARY_TEKST);
    const wysPrzypisu = doc.heightOfString(PRZYPIS_BRUTTO, { width: R - L });
    y = miejsceNa(doc, stan, wiersz, y + 4, wysPrzypisu);
    zwykly(doc, 7, SZARY_TEKST).text(PRZYPIS_BRUTTO, L, y, { width: R - L });
    y += wysPrzypisu + 8;
  }

  // ── 7. Adnotacje ──────────────────────────────────────────────────────────
  // ⚠️ ADNOTACJE SA CZESCIA DOKUMENTU, a nie ozdobnikiem: „metoda kasowa", „samofakturowanie",
  // „odwrotne obciazenie" i „mechanizm podzielonej platnosci" ZMIENIAJA sposob zaksiegowania
  // faktury. Kartka bez nich zmuszala ksiegowa do zajrzenia do XML-a — czyli nie zastepowala go.
  const adnotacje = d.adnotacje ?? [];
  if (adnotacje.length > 0) {
    y = miejsceNa(doc, stan, wiersz, y, 24 + Math.ceil(adnotacje.length / 2) * 12 + 24);
    y = naglowekSekcji(doc, L, y, 'Adnotacje') + 4;
    const SZER_KOL = (R - L) / 2 - 10;
    const yGora = y;
    let yLewa = yGora;
    let yPrawa = yGora;
    adnotacje.forEach((a, i) => {
      const x = i % 2 === 0 ? L : L + SZER_KOL + 20;
      const yBiez = i % 2 === 0 ? yLewa : yPrawa;
      zwykly(doc, 8, SZARY_TEKST).text(napis(a.etykieta), x, yBiez, {
        width: SZER_KOL - 40, lineBreak: false,
      });
      gruby(doc, 8).text(napis(a.wartosc), x + SZER_KOL - 36, yBiez, { width: 36, lineBreak: false });
      if (i % 2 === 0) yLewa = yBiez + 12; else yPrawa = yBiez + 12;
    });
    y = Math.max(yLewa, yPrawa) + 2;

    // Podstawa zwolnienia jako POLE dokumentu — art. 106e ust. 1 pkt 19. Zdanie potrafi byc
    // dlugie („ZWOLNIENIE NA PODSTAWIE ART. 43, UST. 1, PKT 40 USTAWY O VAT"), wiec idzie
    // pelna szerokoscia, pod dwiema kolumnami.
    adnotacje.filter((a) => napis(a.podstawa) !== '').forEach((a) => {
      const tekst = `Podstawa zwolnienia: ${napis(a.podstawa)}`;
      zwykly(doc, 8);
      const wysPodstawy = doc.heightOfString(tekst, { width: R - L });
      y = miejsceNa(doc, stan, wiersz, y + 2, wysPodstawy);
      zwykly(doc, 8).text(tekst, L, y, { width: R - L });
      y += wysPodstawy + 2;
    });
  }

  return bajty(doc);
}
