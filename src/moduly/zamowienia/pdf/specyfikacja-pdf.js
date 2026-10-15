import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { bladOperatora } from '../../../domena/bledy.js';

// Generator PDF-a "Specyfikacji zamowienia" — kartka wkladana do KAZDEJ paczki. Przy
// zamowieniach firmowych zastepuje wydruk faktury (ta i tak dociera przez KSeF), przy
// indywidualnych idzie obok paragonu z kasy fiskalnej. Uklad KALKUJE proforma-pdf.js
// (te same stale formatu i te same pomocnicze zwykly()/gruby()) — klient dostanie oba
// dokumenty w tym samym roku, wiec nie maja wygladac jak z dwoch roznych firm.
//
// ⚠️ TEN MODUL TYLKO RYSUJE. Zadnego liczenia kwot, VAT-u ani skladania pozycji — wszystko
// przychodzi juz gotowe z domain/specyfikacja.js (daneSpecyfikacji, Zadanie 6). Arytmetyka
// dokumentu ma byc testowalna bez czytania PDF-a.

const KATALOG = path.dirname(fileURLToPath(import.meta.url));

// ⚠️ CICHA AWARIA, KTORA KONCZY SIE U KLIENTA. Wbudowane fonty PDF (Helvetica i spolka) NIE
// MAJA polskich znakow, a pdfkit nie protestuje — dokument powstaje bez jednego ostrzezenia,
// tylko z dziurami zamiast `l a e z s c n o z`. „Zak ad Us ug", „ ód ". Dlatego
// KAZDY napis w tym module idzie przez zwykly()/gruby() nizej, a nazwy wbudowanych fontow
// nie pojawiaja sie w tym pliku ani razu. Jedyny test, ktory zlamanie tej zasady wylapie, to
// odczyt powrotny pdftotext-em — bo Buffer wyglada tak samo w obu przypadkach.
const FONT = 'DejaVu';
const FONT_GRUBY = 'DejaVu-Bold';
const PLIKI_FONTOW = {
  [FONT]: path.join(KATALOG, 'fonty', 'DejaVuSans.ttf'),
  [FONT_GRUBY]: path.join(KATALOG, 'fonty', 'DejaVuSans-Bold.ttf'),
};

const A4_SZER = 595.28;
const MARGINES = 40;
const L = MARGINES;                 // lewa krawedz tresci
const R = A4_SZER - MARGINES;       // prawa krawedz tresci (555.28)
const PRAWA_KOLUMNA = 320;          // poczatek kolumny „NABYWCA"

const CZARNY = '#1a1a1a';
const SZARY_TEKST = '#666666';
const SZARY_PASEK = '#c9c9c9';
const SZARY_WIERSZ = '#eeeeee';
const SZARY_LINIA = '#cccccc';

// Kolumny tabeli pozycji: Symbol | Nazwa | Ilosc | Cena | Wartosc — dokladnie w tej
// kolejnosci, bo tak obiecuje wrzutka prawna wkladana dzis do paczek. Suma `x + w` ostatniej
// kolumny to dokladnie `R`, tak jak w proforma-pdf.js.
const KOLUMNY = {
  symbol: { x: L, w: 70, align: 'left' },
  nazwa: { x: 116, w: 220, align: 'left' },
  ilosc: { x: 340, w: 40, align: 'right' },
  cena: { x: 386, w: 80, align: 'right' },
  wartosc: { x: 470, w: R - 470, align: 'right' },
};

function zwykly(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT).fontSize(rozmiar).fillColor(kolor);
}

function gruby(doc, rozmiar = 9, kolor = CZARNY) {
  return doc.font(FONT_GRUBY).fontSize(rozmiar).fillColor(kolor);
}

function linia(doc, y) {
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(SZARY_LINIA).stroke();
}

// Naglowek sekcji: szary prostokat + kapitaliki zlozone z dwoch napisow na wspolnej linii
// bazowej (pdfkit nie ma kapitalikow). Identyczne z proforma-pdf.js.
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
 * Blok adresowy — naglowek sekcji + lista linii juz sformatowanych przez wolajacego.
 * Zwraca `y` pod ostatnia linia. Linie moga sie zawinac (nazwa firmy potrafi byc dluga)
 * i wtedy kolejna linia idzie o ZMIERZONA wysokosc nizej, a nie o staly skok.
 */
