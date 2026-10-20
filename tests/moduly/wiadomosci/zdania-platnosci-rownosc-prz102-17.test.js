// PRZ-102.17 — gdy żadne zdanie o płatności nie jest zmienione, maile są BAJT W BAJT takie jak przed zmianą.
//
// Wzorzec (tests/fixtures/zdania-platnosci-prz102-17.json) zapisał skrypt uruchomiony na kodzie SPRZED zmiany
// (gałąź od 28b950e), na scenariuszach z tests/pomoc/zdania-platnosci-scenariusze.js: każdy z siedmiu wariantów
// zdania zamykającego, oba zdania o załącznikach, nagłówki DO ZAPŁATY / PRZELEW — w drodze bez zapisanego szablonu
// (jakoTekstWiadomosci + renderWiadomoscHtml, czyli produkcja) i w drodze szablonu domyślnego (zlozTresc + renderSzablonHtml).
//
// PRZ-102.19 dopisał do tego samego pliku klucze „zamówienie: …", „wątek Allegro bez zamówienia" i „podgląd podpisu":
// potwierdzenie (droga bez szablonu i szablon domyślny), szablon własny ze wszystkimi blokami zamówienia, „Zamówienie
// wysłane", tekst do wątku Allegro i podgląd podpisu w Ustawieniach → Poczta. Zapisał je skrypt uruchomiony na kodzie
// SPRZED PRZ-102.19 (gałąź od 9fbc537, `src/` nietknięty): wczytuje plik, sprawdza, że ponowny zapis daje te same bajty,
// dopisuje nowe klucze i zapisuje z tym samym wcięciem — istniejące wzorce nie zmieniły ani znaku (git diff: same „+").
// Ten plik nie może być przegenerowany „żeby przeszło" — zmiana wzorca to zmiana maili na produkcji.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modelWiadomosci, jakoTekstWiadomosci } from '../../../src/domena/wiadomosc-platnicza.js';
import { renderWiadomoscHtml } from '../../../src/core/poczta/wiadomosc-html.js';
import { mailPlatniczy, mailPotwierdzenia, mailWlasny, mailWyslane, tekstDoWatku } from '../../../src/moduly/wiadomosci/szablony.js';
import { podgladPodpisu } from '../../../src/moduly/wiadomosci/podpis-maili.js';
import { DOMYSLNE } from '../../../src/domena/szablony-wiadomosci.js';
import { DOMYSLNE_ZDANIA, ZDANIA } from '../../../src/domena/zdania-platnosci.js';
import { zdaniaPlatnosciTeraz } from '../../../src/moduly/wiadomosci/zdania-platnosci.js';
import { SCENARIUSZE, SCENARIUSZE_ZAMOWIENIA, WLASNY, OPRAWA } from '../../pomoc/zdania-platnosci-scenariusze.js';

const WZORZEC = JSON.parse(readFileSync(new URL('../../fixtures/zdania-platnosci-prz102-17.json', import.meta.url), 'utf8'));
const BEZ_ZAMOWIENIA = 'wątek Allegro bez zamówienia';
const PODGLAD_PODPISU = 'podgląd podpisu (Ustawienia → Poczta)';

const mail = (z, dokument, opcje) => {
  const m = modelWiadomosci(z, opcje);
  const s = mailPlatniczy(z, m, { temat_id: opcje.temat_id, dokument, oprawa: OPRAWA, szablon: DOMYSLNE[opcje.temat_id] });
  return { tekst: jakoTekstWiadomosci(m), html: renderWiadomoscHtml(m, OPRAWA), szablon: { temat: s.temat, tekst: s.tekst, html: s.html } };
};

const trzy = (m) => ({ temat: m.temat, tekst: m.tekst, html: m.html });
/** Wszystkie maile z blokami zamówienia — `zdania` undefined = wywołanie bez parametru (jak przed PRZ-102.19). */
const maileZamowienia = (z, zdania) => {
  const o = zdania === undefined ? {} : { zdania };
  return {
    potwierdzenie: trzy(mailPotwierdzenia(z, { oprawa: OPRAWA, szablon: null, ...o })),
    szablon: trzy(mailPotwierdzenia(z, { oprawa: OPRAWA, szablon: DOMYSLNE.potwierdzenie, ...o })),
    wlasny: trzy(mailWlasny(z, WLASNY, { oprawa: OPRAWA, ...o })),
    wyslane: trzy(mailWyslane(z, DOMYSLNE.wyslane, { oprawa: OPRAWA, ...o })),
    watek: tekstDoWatku(z, WLASNY, { podpis: OPRAWA.podpis, ...o }),
  };
};

