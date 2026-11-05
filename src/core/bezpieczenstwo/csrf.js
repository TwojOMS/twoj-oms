// Ochrona przed CSRF dla obu paneli (indywidualnego i OMS).
//
// Czego pilnuje. Oba panele stoja za Basic Auth. Przegladarka, ktora raz sie
// uwierzytelnila, DOKLADA te poswiadczenia do KAZDEGO zadania na ten adres — takze
// do zadania wystawionego przez zupelnie obca strone otwarta w sasiedniej karcie.
// Bez tej ochrony formularz na cudzej stronie moze nadac paczke albo wystawic fakture
// w KSeF, czyli wywolac skutek, ktorego nie da sie cofnac.
//
// Dlaczego akurat sprawdzanie zrodla, a nie token w formularzu. Token trzeba wpiac
// do KAZDEGO formularza i do kazdego wywolania htmx; jedno pominiete miejsce to cicha
// dziura, ktorej nic nie zglosi. Tu regula jest jedna i obejmuje wszystko, co przyjdzie —
// takze trasy dopisane w przyszlosci, o ktorych autor ochrony nie wie.

import { motywZNaglowka } from '../../domena/motyw.js';
import { sciezkaWidoku } from '../web/widoki.js';

export const METODY_BEZPIECZNE = ['GET', 'HEAD', 'OPTIONS'];

// PRZ-152.G13c1: odmowa z haka rdzenia (CSRF tutaj, podgląd demo w podglad-demo.js). Nawigacja przeglądarki
// (formularz, link: Accept z text/html i bez nagłówka HX-Request) dostaje stronę w barwach OMS z paskiem uwagi
// i drogą powrotu; skrypt (fetch: Accept */* albo application/json), htmx i program — dotychczasowy text/plain.
// Status i tekst bez zmian. Dokument samodzielny (odmowa-rdzenia.ejs), bo hak onRequest działa przed preHandlerem,
// który liczy menu i motyw dla wspólnej ramy oraz tłumaczy krótkie nazwy widoków (K1, jak brak-dostepu.ejs).
export function czyNawigacjaPrzegladarki(req) {
  return String(req.headers.accept ?? '').includes('text/html') && req.headers['hx-request'] === undefined;
}

export function odmowaRdzenia(req, reply, status, komunikat, { tytul, wroc, napisWroc }) {
  if (!czyNawigacjaPrzegladarki(req)) return reply.code(status).type('text/plain; charset=utf-8').send(komunikat);
  return reply.code(status).type('text/html; charset=utf-8').view(sciezkaWidoku('odmowa-rdzenia.ejs'), {
    wlasnyUklad: true, motyw: motywZNaglowka(req.headers.cookie), tytul, komunikat, wroc, napisWroc,
  });
}

// Port domyslny bywa w jednym miejscu zapisany, a w drugim pominiety: naglowek Host
// niesie "panel.local:80", a URL w Origin normalizuje sie do "panel.local". To ten sam
// adres i musi sie porownac jako rowny.
function normalizuj(host) {
  return String(host ?? '').trim().toLowerCase().replace(/:(80|443)$/, '');
}

function hostZUrl(url) {
  try {
    const u = new URL(url);
    // Bez tego "to nie jest URL" moze przejsc jako URL o pustym hoscie, a pusty host
    // porownalby sie na rowni z brakiem naglowka Host.
    if (!u.host) return null;
    return u.host;
  } catch {
    return null;
  }
}

/**
 * Zwraca null, gdy zadanie wolno przepuscic, albo tekst powodu odmowy.
 * Czysta funkcja — hook nizej tylko podaje jej naglowki.
 */
export function sprawdzZrodlo({ method, host, origin, referer }) {
  if (METODY_BEZPIECZNE.includes(String(method ?? '').toUpperCase())) return null;

  const nasz = normalizuj(host);
  if (!nasz) return 'zadanie bez naglowka Host — nie ma z czym porownac zrodla';

  // Origin ma pierwszenstwo i jest OSTATECZNY. Jesli przyszedl, nie wolno przy jego
  // odrzuceniu siegac po Referer: doslowne "null" (sandboksowana ramka, czesc
  // przekierowan) to informacja "pochodzenie nieujawnione", a nie brak naglowka.
  if (origin !== undefined && origin !== null && origin !== '') {
    const zrodlo = hostZUrl(origin);
    if (!zrodlo) return `nagłówek Origin nie jest adresem: ${origin}`;
    if (normalizuj(zrodlo) !== nasz) return `żądanie z obcego źródła (Origin: ${origin})`;
    return null;
  }

  // Zapas dla przegladarek, ktore przy formularzu na wlasny serwer Origin pomijaja
  // (tak przez lata robil Firefox). Referer przy zwyklym formularzu jest zawsze.
  if (referer !== undefined && referer !== null && referer !== '') {
    const zrodlo = hostZUrl(referer);
    if (!zrodlo) return `nagłówek Referer nie jest adresem: ${referer}`;
    if (normalizuj(zrodlo) !== nasz) return `żądanie z obcego źródła (Referer: ${referer})`;
    return null;
  }

  // Zawodzimy zamknieciem. Oba panele sa narzedziami przegladarkowymi w LAN-ie;
  // nie ma legalnego klienta, ktory zmienia stan i nie wysyla ani Origin, ani Referera.
  return 'żądanie bez nagłówka Origin i Referer — nie da się stwierdzić, skąd przyszło';
}

/**
 * Podpina ochrone jako hook onRequest.
 *
 * KOLEJNOSC MA ZNACZENIE: rejestrowac PO haku uwierzytelniania. Inaczej zadanie
 * nieuwierzytelnione dostaje 403 zamiast 401 i przestaje byc widac, ze panel w ogole
 * pyta o haslo.
 */
export function zarejestrujOchroneCsrf(app) {
  app.addHook('onRequest', async (req, reply) => {
    const powod = sprawdzZrodlo({
      method: req.method,
      host: req.headers.host,
      origin: req.headers.origin,
      referer: req.headers.referer ?? req.headers.referrer,
    });
    if (!powod) return;
    req.log?.warn?.({ url: req.url, powod }, 'CSRF: odmowa');
    return odmowaRdzenia(req, reply, 403,
      `Odmowa: ${powod}.\n\nJeśli to Twoje własne działanie w panelu, otwórz panel pod jego zwykłym adresem i spróbuj ponownie.`,
      { tytul: 'Nie wykonano polecenia', wroc: '/', napisWroc: 'Przejdź do panelu' });
  });
}
