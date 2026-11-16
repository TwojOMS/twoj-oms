import { timingSafeEqual } from 'node:crypto';

// Kawałki logowania wspólne dla strażnika, ekranu logowania i kilku tras (konta, moje konto, zdrowie, ekrany, nagłówki w aplikacja.ts): regułę „kto wchodzi” ma
// określać jedno miejsce.

// Trasy dostępne BEZ zalogowania. Inaczej ekran logowania odsyłałby sam do siebie.
// Lista jest jawna i zamknięta: „wszystko pod /login” otwierałoby także każdą trasę
// dopisaną tam w przyszłości.
//
// ⚠️ /health jest otwarte DLA CZUJKI monitoring (zewnętrzny skrypt sh z samym curl-em,
// bez poświadczeń) — odpowiedź to wyłącznie wiek zegarów i stan kanałów po białej liście,
// zero danych klientów i zero sekretów (pilnuje tego tests/moduly/zdrowie/health-kompozycja.test.js).
export const TRASY_OTWARTE = ['/login', '/health', '/favicon.ico'];

// ⚠️ ZASOBY STATYCZNE MUSZĄ BYĆ OTWARTE — inaczej EKRAN LOGOWANIA RENDERUJE SIĘ BEZ STYLÓW.
// Żądanie o arkusz albo font NIE MA nagłówka `Accept: text/html`, więc strażnik nie uzna go
// za wejście przeglądarki i odeśle do Basic Auth: przeglądarka dostaje 401 na arkusz CSS
// i pokazuje ekran logowania czcionką systemową, bez ani jednej barwy marki.
// Testy HTML tego NIE WIDZĄ, bo status samej strony jest wtedy poprawny — 200.
//
// Bezpieczeństwo: pod tym prefiksem leżą wyłącznie arkusze, htmx, skrypty ekranów i obrazki (ikony, logotypy). Zero danych
// klienta, zero konfiguracji. Ścieżki spoza katalogu odcina @fastify/static, nie my.
//
// Drugi prefiks, /haslo/, to formularz hasła z jednorazowego linku; własny hamulec,
// no-store, Referrer-Policy strict-origin (src/moduly/ustawienia/trasy/haslo-link.js). CSRF po Origin obowiązuje i tu.
export const PREFIKSY_OTWARTE = ['/public/', '/haslo/'];

export function czyTrasaOtwarta(url) {
  const sciezka = String(url ?? '').split('?')[0];
  // Ścieżka wychodząca z /public nie jest zasobem publicznym.
  if (sciezka.startsWith('/public/') && sciezka.split('/').includes('..')) return false;
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

/** Czy polaczenie przyszlo po HTTPS — decyduje o fladze `Secure` w ciasteczku i o nagłówku HSTS. */
export function polaczenieBezpieczne(req) {
  // `x-forwarded-proto` stawia reverse proxy. Podrobienie go nikomu niczego nie otwiera: zmienia tylko
  // odpowiedź na to samo żądanie — flagę `Secure` jej ciasteczka i nagłówek HSTS (core/aplikacja.ts),
  // który przeglądarka i tak pomija na połączeniu bez HTTPS.
  const naglowek = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (naglowek) return naglowek === 'https';
  return req.protocol === 'https';
}
