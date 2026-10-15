import { timingSafeEqual } from 'node:crypto';

// Kawalki logowania wspolne dla OBU paneli. Same trasy i widoki zostaja osobne, bo roznia
// sie ukladem i paleta — ale regula „kto wchodzi" ma byc jedna.

// Trasy dostepne BEZ zalogowania. Inaczej ekran logowania odsylalby sam do siebie.
// Lista jest jawna i zamknieta: „wszystko pod /login" otwieraloby takze kazda trase
// dopisana tam w przyszlosci.
//
// ⚠️ /health jest otwarte DLA CZUJKI monitoring (zewnetrzny skrypt sh z samym curl-em,
// bez poswiadczen) — odpowiedz to wylacznie wiek zegarow i stan kanalow po bialej liscie,
// zero danych klientow i zero sekretow (tests/oms/web-zdrowie.test.js tego pilnuje).
// Lista jest WSPOLNA dla obu paneli, a trase ma tylko OMS: panel indywidualny oddaje
// na /health czyste 404 bez logowania — swiadomie (tests/security/zdrowie-otwarte.test.js).
export const TRASY_OTWARTE = ['/login', '/health'];

// ⚠️ ZASOBY STATYCZNE MUSZA BYC OTWARTE — inaczej EKRAN LOGOWANIA RENDERUJE SIE BEZ STYLOW.
// Zadanie o arkusz albo font NIE MA naglowka `Accept: text/html`, wiec straznik nie uzna go
// za wejscie przegladarki i odesle do Basic Auth: przegladarka dostaje 401 na `app.css`
// i pokazuje ekran logowania czcionka systemowa, bez ani jednej barwy marki.
// Zlapane w przegladarce 2026-08-09; testy HTML tego NIE WIDZA, bo status samej strony
// jest wtedy poprawny — 200.
//
// Bezpieczenstwo: pod tym prefiksem leza wylacznie arkusz, htmx, fonty i ikony. Zero danych
// klienta, zero konfiguracji. Sciezki spoza katalogu odcina @fastify/static, nie my.
//
// PRZ-069: jedyny nowy adres bez logowania — formularz hasła z jednorazowego linku; własny hamulec,
// no-store, Referrer-Policy strict-origin (src/moduly/ustawienia/trasy/haslo-link.js). CSRF po Origin obowiązuje i tu.
export const PREFIKSY_OTWARTE = ['/public/', '/haslo/'];

export function czyTrasaOtwarta(url) {
  const sciezka = String(url ?? '').split('?')[0];
  if (TRASY_OTWARTE.includes(sciezka)) return true;
  return PREFIKSY_OTWARTE.some((p) => sciezka.startsWith(p));
}

/**
 * Porownanie stalo-czasowe dwoch tekstow.
 * ⚠️ Zwykle `===` konczy sie na pierwszym roznym znaku. Przy hasle to teoretyczny problem
 * w LAN-ie, ale kosztuje trzy linie, a jest ta sama regula, co przy podpisie ciasteczka —
 * dwa rozne standardy w jednym module uwierzytelniania to proszenie sie o pomylke.
 */
export function rowneStaloCzasowo(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Czy polaczenie przyszlo po HTTPS — decyduje o fladze `Secure` w ciasteczku. */
export function polaczenieBezpieczne(req) {
  // `x-forwarded-proto` stawia proxy (DSM). Ufamy mu, bo panele nie sa wystawione na swiat:
  // zeby ten naglowek podrobic, trzeba juz byc w LAN-ie — a wtedy podrobienie niczego nie
  // otwiera, bo jedynym skutkiem jest DOLOZENIE flagi Secure, nie jej zdjecie.
  const naglowek = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (naglowek) return naglowek === 'https';
  return req.protocol === 'https';
}