// Tekst domyślny tak, jak stoi w mailu: nagłówki wielkimi literami (wersja tekstowa), etykieta przelewu z dwukropkiem,
// numer proformy wstawiony, „adres do uzgodnienia" w nawiasie, jednostka po ukośniku.
const jakWMailu = (z) => {
  if (z.klucz.startsWith('naglowek_')) return z.domyslne.toLocaleUpperCase('pl-PL');
  if (z.klucz === 'etykieta_razem') return `${z.domyslne.toLocaleUpperCase('pl-PL')}: `;
  if (z.klucz === 'adres_do_uzgodnienia') return `(${z.domyslne})`;
  if (z.klucz === 'jednostka') return `/${z.domyslne}`;
  if (z.grupa === 'przelew' && z.klucz !== 'dopisek_brutto') return `${z.domyslne}: `;
  return z.domyslne.replace('{numer_proformy}', 'PF 7/10/2026');
};

describe('PRZ-102.17: zdania niezmienione = mail sprzed zmiany, co do bajtu', () => {
  it('wzorzec obejmuje wszystkie warianty zdania zamykającego, oba zdania o załącznikach i każdy stały tekst', () => {
    const platnicze = SCENARIUSZE.map(([n]) => WZORZEC[n].tekst).join('\n');
    const zamowienia = SCENARIUSZE_ZAMOWIENIA.map(([n]) => WZORZEC[n].potwierdzenie.tekst).join('\n');
    const html = SCENARIUSZE_ZAMOWIENIA.map(([n]) => WZORZEC[n].potwierdzenie.html).join('\n');
    for (const z of ZDANIA) {
      if (z.grupa === 'zamowienie' || z.grupa === 'podpis') {
        // Kolumny tabeli są tylko w HTML-u; reszta stoi w obu postaciach.
        expect(z.klucz.startsWith('kolumna_') ? html : zamowienia, z.klucz).toContain(z.klucz.startsWith('kolumna_') ? `>${z.domyslne}</td>` : jakWMailu(z));
      }
      if (z.grupa !== 'zamowienie') expect(platnicze, z.klucz).toContain(jakWMailu(z));
    }
    expect(Object.keys(DOMYSLNE_ZDANIA)).toHaveLength(ZDANIA.length);
    expect(Object.keys(WZORZEC)).toHaveLength(SCENARIUSZE.length + SCENARIUSZE_ZAMOWIENIA.length + 2);
  });

  // Trzy drogi do „niezmienione": bez parametru (stare wywołania), z pustej bazy (jak usługa przy każdym mailu)
  // i z kompletem tekstów domyślnych podanym wprost.
  const drogi = [
    ['bez parametru zdania', () => undefined],
    ['zdania z pustej bazy', () => zdaniaPlatnosciTeraz(openOmsDb(':memory:'))],
    ['komplet domyślnych podany wprost', () => ({ ...DOMYSLNE_ZDANIA })],
  ];
  for (const [droga, zdania] of drogi) {
    for (const [nazwa, { z, dokument, opcje }] of SCENARIUSZE) {
      it(`${droga}: ${nazwa}`, () => {
        const z0 = zdania();
        const wynik = mail(z, dokument, z0 === undefined ? opcje : { ...opcje, zdania: z0 });
        const w = WZORZEC[nazwa];
        expect(Buffer.from(wynik.tekst).equals(Buffer.from(w.tekst)), 'tekst').toBe(true);
        expect(Buffer.from(wynik.html).equals(Buffer.from(w.html)), 'html').toBe(true);
        expect(wynik.szablon).toEqual(w.szablon);
      });
    }

    // PRZ-102.19: etykiety i stałe teksty bloków zamówienia oraz „Pozdrawiamy," — wszystkie rodzaje maili do klienta.
    for (const [nazwa, z] of SCENARIUSZE_ZAMOWIENIA) {
      it(`${droga}: ${nazwa}`, () => {
        const wynik = maileZamowienia(z, zdania());
        const w = WZORZEC[nazwa];
        for (const rodzaj of ['potwierdzenie', 'szablon', 'wlasny', 'wyslane']) {
          expect(wynik[rodzaj].temat, `${rodzaj} temat`).toBe(w[rodzaj].temat);
          expect(Buffer.from(wynik[rodzaj].tekst).equals(Buffer.from(w[rodzaj].tekst)), `${rodzaj} tekst`).toBe(true);
          expect(Buffer.from(wynik[rodzaj].html).equals(Buffer.from(w[rodzaj].html)), `${rodzaj} html`).toBe(true);
        }
        expect(Buffer.from(wynik.watek).equals(Buffer.from(w.watek)), 'wątek Allegro').toBe(true);
      });
    }

    it(`${droga}: ${BEZ_ZAMOWIENIA} i ${PODGLAD_PODPISU}`, () => {
      const z0 = zdania();
      const o = z0 === undefined ? {} : { zdania: z0 };
      expect(tekstDoWatku(null, WLASNY, { podpis: OPRAWA.podpis, ...o })).toBe(WZORZEC[BEZ_ZAMOWIENIA].watek);
      expect(z0 === undefined ? podgladPodpisu(OPRAWA) : podgladPodpisu(OPRAWA, o)).toEqual(WZORZEC[PODGLAD_PODPISU]);
    });
  }
});
