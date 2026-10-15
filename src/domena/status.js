import { fakturaWymagaCzlowieka } from './faktura-stan.js';
import { zamowienieWymagaCzlowieka, przesylkaUkryta } from './przesylka-stan.js';
import { zwrotRozliczony } from './zwrot.js';

// ⚠️ KOLEJNOSC KLUCZY STERUJE KOLEJNOSCIA ZAKLADEK w panelu bocznym listy
// (routes/zamowienia.js sklada je `Object.keys(ETYKIETY).map`). „indywidualne" stoi zaraz
// za „nowe" na prosbe wlasciciela („dodatkowy status obok nowe").
export const ETYKIETY = {
  nowe: 'Nowe',
  indywidualne: 'Indywidualne',
  w_realizacji: 'W realizacji',
  wyslane: 'Wysłane',
  zwrot: 'Zwrot',
  anulowane: 'Anulowane',
};

// Status WYNIKA z faktow, nie jest kolumna do przestawiania. Kolejnosc jest
// istotna: pierwsze trafienie wygrywa.
export function wyliczStatus(z) {
  if (z.anulowane) return 'anulowane';
  // ⚠️ DWA ZRODLA JEDNEGO STANU I OBA SA POTRZEBNE.
  //   `ma_zwrot`  — jest wpis w tabeli `zwroty` (od 08.2026 jedyna droga rejestracji).
  //   `zwrot_at`  — stary znacznik reczny, bez kwoty i bez pozycji. Na produkcji takie
  //                 zamowienia leza i dopisywanie im kwot wstecz byloby zmyslaniem danych,
  //                 ktorych nikt nie zapisal.
  //
  // ⚠️ `ma_zwrot` USTAWIAJA OBIE DROGI ODCZYTU (pobierzZamowienie i listaZamowien) i to jest
  // warunek poprawnosci: `wyliczStatus` wola tez `allegro-status.js` i `sync-sklep.js`.
  // Wiersz bez tego pola oddalby 'wyslane' i panel odeslalby do Allegro status realizacji
  // zamowienia, ktore wlasnie wrocilo.
  if (z.zwrot_at || z.ma_zwrot) return 'zwrot';
  // ⚠️ „WYSLANE" WYNIKA Z WLASNEGO FAKTU (`wyslane_at`), A NIE Z ISTNIENIA PACZKI.
  //
  // Do 2026-07-31 wystarczyla nadana przesylka — i to bylo zle w codziennej robocie:
  // etykieta powstaje przy PAKOWANIU, a paczka wyjezdza dopiero z kurierem, czesto
  // nastepnego dnia. Status skakal na „Wyslane" w chwili wydruku etykiety i zamowienie
  // znikalo z listy roboczej, choc lezalo jeszcze na stole. Decyzja wlasciciela: „po
  // utworzeniu etykiety nie zmieniaj statusu na wyslane".
  //
  // Konsekwencja, ktora trzeba znac: „Wyslane" jest teraz statusem USTAWIANYM RECZNIE
  // (jest na liscie w domain/status-reczny.js). Panel nie zgaduje momentu wyjazdu paczki,
  // bo go nie zna — zna tylko moment wydruku etykiety, a to nie to samo.
  if (z.wyslane_at) return 'wyslane';
  if (z.w_realizacji_at) return 'w_realizacji';
  // ⚠️ „INDYWIDUALNE" STOI NA SAMYM DOLE DRABINKI, TUZ NAD „NOWE" — i to jest cala regula
  // (prosba wlasciciela 2026-08-07): „zamowienie trafia tam na czas jego przetwarzania,
  // az projekt indywidualny zostanie zaakceptowany, i przenoszone jest do «w realizacji»
  // razem z reszta zamowien".
  //
  // Wyjscie ze statusu jest wiec DOKLADNIE TYM SAMYM faktem, co dla kazdego innego
  // zamowienia — `w_realizacji_at`, ustawianym recznie z belki karty. Zadnego nowego
  // przelacznika, zadnej nowej kolumny: akceptacja projektu to klikniecie „W realizacji".
  //
  // ⚠️ `z.indywidualne` TO ZNACZNIK KANALU, NIE STAN — liczy go poller z pozycji zamowienia
  // (domain/indywidualne.js) i przepisuje przy KAZDEJ synchronizacji. Zostaje na zamowieniu
  // takze po przejsciu dalej i ma zostac: czyta go `/api/sprzedaz` (kanal
  // SKLEP_INDYWIDUALNE), filtr kanalu i odznaka na liscie. Ta linia go NIE KONSUMUJE —
  // tylko czyta. Dlatego „indywidualne" nie ma i nie moze miec wpisu w STATUSY_RECZNE:
  // nie ma czego ustawiac, skoro nie ma wlasnego faktu.
  if (z.indywidualne) return 'indywidualne';
  return 'nowe';
}

