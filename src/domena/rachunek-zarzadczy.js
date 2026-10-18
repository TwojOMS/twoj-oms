import { sprzedazWOkresie, zwrotyWOkresie } from './sprzedaz-okresu.js';
import { miesiaceOkresu, nazwaOkresu } from './okresy-raportu.js';
import { podatekNarastajaco } from './podatek-skala.js';
import { wskazniki, prowizjaAllegroZaMiesiac } from './wskazniki-zarzadcze.js';
import { kategoriaWiersza } from './lista-kosztow.js';
import { daneOkresu } from '../oms/db/dane-miesieczne.js';
import { kosztyMiesiaca } from '../oms/db/koszty.js';
import { kategoriaDlaNip } from '../oms/db/kategorie-kosztow.js';
import { grosze } from './kwoty.js';

// Rachunek zarzadczy: „ile z tego zostaje", a nie „ile sprzedalismy".
//
// ⚠️⚠️ TO NIE JEST WYNIK KSIEGOWY i ekran ma to pisac wprost. Pelna ksiegowosc prowadzi biuro
// księgowe i jego liczby sa wiazace. Pomiar na I polroczu 2026 pokazal, ze sprzedaz liczona
// po dacie ZAMOWIENIA jest wyzsza od przychodu w KPiR (ksiegowanego po dacie WYSTAWIENIA
// faktury) o ok. 2,5% po odjeciu zwrotow i duplikatow.

/**
 * ⚠️ PODLOGA: kosztow sprzed 2026 NIE MA I NIE BEDZIE — KSeF ruszyl na dobre w maju 2026,
 * a podloga historii kosztow to 1.01.2026. Rachunek za 2025 bylby zyskiem zawyzonym
 * o niewidoczne wydatki, wiec go NIE OFERUJEMY.
 */
export const PODLOGA = null;

/**
 * ⚠️ PODLOGA ZWROTOW: zwrotow sprzed wdrozenia zakladki ZWROTY panel NIE MA W ZADNYM ZRODLE —
 * `zwrotyWOkresie` czyta wylacznie tabele `zwroty`, ktora zaczela sie zapelniac dopiero od tego
 * dnia. Dla zakresu konczacego sie WCZESNIEJ pusty wynik `zwrotyWOkresie` nie znaczy „zwrotow
 * nie bylo", tylko „panel ich nie widzial" — ekran ma pokazac „brak danych", NIGDY 0,00 zl.
 * Ta sama zasada, co przy DROPSHIPPING za 2025 (domain/kanaly-raportowe.js).
 */
export const PODLOGA_ZWROTOW = null;

/**
 * ⚠️ PROG POKRYCIA. Podzial na zmienne i stale policzony z jednej trzeciej wydatkow dalby
 * prog rentownosci, w ktory dałoby sie uwierzyc — a bylby zmysleniem. To naprawilo cichy
 * blad w repo `raporty`: Q2 i polrocze rysowaly rozbicie z samego czerwca, opisujac je jako
 * rozbicie CALEGO okresu.
 */
const PROG_POKRYCIA = 95;

const gr = (s) => (s ? grosze(s, 'kwota') : 0);

// ⚠️ JEDNO MIEJSCE, KTORE SUMUJE `nettoGrosze` Z LISTY WIERSZY SPRZEDAZY/ZWROTOW — uzywaja go
// gorny rachunek (`rachunekOkresu`), rozbicie miesiac po miesiacu (`rachunekMiesiaca`) i dochod
// roku dla podatku (`dochodRoku` nizej). Trzy niezalezne `reduce((s, w) => s + w.nettoGrosze, 0)`
// rozjechalyby sie przy pierwszej zmianie reguly — dokladnie ta sama choroba, przed ktora bronia
// komentarze przy `sprzedazWOkresie`/`zwrotyWOkresie`.
const sumaNetto = (wiersze) => wiersze.reduce((s, w) => s + w.nettoGrosze, 0);

