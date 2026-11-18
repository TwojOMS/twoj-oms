// Podpisane ciasteczko sesji.
//
// Po co. Basic Auth wysyla haslo w KAZDYM zadaniu (base64, czyli praktycznie jawnie)
// i nie da sie go ostylowac — przegladarka rysuje wlasne okienko systemowe. Ciasteczko
// przechodzi przez siec RAZ, przy logowaniu, a ekran logowania jest nasz.
//
// Dlaczego podpis, a nie tabela sesji. Sesji jest niewiele — tyle, ile urządzeń operatorów.
// Tabela dawałaby odwoływanie pojedynczego urządzenia, ale kosztem migracji i zapytania
// przy KAZDYM zadaniu. Podpis nie wymaga ani jednego odczytu: tresc ciasteczka niesie
// wszystko, czego trzeba, a jej nienaruszalnosci pilnuje HMAC.
//
// ⚠️ Ciasteczko jest CZYTELNE dla każdego, kto je ma — podpis chroni przed PODMIANĄ,
// nie przed odczytem. Nie wolno wkładać tu niczego poza nazwą konta, datą ważności
// i wersją hasła.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// ⚠️ KAŻDA USŁUGA MA WŁASNĄ NAZWĘ CIASTECZKA I WSZYSTKIE STOJĄ TUTAJ, OBOK SIEBIE — CELOWO.
//
// Ciasteczka NIE SĄ dzielone portem (RFC 6265, §8.5: „cookies do not provide isolation by
// port”). Dwie usługi na tym samym hoście, różniące się tylko portem, to dla przeglądarki
// JEDEN gospodarz i JEDEN słoik. Wspólna nazwa znaczyłaby, że zalogowanie do jednej usługi
// NADPISUJE ciasteczko drugiej; a ponieważ każda podpisuje własnym sekretem (osobne bazy),
// nadpisane ciasteczko byłoby dla niej bezwartościowe. Operator logowałby się za każdym
// razem, gdy przeskoczy między usługami.
//
// Nazwy stoją w JEDNYM miejscu, żeby kolejna usługa na tym samym hoście nie mogła wybrać
// swojej w oderwaniu od pozostałych. Ten sam powód ma już `oms_motyw` w src/domena/motyw.js.
export const NAZWA_CIASTECZKA_PANEL = 'sesja_panel';
export const NAZWA_CIASTECZKA_OMS = 'sesja_oms';
export const NAZWA_CIASTECZKA_OMS_PROBA = 'sesja_oms_proba';

// Piaskownica (OMS_TRYB=proba) może stać na tym samym gospodarzu co instancja produkcyjna
// — ten sam powód, co wyżej. Produkcja zostaje przy `sesja_oms`, żeby wydanie nikogo nie wylogowało.
// Nazwę wybiera konfiguracja modułu `web` (`proba`), nie `process.env` czytany tutaj.
export function nazwaCiasteczkaOms(proba) {
  return proba ? NAZWA_CIASTECZKA_OMS_PROBA : NAZWA_CIASTECZKA_OMS;
}

// 90 dni. Wartosc odnawia sie przy kazdym wejsciu (patrz `wartoOdswiezyc` niżej), wiec przy
// codziennej pracy nie wygasa nigdy — a porzucone urzadzenie traci dostep po kwartale.
export const WAZNOSC_MS = 90 * 24 * 60 * 60 * 1000;

