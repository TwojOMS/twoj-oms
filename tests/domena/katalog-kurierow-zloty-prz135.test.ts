// PRZ-135.01 — ZŁOTE TESTY katalogu integracji wysyłki i sekcji „Kurierzy” w Ustawieniach (stan z fb84a210).
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { KATALOG_INTEGRACJI } from '../../src/domena/katalog-integracji.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'), origin: 'http://localhost' };

describe('katalog integracji — wpisy kategorii wysylka', () => {
  it('6 wpisów (DHL i Apaczka — T3, decyzja właściciela 03.11), całe obiekty, w tej kolejności', () => {
    expect(KATALOG_INTEGRACJI.filter((u) => u.kategoria === 'wysylka')).toEqual([
      { id: 'dpd', nazwa: 'DPD', kategoria: 'wysylka', opis: 'Nadaj przesyłki przez DPD.', logo: '/integracje/dpd.svg',
        dostepnosc: 'dostepna', href: '/ustawienia/integracje/dpd', konfigurator: null },
      { id: 'inpost', nazwa: 'InPost', kategoria: 'wysylka', opis: 'Nadaj przesyłki przez InPost.', logo: '/integracje/inpost.svg',
        dostepnosc: 'dostepna', href: '/ustawienia/integracje/inpost', konfigurator: null },
      { id: 'wza', nazwa: 'Wysyłam z Allegro', kategoria: 'wysylka', opis: 'Nadaj przesyłki z wykorzystaniem powiązanego konta Allegro.',
        logo: '/integracje/allegro.svg', dostepnosc: 'dostepna', href: '/ustawienia/integracje#grupa-sprzedaz', konfigurator: null },
      { id: 'gls', nazwa: 'GLS', kategoria: 'wysylka', opis: 'Połączenie z kurierem GLS.', logo: '/integracje/gls.png',
        dostepnosc: 'planowana', href: null, konfigurator: null },
      { id: 'dhl', nazwa: 'DHL', kategoria: 'wysylka', opis: 'Połączenie z kurierem DHL.', logo: '/integracje/dhl.svg',
        dostepnosc: 'planowana', href: null, konfigurator: null },
      { id: 'apaczka', nazwa: 'Apaczka', kategoria: 'wysylka', opis: 'Broker — wiele firm kurierskich w jednej umowie.',
        logo: '/integracje/paczka.svg', dostepnosc: 'planowana', href: null, konfigurator: null },
    ]);
  });
});

// PRZ-136.09 (03.11): przebudowa katalogu — przycisk btn--drugi, pastylka „Wkrótce”, wymiary logo, data-usluga.
// PRZ-136.14: logo bez loading="lazy" (puste przy zrzucie całej strony), WzA → grupa kont Allegro na liście.
const WYCIAG_WYSYLKA =
  '<section class="ust-kategoria"><h2>Wysyłka</h2><div class="ust-katalog">\n\n\n<article class="ust-karta-integracji" data-usluga="dpd"><div class="ust-logo-marki"><img src="/public/integracje/dpd.svg" alt="DPD" width="100" height="38"></div>\n<h3>DPD</h3><p>Nadaj przesyłki przez DPD.</p>\n<span class="ust-znacznik">Dostępna</span>\n\n<div class="ust-karta-akcje"><a class="btn btn--drugi btn--maly" href="/ustawienia/integracje/dpd">Konfiguruj</a></div>\n\n</article>\n\n<article class="ust-karta-integracji" data-usluga="inpost"><div class="ust-logo-marki"><img src="/public/integracje/inpost.svg" alt="InPost" width="100" height="38"></div>\n<h3>InPost</h3><p>Nadaj przesyłki przez InPost.</p>\n<span class="ust-znacznik">Dostępna</span>\n\n<div class="ust-karta-akcje"><a class="btn btn--drugi btn--maly" href="/ustawienia/integracje/inpost">Konfiguruj</a></div>\n\n</article>\n\n<article class="ust-karta-integracji" data-usluga="wza"><div class="ust-logo-marki"><img src="/public/integracje/allegro.svg" alt="Wysyłam z Allegro" width="100" height="38"></div>\n<h3>Wysyłam z Allegro</h3><p>Nadaj przesyłki z wykorzystaniem powiązanego konta Allegro.</p>\n<span class="ust-znacznik">Dostępna</span>\n\n<div class="ust-karta-akcje"><a class="btn btn--drugi btn--maly" href="/ustawienia/integracje#grupa-sprzedaz">Konfiguruj</a></div>\n\n</article>\n\n<article class="ust-karta-integracji ust-karta-integracji--planowana" data-usluga="gls"><div class="ust-logo-marki"><img src="/public/integracje/gls.png" alt="GLS" width="100" height="38"></div>\n<h3>GLS</h3><p>Połączenie z kurierem GLS.</p>\n<span class="ust-znacznik ust-znacznik--wkrotce">Wkrótce</span>\n\n</article>\n\n<article class="ust-karta-integracji ust-karta-integracji--planowana" data-usluga="dhl"><div class="ust-logo-marki"><img src="/public/integracje/dhl.svg" alt="DHL" width="100" height="38"></div>\n<h3>DHL</h3><p>Połączenie z kurierem DHL.</p>\n<span class="ust-znacznik ust-znacznik--wkrotce">Wkrótce</span>\n\n</article>\n\n<article class="ust-karta-integracji ust-karta-integracji--planowana" data-usluga="apaczka"><div class="ust-logo-marki"><img src="/public/integracje/paczka.svg" alt="Apaczka" width="100" height="38"></div>\n<h3>Apaczka</h3><p>Broker — wiele firm kurierskich w jednej umowie.</p>\n<span class="ust-znacznik ust-znacznik--wkrotce">Wkrótce</span>\n\n</article></div></section>';

describe('Ustawienia → Integracje — sekcja Wysyłka i brak sekcji Kurierzy', () => {
  it('katalog: sekcja Wysyłka dosłownie', async () => {
    const a = await zbudujOms({ env });
    try {
      const r = await a.app.inject({ method: 'GET', url: '/ustawienia/integracje/katalog', headers });
      const od = r.body.indexOf('<section class="ust-kategoria"><h2>Wysyłka</h2>');
      expect(od).toBeGreaterThan(-1);
      expect(r.body.slice(od, r.body.indexOf('</section>', od) + 10)).toBe(WYCIAG_WYSYLKA);
    } finally { await a.app.close(); a.db.close(); }
  });

  it('/ustawienia/integracje dziś nie pokazuje sekcji „Kurierzy” (martwa gałąź szablonu)', async () => {
    const a = await zbudujOms({ env });
    try {
      const r = await a.app.inject({ method: 'GET', url: '/ustawienia/integracje', headers });
      expect(r.statusCode).toBe(200);
      expect(r.body.includes('<h2>Kurierzy</h2>')).toBe(false);
    } finally { await a.app.close(); a.db.close(); }
  });
});