// ⚠️⚠️ KATEGORIA DOKUMENTU WYGRYWA Z MAPA PO NIP-IE — i ta regula ma JEDNO miejsce
// (`kategoriaWiersza` w domain/lista-kosztow.js), z ktorego korzysta zarowno zakladka KOSZTY,
// jak i ten rachunek. Trzecia kopia znaczylaby, ze ekran kosztow i rozbicie w rachunku
// pokazuja dwie rozne kategorie tego samego dokumentu — bez zadnego bledu.
//
// Co to naprawilo (2026-08-14): koszty dopisane recznie — Google, Meta, Anthropic, czyli
// dokladnie te, ktorych w KSeF nie ma i dla ktorych pole kategorii dokumentu w ogole powstalo
// — wchodzily tutaj jako „Nieprzypisane"/„drobne", bo mapa po NIP-ie ich nie zna (jej kluczem
// glownym jest NIP, a oni polskiego NIP-u nie maja). Suma kosztow byla poprawna, wiec nic nie
// krzyczalo; nieprawdziwe bylo ROZBICIE i wszystko, co z niego wynika — prog rentownosci
// i marza po kosztach zmiennych, czyli liczby, na ktorych zapada decyzja operatora.
function kosztyOkresu(db, miesiace) {
  let netto = 0;
  const wgKategorii = new Map();
  const poNipie = (nip) => kategoriaDlaNip(db, nip);
  for (const m of miesiace) {
    for (const k of kosztyMiesiaca(db, m)) {
      const n = gr(k.netto);
      netto += n;
      const przypisanie = kategoriaWiersza(k, poNipie);
      const nazwa = przypisanie?.kategoria ?? 'Nieprzypisane';
      const typ = przypisanie?.typ ?? 'drobne';
      const b = wgKategorii.get(nazwa) ?? { kategoria: nazwa, typ, nettoGrosze: 0, dokumentow: 0 };
      b.nettoGrosze += n;
      b.dokumentow += 1;
      wgKategorii.set(nazwa, b);
    }
  }
  return {
    nettoGrosze: netto,
    kategorie: [...wgKategorii.values()].sort((a, b) => b.nettoGrosze - a.nettoGrosze),
  };
}

/** Ostatni dzien miesiaca 'RRRR-MM' — dzien 0 nastepnego miesiaca. Luty przestepny wychodzi sam. */
const koniecMiesiaca = (miesiac) => new Date(
  Date.UTC(Number(miesiac.slice(0, 4)), Number(miesiac.slice(5, 7)), 0),
).toISOString().slice(0, 10);

function rachunekMiesiaca(db, miesiac, regulySprzedazy) {
  const od = `${miesiac}-01`;
  const doDnia = koniecMiesiaca(miesiac);
  // ⚠️ ZWROT OBCIAZA MIESIAC ZWROTU — TA SAMA regula i TA SAMA funkcja `zwrotyWOkresie`, co
  // w `rachunekOkresu` nizej (art. 14 ust. 1m PIT, art. 29a ust. 13 VAT). Okno [od, doDnia] jest
  // WLASNYM miesiacem tej funkcji, a miesiace kafelkuja zakres bez dziur i bez nakladania sie
  // (`koniecMiesiaca`) — wiec kazdy zwrot wpada do DOKLADNIE JEDNEGO miesiecznego okna, tego,
  // w ktorym faktycznie nastapil, i suma miesiecy zgadza sie z rachunkiem calego okresu co do
  // grosza. Netto liczy `zwrotyWOkresie` sama (nettoZ) — DRUGI RAZ tej arytmetyki tu nie ma,
  // inaczej zwrot zdejmowalby inna kwote netto, niz dodala sprzedaz.
  const zwrotyNetto = sumaNetto(zwrotyWOkresie(db, { od, do: doDnia }, regulySprzedazy));
  const przychod = sumaNetto(sprzedazWOkresie(db, { od, do: doDnia }, regulySprzedazy)) - zwrotyNetto;
  const koszty = kosztyOkresu(db, [miesiac]).nettoGrosze;
  const { miesiace: [dane] = [] } = daneOkresu(db, [miesiac]);
  const zus = gr(dane?.zus_razem);
  const pit5 = gr(dane?.pit5_zaplacony);
  const wynik = przychod - koszty;
  return {
    miesiac,
    przychodNettoGrosze: przychod,
    kosztyNettoGrosze: koszty,
    wynikGrosze: wynik,
    zusGrosze: zus,
    pit5Grosze: pit5,
    zostajeGrosze: dane ? wynik - zus - pit5 : null,
    marza: przychod ? (wynik / przychod) * 100 : 0,
  };
}

