import { grosze, zl } from './kwoty.js';

// Pozycje faktury KOSZTOWEJ wyjete z oryginalnego XML-a z KSeF (FA (3), schema 1-0E,
// przestrzen http://crd.gov.pl/wzor/2025/06/25/13775/ — ksztalt ZMIERZONY na zywym API
// 12.08.2026, Zadanie 0, a nie odczytany z dokumentacji).
//
// ⚠️ TO JEST JEDYNE MIEJSCE, W KTORYM KSZTALT XML-a FA ZAMIENIA SIE W KSZTALT PANELU —
// dokladnie ta sama zasada, co przy `naWiersz` (domain/koszt-metadane.js) dla metadanych
// JSON-owych. Generator PDF-a (pdf/koszt-pdf.js) nie zna ani jednej nazwy wezla FA i ma
// jej nie poznac: schema FA zmienia sie decyzja Ministerstwa, nie nasza, wiec drugie
// mapowanie rozjechaloby sie z pierwszym przy pierwszej takiej zmianie.
//
// ⚠️ PARSER JEST WLASNY I MA TAKI ZOSTAC. Repo nie ma zadnej biblioteki XML (patrz
// package.json), a odczyt kilku plaskich wezlow z dokumentu, ktory sami przed chwila
// pobralismy z KSeF, nie jest powodem do dolozenia zaleznosci. Ta sama droga, co przy
// odpowiedzi GUS-a (domain/gus.js) — tam tez czytamy XML wyrazeniem regularnym.
//
// ⚠️ SUM DOKUMENTU TU SIE NIE LICZY. Zadnego sumowania pozycji, zadnego skladania sumy
// miesiaca: kwoty dokumentu (netto/VAT/brutto) sa juz w tabeli `koszty`, wprost z metadanych
// KSeF. Suma pozycji policzona tutaj byla drugim zrodlem tej samej prawdy i przy pierwszym
// rabacie albo zaokragleniu rozeszlaby sie z pierwszym.
//
// ⚠️ WYJATEK, KTORY MA BYC WYJATKIEM (2026-09-03, `dokumentZXml`): BRUTTO, ktorego FA(3)
// w danym miejscu NIE NIESIE, jest tu WYPROWADZANE — brutto pozycji z `P_11 + P_11Vat`
// (albo ze stawki, gdy VAT-u pozycji nie ma) i brutto w rozbiciu na stawki z `P_13_x + P_14_x`.
// Trzy warunki czynia z tego wyswietlenie, a nie druga ksiegowosc:
//   1. liczy sie WYLACZNIE na groszach calkowitych (`grosze`/`zl` z domain/kwoty.js,
//      niezmiennik 4.5) — nigdy na liczbach zmiennoprzecinkowych,
//   2. kazda taka kwota niesie znacznik `bruttoWyliczone`, a wydruk oznacza ja przypisem,
//   3. NIE WCHODZI do zadnej sumy panelu: suma miesiaca i kwoty na wydruku „Razem" biora sie
//      z metadanych KSeF (tabela `koszty`), a nie stad.
// Powod jest prosty: ksiegowa dostaje kartke z kolumna „Wartosc brutto", ktorej wystawca
// czesto nie wypelnia — pusta kolumna wyglada jak brak danych, a nie jak brak pola w schemie.

// Nazwa wezla moze przyjsc z przedrostkiem przestrzeni nazw — na produkcji WIDZIELISMY
// `tns:` (Subiekt GT), `ns1:` (TERG) i brak przedrostka (wiekszosc). To ustawienie WYSTAWCY,
// nie nasze, wiec kazdy odczyt musi znosic oba warianty.
const znacznik = (nazwa) => `(?:[A-Za-z0-9_.-]+:)?${nazwa}`;

// Encje XML-a rozpakowane RECZNIE: `&amp;` w nazwie towaru („Papier &amp; spolka") wydrukowany
// doslownie jest bledem widocznym na dokumencie. `&amp;` idzie NA KONCU, inaczej „&amp;lt;"
// rozpakowaloby sie dwa razy i dalo znak `<` tam, gdzie wystawca chcial napisu.
const ENCJE = [
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&quot;/g, '"'],
  [/&apos;/g, "'"],
  [/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16))],
  [/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec))],
  [/&amp;/g, '&'],
];