function blokSekcja(doc, x, y, szerokosc, tytul, linieTekstu) {
  let biezace = naglowekSekcji(doc, x, y, tytul);
  zwykly(doc, 9);
  for (const l of linieTekstu) {
    doc.text(l, x, biezace, { width: szerokosc });
    biezace += Math.max(doc.heightOfString(l, { width: szerokosc }), 12) + 1;
  }
  return biezace;
}

/**
 * Komorka tabeli — JEDNA LINIA, zawsze. Wyrownanie liczone samemu i `text()` BEZ `width`,
 * bo pdfkit z podanym `width` lamie tekst NAWET przy `lineBreak: false` (zmierzone w
 * proforma-pdf.js — patrz tam komentarz przy `komorka()`).
 */
function komorka(doc, tekst, kol, y) {
  const napis = String(tekst ?? '');
  const szer = doc.widthOfString(napis);
  const x = kol.align === 'right' ? kol.x + kol.w - szer : kol.x;
  doc.text(napis, x, y, { lineBreak: false });
}

// Kwota juz przychodzi sformatowana w zlotowkach (`daneSpecyfikacji` wola `zl()`) — tu
// dokladamy tylko walute. `null`/`undefined` (cena jednostkowa umie byc `null`, patrz
// domain/specyfikacja.js) daje pusta komorke, nie napis "null PLN".
const kwota = (napisZl) => (napisZl == null || napisZl === '' ? '' : `${napisZl} PLN`);

const NAGLOWKI_TABELI = [
  ['Symbol', KOLUMNY.symbol],
  ['Nazwa towaru', KOLUMNY.nazwa],
  ['Ilość', KOLUMNY.ilosc],
  ['Cena', KOLUMNY.cena],
  ['Wartość', KOLUMNY.wartosc],
];

function naglowekTabeli(doc, y) {
  gruby(doc, 8.5);
  NAGLOWKI_TABELI.forEach(([napis, kol]) => {
    doc.text(napis, kol.x, y, { width: kol.w, align: kol.align, lineBreak: false });
  });
  const dol = y + 14;
  linia(doc, dol);
  return dol + 6;
}

function wierszPozycji(doc, y, pozycja, lp) {
  const nazwa = String(pozycja?.nazwa ?? '');
  zwykly(doc, 9);
  const wysNazwy = doc.heightOfString(nazwa, { width: KOLUMNY.nazwa.w });
  const wys = Math.max(wysNazwy, 11) + 10;

  if (lp % 2 === 1) {
    doc.rect(L, y - 4, R - L, wys).fillColor(SZARY_WIERSZ).fill();
  }

  zwykly(doc, 9);
  komorka(doc, pozycja?.symbol, KOLUMNY.symbol, y);
  doc.text(nazwa, KOLUMNY.nazwa.x, y, { width: KOLUMNY.nazwa.w, align: 'left' });
  komorka(doc, pozycja?.ilosc, KOLUMNY.ilosc, y);
  komorka(doc, kwota(pozycja?.cenaZl), KOLUMNY.cena, y);
  gruby(doc, 9);
  komorka(doc, kwota(pozycja?.wartoscZl), KOLUMNY.wartosc, y);

  return y + wys;
}

