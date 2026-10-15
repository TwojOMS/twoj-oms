// PRZ-083 (właściciel 15.10): Ustawienia w demo publicznym do OBEJRZENIA przez gościa — nic do zapisania.
//
// Wpinany w pipeline.js WYŁĄCZNIE, gdy instancja ma konto gościa demo (kontoDemo ≠ null, a to wymaga OMS_TRYB=proba —
// src/core/demo.ts). Na produkcji ten hak nie istnieje. Działa PO strażniku (req.konto już jest):
//  • konto gościa dostaje znacznik `podgladDemo` — trasy Kont i Ról (zwykle tylko dla admina) wpuszczają z nim GET,
//    widoki maskują to, czego gość nie powinien widzieć (dziennik prób logowania, login administratora), a układ
//    robi treść Ustawień martwą (inert) i stawia nad nią pasek podglądu;
//  • KAŻDE żądanie inne niż GET/HEAD pod /ustawienia od gościa kończy się tu 403 — zanim dojdzie do trasy. To jest
//    właściwa blokada („inert” w przeglądarce to tylko wygoda; ręcznie złożony POST zatrzymuje się tutaj).
export const KOMUNIKAT_PODGLADU = 'W wersji demonstracyjnej ustawienia można tylko obejrzeć — zmiany są wyłączone.';

export function wUstawieniach(url) {
  const sciezka = String(url ?? '').split('?')[0];
  return sciezka === '/ustawienia' || sciezka.startsWith('/ustawienia/');
}

export function podgladUstawienDemo({ loginGoscia }) {
  return async (req, reply) => {
    if (!req.konto || req.konto.login !== loginGoscia) return;
    req.konto = { ...req.konto, podgladDemo: true };
    if (wUstawieniach(req.url) && req.method !== 'GET' && req.method !== 'HEAD') {
      return reply.code(403).type('text/plain; charset=utf-8').send(KOMUNIKAT_PODGLADU);
    }
  };
}

// Ekran „Użytkownicy i uprawnienia” w podglądzie: konto administratora demo (login i imię z montowanego konto.json)
// pokazane jako właściciel zmyślonej firmy. Dziennik prób logowania gość dostaje pusty — są w nim loginy wpisane przez
// innych gości (bywa, że e-mail) i ich adresy IP.
export const WLASCICIEL_DEMO = { login: 'wlasciciel', imie: 'Właściciel firmy' };

export function kontoWPodgladzieDemo(konto, czyAdmin) {
  if (!konto || !czyAdmin) return konto;
  return { ...konto, ...WLASCICIEL_DEMO, email: null, ostatnie_logowanie: null };
}

/**
 * Zmyślony dziennik logowań do podglądu demo (zamiast prawdziwego z loginami i IP innych gości). Ten sam kształt co
 * ostatnieLogowania (core/bezpieczenstwo/konta.js). Godziny liczone wstecz od `teraz`; IP z zakresu dokumentacyjnego.
 */
export function logowaniaDemo(teraz = new Date()) {
  const t = teraz.getTime();
  const wpis = (minutWstecz, login, wynik, ip) => ({ at: new Date(t - minutWstecz * 60_000).toISOString(), login, usluga: 'oms', ip, wynik });
  return [
    wpis(12, 'anna', 'udane', '203.0.113.24'),
    wpis(95, WLASCICIEL_DEMO.login, 'udane', '203.0.113.7'),
    wpis(97, WLASCICIEL_DEMO.login, 'zle-haslo', '203.0.113.7'),
    wpis(260, 'marek', 'udane', '203.0.113.31'),
    wpis(24 * 60 + 40, 'anna', 'udane', '203.0.113.24'),
  ];
}