const rozpakuj = (s) => ENCJE.reduce((tekst, [wzor, na]) => tekst.replace(wzor, na), s);

/**
 * Tresc pierwszego wezla o tej nazwie. Brak wezla i wezel pusty (takze samozamykajacy sie,
 * `<P_8A/>`) daja PUSTY NAPIS — nigdy `undefined`, bo to slowo trafiloby wprost na wydruk.
 */
function tresc(xml, nazwa) {
  const m = String(xml).match(
    new RegExp(`<${znacznik(nazwa)}(?:\\s[^>]*)?>([\\s\\S]*?)</${znacznik(nazwa)}>`, 'i'),
  );
  return m ? rozpakuj(m[1]).trim() : '';
}

/**
 * Ilosc bez zer nieznaczacych. KSeF niesie `P_8B` w postaci „2.0000" — „2.0000 ryzy" nie jest
 * zapisem, ktory ktokolwiek widzial na fakturze. Przycinamy WYLACZNIE ogon po kropce i tylko
 * wtedy, gdy wartosc wyglada na liczbe: „2 x 5" czy „ok. 3" zostaja nietkniete.
 */
function bezZerNieznaczacych(napis) {
  if (!/^-?\d+\.\d+$/.test(napis)) return napis;
  return napis.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Stawka VAT gotowa do wydrukowania. Liczba dostaje procent („23" → „23%"), a kazda inna
 * wartosc zostaje DOSLOWNIE: „zw" (zwolniony), „np" (nie podlega), „oo" (odwrotne obciazenie).
 * „zw%" bylby napisem, ktorego na fakturze nie ma i ktory zmyslalby stawke tam, gdzie jej nie ma.
 */
const stawka = (napis) => (/^-?\d+([.,]\d+)?$/.test(napis) ? `${napis}%` : napis);

/**
 * Pozycje dokumentu z XML-a FA(3) — w kolejnosci, w jakiej stoja w dokumencie.
 *
 * Kazda pozycja to `{ lp, nazwa, jednostka, ilosc, cenaNetto, wartoscNetto, stawkaVat }`,
 * wszystko NAPISAMI: kwoty w tym repo nie zamieniaja sie w liczby zmiennoprzecinkowe
 * (niezmiennik 4.5), a tutaj nie sa nawet dodawane — tylko przepisywane na dokument.
 *
 * ⚠️ BRAK POZYCJI ODDAJE PUSTA LISTE, A NIE WYJATEK. Wizualizacja ma powstac takze dla
 * dokumentu, ktorego pozycji nie da sie odczytac — kwoty i sprzedawca ida wtedy z tabeli
 * `koszty`, a sam PDF mowi wprost, ze pozycji nie bylo (patrz pdf/koszt-pdf.js). Odmowa
 * zabralaby operatorowi caly podglad dokumentu przez jeden nieznany ksztalt tabeli pozycji.
 */
export function pozycjeZXml(xml) {
  return wierszeFa(xml).map((w, i) => ({
    // Numer wiersza bierze sie z dokumentu (`NrWierszaFa`), a wlasny licznik jest wylacznie
    // zapasem: to wystawca decyduje o numeracji pozycji i ona ma sie zgadzac z oryginalem.
    lp: tresc(w, 'NrWierszaFa') || String(i + 1),
    nazwa: tresc(w, 'P_7'),
    jednostka: tresc(w, 'P_8A'),
    ilosc: bezZerNieznaczacych(tresc(w, 'P_8B')),
    cenaNetto: tresc(w, 'P_9A'),
    wartoscNetto: tresc(w, 'P_11'),
    stawkaVat: stawka(tresc(w, 'P_12')),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// CALY DOKUMENT — komplet elementow art. 106e ust. 1 ustawy o VAT plus adnotacje FA(3)
// ─────────────────────────────────────────────────────────────────────────────
//
// Powstalo 2026-09-03 z pytania wlasciciela: „czy te wizualizacje XML nadaja sie do
// dostarczenia do biura?". Do tego dnia NIE nadawaly sie — kartka nie niosla nabywcy,
// adresu sprzedawcy, daty sprzedazy, rozbicia VAT na stawki, brutta pozycji, podstawy
// zwolnienia jako POLA (a nie przypadkowego zdania w nazwie pozycji), adnotacji ani
// informacji o platnosci. Ksiegowa dostawala kartke, ktorej nie da sie sprawdzic.
//
// ⚠️ TO WCIAZ JEST TO SAMO JEDYNE MIEJSCE ZNAJACE NAZWY WEZLOW FA. Wynik jest GOTOWY DO
// DRUKU: etykiety stawek, „Tak"/„Nie" adnotacji i forma platnosci slownie powstaja TUTAJ,
// zeby pdf/koszt-pdf.js dalej nie znal ani jednej nazwy z FA(3). Schema FA zmienia sie
// decyzja Ministerstwa — drugie mapowanie w generatorze rozjechaloby sie z pierwszym.
//
// ⚠️ KODU POLA (`P_13_1`, `P_19`, …) NIE UKRYWAMY — idzie na wydruk obok etykiety. Czesc
// pol FA(3) jest wieloznaczna z samej nazwy (`P_13_1` to „22% albo 23%", `P_13_6_1..3` to
// trzy rozne zerowe stawki) i wymyslenie im ladnych opisow znaczyloby WSTAWIENIE NA CUDZY
// DOKUMENT tresci, ktorej wystawca tam nie napisal. Kod pola daje ksiegowej sposob na
// sprawdzenie kartki wobec oryginalnego XML-a — i to jest cala rola tej kolumny.

/** Wszystkie bloki `<FaWiersz>…</FaWiersz>` w kolejnosci dokumentu (surowe napisy). */
function wierszeFa(xml) {
  const znalezione = String(xml ?? '').match(
    new RegExp(`<${znacznik('FaWiersz')}(?:\\s[^>]*)?>[\\s\\S]*?</${znacznik('FaWiersz')}>`, 'gi'),
  );
  return znalezione ?? [];
}

/**
 * Blok o podanej nazwie razem ze znacznikami (`<Podmiot1>…</Podmiot1>`) albo pusty napis.
 *
 * ⚠️ ODCZYT PRZEZ BLOK, A NIE Z CALEGO DOKUMENTU — i to nie jest porzadkowanie kodu.
 * `Podmiot2` na fakturze P4 niesie `Adres` ORAZ `AdresKoresp`, a oba maja w srodku `AdresL1`.
 * Odczyt `AdresL1` z calego podmiotu trafia w ten, ktory stoi wyzej — czyli raz w siedzibe,
 * a raz w adres korespondencyjny, zaleznie od wystawcy. Na fakturze ma stac SIEDZIBA.
 */
function blok(xml, nazwa) {
  const m = String(xml ?? '').match(
    new RegExp(`<${znacznik(nazwa)}(?:\\s[^>]*)?>[\\s\\S]*?</${znacznik(nazwa)}>`, 'i'),
  );
  return m ? m[0] : '';
}

/**
 * Czy wezel w ogole w dokumencie STOI (takze pusty albo samozamykajacy sie).
 *
 * ⚠️ OBECNOSC TO CO INNEGO NIZ WARTOSC. `P_13_2` z wartoscia `0` (tak wystawia HURTEL) to
 * zdanie wystawcy „stawka obnizona: zero", a brak wezla to „tej stawki na fakturze nie ma".
 * Gdyby o wydruku wiersza decydowala niepusta wartosc, oba przypadki wygladalyby tak samo.
 */
function jest(xml, nazwa) {
  return new RegExp(`<${znacznik(nazwa)}(?:\\s[^>]*)?/?>`, 'i').test(String(xml ?? ''));
}

// Kwota nadajaca sie do arytmetyki na groszach. Wszystko inne (pusty napis, „b/d", zakres)
// idzie na wydruk doslownie i NIE jest niczym mnozone ani dodawane.
const LICZBA = /^-?\d+([.,]\d+)?$/;

/** Napis kwoty na grosze calkowite, albo `null` gdy to nie jest kwota. */
function nagrosze(napis) {
  const tekst = String(napis ?? '').trim().replace(',', '.');
  return LICZBA.test(tekst) ? grosze(tekst, 'kwota z XML-a FA(3)') : null;
}

/**
 * Brutto = netto + VAT, na GROSZACH CALKOWITYCH (niezmiennik 4.5). Pusty napis, gdy
 * ktorejkolwiek strony nie da sie odczytac jako kwoty — „0,00" byloby zdaniem o pieniadzach,
 * ktorego wystawca nie napisal.
 */
function nettoPlusVat(netto, vat) {
  const a = nagrosze(netto);
  const b = nagrosze(vat);
  if (a === null || b === null) return '';
  return zl(a + b);
}

/**
 * Brutto WYPROWADZONE ZE STAWKI — ostatnia deska ratunku dla pozycji, przy ktorej wystawca
 * nie podal ani `P_11A`, ani `P_11Vat` (tak wystawia OVH i InPost).
 *
 * ⚠️ TO JEST WYSWIETLENIE, NIE KSIEGOWANIE. Zaokraglenie robimy raz, na groszach, i wynik
 * wraca z podniesiona flaga `bruttoWyliczone` — wydruk stawia przy nim przypis, a ksiegowa
 * widzi, ktora liczba jest przepisana z dokumentu, a ktora nasza. Do zadnej sumy nie wchodzi.
 */
function bruttoZeStawki(netto, stawkaVat) {
  const gr = nagrosze(netto);
  if (gr === null) return '';
  const procent = String(stawkaVat ?? '').trim().replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(procent)) return zl(Math.round((gr * (100 + Number(procent))) / 100));
  // Stawki BEZ VAT-u na fakturze: zwolniona, niepodlegajaca, odwrotne obciazenie. Brutto rowna
  // sie tam netto i to NIE JEST zgadywanie stawki — sprzedawca nie dolicza VAT-u w zadnej
  // z nich (przy „oo" rozlicza go nabywca, ale na TYM dokumencie kwoty nie ma). Bez tej galezi
  // kolumna „Wartosc brutto" byla pusta na kazdej fakturze zwolnionej — czyli na fakturach
  // PayU, ktore przychodza co miesiac.
  if (['zw', 'np', 'oo'].includes(procent.toLowerCase())) return zl(gr);
  return '';
}

// Stawki podsumowania VAT z FA(3). `netto` to pole `P_13_*`, `vat` — odpowiadajace `P_14_*`
// (stawki zerowe, zwolniona, „np", „oo" i marza VAT-u nie maja i nie dostaja pustej kolumny
// z zerem), `vatPln` — `P_14_*W`, czyli VAT przeliczony na zlote na fakturze w obcej walucie
// (widziane na fakturach Allegro w EUR i CZK).
const STAWKI_VAT = [
  { kod: 'P_13_1', vat: 'P_14_1', vatPln: 'P_14_1W', etykieta: '23% / 22%' },
  { kod: 'P_13_2', vat: 'P_14_2', vatPln: 'P_14_2W', etykieta: '8% / 7%' },
  { kod: 'P_13_3', vat: 'P_14_3', vatPln: 'P_14_3W', etykieta: '5%' },
  { kod: 'P_13_4', vat: 'P_14_4', vatPln: 'P_14_4W', etykieta: 'ryczałt (taksówki)' },
  { kod: 'P_13_5', vat: 'P_14_5', vatPln: 'P_14_5W', etykieta: 'stawka szczególna' },
  { kod: 'P_13_6_1', etykieta: '0%' },
  { kod: 'P_13_6_2', etykieta: '0%' },
  { kod: 'P_13_6_3', etykieta: '0%' },
  { kod: 'P_13_7', etykieta: 'zw' },
  { kod: 'P_13_8', etykieta: 'np' },
  { kod: 'P_13_9', etykieta: 'np (art. 100)' },
  { kod: 'P_13_10', etykieta: 'oo' },
  { kod: 'P_13_11', etykieta: 'marża' },
];

// Adnotacje FA(3). `nie` to wariant „N" tego samego pola: `P_19N`, `P_22N`, `P_PMarzyN`
// znacza „nie dotyczy" i na wydruku maja dac „Nie", a nie zniknac — bo brak adnotacji
// i adnotacja „nie" to dla ksiegowej dwie rozne informacje.
const ADNOTACJE = [
  { kod: 'P_16', etykieta: 'Metoda kasowa' },
  { kod: 'P_17', etykieta: 'Samofakturowanie' },
  { kod: 'P_18', etykieta: 'Odwrotne obciążenie' },
  { kod: 'P_18A', etykieta: 'Mechanizm podzielonej płatności' },
  {
    kod: 'P_19',
    nie: 'P_19N',
    blok: 'Zwolnienie',
    etykieta: 'Zwolnienie z VAT',
    podstawy: ['P_19A', 'P_19B', 'P_19C'],
  },
  {
    kod: 'P_22', nie: 'P_22N', blok: 'NoweSrodkiTransportu', etykieta: 'Nowe środki transportu',
  },
  { kod: 'P_23', etykieta: 'Transakcja trójstronna uproszczona' },
  {
    kod: 'P_PMarzy', nie: 'P_PMarzyN', blok: 'PMarzy', etykieta: 'Procedura marży',
  },
];

/**
 * Odczyt ze slownika opisow — WYLACZNIE po kluczu WLASNYM.
 *
 * ⚠️⚠️ KLUCZ POCHODZI Z CUDZEGO DOKUMENTU, a zwykle `slownik[klucz]` siega po LANCUCH
 * PROTOTYPOW (poprawka po drugiej recenzji, 03.09.2026). Wystawca — albo pomylka w jego
 * generatorze — wpisujacy w `FormaPlatnosci` napis „constructor" dostawal na kartce
 * `function Object() { [native code] }` w miejscu formy zaplaty. `??` tego NIE LAPIE:
 * wartosc odziedziczona nie jest `undefined`. To jest jedyne miejsce, w ktorym napis
 * z XML-a staje sie kluczem, wiec straznik stoi tutaj, a nie w trzech miejscach z osobna.
 */
const zeSlownika = (slownik, klucz, zapas) => (
  Object.hasOwn(slownik, klucz) ? slownik[klucz] : zapas
);

// Formy platnosci wprost ze slownika FA(3). Kod spoza slownika idzie na wydruk DOSLOWNIE
// (jako „kod N") — zmyslona nazwa byla zdaniem o cudzym dokumencie, ktorego nikt nie sprawdzil.
const FORMY_PLATNOSCI = {
  1: 'gotówka',
  2: 'karta',
  3: 'bon',
  4: 'czek',
  5: 'kredyt',
  6: 'przelew',
  7: 'płatność mobilna',
};

// Typy korekty z FA(3) opisane po ludzku. `TypKorekty` ROZSTRZYGA, W JAKIM MIESIACU korekta
// wchodzi do ksiag — sam kod („2") nie mowi ksiegowej niczego, a wizualizacja go do 03.09.2026
// w ogole nie drukowala. Kod spoza slownika idzie doslownie (jak przy formie platnosci).
//
// ⚠️ TYP 3 NIE DOSTAJE PRZYKLADU („np. uzgodnienia") i NIE DOSTAJE DATY — poprawka po drugiej
// recenzji (03.09.2026). FA(3) nie ma ANI JEDNEGO wezla, ktory by te „inna date" niosl:
// dane korekty to `PrzyczynaKorekty`, `TypKorekty` i `DaneFaKorygowanej/*` (numer, data
// wystawienia i numer KSeF faktury korygowanej) — sprawdzone w schemie i w archiwum
// kosztowym, w ktorym na 102 dokumenty nie ma ani jednej korekty. Data, w ktorej korekta
// skutkuje, stoi wiec — o ile w ogole — w tresci `PrzyczynaKorekty`, a ta idzie na wydruk
// osobno i doslownie. Dopisanie przykladu podpowiadalo ksiegowej powod korekty, ktorego
// na cudzym dokumencie nie ma.
const TYPY_KOREKTY = {
  1: 'korekta skutkująca w dacie ujęcia faktury pierwotnej',
  2: 'korekta skutkująca w dacie wystawienia faktury korygującej',
  3: 'korekta skutkująca w innej dacie',
};

// Rodzaje faktury z FA(3) opisane po ludzku — generator PDF-a nie ma znac tych skrotow.
const RODZAJE = {
  VAT: 'Faktura VAT',
  KOR: 'Faktura korygująca',
  ZAL: 'Faktura zaliczkowa',
  ROZ: 'Faktura rozliczeniowa',
  UPR: 'Faktura uproszczona',
  KOR_ZAL: 'Korekta faktury zaliczkowej',
  KOR_ROZ: 'Korekta faktury rozliczeniowej',
};

/** „1" → „Tak", „2" → „Nie". Cokolwiek innego idzie doslownie — to cudzy dokument. */
function takNie(wartosc) {
  if (wartosc === '1') return 'Tak';
  if (wartosc === '2') return 'Nie';
  return wartosc;
}

/**
 * Strona transakcji (`Podmiot1` = sprzedawca, `Podmiot2` = nabywca) gotowa do wydruku.
 *
 * ⚠️ IDENTYFIKATOR NIE JEST ZAWSZE NIP-em. FA(3) dopuszcza `NrID` (podmiot zagraniczny),
 * `IDWew` (identyfikator wewnetrzny) i `BrakID` — a puste pole „NIP:" na fakturze wyglada
 * jak brak danych, nie jak dokument wystawiony podmiotowi bez numeru.
 */
function podmiot(xml, nazwaWezla) {
  const blokPodmiotu = blok(xml, nazwaWezla);
  const dane = blok(blokPodmiotu, 'DaneIdentyfikacyjne');
  const adres = blok(blokPodmiotu, 'Adres');

  const nip = tresc(dane, 'NIP');
  const nrId = tresc(dane, 'NrID');
  const idWew = tresc(dane, 'IDWew');
  let identyfikator = '';
  if (nip) identyfikator = `NIP: ${nip}`;
  else if (nrId) identyfikator = `Nr identyfikacyjny: ${nrId}`;
  else if (idWew) identyfikator = `ID wewnętrzny: ${idWew}`;
  else if (jest(dane, 'BrakID')) identyfikator = 'Brak identyfikatora podatkowego';

  const kodKraju = tresc(adres, 'KodKraju');
  return {
    nazwa: tresc(dane, 'Nazwa'),
    nip,
    identyfikator,
    kodKraju,
    // Kraj dopisany TYLKO wtedy, gdy to nie Polska: „PL" pod polskim adresem jest szumem,
    // a brak „DE" pod niemieckim gubi jedyna informacje o tym, ze to zagranica.
    adres: [
      tresc(adres, 'AdresL1'),
      tresc(adres, 'AdresL2'),
      kodKraju && kodKraju.toUpperCase() !== 'PL' ? kodKraju.toUpperCase() : '',
    ].map((s) => s.trim()).filter((s) => s !== ''),
  };
}

/** Podsumowanie VAT w rozbiciu na stawki — wylacznie te, ktore w dokumencie STOJA. */
function stawkiZFa(fa) {
  return STAWKI_VAT.filter((s) => jest(fa, s.kod)).map((s) => {
    const netto = tresc(fa, s.kod);
    const vat = s.vat ? tresc(fa, s.vat) : '';
    return {
      kod: s.kod,
      etykieta: s.etykieta,
      netto,
      vat,
      vatPln: s.vatPln ? tresc(fa, s.vatPln) : '',
      // Brutto stawki: netto + VAT, a przy stawkach bez VAT-u — samo netto. FA(3) tego pola
      // NIE MA, wiec kazdy wiersz jest oznaczony jako wyliczony (patrz przypis na wydruku).
      brutto: vat === '' ? netto : nettoPlusVat(netto, vat),
      bruttoWyliczone: true,
    };
  });
}

/** Adnotacje gotowe do wydruku: etykieta, „Tak"/„Nie" i podstawa zwolnienia, gdy jest. */
function adnotacjeZFa(fa) {
  const blokAdnotacji = blok(fa, 'Adnotacje');
  if (blokAdnotacji === '') return [];
  return ADNOTACJE.flatMap((a) => {
    const zrodlo = a.blok ? blok(blokAdnotacji, a.blok) : blokAdnotacji;
    const wprost = tresc(zrodlo, a.kod);
    let wartosc = '';
    if (jest(zrodlo, a.kod)) wartosc = takNie(wprost);
    else if (a.nie && jest(zrodlo, a.nie)) wartosc = 'Nie';
    else return [];
    // Podstawa prawna zwolnienia jest POLEM dokumentu (`P_19A/B/C`), a nie zdaniem wplecionym
    // w nazwe pozycji — i wlasnie tego brakowalo ksiegowej na starej wizualizacji.
    const podstawa = (a.podstawy ?? [])
      .map((p) => tresc(zrodlo, p)).filter((s) => s !== '').join(' ');
    return [{
      kod: a.kod, etykieta: a.etykieta, wartosc, podstawa,
    }];
  });
}

/**
 * Wplaty czesciowe (`ZaplataCzesciowa`) — WSZYSTKIE, w kolejnosci dokumentu.
 *
 * ⚠️ FA(3) DOPUSZCZA WIELE TAKICH BLOKOW: faktura placona w ratach ma ich tyle, ile wplat.
 * Odczyt pierwszego z brzegu (`tresc`) oddawalby jedna rate z kilku, a kartka mowilaby
 * ksiegowej o zaplacie mniejszej, niz wystawca na dokumencie potwierdzil.
 */
function zaplatyCzesciowe(platnosc) {
  const bloki = String(platnosc).match(
    new RegExp(
      `<${znacznik('ZaplataCzesciowa')}(?:\\s[^>]*)?>[\\s\\S]*?</${znacznik('ZaplataCzesciowa')}>`,
      'gi',
    ),
  ) ?? [];
  return bloki.map((b) => ({
    kwota: tresc(b, 'KwotaZaplatyCzesciowej'),
    data: tresc(b, 'DataZaplatyCzesciowej'),
  }));
}

/**
 * Informacja o zaplacie — status, data, termin, forma slownie, rachunek, wplaty czesciowe.
 *
 * ⚠️⚠️ `zaplacono` MA TRZY STANY, NIE DWA (poprawka po recenzji 2026-09-03):
 *   `true`  — `Zaplacono` = 1, wystawca potwierdza zaplate,
 *   `false` — `Zaplacono` = 2, wystawca MOWI, ze nie zaplacono,
 *   `null`  — wezla NIE MA, czyli dokument o zaplacie NIE MOWI NIC.
 * Do tej poprawki brak wezla i „2" dawaly to samo `false`, a wydruk stawial na cudzym
 * dokumencie napis „Nie zapłacono" — czyli WSTAWIAL FAKT, ktorego wystawca tam nie napisal.
 * Blok `Platnosc` bez `Zaplacono` (sama forma i termin) jest w archiwum czestszy niz z nim.
 */
function platnoscZFa(fa) {
  const p = blok(fa, 'Platnosc');
  const kodFormy = tresc(p, 'FormaPlatnosci');
  const forma = kodFormy === '' ? '' : zeSlownika(FORMY_PLATNOSCI, kodFormy, `kod ${kodFormy}`);
  const znacznikZaplaty = tresc(p, 'Zaplacono');
  let zaplacono = null;
  if (znacznikZaplaty === '1') zaplacono = true;
  else if (znacznikZaplaty === '2') zaplacono = false;
  return {
    zaplacono,
    dataZaplaty: tresc(p, 'DataZaplaty'),
    czesciowa: tresc(p, 'ZnacznikZaplatyCzesciowej') === '1',
    zaplatyCzesciowe: zaplatyCzesciowe(p),
    termin: tresc(blok(p, 'TerminPlatnosci'), 'Termin'),
    forma,
    // `PlatnoscInna` to zdanie wystawcy zamiast kodu ze slownika („Pobrano z wplywow.
    // Faktura nie wymaga zaplaty" — PayU). Bez niego kartka klamie, ze formy platnosci nie ma.
    opis: tresc(p, 'OpisPlatnosci'),
    rachunek: tresc(blok(p, 'RachunekBankowy'), 'NrRB'),
  };
}

/** Dane faktury korygowanej — `null`, gdy dokument nie jest korekta. */
function korektaZFa(fa) {
  const dane = blok(fa, 'DaneFaKorygowanej');
  const przyczyna = tresc(fa, 'PrzyczynaKorekty');
  const typ = tresc(fa, 'TypKorekty');
  if (dane === '' && przyczyna === '' && typ === '') return null;
  return {
    przyczyna,
    typ,
    typOpis: zeSlownika(TYPY_KOREKTY, typ, typ ? `kod ${typ}` : ''),
    numer: tresc(dane, 'NrFaKorygowanej'),
    data: tresc(dane, 'DataWystFaKorygowanej'),
    ksef: tresc(dane, 'NrKSeFFaKorygowanej'),
  };
}

/** Pozycje z kompletem kolumn art. 106e — z cena i wartoscia BRUTTO wlacznie. */
function pozycjeSzczegolowe(xml) {
  return wierszeFa(xml).map((w, i) => {
    const wartoscNetto = tresc(w, 'P_11');
    const kwotaVat = tresc(w, 'P_11Vat');
    const stawkaVat = tresc(w, 'P_12');
    const bruttoWprost = tresc(w, 'P_11A');
    // Kolejnosc jest cala trescia reguly: najpierw pole wystawcy (`P_11A`), potem suma
    // dwoch jego pol (`P_11 + P_11Vat`), a dopiero na koncu nasze wyprowadzenie ze stawki.
    let wartoscBrutto = bruttoWprost;
    let bruttoWyliczone = false;
    if (wartoscBrutto === '') {
      wartoscBrutto = nettoPlusVat(wartoscNetto, kwotaVat);
      if (wartoscBrutto === '') {
        wartoscBrutto = bruttoZeStawki(wartoscNetto, stawkaVat);
        bruttoWyliczone = wartoscBrutto !== '';
      }
    }
    return {
      lp: tresc(w, 'NrWierszaFa') || String(i + 1),
      nazwa: tresc(w, 'P_7'),
      jednostka: tresc(w, 'P_8A'),
      ilosc: bezZerNieznaczacych(tresc(w, 'P_8B')),
      // Data dostawy PRZY POZYCJI — dokument potrafi nie miec `P_6` w ogole i wtedy to jest
      // jedyna data sprzedazy, jaka na nim stoi (art. 106e ust. 1 pkt 6).
      dataDostawy: tresc(w, 'P_6A'),
      cenaNetto: tresc(w, 'P_9A'),
      cenaBrutto: tresc(w, 'P_9B'),
      rabat: tresc(w, 'P_10'),
      wartoscNetto,
      kwotaVat,
      wartoscBrutto,
      bruttoWyliczone,
      stawkaVat: stawka(stawkaVat),
    };
  });
}

/**
 * CALY dokument FA(3) gotowy do wydrukowania — komplet elementow art. 106e ust. 1 ustawy
 * o VAT plus adnotacje. Wszystko NAPISAMI, brak wezla daje pusty napis (nigdy `undefined`).
 *
 * ⚠️ NIECZYTELNE WEJSCIE ODDAJE PUSTY DOKUMENT, A NIE WYJATEK — ta sama zasada, co przy
 * `pozycjeZXml`. Wizualizacja ma powstac takze dla dokumentu o nieznanym ksztalcie: kwoty
 * i sprzedawca ida wtedy z tabeli `koszty`, a odmowa zabralaby operatorowi caly podglad.
 */
export function dokumentZXml(xml) {
  const tekst = String(xml ?? '');
  const fa = blok(tekst, 'Fa');
  const rodzajFaktury = tresc(fa, 'RodzajFaktury');
  return {
    dataWytworzenia: tresc(blok(tekst, 'Naglowek'), 'DataWytworzeniaFa'),
    sprzedawca: podmiot(tekst, 'Podmiot1'),
    nabywca: podmiot(tekst, 'Podmiot2'),
    waluta: tresc(fa, 'KodWaluty'),
    numer: tresc(fa, 'P_2'),
    dataWystawienia: tresc(fa, 'P_1'),
    miejsceWystawienia: tresc(fa, 'P_1M'),
    dataSprzedazy: tresc(fa, 'P_6'),
    // Okres zamiast jednej daty — tak wystawia OVH, P4 i Allegro (abonamenty i rozliczenia
    // miesieczne). Bez tego kartka nie miala ANI JEDNEJ daty sprzedazy.
    okresOd: tresc(blok(fa, 'OkresFa'), 'P_6_Od'),
    okresDo: tresc(blok(fa, 'OkresFa'), 'P_6_Do'),
    rodzajFaktury,
    rodzajOpis: zeSlownika(
      RODZAJE, rodzajFaktury, rodzajFaktury ? `Faktura (${rodzajFaktury})` : '',
    ),
    czyKorekta: rodzajFaktury.startsWith('KOR'),
    naleznoscOgolem: tresc(fa, 'P_15'),
    stawki: stawkiZFa(fa),
    adnotacje: adnotacjeZFa(fa),
    pozycje: pozycjeSzczegolowe(tekst),
    platnosc: platnoscZFa(fa),
    korekta: korektaZFa(fa),
  };
}