// Stopka rysowana na BIEZACEJ stronie, w stalym miejscu przy dole. Dolny margines zerujemy
// na czas pisania, bo pdfkit na tekst ponizej marginesu odpowiada dolozeniem kolejnej strony
// (ten sam trik co w proforma-pdf.js).
//
// ⚠️ TA LINIA JEST CALA STAWKA TEGO DOKUMENTU. Bez niej kartka z pozycjami i cenami laduje w
// ksiegowosci firmy obok faktury z KSeF i zostaje zaksiegowana DRUGI RAZ — to nie ozdobnik
// prawniczy, tylko powod, dla ktorego dokument w ogole moze zastapic wydruk faktury.
//
// ⚠️ WOLANA RAZ NA KAZDA STRONE, NA KONCU (`stopkaNaKazdejStronie` nizej), a NIE z konca
// `rysujStrone`. Do 12.08.2026 stalo tu jedno wywolanie na koniec rysowania zamowienia —
// czyli stopka trafiala na strone BIEZACA W TEJ CHWILI, a wiec WYLACZNIE na ostatnia.
// Zmierzone na 30 pozycjach: str. 1 i 2 niosly komplet pozycji, symboli i cen BEZ ANI JEDNEGO
// zdania odcinajacego kartke od faktury — dokladnie ta kartka, przed ktorej zaksiegowaniem
// drugi raz to zdanie ma bronic. Ksiegowa dostajaca do reki strone 1 nie ma z czego poznac,
// ze to nie faktura.
function stopka(doc, nazwaSprzedawcy) {
  const dolny = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  zwykly(doc, 8, SZARY_TEKST).text(
    'Dokument informacyjny — nie jest fakturą VAT ani paragonem fiskalnym.',
    L,
    doc.page.height - 50,
    { width: R - L },
  );
  zwykly(doc, 8, SZARY_TEKST).text(
    `Wystawiono w panelu zamówień${nazwaSprzedawcy ? ` ${nazwaSprzedawcy}` : ''}`,
    L,
    doc.page.height - 36,
    { width: R - L, lineBreak: false },
  );
  doc.page.margins.bottom = dolny;
}

/**
 * Stopka na KAZDEJ stronie dokumentu — wolana raz, tuz przed zamknieciem pliku.
 *
 * ⚠️ DLACZEGO PRZEBIEG PO STRONACH, A NIE WYWOLANIE PO KAZDYM `addPage()`: strona konczy sie
 * w dwoch niezaleznych miejscach (`nowaStronaKontynuacji` przy lamaniu tabeli i `addPage()`
 * miedzy zamowieniami w `zbudujSpecyfikacjeWieluPdf`), a stopki brakuje wtedy, gdy KTORES
 * z nich zostanie pominiete. Przebieg po `bufferedPageRange()` nie da sie pomylic: liczy
 * strony, ktore NAPRAWDE POWSTALY, wiec nowe miejsce lamania strony dostaje stopke samo,
 * bez pamietania o niej. Stad `bufferPages: true` w `noweDoc` — bez tego pdfkit wypycha
 * strone do strumienia od razu i wrocic do niej juz nie sposob.
 */
function stopkaNaKazdejStronie(doc, nazwaSprzedawcy) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i += 1) {
    doc.switchToPage(i);
    stopka(doc, nazwaSprzedawcy);
  }
}

/**
 * Bajty gotowego dokumentu, SYNCHRONICZNIE — `doc.end()` skłąda caly plik w jednym
 * przebiegu i wypycha go do bufora strumienia, wiec wystarczy go oproznic `read()`-em.
 * Przy `bufferPages: true` strony czekaja w pamieci az do `end()`, wiec stopke stemplujemy
 * TUTAJ — po narysowaniu calej tresci, a przed zamknieciem pliku.
 */
function bajty(doc, nazwaSprzedawcy) {
  stopkaNaKazdejStronie(doc, nazwaSprzedawcy);
  doc.end();
  const kawalki = [];
  for (let k = doc.read(); k !== null; k = doc.read()) kawalki.push(k);
  return Buffer.concat(kawalki);
}

function noweDoc(tytul, autor) {
  const doc = new PDFDocument({
    size: 'A4',
    // Strony trzymane w pamieci do `end()` — patrz `stopkaNaKazdejStronie`. Bez tego nie da
    // sie dostawic niczego do strony, ktora juz odplynela do strumienia.
    bufferPages: true,
    margins: {
      top: MARGINES, bottom: MARGINES, left: MARGINES, right: MARGINES,
    },
    info: { Title: tytul, Author: autor ?? 'Twój OMS' },
  });
  for (const [nazwa, plik] of Object.entries(PLIKI_FONTOW)) doc.registerFont(nazwa, plik);
  doc.font(FONT);
  return doc;
}

/**
 * Wiersz identyfikujacy na STRONIE KONTYNUACJI: powtorzony tytul dokumentu, numer zamowienia
 * i numer strony W OBREBIE TEGO ZAMOWIENIA. Zwraca `y`, od ktorego wolno pisac dalej.
 *
 * ⚠️ POWOD JEST TAKI SAM JAK PRZY STOPCE. Do 12.08.2026 strona druga i kazda nastepna
 * zaczynala sie od golego naglowka tabeli: ani tytulu, ani numeru zamowienia — sama kartka
 * z symbolami i cenami. Wypadnie z paczki, wsunie sie miedzy dokumenty innego zamowienia
 * i nie ma po czym poznac, do czego nalezy. Zamowienie lamie sie na druga strone juz przy
 * okolo dwudziestu pozycjach, wiec to nie jest przypadek brzegowy.
 */
