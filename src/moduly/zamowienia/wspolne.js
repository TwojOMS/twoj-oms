import { ostatniWpisLogu } from '../../oms/db/zamowienia.js';
import { probaStarszaNizGodzina } from '../wysylka/services/status-kuriera.js';
import { podsumowanieZwrotow } from '../../domena/zwrot-widok.js';
import { OPCJE_STATUSU, anulowaneWSklepie } from '../../domena/status-reczny.js';
import { metodaZmienionaRecznie, saNadpisanieWysylki, metodaZeSklepu, METODY_WYSYLKI } from '../../domena/wysylka.js';
import { miniaturaPozycji } from '../../domena/miniatura-pozycji.js';
import { miniaturyLustra, paryPozycji } from '../../oms/db/miniatury-lustra.js';
import { kuponyZWiersza } from '../../domena/kupony.js';
import { atrybucjaZWiersza, opisAtrybucji } from '../../domena/atrybucja.js';
import ejs from 'ejs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { adresSprzedawcy } from '../../domena/adres-sprzedawcy.js';
import { nipSprzedawcy, bdoSprzedawcy } from '../../domena/nip-bdo-firmy.js';
import { adresOdbiorcy, polaReczneAdresu } from '../../domena/adres-odbiorcy.js';
import { daneFaktury, polaReczneFaktury, chceFakture, chceFaktureZmienioneRecznie } from '../../domena/dane-faktury.js';
export const teraz = () => new Date().toISOString();
export const AKCJA_ALLEGRO_PROBA = 'allegro.przesylka.proba';
export function allegroWymagaOdpytania(db, zamowienieId, terazMs = Date.now()) {
  return probaStarszaNizGodzina(ostatniWpisLogu(db, zamowienieId, AKCJA_ALLEGRO_PROBA)?.at, terazMs);
}
export function miniaturyEkranu(db, zamowienia) {
  const lustro = miniaturyLustra(db, paryPozycji(zamowienia));
  return (kanal, produktId, zdjecie) => miniaturaPozycji(lustro, kanal, produktId, zdjecie);
}
export function ktoKlikal(req) {
  const naglowek = req.headers?.authorization ?? '';
  if (!naglowek.startsWith('Basic ')) return 'operator';
  const [user] = Buffer.from(naglowek.slice(6), 'base64').toString('utf8').split(':');
  return user || 'operator';
}
export function sprzedawcaSpecyfikacji(config) {
  const a = adresSprzedawcy(config);
  return {
    nazwa: a.nazwa,
    adres: [a.ulica, [a.kod, a.miasto].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    // PRZ-108.10: NIP i BDO z pliku albo Ustawień → Firma (każde pole osobno); bez NIP-u odmowa, bez BDO — bez BDO.
    nip: nipSprzedawcy(config),
    bdo: bdoSprzedawcy(config),
  };
}
export function daneKarty(z) {
  // ⚠️ ZAMÓWIENIE RĘCZNE NIE DOSTAJE ŻADNYCH OZNACZEŃ „zmienione ręcznie" (07.08.2026,
  // prośba właściciela). Znacznik odpowiada na pytanie „czy ta wartość odbiega od tego, co
  // podał SKLEP" — a przy zamówieniu telefonicznym sklepu nie ma i każda wartość jest nasza.
  // Oznaczone było więc wszystko, co ktokolwiek poprawił, i nie znaczyło NIC poza „ktoś tu
  // był". To ten sam powód, dla którego `saNadpisania` niżej jest tam wyłączone od dawna.
  //
  // Wygaszamy ŹRÓDŁA, nie widok: `wysylkaReczne`/`fakturaReczne` czyta wyłącznie helper
  // `oznaczenie()` w szablonie, więc pusta lista gasi znacznik w KAŻDYM z kilkunastu miejsc
  // naraz — i gasi go tak samo w trybie odczytu, jak w edycji. Warunek wpisany w szablon
  // trzeba by powtórzyć kilkanaście razy i przy pierwszym nowym polu ktoś by go pominął.
  const zeSklepu = z.sklep !== 'reczne';
  return {
    wysylka: adresOdbiorcy(z),
    wysylkaReczne: zeSklepu ? polaReczneAdresu(z) : [],
    faktura: daneFaktury(z),
    fakturaReczne: zeSklepu ? polaReczneFaktury(z) : [],
    chceFakture: chceFakture(z),
    przelacznikReczny: zeSklepu && chceFaktureZmienioneRecznie(z),
    // „Przywroc dane ze sklepu" ma sie pokazywac WYLACZNIE wtedy, gdy jest co przywracac —
    // ta sama zasada, co przy przycisku „zalatwione recznie" przy przesylce. Liczymy to
    // z KOLUMN, nie z listy roznic: nadpisanie rowne wartosci ze sklepu nie jest juz
    // oznaczane na karcie, ale dalej lezy w bazie i dalej wypada je umiec skasowac.
    //
    // ⚠️ I6 (recenzja calej galezi): dla zamowienia RECZNEGO ten przycisk ma NIE ISTNIEC,
    // niezaleznie od tego, co lezy w kolumnach — bo NIE MA SKLEPU, do ktorego mozna by
    // wrocic. „Dane ze sklepu" dla zamowienia recznego to po prostu to, co ktos wpisal
    // w formularzu zalozenia, a „przywrocenie" znaczyloby skasowanie pozniejszych poprawek
    // do stanu, ktory nie jest zadnym zewnetrznym zrodlem prawdy — tylko starsza wersja
    // tej samej reki.
    //
    // ⚠️ 2026-08-01 uzasadnienie tego warunku SIE ZMIENILO, sam warunek nie. Wczesniej
    // stalo tu, ze formularz zakladania „nie zbiera adresu ani NIP-u" — od przebudowy
    // ekranu zbiera jedno i drugie, wiec zdanie przestalo byc prawda. Przycisk zostaje
    // ukryty z powodu powyzej.
    saNadpisania: z.sklep !== 'reczne'
      && (Boolean(z.dostawa_reczna_json || z.klient_reczny_json) || z.chce_fakture_reczne != null),
    // Kupony sklepu (kampania WRZESIEN30) — gotowa lista dla widoku, parsowanie kolumny
    // robi domena (kuponyZWiersza), nie szablon. Informacja OPISOWA pod tabela pozycji:
    // ceny pozycji sa juz PO rabacie, wiec karta niczego z tego nie liczy.
    kupony: kuponyZWiersza(z.kupony_json),
    // Skad przyszlo zamowienie (Etap 3). Widok dostaje GOTOWY opis — etykiete, szczegol
    // i wskazowke — a nie surowe pola do sklejania. `atrybucja` zostaje obok, bo karta
    // pokazuje tez strone wejscia, urzadzenie i wielkosc sesji.
    //
    // ⚠️ `null` w `atrybucja` znaczy „sklep tego nie zapisal" (zamowienie sprzed wlaczenia
    // atrybucji, Allegro, zamowienie reczne) — i opis mowi to WPROST, zamiast udawac
    // wejscie bezposrednie.
    atrybucja: atrybucjaZWiersza(z.atrybucja_json),
    opisAtrybucji: opisAtrybucji(atrybucjaZWiersza(z.atrybucja_json)),
    // Czy jakakolwiek paczka JUZ POJECHALA. Karta ma powiedziec wprost, czego edycja NIE
    // naprawia: kurs nadanej paczki idzie po adresie z chwili nadania (kolumna
    // `przesylki.adres_uzyty`) i zadna poprawka na karcie go nie zawroci. Ta sama flaga
    // sluzy ostrzezeniu przy metodzie wysylki — zmiana metody tez nie zawraca paczki.
    jestNadanaPaczka: (z.przesylki ?? []).some((p) => p.status === 'nadana'),
    // Lista wyboru statusu. Widok jej NIE sklada sam — inaczej „Wyslane" wrociloby do
    // rozwijanego pola przy pierwszej zmianie ETYKIETY, mimo ze trasa i tak by je odrzucila.
    opcjeStatusu: z.opcje_statusow ?? OPCJE_STATUSU,
    // Skad pochodzi anulowanie. Karta mowi „najpierw wycofaj anulowanie w sklepie"
    // WYLACZNIE wtedy, gdy to prawda — przy anulowaniu recznym wyjscie jest w panelu
    // i tamto zdanie wysylaloby operatora w miejsce, w ktorym nic nie znajdzie.
    anulowaneWSklepie: anulowaneWSklepie(z),
    // Metoda wysylki: oznaczenie liczone z ROZNICY wobec sklepu, przycisk przywracania
    // z OBECNOSCI nadpisania — dokladnie ta sama para zasad, co przy danych klienta.
    //
    // ⚠️ I6 (recenzja calej galezi) sprawdzone TUTAJ tez: „Przywroc metode ze sklepu"
    // NIE dostaje tej samej poprawki co saNadpisania wyzej, bo NIE cierpi na ta sama
    // pulapke. Kolumna metoda_wysylki (ta „ze sklepu" dla zamowienia recznego) zawsze
    // dostaje realna wartosc z METODY_WYSYLKI juz przy zakladaniu zamowienia
    // (utworzZamowienieReczne: `dane.metoda_wysylki ?? 'dpd'`; od 2026-08-01 sklada ja
    // `metodaWysylkiZWyboru` z wyboru dostawy i platnosci, a ta oddaje WYLACZNIE wartosci
    // z METODY_WYSYLKI albo rzuca) — nigdy nie jest pusta ani NULL. Przywrocenie wraca
    // wiec do metody faktycznie wybranej przy zakladaniu, a nie do pustki, ktorej nikt
    // nigdy nie ustawil.
    // ⚠️ Ten sam powód, co przy `wysylkaReczne` wyżej: przy zamówieniu ręcznym „zmienione
    // ręcznie" nie ma się do czego odnieść. Wygaszamy WYŁĄCZNIE znacznik — `saNadpisanieWysylki`
    // niżej zostaje nietknięte, bo steruje PRZYCISKIEM przywracania, a to osobna decyzja
    // (skasować leżące w bazie nadpisanie da się i tu).
    metodaZmienionaRecznie: zeSklepu && metodaZmienionaRecznie(z),
    saNadpisanieWysylki: saNadpisanieWysylki(z),
    metodaZeSklepu: metodaZeSklepu(z),
    metodyWysylki: METODY_WYSYLKI,
    // `null` przy braku zwrotow — widok nie rysuje wtedy ani jednego elementu (wymog
    // wlasciciela: karta ma nie urosnac ani o piksel przy 99% zamowien bez zwrotu).
    zwroty: podsumowanieZwrotow(z),
  };
}
export const KATALOG_WIDOKOW = join(dirname(fileURLToPath(import.meta.url)), 'widoki');
export async function fragment(reply, plik, dane) {
  const html = await ejs.renderFile(join(KATALOG_WIDOKOW, plik), dane);
  return reply.type('text/html; charset=utf-8').send(html);
}