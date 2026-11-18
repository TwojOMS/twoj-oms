// UPRAWNIENIA (SCOPE) KANALU ALLEGRO — czytane z tokenu, porownywane z tym, czego panel
// naprawde potrzebuje.
//
// ⚠️⚠️ POWOD ISTNIENIA TEGO MODULU. Token Allegro niesie zakresy Z CHWILI AUTORYZACJI,
// a odswiezenie je ZACHOWUJE. Uprawnienie dodane pozniej w aplikacji na
// apps.developer.allegro.pl NIE POJAWI SIE w tokenie samo — wchodzi wylacznie przy NOWEJ
// autoryzacji (device flow). Zmierzone: po odswiezeniu pary tokenow kanaly mialy dokladnie te
// same zakresy co w dniu autoryzacji, mimo ze `messaging` i `disputes` byly juz nadane w aplikacji.
// Bez tego modulu panel nie ma jak tego
// zauwazyc: zamowienia chodza, kanal wyglada zdrowo, a Centrum wiadomosci oddaje 403.
//
// ⚠️ NAZWY ZAKRESOW NIE SA POSWIADCZENIEM (reguła: sekrety nie wychodzą — dotyczy tokenow i hasel). Wolno
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
  // Centrum wiadomosci — zakladka /wiadomosci i autoresponder.
  'allegro:api:messaging',
  // Dyskusje i reklamacje (`GET /sale/issues`), tylko odczyt.
  'allegro:api:disputes',
];

/**
 * Zakresy do wystawiania ofert. ⚠️⚠️ OPCJONALNE, NIE WYMAGANE — i to
 * jest decyzja. Dopisanie ich do `WYMAGANE_UPRAWNIENIA` uznałoby KAŻDE działające konto za
 * niekompletne: pas na ekranie, otwarta bariera wiązania, a wiązanie NADPISUJE działającą
 * parę tokenów. Konto bez nich ma działać dokładnie jak dziś; zgodę dostaje na żądanie.
 */
export const UPRAWNIENIA_OFERT = Object.freeze(['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read']);

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

/** Czy token niesie OBA zakresy ofert. Nieczytelny token = brak zgody (nigdy nie rzuca). */
export function maZgodeNaOferty(accessToken) {
  const zbior = new Set(uprawnieniaZTokenu(accessToken));
  return UPRAWNIENIA_OFERT.every((u) => zbior.has(u));
}

/**
 * Czy WIADOMO, że token nie ma zgody na oferty. ⚠️ Nieczytelny token to „nie wiem", a nie
 * „brak" — z tego samego powodu co w `brakujaceUprawnienia`: ta flaga otwiera wiązanie.
 */
export function brakZgodyNaOferty(accessToken) {
  return uprawnieniaZTokenu(accessToken).length > 0 && !maZgodeNaOferty(accessToken);
}