function wierszKontynuacji(doc, dane, nrStrony) {
  const y = MARGINES;
  gruby(doc, 9).text(
    `Specyfikacja zamówienia nr ${dane?.numer ?? ''} — str. ${nrStrony}`,
    L,
    y,
    { width: R - L, lineBreak: false },
  );
  linia(doc, y + 13);
  return y + 20;
}

/**
 * Nowa strona TEGO SAMEGO zamowienia. `stan.strona` liczy strony w obrebie zamowienia (a nie
 * w obrebie pliku), bo to ta liczba cos znaczy dla czlowieka trzymajacego kartki jednej paczki.
 */
function nowaStronaKontynuacji(doc, dane, stan) {
  doc.addPage();
  stan.strona += 1;
  return wierszKontynuacji(doc, dane, stan.strona);
}

/**
 * Jedna strona specyfikacji dla jednego zamowienia. Wejscie to WYLACZNIE `daneSpecyfikacji`
 * z domain/specyfikacja.js — ten modul nie zna zadnego innego ksztaltu.
 */
function rysujStrone(doc, dane = {}) {
  const stan = { strona: 1 };
  let y = 48;
  gruby(doc, 18).text('Specyfikacja zamówienia', L, y, { width: R - L, align: 'center' });
  y += 32;

  zwykly(doc, 10).text(`Nr ${dane.numer ?? ''}`, L, y, { width: 260, lineBreak: false });
  // ⚠️ „Data zamówienia", nie samo „Data" (24.08.2026) — i to nie jest kosmetyka. Na kartce
  // sa teraz DWIE daty (zlozenia i platnosci), wiec goly napis „Data" kazalby zgadywac,
  // ktora to. Wartosc sie nie zmienila: to zawsze byl dzien ZLOZENIA zamowienia
  // (`utworzone_at` w czasie warszawskim, patrz domain/specyfikacja.js).
  zwykly(doc, 10).text(`Data zamówienia: ${dane.dataZamowienia ?? ''}`, 300, y, {
    width: R - 300, align: 'right', lineBreak: false,
  });
  y += 22;

  linia(doc, y);
  y += 18;

  // ⚠️ NIP DOLOZONY 12.08.2026 (recenzja). Przy zamowieniach firmowych ta kartka ZASTEPUJE
  // wydruk faktury (faktura i tak dociera przez KSeF) — dokument sprzedazowy dla odbiorcy
  // instytucjonalnego bez numeru identyfikacji podatkowej wystawcy byl widoczna dziura,
  // nawet gdy formalnie nie jest to faktura VAT. Ta sama zasada, co przy BDO wyzej: pusty
  // NIP daje pusta linie (filtr `filter((s) => s !== '')` nizej), nie napis "NIP: null".
  const liniiSprzedawcy = [
    dane.sprzedawca?.nazwa,
    dane.sprzedawca?.adres,
    dane.sprzedawca?.nip ? `NIP: ${dane.sprzedawca.nip}` : '',
    dane.sprzedawca?.bdo ? `BDO: ${dane.sprzedawca.bdo}` : '',
  ].map((s) => String(s ?? '').trim()).filter((s) => s !== '');

  const liniiNabywcy = [
    dane.nabywca?.firma,
    dane.nabywca?.ulica,
    [dane.nabywca?.kod, dane.nabywca?.miasto].filter(Boolean).join(' '),
    dane.nabywca?.kraj,
    dane.nabywca?.nip ? `NIP: ${dane.nabywca.nip}` : '',
  ].map((s) => String(s ?? '').trim()).filter((s) => s !== '');

  const dolSprzedawcy = blokSekcja(doc, L, y, PRAWA_KOLUMNA - L - 20, 'Sprzedawca', liniiSprzedawcy);
  const dolNabywcy = blokSekcja(doc, PRAWA_KOLUMNA, y, R - PRAWA_KOLUMNA, 'Nabywca', liniiNabywcy);
  y = Math.max(dolSprzedawcy, dolNabywcy) + 20;

  y = naglowekSekcji(doc, L, y, 'Pozycje') + 8;
  y = naglowekTabeli(doc, y);

  // ⚠️ LAMANIE STRONY WEWNATRZ ZAMOWIENIA — MECHANIZM PRZENIESIONY 1:1 Z proforma-pdf.js,
  // SWIADOMIE (nie wymyslony od nowa). Powod jest usterka, ktora tu byla: `komorka()` rysuje
  // BEZ `width`, wiec nigdy sama nie sprawdza granicy strony i pisze na wspolrzednej lezacej
  // juz POZA arkuszem — po cichu, bez wyjatku. Jedynie `doc.text()` Z `width` (kolumna
  // „Nazwa") przechodzi przez `LineWrapper.wrap()`, ktore samo dokladalo strone W SRODKU
  // WIERSZA — i to WYLACZNIE dla tej jednej komorki, wiec Symbol/Ilosc/Cena/Wartosc tego
  // wiersza zostawaly na starej stronie, a RAZEM/koszt dostawy dziedziczyly rozjechane `y`
  // i znikaly z dokumentu bez sladu. Sprawdzenie granicy PRZED wierszem (z zapasem na jego
  // wysokosc) i reczne `addPage()` z powtorzonym naglowkiem tabeli usuwa ten mechanizm
  // calkowicie — dokladnie tak, jak na fakturze proforma.
  const dolnaGranica = doc.page.height - MARGINES - 22; // 22 pkt rezerwy na stopke
  (dane.pozycje ?? []).forEach((p, i) => {
    zwykly(doc, 9);
    const wys = Math.max(doc.heightOfString(String(p?.nazwa ?? ''), { width: KOLUMNY.nazwa.w }), 11) + 10;
    if (y + wys > dolnaGranica) {
      y = naglowekTabeli(doc, nowaStronaKontynuacji(doc, dane, stan));
    }
    y = wierszPozycji(doc, y, p, i + 1);
  });
  y += 10;

  // Blok podsumowania (koszt dostawy, RAZEM, platnosc, dostawa, faktura) trzymamy RAZEM na
  // jednej stronie — tak samo jak proforma trzyma razem tabele VAT i „Do zaplaty": kwota
  // oderwana od pozycji, z ktorych wyszla, jest kwota bez podstawy.
  // ⚠️ BUDZET WYSOKOSCI MUSI OBEJMOWAC KAZDA LINIE, KTORA NAPRAWDE PADNIE. Dolozenie
  // wiersza bez policzenia go tutaj daje blok podsumowania rozerwany miedzy strony —
  // czyli kwote „RAZEM" oderwana od pozycji, z ktorych wyszla. Uwagi klienta liczymy
  // OSOBNO (nizej), bo ich wysokosc zalezy od dlugosci tekstu.
  const potrzeba = 14 + 18 + 16 + 24 + 15 + 15
    + (dane.dataPlatnosci ? 15 : 0)
    + (dane.faktura?.numer || dane.fakturaWybrana || dane.paragon ? 16 : 0);
  if (y + potrzeba > dolnaGranica) {
    y = nowaStronaKontynuacji(doc, dane, stan);
  } else {
    linia(doc, y);
    y += 14;
  }

  zwykly(doc, 9).text('Koszt dostawy', L, y, { width: 200, lineBreak: false });
  komorka(doc, kwota(dane.dostawaZl), KOLUMNY.wartosc, y);
  y += 18;

  gruby(doc, 11).text('RAZEM', L, y, { lineBreak: false });
  gruby(doc, 12);
  komorka(doc, kwota(dane.razemZl), KOLUMNY.wartosc, y);
  y += 16;

  // ⚠️ NETTO STOI POD BRUTTEM I JEST SZARE — kolejnosc i waga sa tu informacja. „RAZEM" to
  // kwota, ktora klient PLACI, i ona ma zostac najmocniejsza liczba na kartce; netto jest
  // rozbiciem tej samej kwoty, potrzebnym firmom. Netto wybite tak samo mocno kazaloby
  // przy pierwszym spojrzeniu zgadywac, ktora liczba jest do zaplaty.
  zwykly(doc, 9, SZARY_TEKST).text('w tym netto', L, y, { lineBreak: false });
  komorka(doc, kwota(dane.nettoZl), KOLUMNY.wartosc, y);
  zwykly(doc, 9);
  y += 24;

  zwykly(doc, 9).text(`Płatność: ${dane.platnosc ?? ''}`, L, y, { width: R - L, lineBreak: false });
  y += 15;
  // ⚠️ TYLKO GDY PLATNOSC BYLA. Przy pobraniu pieniadze odbiera kurier przy doreczeniu,
  // wiec data platnosci jeszcze nie istnieje — pusty wiersz „Data płatności: " albo myslnik
  // sugerowalby klientowi, ze cos poszlo nie tak.
  if (dane.dataPlatnosci) {
    zwykly(doc, 9).text(`Data płatności: ${dane.dataPlatnosci}`, L, y, { width: R - L, lineBreak: false });
    y += 15;
  }
  zwykly(doc, 9).text(`Sposób dostawy: ${dane.dostawa ?? ''}`, L, y, { width: R - L, lineBreak: false });
  y += 15;

  // ⚠️⚠️ DOKUMENT SPRZEDAZY — JEDNA LINIA, DWIE MOZLIWE TRESCI I ONE SIE WYKLUCZAJA.
  //
  // Faktura: linijka warunkowa, bo dokument powstaje czesto PRZED faktura i to nie jest blad.
  // Paragon: dla klienta, ktory faktury NIE chcial — do 24.08.2026 taka kartka milczala
  // o dokumencie sprzedazy w ogole, wiec klient dostawal specyfikacje bez jednego slowa
  // o tym, czym udokumentowany jest zakup.
  //
  // ⚠️ KOLEJNOSC: faktura wygrywa. Zamowienie z wystawiona faktura ma na kartce jej numer,
  // nawet gdyby flaga „chce fakture" byla w miedzyczasie przestawiona — numer dokumentu,
  // ktory JUZ ISTNIEJE, jest twardszym faktem niz zyczenie sprzed tygodnia.
  // ⚠️ ETYKIETA BRZMI „Dokument sprzedaży", a nie samo „Dokument" — i to nie jest ozdobnik.
  // Stopka KAZDEJ strony niesie „Dokument informacyjny — nie jest fakturą VAT ani paragonem
  // fiskalnym". Linia zaczynajaca sie od golego „Dokument: paragon fiskalny" czytalaby sie
  // razem ze stopka jak zaprzeczenie samej siebie. Z doprecyzowana etykieta obie mowia
  // spojnie: TA kartka jest informacyjna, a dokumentem sprzedazy jest to, co nazwane wyzej.
  if (dane.faktura?.numer) {
    zwykly(doc, 9).text(
      `Dokument sprzedaży: faktura VAT nr ${dane.faktura.numer} — doręczona przez KSeF`,
      L,
      y,
      { width: R - L },
    );
    y += 16;
  } else if (dane.fakturaWybrana) {
    zwykly(doc, 9).text(
      'Wybrany dokument sprzedaży: faktura VAT',
      L,
      y,
      { width: R - L },
    );
    y += 16;
  } else if (dane.paragon) {
    zwykly(doc, 9).text(
      'Dokument sprzedaży: paragon fiskalny — w przesyłce',
      L,
      y,
      { width: R - L },
    );
    y += 16;
  }

  uwagiKlienta(doc, dane, stan, y);
}

