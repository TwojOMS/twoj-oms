// Podpisane ciasteczko sesji — wspolne dla obu paneli (indywidualnego i OMS).
//
// Po co. Basic Auth wysyla haslo w KAZDYM zadaniu (base64, czyli praktycznie jawnie)
// i nie da sie go ostylowac — przegladarka rysuje wlasne okienko systemowe. Ciasteczko
// przechodzi przez siec RAZ, przy logowaniu, a ekran logowania jest nasz.
//
// Dlaczego podpis, a nie tabela sesji. Sesji jest tyle, co urzadzen wlasciciela — dwa.
// Tabela dawalaby odwolywanie pojedynczego urzadzenia, ale kosztem migracji i zapytania
// przy KAZDYM zadaniu. Podpis nie wymaga ani jednego odczytu: tresc ciasteczka niesie
// wszystko, czego trzeba, a jej nienaruszalnosci pilnuje HMAC.
//
// ⚠️ Ciasteczko jest CZYTELNE dla kazdego, kto je ma — podpis chroni przed PODMIANA,
// nie przed odczytem. Nie wolno wkladac tu niczego poza nazwa konta i data waznosci.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

// ⚠️ KAZDA USLUGA MA WLASNA NAZWE CIASTECZKA I OBIE STOJA TUTAJ, OBOK SIEBIE — CELOWO.
//
// Ciasteczka NIE SA dzielone portem (RFC 6265, §8.5: „cookies do not provide isolation by
// port"). Panel chodzi na <host>:3000, OMS na <host>:3001 — dla przegladarki to
// JEDEN gospodarz i JEDEN sloik. Wspolna nazwa znaczyla, ze zalogowanie do jednej uslugi
// NADPISUJE ciasteczko drugiej; a poniewaz kazda podpisuje wlasnym sekretem (osobne bazy),
// nadpisane ciasteczko byloby dla niej bezwartosciowe. Operator logowal sie kilka razy
// dziennie — dokladnie tyle razy, ile razy przeskoczyl miedzy panelem a OMS-em.
//
// Nazwy stoja w JEDNYM miejscu, zeby trzecia usluga na tym samym gospodarzu nie mogla
// wybrac swojej w oderwaniu od pozostalych. Ten sam powod ma juz `oms_motyw`
// w src/oms/domain/motyw.js.
export const NAZWA_CIASTECZKA_PANEL = 'sesja_panel';
export const NAZWA_CIASTECZKA_OMS = 'sesja_oms';
export const NAZWA_CIASTECZKA_OMS_PROBA = 'sesja_oms_proba';

// PRZ-080: piaskownica (:3005, OMS_TRYB=proba) stoi na tym samym gospodarzu co produkcja (:3001)
// — ten sam powod, co wyzej. Produkcja zostaje przy `sesja_oms`, zeby wydanie nikogo nie wylogowalo.
// Nazwe wybiera konfiguracja modulu `web` (`proba`), nie `process.env` czytany tutaj.
export function nazwaCiasteczkaOms(proba) {
  return proba ? NAZWA_CIASTECZKA_OMS_PROBA : NAZWA_CIASTECZKA_OMS;
}

// 90 dni. Wartosc odnawia sie przy kazdym wejsciu (patrz `odswiez` nizej), wiec przy
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

/** Nowy sekret do zapisania w bazie. 32 bajty — tyle, ile ma blok SHA-256. */
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
 * Panel stoi dzis na czystym HTTP i ma stanac za proxy pozniej, wiec flaga musi isc
 * za faktycznym polaczeniem, a nie byc wpisana na sztywno w jedna albo w druga strone.
 */
export function ciasteczkoSesji(nazwa, wartosc, { bezpieczne, maxWiek = Math.floor(WAZNOSC_MS / 1000) } = {}) {
  const czesci = [
    `${nazwa}=${wartosc}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxWiek}`,
  ];
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
