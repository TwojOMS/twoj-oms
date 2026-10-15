// Czy przy otwarciu karty zapytac inFakt o numer KSeF TEJ jednej faktury.
//
// ⚠️ ISTNIEJE, BO DWA EKRANY POKAZYWALY CO INNEGO, I TO NIE BYL PRZYPADEK. Zakladka FAKTURY
// czyta inFakt NA ZYWO przy kazdym wejsciu, wiec numer widac tam ~70 s po wysylce. Karta
// zamowienia czyta `ksef_numer` z WLASNEJ bazy, a to pole wypelnia wylacznie czuwacz, ktory
// tyka CO GODZINE (bootstrap.js, ODSTEP_CZUWACZA_MS). Stad zgloszenie wlasciciela 12.08.2026:
// „dlaczego numer KSeF pojawia sie w panelu faktur szybko, a na karcie duzo pozniej?".
//
// ⚠️⚠️ GORSZY PRZYPADEK NIZ OPOZNIENIE: DLA CZESCI FAKTUR NUMER NIE PRZYSZEDLBY NIGDY.
// Czuwacz pyta WYLACZNIE o dwie grupy (domain/ksef-oczekiwanie.js): zamowienia z kanalu
// Allegro i dokumenty, ktorych wysylke do KSeF zlecil sam panel. Faktura sklepowa, ktora
// trafila do KSeF inna droga — bo wlasciciel kliknal w inFakcie albo poszla ich wieczornym
// automatem — nie dostawala numeru na karcie NIGDY. To ograniczenie zostaje w czuwaczu
// (pytanie o wszystkie to setki wywolan miesiecznie bez nowej informacji), a znosi je
// dopiero ta sciezka: pytamy o dokument, na ktory CZLOWIEK WLASNIE PATRZY.
//
// ⚠️ TO JEST TEN SAM WZORZEC, CO NUMERY LISTOW Z ALLEGRO NA KARCIE (routes/zamowienia.js):
// koszt ograniczony UWAGA CZLOWIEKA, zero ruchu w tle. Roznica jest w dlawiku — tam znacznik
// proby idzie do logu, bo kolumny nie ma; tutaj kolumna JEST i nazywa sie
// `ksef_sprawdzona_at`. Czuwacz zapisuje ja przy kazdym pytaniu, udanym czy nie, wiec
// dostajemy dlawik za darmo, bez nowej kolumny i bez wpisu do logu przy kazdej odslonie.

/**
 * Ile czekamy miedzy pytaniami o TEN SAM dokument.
 *
 * ⚠️ DWIE MINUTY, A NIE GODZINA — i to jest cala roznica wobec czuwacza. inFakt nadaje numer
 * ~70 s po przyjeciu zlecenia (pomiar 06.08.2026), wiec prog krotszy niz to okno kazalby
 * pytac w kolko o dokument, ktory jeszcze numeru nie ma. Prog dluzszy znaczylby, ze czlowiek
 * odswieza karte i dalej widzi „brak", choc numer jest juz od minuty.
 *
 * ⚠️ Dlawi TEMPO, nie CZAS ZYCIA: karty faktur bez numeru mozna otwierac latami, ale
 * dwadziescia razy F5 w minute to JEDNO zapytanie do inFaktu.
 */
export const PROG_DOCZYTANIA_KSEF_MS = 2 * 60 * 1000;

/**
 * @param faktura wiersz z `faktury` (moze byc `null` — zamowienie bez faktury)
 * @param teraz znacznik w ms
 */
export function czyDoczytacKsef(faktura, teraz = Date.now(), progMs = PROG_DOCZYTANIA_KSEF_MS) {
  // Bez uuid nie ma o co pytac: rezerwacja bez dokumentu to jeszcze nie faktura.
  if (!faktura?.infakt_uuid) return false;
  // ⚠️ NUMER RAZ ZAPISANY KONCZY SPRAWE. Jest jedynym dowodem, ze dokument jest w KSeF, i nic
  // go nie unicestwia — wiec pytanie o niego drugi raz nie moze przyniesc nowej informacji.
  if (faktura.ksef_numer) return false;

  const ostatnie = Date.parse(faktura.ksef_sprawdzona_at ?? '');
  // Nigdy nie pytalismy (albo stempel jest uszkodzony) — pytamy. Brak informacji nie jest
  // powodem do milczenia; ta sama zasada, co przy `stanFaktury` i przy dlawiku Allegro.
  if (!Number.isFinite(ostatnie)) return true;

  return teraz - ostatnie >= progMs;
}