/**
 * Uwagi, ktore klient sam wpisal przy zamowieniu (`customer_note` ze sklepu albo
 * `messageToSeller` z Allegro) — wydrukowane WRACAJA do niego jako potwierdzenie, ze ktos
 * je przeczytal.
 *
 * ⚠️⚠️ WYSOKOSC LICZYMY, A NIE ZGADUJEMY. To jedyne pole tego dokumentu o dlugosci
 * nieograniczonej z gory: klient potrafi wkleic akapit. Staly budzet punktow uciąlby tekst
 * na dole strony albo — gorzej — nadpisal nim stopke, ktora odcina ten dokument od faktury.
 * `heightOfString` pyta o to sam silnik PDF, tymi samymi ustawieniami czcionki, ktorymi
 * potem rysuje.
 */
function uwagiKlienta(doc, dane, stan, yWejscia) {
  if (!dane.uwagiKlienta) return;
  let y = yWejscia + 10;

  zwykly(doc, 9);
  const szerokosc = R - L;
  const wysokoscTekstu = doc.heightOfString(dane.uwagiKlienta, { width: szerokosc });
  const dolnaGranica = doc.page.height - MARGINES - 22;

  // Naglowek (14) + tekst + oddech (6). Nie miesci sie w calosci — cala sekcja idzie
  // na kolejna strone, zamiast rozpadac sie na naglowek tu i tresc tam.
  if (y + 14 + wysokoscTekstu + 6 > dolnaGranica) {
    y = nowaStronaKontynuacji(doc, dane, stan);
  }

  gruby(doc, 9).text('Uwagi klienta', L, y, { width: szerokosc, lineBreak: false });
  y += 14;
  zwykly(doc, 9).text(dane.uwagiKlienta, L, y, { width: szerokosc });
}