// Anulowanie PO nadaniu albo PO wystawieniu faktury. `wyliczStatus` slusznie oddaje wtedy
// 'anulowane' (to FAKT ze sklepu), ale sam ten status chowal zamowienie razem z paczka
// w drodze i faktura, ktora czeka w inFakcie na wieczorna zbiorcza wysylke do KSeF (panel
// jej tam sam nie wysyla — patrz services/faktura.js). Nie trzeba zadnego wyscigu —
// wystarczy anulowanie dzien po wysylce. Faktura liczy sie TAKZE wystawiona: wlasnie ona
// jest tu problemem, bo jej nikt sam nie skasuje ani nie skoryguje — a dopoki nie pojdzie
// do KSeF, to jeszcze KASOWANIE w inFakcie, nie korekta.
export function anulowaneWymagaUwagi(z) {
  // ⚠️⚠️ UKRYTA PACZKA NIE JEST SPRAWĄ — bo człowiek już ją zamknął (13.09.2026).
  //
  // Komentarz przy kolumnie `ukryta_at` w schema.sql mówi to od dnia jej dołożenia
  // (25.08.2026): „Ukrycie zdejmuje zamowienie TAKZE z listy roboczej, wiec musi byc
  // wiadomo, czyja to decyzja — stad `ukryta_przez`". Do dziś nie było to prawdą: ta
  // funkcja liczyła KAŻDY wiersz przesyłki, także ukryty. Zmierzone na produkcji 13.09:
  // zamówienie 1267 (anulowane ręcznie, paczka ukryta 25.08, list 1000123456789U) wisiało
  // na „Do zrobienia" 19 dni jako 1 z 7 pozycji — wbrew decyzji, która ma w bazie autora.
  //
  // ⚠️ PREDYKATEM JEST `przesylkaUkryta`, NIE goła kolumna. Ukrycie WYGASA, gdy u kuriera
  // wydarzy się coś PO nim: paczka spisana na straty, która ruszyła, znów jest sprawą.
  // Reguła czytająca surowe `ukryta_at` uciszyłaby wtedy paczkę żywą — i to jest różnica,
  // której na ekranie nikt by nie zauważył.
  //
  // ⚠️ FAKTURA ZOSTAJE PO DRUGIEJ STRONIE SUMY. Ukrycie paczki zamyka sprawę PACZKI;
  // dokument wiszący przy anulowanym zamówieniu dalej wymaga korekty i nie ma prawa
  // zniknąć razem z nią.
  const zywe = (z.przesylki ?? []).filter((p) => !przesylkaUkryta(p));
  return Boolean(z.anulowane && (zywe.length > 0 || z.faktura));
}