export function rachunekOkresu(db, { od, do: doDnia }, { regulySprzedazy = {}, podlogaKosztow = null } = {}) {
  if (!podlogaKosztow) { const e = new Error(BRAK_PODLOGI_KOSZTOW); e.dlaOperatora = true; throw e; }
  if (od.slice(0, 7) < podlogaKosztow) {
    const e = new Error(
      `Rachunek zarządczy zaczyna się od ${podlogaKosztow}: kosztów sprzed KSeF panel nie zna,`
      + ' więc wcześniejszy wynik byłby zyskiem zawyżonym o niewidoczne wydatki.',
    );
    e.dlaOperatora = true;
    throw e;
  }

  const miesiace = miesiaceOkresu({ od, do: doDnia });
  // ⚠️⚠️ PROWIZJA ALLEGRO WYLACZNIE DLA PELNEGO MIESIACA KALENDARZOWEGO, a nie dla „zakresu,
  // ktory miesci sie w jednym miesiacu" (2026-08-14). Zakres 5–20 czerwca ma jeden miesiac na
  // liscie, wiec warunek `miesiace.length === 1` wpuszczal do rachunku prowizje za CALY
  // czerwiec przy sprzedazy z szesnastu dni — wskaznik „prowizja / sprzedaz Allegro"
  // wychodzil absurdalnie wysoki i wygladal wiarygodnie. To ta sama rodzina bledu, co
  // faktura prowizyjna dotyczaca miesiaca poprzedniego (patrz `prowizjaAllegroZaMiesiac`):
  // licznik i mianownik z DWOCH roznych okresow.
  //
  // Rozpoznanie robi `nazwaOkresu` (domain/okresy-raportu.js), a nie wlasne porownanie dat:
  // oddaje 'RRRR-MM' DOKLADNIE wtedy, gdy zakres pokrywa sie z pelnym miesiacem (kwartal
  // wychodzi jako '2026-Q2', rok jako '2026', zakres dowolny jako 'od – do').
  const pelnyMiesiac = /^\d{4}-\d{2}$/.test(nazwaOkresu({ od, do: doDnia })) ? miesiace[0] : null;
  // ⚠️⚠️ ZAKRES URWANY W POLOWIE MIESIACA MIESZA DWIE MIARY, i ekran ma o tym POWIEDZIEC.
  // Sprzedaz liczy sie co do dnia, ale koszty, ZUS, PIT-5 i VAT-7 sa MIESIECZNE i innych nie
  // ma — panel dostaje je z KSeF po dacie wystawienia i z recznego wpisu za caly miesiac.
  // Rachunek za 5–20 czerwca odjalby wiec od szesnastu dni sprzedazy koszty CALEGO czerwca:
  // wynik wyszedlby glęboko ujemny i wygladalby jak zapasc, a nie jak zle zadane pytanie.
  // To ta sama rodzina bledu, co przy prowizji wyzej, tylko o wieksza kwote.
  const pelneMiesiace = od.endsWith('-01') && doDnia === koniecMiesiaca(miesiace.at(-1));
  const wiersze = sprzedazWOkresie(db, { od, do: doDnia }, regulySprzedazy);
  // ⚠️ ZWROT OBCIAZA MIESIAC, W KTORYM NASTAPIL — nie miesiac sprzedazy. Podstawa: art. 14
  // ust. 1m ustawy o PIT (korekta przychodu w okresie wystawienia korekty) i art. 29a ust. 13
  // ustawy o VAT. Wariant „cofnij zwrot do miesiaca sprzedazy" dawalby rachunek zmieniajacy
  // sie PO zamknieciu miesiaca i rozjezdzalby sie z KPiR.
  //
  // Netto liczone TA SAMA regula co sprzedaz (nettoZ w sprzedaz-okresu.js, wewnatrz
  // zwrotyWOkresie) — inaczej zwrot zdejmowalby inna kwote netto, niz dodala sprzedaz.
  const zwroty = zwrotyWOkresie(db, { od, do: doDnia }, regulySprzedazy);
  const zwrotyNettoGrosze = sumaNetto(zwroty);
  const przychodNettoGrosze = sumaNetto(wiersze) - zwrotyNettoGrosze;
  const koszty = kosztyOkresu(db, miesiace);
  const dane = daneOkresu(db, miesiace);

  const wynikGrosze = przychodNettoGrosze - koszty.nettoGrosze;
  // ⚠️ Brak choc jednego wiersza danych = „zostaje" NIE DA SIE POLICZYC. `null`, nie liczba
  // pomniejszona o zero — bo kwota pomniejszona o nieznany ZUS wyglada jak prawdziwa.
  const zostajeGrosze = dane.brakujace.length
    ? null
    : wynikGrosze - dane.suma.zusRazemGrosze - dane.suma.pit5Grosze;

  // Pokrycie liczymy TYLKO gdy operator podal kontrolna kwote z KPiR. Bez niej raport
  // powstaje normalnie i o pokryciu milczy — pole jest NIEOBOWIAZKOWE.
  const kpirKoszty = dane.suma.kpirKosztyGrosze;
  const pokrycieKosztow = kpirKoszty
    ? (koszty.nettoGrosze / kpirKoszty) * 100
    : null;
  const kosztyZnane = pokrycieKosztow === null ? true : pokrycieKosztow >= PROG_POKRYCIA;

  const kpirPrzychod = dane.suma.kpirPrzychodGrosze;
  const roznicaPrzychodu = kpirPrzychod ? {
    kpirGrosze: kpirPrzychod,
    roznicaGrosze: przychodNettoGrosze - kpirPrzychod,
    procent: ((przychodNettoGrosze - kpirPrzychod) / kpirPrzychod) * 100,
  } : null;

  // Podatek NARASTAJACO od stycznia roku, w ktorym konczy sie okres.
  const rok = doDnia.slice(0, 4);
  const odStycznia = miesiaceOkresu({ od: `${rok}-01-01`, do: doDnia });
  const daneRoku = daneOkresu(db, odStycznia);
  // ⚠️⚠️ PODSTAWA PODATKU MA ODJETE ZWROTY, TA SAMA REGULA CO WYZEJ — inaczej PIT liczylby sie
  // od przychodu, ktorego juz nie ma, i wychodzilby ZAWYZONY (realne pieniadze, nie kosmetyka).
  // Okno [rok-01-01, doDnia] jest TYM SAMYM oknem, co przy sprzedazy linijke wyzej: zwrot
  // wystawiony w dowolnym miesiacu OD STYCZNIA DO KONCA raportowanego okresu pomniejsza dochod
  // narastajaco od chwili, w ktorej faktycznie nastapil — zgodnie z art. 14 ust. 1m PIT.
  const zwrotyRokuNettoGrosze = sumaNetto(zwrotyWOkresie(db, { od: `${rok}-01-01`, do: doDnia }, regulySprzedazy));
  const dochodRoku = sumaNetto(sprzedazWOkresie(db, { od: `${rok}-01-01`, do: doDnia }, regulySprzedazy))
    - zwrotyRokuNettoGrosze - kosztyOkresu(db, odStycznia).nettoGrosze;
  const podatek = podatekNarastajaco({
    dochodGrosze: dochodRoku,
    spoleczneGrosze: daneRoku.suma.zusSpoleczneGrosze,
  });

  const prowizjaAllegro = pelnyMiesiac ? prowizjaAllegroZaMiesiac(db, pelnyMiesiac) : null;
  const sprzedazAllegroGrosze = wiersze
    .filter((w) => w.kanal.startsWith('ALLEGRO_'))
    .reduce((s, w) => s + w.nettoGrosze, 0);

  return {
    od,
    do: doDnia,
    // `false` znaczy „ten zakres nie pokrywa sie z pelnymi miesiacami" — patrz wyzej. Ekran
    // ma wtedy postawic pasek ostrzegawczy, a nie po cichu odjac miesieczne koszty od
    // czesciowej sprzedazy.
    pelneMiesiace,
    przychodNettoGrosze,
    // ⚠️ TO JEST INNA LICZBA NIZ `zwrotyGrosze` NIZEJ. `zwrotyNettoGrosze` liczy sie z
    // prawdziwych wierszy tabeli `zwroty` (ta sama funkcja, co na ekranie sprzedazy) i JUZ
    // wszedl w `przychodNettoGrosze` wyzej — po to tu stoi, zeby ekran mogl pokazac, skad
    // wzięła się różnica. `zwrotyGrosze` to osobne, reczne pole z `dane_miesieczne`
    // (Zadanie 13), ktorego rachunek NIE odejmuje — patrz komentarz przy tamtym polu.
    zwrotyNettoGrosze,
    kosztyNettoGrosze: koszty.nettoGrosze,
    wynikGrosze,
    marza: przychodNettoGrosze ? (wynikGrosze / przychodNettoGrosze) * 100 : 0,
    zusGrosze: dane.suma.zusRazemGrosze,
    pit5Grosze: dane.suma.pit5Grosze,
    zostajeGrosze,
    // ⚠️ VAT STOI OSOBNO, POZA RACHUNKIEM. To pieniadz przechodni, nie zysk — mylenie tego
    // jest klasycznym bledem.
    vatGrosze: dane.suma.vat7Grosze,
    // ⚠️ POLE RECZNE (Zadanie 13, `dane_miesieczne.zwroty_brutto`) — NIE to samo, co
    // `zwrotyNettoGrosze` wyzej. To liczy operator z KPiR i rachunek go NIE odejmuje (patrz
    // karta „Zwroty wg KPiR" na ekranie /finanse, przemianowana wlasnie dlatego, ze
    // mylila sie z ponizsza); `zwrotyNettoGrosze` liczy sie z prawdziwych wierszy `zwroty`
    // i JUZ jest odjete od `przychodNettoGrosze` — TAKZE w `rachunekMiesiaca` i w `dochodRoku`
    // (podstawa podatku), poprawka po Zadaniu 11.
    zwrotyGrosze: dane.suma.zwrotyGrosze,
    brakujaceDane: dane.brakujace,
    pokrycieKosztow,
    kosztyZnane,
    // Kategorie i prog rentownosci rysuja sie WYLACZNIE przy wiarygodnym pokryciu.
    kategorie: kosztyZnane ? koszty.kategorie : null,
    roznicaPrzychodu,
    podatek,
    // Sekcja „miesiac po miesiacu" od DWOCH miesiecy wzwyz: suma kwartalu mowi „ile",
    // ale nie „kiedy". W Q1 2026 sam marzec dal wiecej niz styczen i luty razem.
    miesiacami: miesiace.length >= 2 ? miesiace.map((m) => rachunekMiesiaca(db, m, regulySprzedazy)) : null,
    // ⚠️ WSKAZNIKI WYLACZNIE PRZY `kosztyZnane` — policzone z niepelnych kosztow sa dokladnie
    // tym zmysleniem, przed ktorym broni prog 95%: prog rentownosci z jednej trzeciej wydatkow
    // wychodzi niski i wiarygodny naraz.
    wskazniki: kosztyZnane
      ? wskazniki({
        kategorie: koszty.kategorie,
        przychodNettoGrosze,
        zamowien: wiersze.length,
      })
      : null,
    // ⚠️ TYLKO DLA PELNEGO MIESIACA KALENDARZOWEGO (patrz `pelnyMiesiac` wyzej). Prowizja
    // rozstrzyga sie po okresie Z NUMERU faktury (wskazniki-zarzadcze.js), wiec dla kwartalu
    // trzeba by ja skladac miesiac po miesiacu — a zsumowana „jakos" dalaby wskaznik nie do
    // zakwestionowania i nieprawdziwy. Dla zakresu CZESCIOWEGO nie ma jej z czego wziac:
    // faktura prowizyjna obejmuje caly miesiac i nie da sie jej pociac na dni.
    prowizjaAllegro,
    sprzedazAllegroGrosze,
    // ⚠️ ILORAZ LICZY DOMENA, A NIE WIDOK — to jest liczba o pieniadzach, a nie geometria
    // rysunku (ta sama granica, co przy `zl` w raporty.ejs). `null`, gdy sprzedazy Allegro
    // w okresie NIE BYLO: dzielenie daloby wtedy nieskonczonosc, a wpisane „0%" bylo by
    // zdaniem o faktach, ktorych nie ma. `null` takze bez prowizji — patrz wyzej.
    udzialProwizjiAllegro: prowizjaAllegro && sprzedazAllegroGrosze
      ? (prowizjaAllegro.nettoGrosze / sprzedazAllegroGrosze) * 100
      : null,
  };
}

// PRZ-093.07: nowa instalacja widzi to zdanie na FINANSACH, zanim ktokolwiek ustawi podłogę —
// więc mówi, którą zmienną wpisać, w jakim formacie i gdzie. Treść w stałej, żeby linia odczytu
// w `rachunekOkresu` nie przesuwała się przy każdej zmianie słów.
const BRAK_PODLOGI_KOSZTOW = 'Nie ustawiono podłogi danych kosztów rachunku zarządczego.'
  + ' Wpisz w pliku konfiguracji OMS (oms.env) linię OMS_RAPORTY_PODLOGA_KOSZTOW=RRRR-MM, np. 2026-05:'
  + ' pierwszy miesiąc, od którego koszty firmy w OMS-ie (faktury kosztowe z KSeF i koszty dopisane ręcznie)'
  + ' są kompletne — i uruchom OMS ponownie. Rachunek pokaże wynik od tego miesiąca; wcześniejszych nie policzy,'
  + ' bo bez części kosztów zysk wyszedłby zawyżony.';
