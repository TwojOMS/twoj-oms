// UPRAWNIENIA (SCOPE) KANALU ALLEGRO — czytane z tokenu, porownywane z tym, czego panel
// naprawde potrzebuje.
//
// ⚠️⚠️ POWOD ISTNIENIA TEGO MODULU. Token Allegro niesie zakresy Z CHWILI AUTORYZACJI,
// a odswiezenie je ZACHOWUJE. Uprawnienie dodane pozniej w aplikacji na
// apps.developer.allegro.pl NIE POJAWI SIE w tokenie samo — wchodzi wylacznie przy NOWEJ
// autoryzacji (device flow). Zmierzone 28.08.2026: oba kanaly mialy dokladnie te same piec
// zakresow co 05.08, mimo ze `messaging` i `disputes` byly juz nadane w aplikacji, a para
// tokenow odswiezala sie tego samego dnia rano. Bez tego modulu panel nie ma jak tego
// zauwazyc: zamowienia chodza, kanal wyglada zdrowo, a Centrum wiadomosci oddaje 403.
//
// ⚠️ NAZWY ZAKRESOW NIE SA POSWIADCZENIEM (niezmiennik 4.10 dotyczy tokenow i hasel). Wolno
// je pokazac na ekranie — i trzeba, bo bez nazwy czlowiek nie wie, czego dodac w aplikacji.
// Sam token NIGDY nie opuszcza tego modulu.

import { payloadTokenu } from './token-jwt.js';

/**
 * Komplet, ktorego panel potrzebuje. ⚠️ To jest LISTA ZUPELNA, nie lista nowosci: kanal,
 * ktoremu brakuje `orders:write`, jest tak samo niekompletny jak ten bez `messaging`.
 * Dopisanie tu zakresu OTWIERA barierę wiazania na wszystkich kanalach, ktore go nie maja —
 * i o to chodzi.
 */
export const WYMAGANE_UPRAWNIENIA = [
  'allegro:api:orders:read',
  'allegro:api:orders:write',
  'allegro:api:sale:offers:read',
  'allegro:api:shipments:read',
  'allegro:api:shipments:write',
  // Centrum wiadomosci (spec 2026-08-28) — zakladka /wiadomosci i autoresponder.
  'allegro:api:messaging',
  // Dyskusje i reklamacje (`GET /sale/issues`), tylko odczyt.
  'allegro:api:disputes',
];

/**
 * Zakresy z tokenu. NIGDY nie rzuca: wola to ekran stanu kanalu i pasek spraw, a wyjatek
 * tutaj wywalilby liste zamowien z powodu tokenu o nieznanym ksztalcie.
 */
export function uprawnieniaZTokenu(accessToken) {
  const payload = payloadTokenu(accessToken);
  return Array.isArray(payload?.scope) ? payload.scope : [];
}

/**
 * Czego brakuje.
 *
 * ⚠️⚠️ NIECZYTELNY TOKEN TO „NIE WIEM", A NIE „BRAK WSZYSTKIEGO" — i to jest decyzja, nie
 * uproszczenie. Ta lista OTWIERA barierę ponownego wiązania, a wiązanie NADPISUJE działającą
 * parę tokenów i unieważnia ją po stronie Allegro; cofnąć się z tego nie da. Otwieranie
 * bariery na domyśle znaczyłoby, że token o nieznanym kształcie (inna wersja OAuth, pole
 * `scope` jako napis, cokolwiek) zaprasza do zabicia sprawnego kanału.
 *
 * Nic na tym nie tracimy: kanał BEZ pary tokenów i tak ma `polaczony: false`, więc
 * `stanKanalu` uznaje go za pilny i wiązanie otwiera zupełnie inną drogą.
 */
export function brakujaceUprawnienia(accessToken) {
  const ma = uprawnieniaZTokenu(accessToken);
  if (ma.length === 0) return [];
  const zbior = new Set(ma);
  return WYMAGANE_UPRAWNIENIA.filter((u) => !zbior.has(u));
}
