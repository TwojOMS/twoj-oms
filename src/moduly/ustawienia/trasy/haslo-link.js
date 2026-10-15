// PRZ-069: otwarta trasa ustawienia hasła z jednorazowego linku. Bez automatycznego logowania.
// Każdy zły link (zużyty, przeterminowany, podmieniony, wyłączonego konta) dostaje TEN SAM komunikat
// i liczy się do hamulca po IP — odpowiedź nie mówi, który z powodów zaszedł.
import { utworzHamulec, LIMIT_PROB, KARA_MS } from '../../../core/bezpieczenstwo/hamulec.js';
import { dopiszLogowanie } from '../../../core/bezpieczenstwo/konta.js';
import { aktywnyLink, uzyjLinku } from '../linki-hasla.js';
import { MIN_DLUGOSC_HASLA } from './moje-konto.js';

const NIEWAZNY = 'Link jest nieważny — poproś administratora o nowy.';

/**
 * ⚠️ `strict-origin`, NIE `no-referrer` (recenzja D8 r1, P1-1 — zmierzone w Chromium 149 i Edge 155, tabela
 * w docs/prz069-odbior.md). Przy `no-referrer` przeglądarka wysyła z POST formularza `Origin: null` i bez
 * Referera — ochrona CSRF (src/core/bezpieczenstwo/csrf.js) odrzuca to 403, więc hasła z linku nie dało się
 * ustawić w żadnej prawdziwej przeglądarce. `strict-origin` daje poprawny Origin, a Referer to sam origin
 * („http://host/”) — ścieżka z tokenem nie wychodzi w Refererze NIGDZIE, także do własnego serwera.
 * `same-origin` odpada: wysyła do własnego serwera pełny adres z tokenem (logi, każdy zasób strony).
 */
export const POLITYKA_REFERERA_LINKU = 'strict-origin';

export function registerHasloLinkRoutes(app, { db, teraz }) {
  // Wygaszanie po karze i limit kluczy (recenzja D8 r1, P3-3): zgadywanie 256-bitowego tokenu jest bez sensu,
  // hamulec tnie hałas — po karze licznik startuje od zera, a mapa w pamięci nie rośnie bez końca.
  const hamulec = utworzHamulec({ wygasanieMs: KARA_MS, maksKluczy: 10_000 });
  const chwila = () => teraz().getTime();
  const naglowki = (reply) => reply.header('Cache-Control', 'no-store').header('Referrer-Policy', POLITYKA_REFERERA_LINKU);
  const strona = (reply, kod, extra) => naglowki(reply).code(kod).view('haslo-link.ejs', {
    title: 'Ustaw hasło', bezPaska: true, niewazny: false, blad: null, akcja: null, imie: '', cel: null, ...extra });
  const zablokowane = (req, reply) => {
    const s = hamulec.sprawdz(req.ip, chwila());
    return s.wolno ? null : strona(reply, 429, { niewazny: true, blad: `Za dużo prób — spróbuj za ${Math.ceil(s.zostaloMs / 1000)} s.` });
  };
  const odmowa = (req, reply) => {
    const proby = hamulec.odnotujBlad(req.ip, chwila());
    return strona(reply, proby >= LIMIT_PROB ? 429 : 410, { niewazny: true, blad: NIEWAZNY });
  };

  app.get('/haslo/:token', async (req, reply) => {
    const stop = zablokowane(req, reply); if (stop) return stop;
    const link = aktywnyLink(db, req.params.token, teraz);
    if (!link) return odmowa(req, reply);
    return strona(reply, 200, { akcja: `/haslo/${req.params.token}`, imie: link.imie, cel: link.cel });
  });

  app.post('/haslo/:token', async (req, reply) => {
    const stop = zablokowane(req, reply); if (stop) return stop;
    const link = aktywnyLink(db, req.params.token, teraz);
    if (!link) return odmowa(req, reply);
    const nowe = String(req.body?.nowe ?? '');
    const blad = nowe.length < MIN_DLUGOSC_HASLA ? `Hasło musi mieć co najmniej ${MIN_DLUGOSC_HASLA} znaków.`
      : nowe !== String(req.body?.nowe2 ?? '') ? 'Hasło wpisane dwa razy różni się.' : null;
    if (blad) return strona(reply, 400, { akcja: `/haslo/${req.params.token}`, imie: link.imie, cel: link.cel, blad });
    const wynik = uzyjLinku(db, { token: req.params.token, haslo: nowe, teraz });
    if (!wynik) return odmowa(req, reply);
    hamulec.wyczysc(req.ip); // udane użycie dowodzi, że to nie zgadujący (jak po udanym logowaniu)
    dopiszLogowanie(db, { login: wynik.login, usluga: 'oms', ip: req.ip, wynik: 'haslo-z-linku' });
    return naglowki(reply).redirect('/login?haslo=ustawione');
  });
}
