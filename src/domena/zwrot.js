import { grosze, zl } from './kwoty.js';
// Klucz pozycji zamowienia — TA SAMA regula, ktorej uzywa `pozycje_reczne_json`.
// Powtorzona tu bylaby druga tozsamoscia pozycji i rozjechalaby sie przy pierwszej zmianie.
import { kluczPozycji } from './pozycje-reczne.js';
// ⚠️ JEDYNA definicja „kwoty zamowienia" w panelu — patrz komentarz przy barierze kwoty nizej.
// `wysylkaBruttoGrosze` to z kolei JEDYNA definicja „ile kosztowala dostawa" (wartosc EFEKTYWNA,
// po recznych poprawkach) — czyta ja karta, faktura i sufit zwrotu dostawy nizej.
import { kwotaOczekiwanaGrosze, wysylkaBruttoGrosze } from './suma-pozycji.js';
import { NAZWA_ZAPASOWA } from './nazwa-programu.js';

// Regula zwrotu. Modul jest CZYSTY: dostaje zamowienie i cialo formularza, oddaje gotowy
// ksztalt do zapisu albo odmowe po polsku. Bazy nie dotyka (to db/zwroty.js), a trasa
// nie liczy tu niczego u siebie.

const tekst = (s) => {
  const t = String(s ?? '').trim();
  return t || null;
};

// ⚠️ PRZECINEK DZIESIETNY. DOKLADNIE ta sama normalizacja, co w `parsujWplate`
// (domain/platnosci.js) — i z tego samego, spisanego tam powodu: „przecinek dziesietny to to,
// co czlowiek w Polsce naprawde wpisuje […] odrzucanie go tutaj byloby niespojnoscia w obrebie
// jednego panelu". Tak samo robia `parsujKosztReczny`, `parsujCeneBrutto` i dane miesieczne.
//
// ⚠️⚠️ TO JEST EKRAN, NA KTORYM OPERATOR PRZEPISUJE KWOTE Z ALLEGRO — a tam kwota stoi
// Z PRZECINKIEM. Zmierzone przed poprawka (recenzja 2026-08-15): `kwota: '310,33'` konczylo
// sie komunikatem „Kwota nie jest liczbą" i prawdziwego zwrotu nie dalo sie zapisac wcale.
//
// Normalizacja NICZEGO NIE PRZEPUSZCZA: `grosze()` dalej odmawia wszystkiemu, co nie jest
// liczba — zmienia sie wylacznie separator, tak jak w tamtym module.
//
// ⚠️ `typeof === 'string'`, a NIE `String(...)` — dokladnie jak `kwotaGr` w
// domain/koszt-reczny.js. Owiniecie wszystkiego w `String()` zamienialoby wartosc logiczna
// z formularza w napis „true", ktorego `grosze()` juz nie sparsuje; straznik z Zadania 1
// (tests/oms/zwrot-domena.test.js) pilnuje dokladnie tego, ze taka wartosc ma przejsc przez
// `grosze()/zl()`, a nie odbic sie o wlasna normalizacje.
//
// ⚠️ EKSPORTOWANA od 2026-08-15 (przebudowa ekranu zwrotu na dwa kroki). Podpowiedzi kwot na
// kroku 1 i suma liczona przez serwer (domain/zwrot-formularz.js) czytaja DOKLADNIE TE SAMA
// normalizacje — druga kopia znaczylaby, ze „310,33" przechodzi tam, gdzie sie odbija, albo
// odwrotnie. Brief tej przebudowy mowi to wprost: „jest juz normalizacja — uzyj jej, nie pisz
// drugiej".
export const normalizujKwote = (surowa) => (typeof surowa === 'string' ? surowa.trim().replace(',', '.') : surowa);

const kwotaPusta = (surowa) => surowa === null || surowa === undefined
  || (typeof surowa === 'string' && surowa.trim() === '');

// `parsujHurtPozycji` (domain/pozycje-reczne.js) zszywa rownolegle tablice i odmawia CALEGO
// zapisu, gdy ktoras jest krotsza. Tutaj jest tak samo i z tego samego powodu: przesuniecie
// o jeden przypisaloby ilosc z pozycji A do pozycji B — czyli zwrocilo nie ten szablon.
//
// ⚠️ EKSPORTOWANA od 2026-08-15 (dwa kroki ekranu zwrotu): krok 2 i „Wstecz — popraw" czytaja
// TE SAMA tablice wierszy, co zapis (domain/zwrot-formularz.js). Drugi czytnik rownoleglych
// tablic rozjechalby sie przy pierwszej zmianie nazw pol formularza.
/**
 * Jedno pole formularza jako TABLICA — przegladarka wysyla pojedynczy wiersz jako wartosc,
 * a kilka wierszy jako tablice, i kazdy czytelnik rownoleglych tablic musi to widziec tak samo.
 *
 * ⚠️ EKSPORTOWANA od 2026-08-15 (naprawa „kwota podaza za iloscia"): krok 2 czyta jeszcze jedna
 * rownolegla tablice — `pozycja_kwota_propozycja` (domain/zwrot-formularz.js). Druga kopia tego
 * jednego wyrazenia rozjechalaby sie przy pierwszej zmianie ksztaltu ciala.
 */