/**
 * Specyfikacja zamowienia jako gotowy PDF. Jedno zamowienie ZACZYNA SIE OD NOWEJ STRONY —
 * przy niewielu pozycjach to w praktyce jedna strona, ale zamowienie z duza liczba pozycji
 * (dlugie nazwy, wiele wierszy) rozlewa sie na kolejne, z powtorzonym naglowkiem tabeli
 * (patrz `dolnaGranica` w `rysujStrone`). Ta gwarancja — „nowa strona na zamowienie", nie
 * „jedna strona na zamowienie" — jest tym, na czym maja polegac wolajacy.
 *
 * ⚠️ KAZDA strona — takze kontynuacja — niesie stopke odcinajaca dokument od faktury oraz
 * wiersz z numerem zamowienia i numerem strony. Zadnej kartki tego dokumentu nie wolno dac
 * klientowi ani ksiegowosci bez obu tych rzeczy: bez stopki kartka jest do zaksiegowania
 * drugi raz obok faktury z KSeF, bez numeru — nie wiadomo, do ktorej paczki nalezy.
 *
 * Wejscie: WYLACZNIE ksztalt `daneSpecyfikacji` (domain/specyfikacja.js) — `numer`,
 * `dataZamowienia`, `sprzedawca` (`nazwa`, `adres`, `nip`, `bdo`), `nabywca` (`firma`, `ulica`,
 * `kod`, `miasto`, `kraj`, `nip`), `pozycje` (`nazwa`, `symbol`, `ilosc`, `cenaZl`,
 * `wartoscZl`), `dostawaZl`, `razemZl`, `platnosc`, `dostawa`, `faktura` (`{ numer }` albo
 * `null`). Zaden inny ksztalt nie jest obslugiwany.
 */