// Ponizej tego progu nie warto przepisywac ciasteczka przy kazdym zadaniu: przegladarka
// dostawalaby Set-Cookie setki razy dziennie bez zadnego zysku. Odswiezamy dopiero, gdy
// zuzyla sie mniej wiecej doba waznosci.
const PROG_ODSWIEZENIA_MS = 24 * 60 * 60 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function zB64url(tekst) {
  return Buffer.from(String(tekst).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(tresc, sekret) {
  return b64url(createHmac('sha256', String(sekret)).update(tresc).digest());
}

/** Nowy sekret do zapisania w bazie: 32 losowe bajty jako 64 znaki szesnastkowe. */
export function nowySekret() {
  return randomBytes(32).toString('hex');
}

/**
 * Sklada wartosc ciasteczka dla podanego konta.
 * `teraz` jest parametrem, a nie odczytem zegara w srodku — inaczej test na wygasniecie
 * musialby czekac 90 dni albo podmieniac globalny Date.
 */
export function podpisz(uzytkownik, sekret, teraz = Date.now(), wersjaHasla = undefined) {
  // Brak czwartego argumentu zachowuje dokładny dawny format. Wersja jest częścią HMAC.
  if (wersjaHasla !== undefined && (!Number.isSafeInteger(wersjaHasla) || wersjaHasla < 0)) {
    throw new TypeError('Nieprawidłowa wersja hasła');
  }
  const dane = { u: String(uzytkownik), do: teraz + WAZNOSC_MS };
  if (wersjaHasla !== undefined) dane.v = wersjaHasla;
  const tresc = b64url(JSON.stringify(dane));
  return `${tresc}.${hmac(tresc, sekret)}`;
}

/**
 * Zwraca `{ uzytkownik, wygasa }` albo `null`, gdy ciasteczka nie wolno uznac.
 * Kazda droga odmowy konczy sie tym samym `null` — wolajacy nie ma jak (ani po co)
 * rozroznic "podpis sie nie zgadza" od "wygaslo".
 */
export function sprawdz(wartosc, sekret, teraz = Date.now()) {
  if (typeof wartosc !== 'string' || !sekret) return null;

  const kropka = wartosc.lastIndexOf('.');
  if (kropka <= 0 || kropka === wartosc.length - 1) return null;

  const tresc = wartosc.slice(0, kropka);
  const podana = wartosc.slice(kropka + 1);
  const oczekiwana = hmac(tresc, sekret);

  // ⚠️ Porownanie MUSI byc stalo-czasowe. Zwykle `===` konczy sie na pierwszym roznym
  // znaku, a roznica w czasie odpowiedzi pozwala zgadywac podpis znak po znaku.
  // `timingSafeEqual` wymaga rownych dlugosci, wiec sprawdzamy je osobno — sama dlugosc
  // podpisu nie jest sekretem, bo dla HMAC-SHA256 jest zawsze taka sama.
  const a = Buffer.from(podana);
  const b = Buffer.from(oczekiwana);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let dane;
  try {
    dane = JSON.parse(zB64url(tresc).toString('utf8'));
  } catch {
    return null;
  }
  if (!dane || typeof dane.u !== 'string' || typeof dane.do !== 'number') return null;
  if (!(dane.do > teraz)) return null;

  if (Object.hasOwn(dane, 'v')) {
    if (!Number.isSafeInteger(dane.v) || dane.v < 0) return null;
    return { uzytkownik: dane.u, wygasa: dane.do, wersja_hasla: dane.v };
  }

  return { uzytkownik: dane.u, wygasa: dane.do };
}

/**
 * Czy warto wystawic swieze ciasteczko. Zwraca `false` dla ciasteczka swiezo wydanego,
 * `true` dopiero gdy zuzyla sie doba waznosci.
 */
export function wartoOdswiezyc(sesja, teraz = Date.now()) {
  if (!sesja) return false;
  const zuzyte = WAZNOSC_MS - (sesja.wygasa - teraz);
  return zuzyte >= PROG_ODSWIEZENIA_MS;
}

/**
 * Naglowek Set-Cookie. `bezpieczne` wlaczamy tylko po HTTPS — po HTTP przegladarka
 * odrzucilaby ciasteczko z flaga Secure w calosci i logowanie "nic by nie robilo".
 * Instalacja może stać na czystym HTTP albo za proxy z HTTPS, więc flaga musi iść
 * za faktycznym połączeniem, a nie być wpisana na sztywno w jedną albo w drugą stronę.
 */
export function ciasteczkoSesji(nazwa, wartosc, { bezpieczne, maxWiek = Math.floor(WAZNOSC_MS / 1000) } = {}) {
  const czesci = [`${nazwa}=${wartosc}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxWiek}`];
  if (bezpieczne) czesci.push('Secure');
  return czesci.join('; ');
}

/** Ciasteczko kasujace — ta sama sciezka i flagi, zerowy czas zycia. */
export function ciasteczkoWyczyszczenia(nazwa, { bezpieczne } = {}) {
  return ciasteczkoSesji(nazwa, '', { bezpieczne, maxWiek: 0 });
}

/**
 * Wyciaga wartosc ciasteczka z surowego naglowka `Cookie`.
 * ⚠️ Nie da sie tu uzyc `split('=')`: wartosc jest base64url z kropka, ale bywa tez
 * pusta, a inne ciasteczka (np. `motyw`) stoja w tym samym naglowku.
 */
export function zNaglowka(nazwa, naglowek) {
  if (typeof naglowek !== 'string') return null;
  for (const kawalek of naglowek.split(';')) {
    const rowna = kawalek.indexOf('=');
    if (rowna < 0) continue;
    if (kawalek.slice(0, rowna).trim() !== nazwa) continue;
    const wartosc = kawalek.slice(rowna + 1).trim();
    return wartosc === '' ? null : wartosc;
  }
  return null;
}