export const listaPolaFormularza = (body, pole) => (Array.isArray(body?.[pole])
  ? body[pole]
  : [body?.[pole]].filter((x) => x !== undefined));

export function wierszeFormularzaZwrotu(body) {
  const lista = (p) => listaPolaFormularza(body, p);
  const klucze = lista('klucz');
  const ilosci = lista('ilosc');
  const nazwy = lista('nazwa');
  const kwoty = lista('pozycja_kwota');
  if (new Set([klucze.length, ilosci.length, nazwy.length, kwoty.length]).size !== 1) return null;
  return klucze.map((klucz, i) => ({
    klucz_pozycji: String(klucz),
    nazwa: String(nazwy[i] ?? ''),
    ilosc: Number(ilosci[i]),
    kwota: kwoty[i],
  }));
}

/**
 * Ile SZTUK i za ile GROSZY danej pozycji wrocilo we WCZESNIEJSZYCH zwrotach.
 *
 * ⚠️ EKSPORTOWANA i liczaca TAKZE KWOTY od 2026-08-15 (dwa kroki ekranu zwrotu). Bariera sztuk
 * nizej potrzebuje samych sztuk, ale podpowiedz kwoty na kroku 1 (domain/zwrot-formularz.js)
 * musi wiedziec, ile ZLOTOWEK z tej linii juz wrocilo — inaczej drugi zwrot czesciowy
 * proponowalby kwote policzona od pelnej wartosci linii. Jedna funkcja, bo „co juz wrocilo"
 * jest JEDNYM faktem: dwa liczniki tego samego rozjechalyby sie przy pierwszej zmianie
 * ksztaltu zwrotu.
 *
 * `zwroty_pozycje.kwota` jest w schemacie `TEXT NOT NULL` i zapisuje ja wylacznie
 * `zl(grosze(...))` z `parsujZwrot`, wiec `grosze()` ma tu z czego liczyc.
 */
export function juzZwrocone(zwroty) {
  const mapa = new Map();
  for (const w of zwroty ?? []) {
    for (const p of w.pozycje ?? []) {
      const dotad = mapa.get(p.klucz_pozycji) ?? { ilosc: 0, kwotaGr: 0 };
      mapa.set(p.klucz_pozycji, {
        ilosc: dotad.ilosc + Number(p.ilosc ?? 0),
        kwotaGr: dotad.kwotaGr + (kwotaPusta(p.kwota)
          ? 0 : grosze(normalizujKwote(p.kwota), 'kwota zwróconej pozycji')),
      });
    }
  }
  return mapa;
}

export function sumaZwrotowGrosze(zwroty) {
  return (zwroty ?? []).reduce(
    (s, w) => s + grosze(w.kwota, 'zwrot') + (w.kwota_dostawy ? grosze(w.kwota_dostawy, 'zwrot dostawy') : 0),
    0,
  );
}

/**
 * Ile KOSZTU DOSTAWY oddano juz we wczesniejszych zwrotach, w groszach.
 *
 * ⚠️ Osobno od `sumaZwrotowGrosze`, bo to jest INNE pytanie: tamta liczy „ile pieniedzy wrocilo
 * z tego zamowienia" (i wchodzi do bariery lacznej), ta — „ile z tego bylo dostawa" (i wchodzi
 * do jej wlasnego sufitu). Zlepienie obu w jedna liczbe zabraloby sufitowi dostawy jego miare.
 */
export function sumaZwroconejDostawyGrosze(zwroty) {
  return (zwroty ?? []).reduce(
    (s, w) => s + (kwotaPusta(w?.kwota_dostawy)
      ? 0 : grosze(normalizujKwote(w.kwota_dostawy), 'zwrot dostawy')),
    0,
  );
}

/**
 * ⚠️⚠️ ODMOWA DLA CALEGO ZAMOWIENIA — JEDNO ZDANIE, DWA MIEJSCA (drobiazg 2, recenzja
 * 2026-08-15).
 *
 * Do tego dnia regula zyla WYLACZNIE wewnatrz `parsujZwrot`, wiec ekran nowego zwrotu rysowal
 * zamowieniu anulowanemu pelny, wypelniony formularz — z podsumowaniem, podpowiedziami sztuk
 * i kwot — i odmawial dopiero PO kliknieciu „Zarejestruj zwrot", na ekranie bez zadnych pol.
 * Ekran ma o tym powiedziec OD RAZU, ale nie ma prawa miec na to WLASNEGO zdania: czlowiek,
 * ktory przeczyta na kroku 1 co innego, niz oddaje zapis, przestaje ufac obu.
 *
 * `null` znaczy „nie ma powodu, zeby odmowic calemu zamowieniu" — reszte regul (data, sztuki,
 * kwoty) liczy `parsujZwrot` z konkretnego ciala formularza.
 */
export function powodOdmowyRejestracjiZwrotu(z) {
  if (z?.anulowane || z?.anulowane_recznie) {
    return 'To zamówienie jest anulowane — nie ma czego zwracać.';
  }
  return null;
}

