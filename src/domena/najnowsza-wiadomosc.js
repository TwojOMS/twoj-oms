// KTORA WIADOMOSC WATKU JEST NAJNOWSZA — po DACIE, nigdy po pozycji w tablicy.
//
// ⚠️⚠️ ZMIERZONE NA PRODUKCJI 29.08.2026: `GET /messaging/messages` ODDAJE OD NAJNOWSZEJ.
// Poller bral `wiadomosci[wiadomosci.length - 1]` w przekonaniu, ze Allegro oddaje watek
// chronologicznie — czyli bral NAJSTARSZA wiadomosc, prawie zawsze pytanie kupujacego.
// Prawdziwy watek z sondy (bez tresci):
//     [0] 2026-08-07T07:14:04.265Z  isInterlocutor=false   <- NASZA odpowiedz
//     [1] 2026-08-06T18:22:05.982Z  isInterlocutor=true    <- pytanie kupujacego
// `lastMessageDateTime` watku wskazywalo na element ZEROWY.
//
// SKUTEK: wszystkie 18 watkow kanalu sklepu A mialo `ostatnia_od_kupujacego = 1` i NIGDY BY
// NIE ZGASLO, mimo ze wlasciciel odpisal na kazdy jeszcze 7 sierpnia. Dokladnie ta „lampka
// na zawsze", przed ktora ostrzega komentarz w `czyj-ruch-watku.js`.
//
// ⚠️ GROZNIEJSZE NIZ ZLY KOLOR NA EKRANIE: `services/czuwacz-formulki.js` wysyla formulke
// DOKLADNIE do watkow z `ostatnia_od_kupujacego`. Przy tej usterce kwalifikowalo sie
// wszystkie 18 — wlaczenie autorespondera wyslaloby formulke osiemnastu osobom, ktore
// pytaly trzy tygodnie temu i JUZ dostaly odpowiedz. Nie wystrzelilo wylacznie dlatego,
// ze autoresponder nie byl jeszcze wlaczony.
//
// ⚠️ ZADNYCH ZALOZEN O KOLEJNOSCI. Allegro nie obiecuje jej ani przy `GET /messaging/threads`
// (poller wie o tym od poczatku i dlatego nie przerywa na pierwszym znanym watku), ani przy
// wiadomosciach. Oparcie sie na pozycji w tablicy to zaklad o niepisany szczegol cudzego API
// — a ten zaklad przegrywa cicho, bez ani jednego bledu w logu.

/**
 * Najnowsza wiadomosc z listy albo `null`.
 *
 * ⚠️ BEZ DATY NIE ZGADUJEMY. `null` konczy w pollerze jako `ostatnia_od_kupujacego = 0`,
 * czyli „nie czeka" — i to jest BEZPIECZNA strona: falszywe „czeka" wysyla formulke do
 * czlowieka, ktory o nic nie prosil (nieodwracalne), a falszywe „zalatwione" najwyzej gasi
 * lampke przy watku, ktory i tak stoi na liscie.
 */
export function najnowszaWiadomosc(wiadomosci) {
  let najnowsza = null;
  let najnowszaChwila = null;
  for (const m of wiadomosci ?? []) {
    const chwila = Date.parse(m?.createdAt ?? '');
    if (Number.isNaN(chwila)) continue;
    // `>=`, a nie `>`: przy dwoch wiadomosciach z ta sama data rozstrzyga POZNIEJSZA
    // w tablicy. Rozstrzygniecie ma byc jednoznaczne, a nie zalezne od kolejnosci wejscia.
    if (najnowszaChwila === null || chwila >= najnowszaChwila) {
      najnowsza = m;
      najnowszaChwila = chwila;
    }
  }
  return najnowsza;
}
