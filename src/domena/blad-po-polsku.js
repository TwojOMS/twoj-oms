// KOMUNIKAT TECHNICZNY PO POLSKU — dla ekranu i dla budzika, nigdy dla logu.
//
// ⚠️ POWSTALO ZE ZGLOSZENIA WLASCICIELA 10.09.2026: „Poller allegro_b nie działa:
// The operation was aborted due to timeout". Zdanie sklada sie z polskiej ramki panelu
// i angielskiego srodka, bo srodek pisze Node (undici), a nie panel. Czlowiek przy panelu
// ma z takiego wiersza wyciagnac JEDNA rzecz — czy to jego sprawa, czy sieci — a „aborted
// due to timeout" tego nie mowi. Ta sama fraza wychodzi z KAZDEGO polaczenia panelu
// (Allegro, sklepy, inFakt, KSeF, kurierzy), wiec tlumaczenie musi byc jedno.
//
// ⚠️⚠️ TLUMACZYMY PRZY WYSWIETLANIU, NIE PRZY ZAPISIE — i to jest cala tresc tego wyboru.
// W bazie (`stan_pollera.ostatni_blad`, `stan_kosztow.ostatni_blad`, puls czuwaczy) zostaje
// ORYGINAL: to jego szuka sie w dokumentacji undici i w logu kontenera, a wiersze zapisane
// PRZED ta zmiana i tak sa angielskie. Tlumaczenie przy zapisie zalatwialoby wylacznie
// przyszlosc, psulo dowod i rozjezdzaloby sie z `console.error` z tego samego przebiegu.
//
// ⚠️ PODMIENIAMY FRAGMENT, A NIE CALE ZDANIE. Komunikaty sa SKLADANE po drodze
// („terminy płatności: inFakt nieosiągalny: The operation was aborted due to timeout",
// „Sklep nieosiągalny: fetch failed"), wiec dopasowanie calosci nie trafiloby ani razu.
//
// ⚠️ FRAZY NIEZNANEJ NIE RUSZAMY. Komunikat spoza slownika przechodzi w calosci — lepiej
// angielskie zdanie, ktore da sie wkleic w wyszukiwarke, niz polskie zgadywanie o czyms,
// czego nie rozumiemy. Slownik ma rosnac o frazy WIDZIANE na produkcji, nie wyobrazone.

// Kolejnosc MA ZNACZENIE: frazy dluzsze i bardziej szczegolowe stoja przed krotszymi,
// bo podmiana idzie po kolei (`connect ETIMEDOUT` przed golym `ETIMEDOUT`).
const SLOWNIK = [
  // undici / AbortSignal.timeout — TO JEST fraza ze zgloszenia z 10.09.2026.
  [/The operation was aborted due to timeout/gi, 'przekroczony czas oczekiwania na odpowiedź'],
  [/(?:This|The) operation was aborted/gi, 'żądanie przerwane'],
  [/Connect Timeout Error/gi, 'przekroczony czas nawiązywania połączenia'],
  [/Headers Timeout Error/gi, 'serwer nie odesłał nagłówków w wyznaczonym czasie'],
  [/Body Timeout Error/gi, 'serwer nie odesłał treści w wyznaczonym czasie'],
  // `TypeError: fetch failed` — Node chowa prawdziwa przyczyne w `cause`, wiec czlowiek
  // dostaje sama informacje „nie doszlo". Tak to nazywamy, bez udawania, ze wiemy wiecej.
  [/fetch failed/gi, 'połączenie nie doszło do skutku'],
  [/socket hang up/gi, 'druga strona zerwała połączenie'],
  [/Client network socket disconnected before secure TLS connection was established/gi,
    'połączenie zerwane przed zestawieniem szyfrowania TLS'],
  // DNS i gniazdo — nazwa serwera zostaje w tresci (idzie po dwukropku), bo bez niej
  // czlowiek nie wie, KTORA usluga nie odpowiada.
  [/getaddrinfo ENOTFOUND/gi, 'nieznana nazwa serwera:'],
  [/getaddrinfo EAI_AGAIN/gi, 'DNS nie odpowiada dla nazwy:'],
  [/connect ECONNREFUSED/gi, 'serwer odrzucił połączenie:'],
  [/connect ETIMEDOUT/gi, 'przekroczony czas nawiązywania połączenia:'],
  [/read ECONNRESET/gi, 'połączenie zerwane w trakcie odczytu'],
  [/\bECONNRESET\b/g, 'połączenie zerwane'],
  [/\bETIMEDOUT\b/g, 'przekroczony czas połączenia'],
  [/\bEHOSTUNREACH\b/g, 'serwer nieosiągalny'],
  [/\bENETUNREACH\b/g, 'sieć nieosiągalna'],
  // Certyfikaty — objaw wyglada jak awaria uslugi, a jest sprawa do zalatwienia u niej.
  [/certificate has expired/gi, 'wygasł certyfikat serwera'],
  [/unable to verify the first certificate/gi, 'nie udało się zweryfikować certyfikatu serwera'],
  [/self[- ]signed certificate/gi, 'serwer ma certyfikat podpisany sam przez siebie'],
  // undici mowi tak o polaczeniu urwanym w polowie odpowiedzi. Tylko CALE slowo: krotkie
  // i pospolite, wiec podmiana bez granic trafialaby w srodek innych wyrazow.
  [/\bterminated\b/gi, 'połączenie przerwane w trakcie odpowiedzi'],
];

/**
 * Zamienia znane angielskie frazy techniczne na polskie. Wejscie inne niz niepusty napis
 * oddaje BEZ ZMIANY (`null` zostaje `null`) — ta funkcja stoi na drodze komunikatow, ktore
 * czesto po prostu ich nie ma, i nie ma prawa zamienic braku bledu w napis „null".
 */
export function poPolsku(komunikat) {
  if (typeof komunikat !== 'string' || !komunikat) return komunikat;
  let wynik = komunikat;
  for (const [wzor, polskie] of SLOWNIK) wynik = wynik.replace(wzor, polskie);
  return wynik;
}