export function parsujZwrot(z, body, { dzis }) {
  const odmowa = (blad) => ({ zwrot: null, blad });
  const odmowaZamowienia = powodOdmowyRejestracjiZwrotu(z);
  if (odmowaZamowienia) return odmowa(odmowaZamowienia);

  const data = String(body?.data ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return odmowa('Podaj datę zwrotu w formacie RRRR-MM-DD.');
  if (data > dzis) return odmowa('Data zwrotu nie może być z przyszłości.');
  // Dzien zamowienia bierzemy z jego wlasnego znacznika, ucietego do daty: `utworzone_at`
  // niesie dwa formaty naraz (reczne — UTC z „Z"; sklepowe — czas Warszawy bez strefy),
  // wiec porownujemy DNI, nie znaczniki.
  const dzienZamowienia = String(z?.utworzone_at ?? '').slice(0, 10);
  if (dzienZamowienia && data < dzienZamowienia) {
    return odmowa('Data zwrotu nie może być przed zamówieniem.');
  }

  const surowe = wierszeFormularzaZwrotu(body);
  if (!surowe) return odmowa('Formularz zwrotu przyszedł niekompletny — panel niczego nie zapisał.');

  let kwotaGr;
  let dostawaGr;
  try {
    kwotaGr = kwotaPusta(body?.kwota) ? 0 : grosze(normalizujKwote(body.kwota), 'kwota zwrotu');
    dostawaGr = kwotaPusta(body?.kwota_dostawy)
      ? 0 : grosze(normalizujKwote(body.kwota_dostawy), 'zwrot dostawy');
  } catch (e) {
    return odmowa(e.message);
  }
  if (kwotaGr < 0 || dostawaGr < 0) return odmowa('Kwota zwrotu nie może być ujemna.');

  // ⚠️⚠️ SUFIT ZWROTU DOSTAWY (drobiazg 4, recenzja 2026-08-15). `kwota_dostawy` nie miala
  // ZADNEGO ogranicznika od gory — zmierzone: recznie sklecony POST zapisywal zwrot dostawy
  // 139,00 zl przy dostawie 19,00 zl. Bariera laczna nizej tego NIE LAPIE, bo kwota zamowienia
  // jest zwykle wielokrotnie wieksza od kosztu dostawy.
  //
  // Skutek nie jest kosmetyczny: `paryKorekty` (domain/korekta-pozycje.js) sklada korekte
  // z linii DOSTAWY z zamowienia i odmawia dokumentu na kwote, ktorej w tym zamowieniu nie ma —
  // czyli zwrot zostaje nierozliczalny, a wyjsciem jest `UPDATE` na produkcyjnej bazie.
  //
  // ⚠️ Miara to `wysylkaBruttoGrosze` — wartosc EFEKTYWNA (po recznej poprawce wysylki), TA SAMA,
  // ktora stoi na karcie, w kwocie oczekiwanej i w linii „Dostawa" na fakturze. Kolumna
  // `koszt_dostawy_brutto` sama byloby druga definicja tej liczby.
  //
  // ⚠️ POMNIEJSZONY O ODDANE WCZESNIEJ — bez tego dostawe dalo by sie oddac dwa razy w calosci,
  // a przy duzym zamowieniu nie zauwazylaby tego zadna inna bariera. Ekran kroku 1 odmawia
  // proponowania dostawy oddanej wczesniej z tego samego powodu, ale przegladarke da sie obejsc.
  let dostawaZostalaGr;
  try {
    dostawaZostalaGr = Math.max(
      wysylkaBruttoGrosze(z) - sumaZwroconejDostawyGrosze(z?.zwroty),
      0,
    );
  } catch (e) {
    return odmowa(e.message);
  }
  if (dostawaGr > dostawaZostalaGr) {
    return odmowa(
      `Zwrot dostawy (${zl(dostawaGr)} zł) przekracza koszt dostawy tego zamówienia`
      + ` — do oddania zostało ${zl(dostawaZostalaGr)} zł.`
      + ' Korekta i tak odmówiłaby dokumentu na kwotę, której w tym zamówieniu nie ma.',
    );
  }

  const pozycje = [];
  // ⚠️ Suma pozycji W GROSZACH, licznona rownolegle z petla nizej — patrz bariera spojnosci
  // pod petla. Grosze z `pozycjaGr` (juz przepuszczone przez grosze()), NIGDY z parsowania
  // stringow floatowych jeszcze raz.
  let sumaPozycjiGr = 0;
  const wczesniej = juzZwrocone(z?.zwroty);
  const kupione = new Map((z?.pozycje ?? []).map((p, i) => [kluczPozycji(p, i), Number(p.ilosc ?? 0)]));
  for (const w of surowe) {
    if (!Number.isFinite(w.ilosc) || w.ilosc < 0) return odmowa(`Ilość przy „${w.nazwa}" nie jest liczbą.`);
    if (!Number.isInteger(w.ilosc)) return odmowa(`Ilość przy „${w.nazwa}" musi być liczbą całkowitą.`);
    if (w.ilosc === 0) continue;
    const dostepne = (kupione.get(w.klucz_pozycji) ?? 0) - (wczesniej.get(w.klucz_pozycji)?.ilosc ?? 0);
    if (w.ilosc > dostepne) {
      return odmowa(
        `Nie da się zwrócić ${w.ilosc} sztuk „${w.nazwa}" — do zwrotu zostało ${Math.max(dostepne, 0)} sztuk.`,
      );
    }
    let pozycjaGr;
    try {
      pozycjaGr = grosze(normalizujKwote(w.kwota), `kwota przy „${w.nazwa}"`);
    } catch (e) { return odmowa(e.message); }
    sumaPozycjiGr += pozycjaGr;
    pozycje.push({ klucz_pozycji: w.klucz_pozycji, nazwa: w.nazwa, ilosc: w.ilosc, kwota: zl(pozycjaGr) });
  }

  if (!pozycje.length && dostawaGr === 0) {
    // M1: to JEDYNY komunikat, jaki operator dostanie w tej sytuacji — ma byc zdaniem po polsku.
    return odmowa('Zwrot musi obejmować co najmniej jedną pozycję albo zwrot kosztu dostawy — wpisz ilość przy pozycji lub kwotę dostawy.');
  }
  if (kwotaGr === 0 && dostawaGr === 0) return odmowa('Kwota zwrotu musi być większa od zera.');

  // ⚠️⚠️ BARIERA SPÓJNOŚCI KWOTY (znalezisko recenzji, przeoczone przy poprzedniej fali
  // napraw — 2026-08-15). `kwota` (kwota łączna zwrotu za pozycje) i suma `pozycja_kwota` są
  // DWIEMA liczbami, które operator wpisuje RĘCZNIE, niezależnie od siebie — do tego dnia
  // `parsujZwrot` nie sprawdzał między nimi żadnej relacji. Zmierzone: `kwota: '79.00'` z
  // jedną pozycją na `99.00` przechodziło BEZ SŁOWA — `zwrotyWOkresie` (raport,
  // domain/agregacja-sprzedazy.js) czyta `zwroty.kwota` i zdejmuje z przychodu 79,00 zł, a
  // `paryKorekty` (domain/korekta-pozycje.js) składa dokument korekty w inFakcie z
  // `zwroty_pozycje.kwota`, czyli na 99,00 zł. Rozjazd między KPiR a rejestrem VAT, niewidoczny
  // na żadnym ekranie panelu (formularz świadomie nie ma podglądu sumy — zero JavaScriptu na
  // ekranie zwrotu, patrz zwrot.ejs), więc pomyłka jest naturalna, nie egzotyczna.
  //
  // ⚠️ KWOTA ZOSTAJE EDYTOWALNA — decyzja właściciela brzmi „kwotę przepisujesz z Allegro i to
  // ONA jest prawdą" (patrz komentarz przy polu w zwrot.ejs). Ta bariera pilnuje WYŁĄCZNIE
  // spójności obu liczb, a nie narzuca arytmetyki: gdy Allegro oddało inną kwotę niż suma
  // pozycji, to KWOTY PRZY POSZCZEGÓLNYCH POZYCJACH są tym, co operator poprawia, żeby się
  // zgadzały z kwotą z Allegro — nie odwrotnie. Komunikat mówi to wprost.
  //
  // ⚠️ ZWROT SAMEJ DOSTAWY (brak pozycji) nie ma prawa się o tę barierę odbić — i nie odbija
  // się: pusta pętla wyżej daje `sumaPozycjiGr = 0`, a jedyny sposób, żeby przy braku pozycji
  // ominąć barierę `kwotaGr === 0 && dostawaGr === 0` powyżej, to header `kwota` RÓWNE zero.
  // Zero zawsze zgadza się z zerem — ta bariera nie ma więc w tym przypadku czego blokować
  // (dowód, nie założenie: patrz test „zwrot SAMEJ dostawy" w zwrot-domena.test.js).
  //
  // Arytmetyka WYŁĄCZNIE w groszach: `sumaPozycjiGr` to suma już przepuszczonych przez
  // `grosze()` wartości z pętli wyżej, nigdy ponowne parsowanie stringów na floatach —
  // 0,10 zł + 0,20 zł na floatach w JS to 0.30000000000000004, nie 0.30.
  if (kwotaGr !== sumaPozycjiGr) {
    return odmowa(
      `Kwota zwrotu (${zl(kwotaGr)} zł) nie zgadza się z sumą kwot przy pozycjach (${zl(sumaPozycjiGr)} zł)`
      + ` — różnica ${zl(Math.abs(kwotaGr - sumaPozycjiGr))} zł. Kwotę przepisujesz z Allegro — to ona`
      + ' jest prawdą; popraw kwoty przy poszczególnych pozycjach tak, żeby ich suma się zgadzała.',
    );
  }

  // ⚠️ BARIERA KWOTY. To jedyna obrona przed literowka „31033" zamiast „310,33": panel nie
  // wysyla pieniedzy, ale ta kwota idzie WPROST do raportu i do korekty. Liczona po WSZYSTKICH
  // wczesniejszych zwrotach tego zamowienia.
  //
  // ⚠️⚠️ MIARA TO `kwotaOczekiwanaGrosze`, A NIE KOLUMNA `kwota_brutto` (recenzja 2026-08-15).
  // Panel ma na „kwote zamowienia" JEDNA funkcje (domain/suma-pozycji.js) i to ona rzadzi
  // saldem wplat, bariera arytmetyczna faktury i ostrzezeniem pod tabela pozycji. `kwota_brutto`
  // jest kolumna SKLEPU i CELOWO nie rosnie od naszych dopiskow — komentarz w
  // domain/pozycje-faktury.js opisuje wprost, ze porownywanie z nia „kazaloby barierze odmawiac
  // KAZDEMU zamowieniu z dopisana pozycja". Zmierzone: zamowienie 100,00 zl + dopisana doplata
  // 50,00 zl, faktura na 150,00 zl, klient oddaje wszystko → „Suma zwrotów (150,00 zł) przekracza
  // kwotę zamówienia (100,00 zł)" i PRAWDZIWEGO ZWROTU NIE DALO SIE ZAPISAC.
  //
  // `try` jest tu z tego samego powodu, co przy kwotach wyzej: `kwotaOczekiwanaGrosze` chodzi po
  // pozycjach i rzuca `bladOperatora` przy pozycji bez ceny. Ta funkcja NIGDY nie rzuca — oddaje
  // odmowe po polsku, a trasa jej nie lapie.
  let zamowienieGr;
  try {
    zamowienieGr = kwotaOczekiwanaGrosze(z);
  } catch (e) {
    return odmowa(e.message);
  }
  const razem = sumaZwrotowGrosze(z?.zwroty) + kwotaGr + dostawaGr;
  if (razem > zamowienieGr) {
    return odmowa(
      `Suma zwrotów (${zl(razem)} zł) przekracza kwotę zamówienia (${zl(zamowienieGr)} zł).`,
    );
  }

  return {
    blad: null,
    zwrot: {
      data,
      kwota: zl(kwotaGr),
      kwotaDostawy: dostawaGr ? zl(dostawaGr) : null,
      powod: tekst(body?.powod),
      pozycje,
    },
  };
}

/**
 * ⚠️⚠️ TOZSAMOSC ZWROTU — po niej `dodajZwrot` (db/zwroty.js) poznaje POWTORNE WYSLANIE tego
 * samego formularza. Bariery liczy `parsujZwrot` POZA transakcja, wiec bez tego sita back +
 * ponowne zatwierdzenie (albo dwuklik, albo dwie otwarte karty) dawalo DRUGI IDENTYCZNY ZWROT:
 * suma zwrotow sie podwaja, a raport zdejmuje kwote z przychodu DWA RAZY. Specyfikacja nazywa
 * „back+resubmit i dwie otwarte karty" znana droga do drugiego dokumentu i przy korekcie obrona
 * jest (`zarezerwujKorekte`) — przy rejestracji jej nie bylo.
 *
 * Zwrot to TEN SAM zwrot, gdy zgadzaja sie: dzien, kwota, kwota dostawy i ZESTAW pozycji
 * (klucz + ilosc). Kolejnosc pozycji nie ma znaczenia — formularz odsyla je w kolejnosci
 * tabeli, ale to nie jest fakt o zwrocie.
 *
 * ⚠️ Porownanie IDZIE PRZEZ `grosze()`, nie po napisach: '99.00' i '99.0' to ta sama kwota,
 * a rownosc napisow przepuscilaby duplikat przy pierwszej zmianie sposobu formatowania.
 *
 * ⚠️ Funkcja czyta OBA ksztalty naraz — `kwotaDostawy` (wyjscie `parsujZwrot`, czyli kandydat
 * z formularza) i `kwota_dostawy` (kolumna z bazy). Porownujemy wlasnie te dwie strony, wiec
 * przepisywanie jednej na druga u wolajacego byloby trzecim miejscem, w ktorym ta sama rzecz
 * nazywa sie inaczej.
 */
function odciskZwrotu(w) {
  const gr = (v) => (v === null || v === undefined || String(v).trim() === '' ? 0 : grosze(v, 'zwrot'));
  const pozycje = (w?.pozycje ?? [])
    .map((p) => `${p.klucz_pozycji}×${Number(p.ilosc)}`)
    .sort()
    .join('|');
  return [String(w?.data ?? ''), gr(w?.kwota), gr(w?.kwota_dostawy ?? w?.kwotaDostawy), pozycje].join('#');
}

export const czyTenSamZwrot = (a, b) => odciskZwrotu(a) === odciskZwrotu(b);

/**
 * Zwrot ROZLICZONY = pieniadze oddane ORAZ, gdy zamowienie ma fakture, istnieje korekta.
 *
 * ⚠️ Ta funkcja rzadzi lista robocza (`doZrobienia`), a nie statusem. Status „Zwrot" jest
 * KONCOWY i zostaje na zawsze (decyzja wlasciciela) — ale zamowienie z nieoddanymi pieniedzmi
 * ma zostac na liscie do zrobienia, bo jest tam robota. To ten sam wzorzec, ktorym panel
 * trzyma na liscie fakture wymagajaca czlowieka.
 */
export function zwrotRozliczony(z, w) {
  if (!w?.pieniadze_oddane_at) return false;
  if (z?.faktura) return Boolean(w.korekta_numer);
  return true;
}

// Prog dobrany z obserwacji zasobu asynchronicznego inFaktu (numer KSeF pojawia sie tam
// po ~70 s; korekta jest prostsza). Kwadrans jest wielokrotnie dluzszy niz przetwarzanie
// i wielokrotnie krotszy niz dzien pracy — czyli komunikat pojawia sie tego samego dnia.
export const PROG_PRZEPADNIECIA_KOREKTY_MIN = 15;

/**
 * Czy zlecenie korekty przepadlo. ⚠️ `201` z inFaktu NIE dowodzi, ze tresc byla poprawna
 * (zmierzone 2026-08-14 pustym cialem), wiec brak numeru po progu jest JEDYNYM sygnalem
 * odrzucenia, jaki panel dostanie.
 */
export function korektaPrzepadla(w, { teraz = new Date().toISOString() } = {}) {
  if (!w?.korekta_zlecona_at || w.korekta_numer) return false;
  const minut = (Date.parse(teraz) - Date.parse(w.korekta_zlecona_at)) / 60000;
  return Number.isFinite(minut) && minut > PROG_PRZEPADNIECIA_KOREKTY_MIN;
}

/**
 * „Otwarta sprawa korekty" = zwrot BEZ numeru korekty (przy zafakturowanym zamowieniu, ktore
 * jest jedynym miejscem, gdzie ta lista w ogole ma sens — patrz `doczytaj` w
 * services/korekta.js). Kazdy taki zwrot moze jeszcze dostac numer, wiec kazdy jest
 * kandydatem do pomylki: encja korekty w inFakcie nie niesie referencji do zwrotu.
 */
export function wiecejNizJedenOtwartySprawaKorekty(zwroty) {
  return (zwroty ?? []).filter((x) => !x.korekta_numer).length > 1;
}

/**
 * ⚠️⚠️ CZY `doczytaj` (services/korekta.js) SWIADOMIE NIE ZAPYTAL INFAKTU O TEN ZWROT —
 * recenzja kontrolna 2026-08-15, WARUNEK ODBLOKOWANIA.
 *
 * `doczytaj` wychodzi PRZED zapytaniem do inFaktu, gdy to zamowienie ma wiecej niz jeden
 * zwrot z otwarta sprawa korekty (patrz docblock tamtej funkcji) — bo nie ma jak rozstrzygnac,
 * KTORY z dwoch nierozliczonych zwrotow opisuje znaleziony dokument. To jest SWIADOMA DECYZJA
 * i ma zostac.
 *
 * ALE: widok ekranu zwrotu czytal do tego dnia WYLACZNIE `korektaPrzepadla` (proba czasu) i po
 * przekroczonym progu pisal „inFakt nie wystawił dokumentu — zlecenie zostało odrzucone" —
 * zdanie O FAKCIE, KTOREGO PANEL NIE ZNA, bo `doczytaj` nigdy nie zapytal. Czlowiek, ktory w to
 * uwierzy, odblokuje rezerwacje i otworzy droge do DRUGIEGO DOKUMENTU u organu podatkowego.
 *
 * Ta funkcja jest JEDYNYM miejscem, ktore liczy „czy pytalismy" — `doczytaj` i trasa ekranu
 * zwrotu (routes/zwroty.js) czytaja DOKLADNIE TO SAMO zdanie. Widok (zwrot.ejs) tej reguly
 * NIE LICZY, tylko dostaje gotowa odpowiedz od trasy.
 */
export function korektaNieSprawdzona(w, zwroty) {
  if (!w?.korekta_zlecona_at || w.korekta_numer) return false;
  return wiecejNizJedenOtwartySprawaKorekty(zwroty);
}

export function powodOdmowyUsunieciaZwrotu(w) {
  if (w?.pieniadze_oddane_at) {
    return 'Do tego zwrotu pieniądze zostały już oddane — skasowanie zostawiłoby wypłatę bez podstawy.';
  }
  // ⚠️ NUMER SPRAWDZAMY OSOBNO, PRZED REZERWACJA (2026-08-15). Do czasu, gdy numer korekty
  // zapisywala WYLACZNIE sciezka przez rezerwacje, warunek nizej wystarczal: numer nie mial
  // prawa istniec bez `korekta_zlecona_at`. „Korektę wystawiłem ręcznie" zapisuje numer BEZ
  // rezerwacji (korekta powstala poza panelem), wiec bez tej linii taki zwrot dawalby sie
  // skasowac, a w inFakcie zostawalaby korekta bez podstawy.
  if (w?.korekta_numer) {
    return `Do tego zwrotu jest już korekta ${w.korekta_numer} — skasowanie zostawiłoby ją bez podstawy.`;
  }
  if (w?.korekta_zlecona_at) {
    return 'Do tego zwrotu zlecono już korektę — skasowanie zostawiłoby korektę bez podstawy.';
  }
  return null;
}

/**
 * ⚠️⚠️ WYJSCIE ZE STANU, W KTORY PANEL SAM POZWALA WEJSC (przewodnik OMS, 4.9).
 *
 * Zmierzone na zywym koncie 2026-08-14: inFakt oddaje `201` NAWET NA PUSTE CIALO i odrzuca
 * tresc dopiero w przetwarzaniu w tle. Sekwencja, ktora sie przez to zdarza: operator klika
 * „Wystaw korektę" → `201` → `korekta_zlecona_at` ustawione → walidacja w tle odrzuca dokument
 * → po progu ekran pisze „zlecenie zostało odrzucone". I na tym KONIEC: przycisku „Wystaw
 * korektę" juz nie ma (`!w.korekta_zlecona_at`), skasowania zwrotu odmawia
 * `powodOdmowyUsunieciaZwrotu`, a zwrot zostaje NIEROZLICZONY NA ZAWSZE, trzymajac zamowienie
 * na liscie roboczej. Jedynym wyjsciem byl `UPDATE` na produkcyjnej bazie.
 *
 * ⚠️ PROG NIE ZWALNIA REZERWACJI SAM — decyzje podejmuje CZLOWIEK, ktory sprawdzil w inFakcie.
 * To ta sama regula, co przy zerwanym polaczeniu (services/korekta.js) i przy `odblokujFakture`:
 * zaden uplyw czasu nie jest dowodem, ze dokument nie powstal. Prog wyznacza tylko moment,
 * od ktorego wolno CZLOWIEKOWI rozstrzygnac.
 */
/**
 * ⚠️⚠️ JEDNA REGULA PROGU DLA OBU DECYZJI CZLOWIEKA PRZY ZLECENIU, KTORE JESZCZE TRWA
 * (K2, recenzja kontrolna 2026-08-15).
 *
 * Panel ma DWIE drogi wyjscia ze zlecenia korekty: „sprawdziłem w inFakcie, korekty nie ma —
 * odblokuj" i „korektę wystawiłem ręcznie". Przed progiem OBIE znacza to samo: czlowiek
 * rozstrzyga o dokumencie, ktory inFakt moze wlasnie przetwarzac. Odblokowanie mialo bariere,
 * reczny numer NIE MIAL ZADNEJ — zmierzone: rezerwacja sprzed minuty, POST `/korekta/reczna`
 * → 302, numer zapisany, `korekta_zlecona_at` zostaje. Skutek to DWA dokumenty do jednej
 * faktury, ktorych `doczytaj` juz nie zauwazy (wychodzi na `korekta_numer`), `odblokuj`
 * odmowi, a zwrot zamelduje sie jako rozliczony.
 *
 * Regula stoi TUTAJ, w jednym miejscu, i obie drogi czytaja DOKLADNIE TO SAMO ZDANIE. Dwie
 * kopie rozjechalyby sie przy pierwszej zmianie progu — a rozjechany prog to znowu duplikat
 * u organu.
 */
function powodOdmowyPrzyZleceniuWToku(w, { teraz, nazwa = NAZWA_ZAPASOWA }) {
  if (!w?.korekta_zlecona_at || korektaPrzepadla(w, { teraz })) return null;
  return `Od zlecenia korekty nie minęło jeszcze ${PROG_PRZEPADNIECIA_KOREKTY_MIN} minut — `
    + `${nazwa.mianownik} może ją właśnie przetwarzać. Odśwież ten ekran za chwilę; numer pojawi się sam. `
    + 'Rozstrzyganie o tej korekcie teraz dałoby drugi dokument do tej samej faktury.';
}

export function powodOdmowyOdblokowaniaKorekty(w, { teraz = new Date().toISOString(), nazwa = NAZWA_ZAPASOWA } = {}) {
  if (w?.korekta_numer) {
    return `Korekta ${w.korekta_numer} do tego zwrotu istnieje — nie ma czego odblokowywać. `
      + 'Odblokowanie otworzyłoby drogę do drugiej korekty do tej samej faktury.';
  }
  if (!w?.korekta_zlecona_at) {
    return 'Do tego zwrotu nie ma zleconej korekty — nie ma czego odblokowywać.';
  }
  return powodOdmowyPrzyZleceniuWToku(w, { teraz, nazwa });
}

/**
 * ⚠️⚠️ JEDNA KOREKTA NA FAKTURE — REGULA, NIE WYGODA (K1 + W4, recenzja kontrolna 2026-08-15).
 *
 * Zwrotow do jednego zamowienia bywa kilka (specyfikacja dopuszcza to wprost), ale panel czyta
 * ZAWSZE FAKTURE PIERWOTNA. Dla drugiego zwrotu czesciowego zlozylby wiec dokument mowiacy
 * „z 2 szt. na 1 szt." wtedy, gdy pierwsza korekta juz te sztuke zdjela — czyli korekte
 * in minus policzona u organu DWA RAZY. Zeby zlozyc ja poprawnie, trzeba by odtworzyc stan
 * „przed" jako faktura MINUS wszystkie wczesniejsze korekty; panel tego nie umie i dopoki nie
 * umie, ma o tym POWIEDZIEC, a nie wystawic dokument.
 *
 * ⚠️ Regula mieszka TUTAJ, a UZYWAJA jej DWIE warstwy i to jest celowe:
 *   • usluga (services/korekta.js) — zeby odmowa przyszla PRZED dotknieciem inFaktu i po polsku,
 *   • baza (db/zwroty.js, wewnatrz `BEGIN IMMEDIATE`) — bo sprawdzenie POZA transakcja
 *     przepuszczalo DWA rownolegle zgloszenia na dwa zwroty tego samego zamowienia: oba
 *     czytaly „nikt inny nie ma korekty" i oba rezerwowaly wlasny wiersz.
 * To ten sam uklad, co przy `czyTenSamZwrot` i `dodajZwrot`.
 *
 * ⚠️ Warunek obejmuje `korekta_zlecona_at` RAZEM z `korekta_numer`, bo zlecenie bez numeru tez
 * moglo powolac dokument (`201` z inFaktu nie dowodzi niczego w zadna strone — notatka
 * 2026-08-14-oms-zwroty-pomiar.md). Rezerwacja zwolniona po odmowie 4xx ma OBA pola puste, wiec
 * droga do poprawnej korekty zostaje otwarta.
 */
export function powodOdmowyKorektyDlaFaktury(w, zwroty) {
  const inny = (zwroty ?? []).find((x) => x.id !== w?.id && (x.korekta_numer || x.korekta_zlecona_at));
  if (!inny) return null;
  const czym = inny.korekta_numer ? `korektę ${inny.korekta_numer}` : 'korektę zleconą';
  return `Faktura tego zamówienia ma już ${czym} (zwrot z ${inny.data})`
    + ' — drugą wystaw ręcznie w inFakcie. Panel nie umie odtworzyć stanu „przed"'
    + ' po pierwszej korekcie, a błędna korekta liczy się u organu jak prawdziwa.';
}

/**
 * ⚠️⚠️ K1: TEN SAM ZWROT TEZ MOZE JUZ MIEC KOREKTE — I DO 2026-08-15 NIC TEGO NIE PILNOWALO.
 *
 * Bariera wyzej patrzyla wylacznie na INNE zwroty (`x.id !== w.id`), a „Korektę wystawiłem
 * ręcznie" NIE USTAWIA rezerwacji — dla TEGO SAMEGO zwrotu nie bylo wiec zadnej bariery.
 * Zmierzone: zwrot z numerem `9/KOR/08/2026` i pusta rezerwacja przechodzil wszystkie sita,
 * `wystawKorekte` szlo do inFaktu, a `zapiszKorekte` (COALESCE) nadpisywalo numer reczny numerem
 * nowego dokumentu — pierwszy znikal z bazy BEZ SLADU. Droga przez UI: druga otwarta karta albo
 * back+resubmit sprzed wpisania numeru.
 *
 * ⚠️ To jest komunikat DLA CZLOWIEKA. Granica faktu stoi osobno, w SQL-u rezerwacji
 * (`korekta_numer IS NULL` w db/zwroty.js) — bo tamtej nie da sie wyprzedzic wyscigiem.
 * Obie warstwy, nie jedna.
 */
export function powodOdmowyWystawieniaKorekty(w) {
  if (w?.korekta_numer) {
    return `Do tego zwrotu jest już korekta ${w.korekta_numer} — panel drugiej nie wystawi. `
      + 'Drugą korektę do tej samej faktury wystaw ręcznie w inFakcie: panel nie umie odtworzyć '
      + 'stanu „przed" po pierwszej korekcie, a błędna korekta liczy się u organu jak prawdziwa.';
  }
  return null;
}

/**
 * DRUGIE wyjscie: „Korektę wystawiłem ręcznie" — odnotowanie numeru dokumentu, ktory powstal
 * POZA panelem. Panel NICZEGO w inFakcie nie wystawia i niczego tam nie sprawdza: to jest
 * zapis FAKTU, ktory czlowiek juz stwierdzil, dokladnie jak `/faktura/skasowana`.
 *
 * ⚠️ BEZ TEJ DROGI zwrot do faktury skorygowanej poza panelem NIGDY sie nie rozliczy
 * (`zwrotRozliczony` wymaga `korekta_numer`) — a przy DRUGIEJ korekcie do tej samej faktury
 * jest to droga ZALECANA, bo panel odmawia jej swiadomie: nie umie odtworzyc stanu „przed"
 * po pierwszej korekcie (services/korekta.js).
 *
 * Odmowa nadpisania istniejacego numeru to obrona przed dwuklikiem: drugi numer przy tym samym
 * zwrocie znaczylby, ze panel wie o dwoch dokumentach, a rozliczyl jeden.
 *
 * ⚠️⚠️ K2: ODMOWA TAKZE PRZY REZERWACJI W TOKU. Ta droga obchodzila prog, ktorego pilnuje trasa
 * odblokowania — a to jest TA SAMA decyzja o tej samej wadze (patrz
 * `powodOdmowyPrzyZleceniuWToku` wyzej: jedno zdanie, jedno miejsce). Po progu droga zostaje
 * otwarta, bo przy zleceniu, ktore przepadlo, jest to JEDYNE wyjscie.
 */
export function parsujNumerKorekty(w, surowy, { teraz = new Date().toISOString(), nazwa = NAZWA_ZAPASOWA } = {}) {
  const numer = tekst(surowy);
  if (w?.korekta_numer) {
    return {
      numer: null,
      blad: `Ten zwrot ma już zapisaną korektę ${w.korekta_numer} — drugi numer znaczyłby drugi dokument. `
        + `Jeśli pierwszy numer jest błędny, popraw go w ${nazwa.miejscownik} i zgłoś to.`,
    };
  }
  const wToku = powodOdmowyPrzyZleceniuWToku(w, { teraz, nazwa });
  if (wToku) return { numer: null, blad: wToku };
  if (!numer) {
    return { numer: null, blad: `Podaj numer korekty z ${nazwa.dopelniacz} — bez niego nie ma czego odnotować.` };
  }
  return { numer, blad: null };
}