export async function zbudujSpecyfikacjePdf(dane = {}) {
  const doc = noweDoc(`Specyfikacja zamowienia ${dane.numer ?? ''}`.trim(), dane.sprzedawca?.nazwa);
  rysujStrone(doc, dane);
  return bajty(doc, dane.sprzedawca?.nazwa);
}

/**
 * Specyfikacje wielu zamowien w jednym pliku — KAZDE ZAMOWIENIE ZACZYNA SIE OD NOWEJ STRONY,
 * w kolejnosci listy (patrz komentarz przy `zbudujSpecyfikacjePdf`: przy wielu pozycjach
 * jedno zamowienie umie zajac wiecej niz jedna strone, tabela wtedy laduje naglowek od
 * nowa — kolejne zamowienie i tak zaczyna sie na swiezej stronie).
 *
 * ⚠️ PUSTA LISTA ODMAWIA, nie oddaje pustego pliku. Pusty PDF wyglada jak plik, ktory sie
 * udal, a przy wydruku do paczek znaczy paczke BEZ dokumentu — cichszy blad niz rzucony
 * wyjatek nie istnieje.
 */
export async function zbudujSpecyfikacjeWieluPdf(listaDanych = []) {
  if (!Array.isArray(listaDanych) || listaDanych.length === 0) {
    throw bladOperatora('Brak zamowien do wydrukowania specyfikacji.');
  }
  const doc = noweDoc('Specyfikacje zamowien', listaDanych[0]?.sprzedawca?.nazwa);
  listaDanych.forEach((dane, i) => {
    if (i > 0) doc.addPage();
    rysujStrone(doc, dane);
  });
  return bajty(doc, listaDanych[0]?.sprzedawca?.nazwa);
}
