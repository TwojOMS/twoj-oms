// BEZPIECZNIK ODPYTYWANIA `GET /order/checkout-forms/{id}/invoices` (spec 2026-08-28).
//
// ⚠️⚠️ TA REGULA COFA CZESC DECYZJI Z 06.08.2026, i to swiadomie. `domain/sprawy-karty.js`
// mowi: „ODPYTYWANIA W CZUWACZU NIE RUSZAMY — gdy Allegro naprawi zasob, stan zacznie sie
// rozstrzygac SAM". Ta intencja ZOSTAJE. Zmienia sie WYLACZNIE czestotliwosc: panel dowie sie
// o naprawie w ciagu doby, a nie w ciagu godziny. Powod: raport „Bledy techniczne" Allegro
// pokazal 6225 wywolan tego zasobu zakonczonych 400, a od 1.09.2026 art. 3.12 regulaminu
// pozwala odjac za to punkty jakosci sprzedazy.
//
// ⚠️ BEZPIECZNIK JEST NA KANALE, NIE NA FAKTURZE — bo 400 jest wlasnoscia ENDPOINTU, nie
// zamowienia (zmierzone 05.08: smieciowy UUID daje TO SAMO 400, a ten sam smiec na zasobie
// nadrzednym daje 422, czyli 400 powstaje PRZED sprawdzeniem identyfikatora). Pytanie osmiu
// roznych faktur raz na dobe daloby osiem identycznych porazek zamiast jednej odpowiedzi.
//
// ⚠️ SYGNALEM „ZASOB ZYJE" JEST NIEPUSTA LISTA, a nie kod HTTP — i dlatego klient zostaje
// nietkniety. Pytamy wylacznie o faktury, ktore SAMI wyslalismy (`allegro_invoice_id IS NOT
// NULL` jest czescia warunku kolejki), wiec dzialajacy zasob MUSI oddac co najmniej nasz wpis.
// Alternatywa — przepuszczanie kodu 400 przez `pobierzFakturyZamowienia` — ruszalaby 27
// asercji w 7 plikach testow po to, zeby dowiedziec sie tego samego.

// ⚠️ PROG WIEKSZY NIZ JEDEN, i to nie jest ostroznosc na wyrost: dzialajacy zasob moze raz oddac
// pustke w wyscigu z wlasnym indeksowaniem po stronie Allegro. Licznik rosnie PER WIERSZ, wiec
// przy kilku fakturach w kolejce prog i tak zostaje osiagniety w PIERWSZYM przebiegu — krwawienie
// ustaje od razu, a jednorazowa pustka nie zamyka odpytywania na dobe.
export const PROG_PUSTYCH = 3;

// Co ile pytamy przy otwartym bezpieczniku. Doba, bo nikt nie potrzebuje wiedziec w ciagu
// godziny, ze Allegro naprawilo endpoint.
export const ODSTEP_SONDY_MS = 24 * 60 * 60 * 1000;

/**
 * Czy wolno teraz zapytac o ten kanal.
 *
 * ⚠️ WOLANE PRZED `zapiszPytanieOWeryfikacje`, wiec wiersz POMINIETY nie dostaje stempla
 * i zostaje na czole kolejki (`ORDER BY allegro_pytana_at NULLS FIRST`). Dzieki temu sonda
 * przy nastepnej dobie trafia w INNY wiersz niz poprzednio, bez ani jednej linii bookkeepingu.
 *
 * ⚠️ Przy otwartym bezpieczniku pierwszy wiersz przebiegu przestawia `ostatnia_proba_at`, wiec
 * kolejne wiersze TEGO SAMEGO przebiegu widza juz swiezy stempel i odpadaja tutaj. To jest cale
 * ograniczenie „jeden wiersz na dobe" — nie ma osobnego licznika do rozjechania.
 */
export function wolnoPytac(stan, teraz) {
  if (!stan?.bezpiecznik_od) return true;
  if (!stan.ostatnia_proba_at) return true;
  return teraz.getTime() - new Date(stan.ostatnia_proba_at).getTime() >= ODSTEP_SONDY_MS;
}

/**
 * Nowy stan kanalu po odpowiedzi. Czysta funkcja — zapis nalezy do db/stan-weryfikacji.js.
 *
 * ⚠️ NIEPUSTA ODPOWIEDZ ZAMYKA BEZPIECZNIK I ZERUJE LICZNIK. To jest jedyne wyjscie z tego
 * stanu i dokladnie to, czego chce komentarz z 06.08: pierwszy dowod, ze zrodlo zyje, przywraca
 * pelne zachowanie bez zmiany w kodzie.
 */
export function poOdpowiedzi(stan, { pusta }, teraz) {
  const ostatniaProbaAt = teraz.toISOString();
  if (!pusta) return { kolejnePuste: 0, bezpiecznikOd: null, ostatniaProbaAt };

  const kolejnePuste = (stan?.kolejne_puste ?? 0) + 1;
  // ⚠️ `?? teraz` — data otwarcia zapisuje sie RAZ. Przesuwanie jej przy kazdej kolejnej
  // pustce znaczyloby, ze ekran lacznosci zawsze pokazuje „niedostepny od dzisiaj", czyli
  // gubi jedyna informacje, po ktorej widac, ze zasob lezy od tygodni.
  const bezpiecznikOd = kolejnePuste >= PROG_PUSTYCH
    ? (stan?.bezpiecznik_od ?? ostatniaProbaAt)
    : null;
  return { kolejnePuste, bezpiecznikOd, ostatniaProbaAt };
}