// Lista robocza = to, co zostalo do zrobienia. "Oplacone" celowo nie ma tu wplywu:
// oplacenie jest faktem obok statusu, nie etapem procesu.
//
// ⚠️ `teraz` (PRZ-051) — ta sama chwila trafia do obu regul zaleznych od czasu (faktura
// i paczka „zawieszone" po progu). Indeks listy pyta o nia dla chwil PRZYSZLYCH, zeby
// zapisac moment, w ktorym zamowienie samo wraca na liste, zamiast przeliczac cala baze
// przy kazdym otwarciu. Domyslnie „teraz" — dotychczasowi wolajacy nic nie zmieniaja.
export function doZrobienia(z, teraz = Date.now()) {
  // Ta sama zasada, co przy przesylce 'do_wyjasnienia' wyzej, tyle ze dla faktury —
  // wczesniej zapisana w komentarzu i niezastosowana. Zamowienie WYSLANE, z faktura
  // wiszaca w stanie, z ktorego panel sam nie wyjdzie, mialo status „wyslane" i wypadalo
  // z listy roboczej: ostrzezenie widzial wylacznie ten, kto otworzyl akurat te karte.
  // Faktura wymagajaca czlowieka trzyma zamowienie na liscie NIEZALEZNIE od statusu —
  // takze przy anulowanym, bo tam wiszacy dokument jest jeszcze grozniejszy.
  if (fakturaWymagaCzlowieka(z.faktura, teraz)) return true;
  // Ta sama zasada wreszcie po stronie PRZESYLKI, i to dla stanu 'nadana' — czyli tam, gdzie
  // status 'wyslane' zdejmowal zamowienie z listy dokladnie wtedy, gdy powstal problem
  // (nieudany sync ze sklepem, brak etykiety, martwe odpytywanie DPD).
  //
  // Liczone po KAZDEJ paczce: zamowienie z paczka nr 1 czysta i nr 2 bez etykiety ma zostac
  // na liscie. Patrzenie tylko na pierwsza przywrociloby dokladnie te wade, ktora zdanie
  // wyzej opisuje jako juz raz naprawiona.
  if (zamowienieWymagaCzlowieka(z.przesylki, teraz)) return true;
  // TA SAMA ZASADA, TERAZ DLA STATUSU CALEGO ZAMOWIENIA (K1, recenzja Partii 1 Planu B).
  // `zamowienia.sync_woo_blad` znaczy: panel zapisal decyzje czlowieka, ale druga strona
  // (sklep albo Allegro) jej NIE PRZYJELA — czyli klient/kupujacy widzi u siebie stary stan.
  // Bez tej linii `wyliczStatus` dawal 'wyslane' i zamowienie schodzilo z listy w tej samej
  // sekundzie, w ktorej powstal problem; przy zmianie MASOWEJ znikalo tak calych dwadziescia
  // naraz, a slad widzial wylacznie ten, kto otworzyl akurat te karte.
  //
  // ⚠️ Dotyczy OBU kanalow i to jest swiadome: `completed`, ktore nie dojechalo do
  // WooCommerce, znaczy klienta bez maila „zamowienie zrealizowane". Wyjscie ze stanu jest
  // (przycisk „Wyslij ponownie" na karcie), wiec to nie jest sprawa nie do zalatwienia.
  //
  // Kolumna o tej samej nazwie przy PRZESYLCE jest czym innym (notatka z numerem listu)
  // i ma wlasna regule w `sprawyPrzesylki` — patrz komentarz w db/db.js przy migracji.
  if (z.sync_woo_blad) return true;
  if (anulowaneWymagaUwagi(z)) return true;
  // ZWROT NIEROZLICZONY TRZYMA ZAMOWIENIE NA LISCIE — mimo ze jego status jest KONCOWY.
  // Ta sama zasada, co przy fakturze wymagajacej czlowieka wyzej: status mowi „co to jest",
  // lista robocza — „czy jest tu jeszcze robota". Bez tej linii zwrot z nieoddanymi
  // pieniedzmi widzialby wylacznie ten, kto otworzy akurat te karte.
  //
  // Liczone po KAZDYM zwrocie: zamowienie z pierwszym zwrotem rozliczonym i drugim swiezym
  // ma zostac na liscie.
  if ((z.zwroty ?? []).some((w) => !zwrotRozliczony(z, w))) return true;
  // ⚠️ „indywidualne" JEST TU OD 2026-08-07 i bez tego wpisu wdrozenie statusu zdjeloby
  // z listy roboczej komplet zamowien z panelu indywidualnego W DNIU WEJSCIA — wypadlyby
  // z „Do zrobienia" nie dlatego, ze cos sie z nimi stalo, tylko dlatego, ze zmienila sie
  // nazwa ich stanu. To jest praca do wykonania (projekt czeka na akceptacje), a nie stan
  // koncowy.
  return ['nowe', 'indywidualne', 'w_realizacji'].includes(wyliczStatus(z));
}
