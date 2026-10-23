import { zl } from './kwoty.js';

// Eksport sprzedazy do CSV — plik, ktory wychodzi z panelu i ma sie otworzyc w Excelu bez
// zadnego kroku posredniego (2026-08-23).
//
// ⚠️ NIC TU NIE LICZY. Wiersze przychodza gotowe ze `sprzedazWOkresie` — tej samej funkcji,
// ktora rysuje ekran. Druga sciezka liczaca sprzedaz rozjechalaby sie o grosz przy pierwszej
// zmianie reguly, a caly sens tego pliku polega na tym, ze mowi DOKLADNIE to samo, co ekran.
//
// ⚠️ KANAL JEDZIE KLUCZEM (`ALLEGRO_A`), nie nazwa z ekranu. Nazwy czytelne mieszkaja
// w widoku (`NAZWY_KANALOW` w raporty.ejs) i sa tam po to, zeby dalo sie je zmienic bez
// ruszania danych. Plik idzie do zestawienia z KPiR, wiec ma byc STABILNY miedzy wersjami —
// klucz nim jest, napis na ekranie nie.

/** Kolumny pliku. Wariant z klientem dokłada e-mail — patrz `csvSprzedazy`. */
const KOLUMNY = ['Dzień', 'Kanał', 'Numer', 'Źródło', 'Brutto', 'Netto', 'Faktura', 'Opłacone'];

// „historia" i „oms" to nazwy wewnetrzne. W pliku, ktory czlowiek czyta obok wyciagu z KPiR,
// maja znaczyc jedno: skad ta sprzedaz jest znana.
const ZRODLO = { historia: 'Apilo', oms: 'OMS' };

// ⚠️ BOM JEST WARUNKIEM CZYTELNOSCI, nie ozdoba: bez niego Excel otwiera plik jako
// windows-1250 i „Kanał" staje sie „KanaÅ‚". Doklada go TRASA, nie ten modul — dzieki temu
// testy domeny porownuja sam tekst pliku, bez niewidocznego znaku na poczatku.
export const BOM_EXCELA = String.fromCharCode(65279);

const CUDZYSLOW = String.fromCharCode(34);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const KONIEC_LINII = CR + LF;

const takNie = (v) => (v ? 'tak' : 'nie');

// ⚠️ PRZECINEK DZIESIETNY, NIE KROPKA. Excel w polskiej lokalizacji czyta „246.00" jako tekst
// albo (gorzej) jako date, a suma kolumny wychodzi wtedy zerem — czyli plik wyglada dobrze
// i klamie.
const kwota = (grosze) => zl(grosze).replace('.', ',');

// ⚠️ CUDZYSLOWY WEDLUG RFC 4180, bo numer zamowienia przychodzi ZE SKLEPU i z Apilo, czyli
// spoza naszej kontroli. Srednik w takim polu rozjechalby wszystkie kolumny na prawo od niego
// — i to CICHO: plik otworzylby sie normalnie, tylko kwoty wyladowalyby w zlych kolumnach.
// Cudzyslow w srodku pola podwaja sie; nowa linia tez wymusza otoczenie pola cudzyslowami.
function poleCsv(wartosc) {
  const tekst = String(wartosc ?? '');
  const trzeba = tekst.includes(';') || tekst.includes(CUDZYSLOW)
    || tekst.includes(CR) || tekst.includes(LF);
  if (!trzeba) return tekst;
  return CUDZYSLOW + tekst.split(CUDZYSLOW).join(CUDZYSLOW + CUDZYSLOW) + CUDZYSLOW;
}

// ⚠️ TEKST SPOZA OMS-A NIE MOZE STAC SIE FORMULA ARKUSZA. Apostrof dodajemy PRZED
// cytowaniem CSV. Kwoty ida osobno przez poleCsv — ujemna kwota musi zostac liczba.
function pole(wartosc) {
  const tekst = String(wartosc ?? '');
  return poleCsv(/^[=+\-@\t\r]/.test(tekst) ? "'" + tekst : tekst);
}

export function nazwaPlikuSprzedazy(od, doDnia) {
  return `sprzedaz-${od}_${doDnia}.csv`;
}

/**
 * @param {object[]} wiersze prosto ze `sprzedazWOkresie`
 * @param {{zKlientem?: boolean}} opcje `zKlientem` dokłada kolumnę z e-mailem
 *
 * ⚠️ E-MAIL JEST WYLACZONY DOMYSLNIE. Do uzgodnienia z KPiR wystarcza numer i kwota, a plik
 * z adresami klientow wynosi dane osobowe z panelu na czyjs dysk — i zyje tam potem wlasnym
 * zyciem (audyt bezpieczenstwa 17.08: retencja RODO jest sprawa otwarta). Kto potrzebuje
 * adresow, dopisuje `klient=1` swiadomie.
 */
export function csvSprzedazy(wiersze, { zKlientem = false } = {}) {
  const naglowek = zKlientem ? [...KOLUMNY, 'E-mail'] : KOLUMNY;
  const linie = [naglowek.map(pole).join(';')];
  for (const w of wiersze ?? []) {
    const komorki = [
      poleCsv(w.dzien),
      pole(w.kanal),
      pole(w.numer ?? ''),
      pole(ZRODLO[w.zrodlo] ?? w.zrodlo),
      poleCsv(kwota(w.bruttoGrosze)),
      poleCsv(kwota(w.nettoGrosze)),
      poleCsv(takNie(w.faktura)),
      poleCsv(takNie(w.oplacone)),
    ];
    if (zKlientem) komorki.push(pole(w.email ?? ''));
    linie.push(komorki.join(';'));
  }
  return linie.join(KONIEC_LINII);
}
