import { describe, it, expect } from 'vitest';
import {
  wartoPytacAllegroONumery, OKNO_DOPYTANIA_PO_WYSLANIU_DNI,
} from '../../src/domena/allegro-numery.js';

// CZY PYTAC ALLEGRO O NUMERY LISTOW TEGO ZAMOWIENIA (25.08.2026).
//
// Do tej pory warunek brzmial „dopoki zamowienie NIE MA `wyslane_at`" — czyli dopoki wisi
// na liscie roboczej. Zmierzone na produkcji tego dnia: **22 zamowienia Allegro oznaczone
// jako wyslane nie maja w panelu ANI JEDNEJ przesylki**, a numery po stronie Allegro sa.
//
// Wzorcowy przypadek to zamowienie 1207: przesylka powstala w Allegro o 09:11:40, a czlowiek
// oznaczyl zamowienie jako wyslane o 09:12 — DWADZIESCIA SEKUND pozniej. Okno zamknelo sie,
// zanim ktokolwiek otworzyl karte. Ograniczenie bylo udokumentowane, ale WASKO: jako
// „dosylka nadana po oznaczeniu wysylki nie dojdzie". W praktyce zjadalo tez numer PIERWSZEJ
// paczki, gdy operator klika szybciej, niz panel zdazy zajrzec.

const TERAZ = '2026-08-25T10:00:00Z';
const z = (nad = {}) => ({ wyslane_at: null, ...nad });

describe('wartoPytacAllegroONumery', () => {
  it('zamowienie niewyslane pytamy jak dotad — bez zmian', () => {
    expect(wartoPytacAllegroONumery(z(), { maPrzesylke: false, teraz: TERAZ })).toBe(true);
    // Takze gdy paczka juz jest: dosylka do zamowienia W TOKU ma sie dociagnac.
    expect(wartoPytacAllegroONumery(z(), { maPrzesylke: true, teraz: TERAZ })).toBe(true);
  });

  it('wyslane BEZ zadnej przesylki pytamy — to jest ta luka', () => {
    expect(wartoPytacAllegroONumery(
      z({ wyslane_at: '2026-08-24T09:12:00Z' }), { maPrzesylke: false, teraz: TERAZ },
    )).toBe(true);
  });

  // ⚠️ TU JEST HAMULEC. Warunek „pytaj zawsze po wyslaniu" znaczylby jedno zadanie do Allegro
  // na KAZDE otwarcie karty archiwalnej — reklamacje, faktury, przegladanie historii. Tego
  // wlasnie broni komentarz przy trasie (~14 000 zadan na dobe w wariancie pollera).
  // Numer, ktory mamy, jest odpowiedzia ostateczna: nie zmienia sie w zyciu paczki.
  it('wyslane z paczka NIE jest pytane — numer juz mamy', () => {
    expect(wartoPytacAllegroONumery(
      z({ wyslane_at: '2026-08-24T09:12:00Z' }), { maPrzesylke: true, teraz: TERAZ },
    )).toBe(false);
  });

  it('po oknie przestajemy pytac — archiwum nie wali w API Allegro', () => {
    expect(OKNO_DOPYTANIA_PO_WYSLANIU_DNI).toBe(30);
    const swieze = '2026-07-27T10:00:00Z'; // 29 dni
    const stare = '2026-07-25T10:00:00Z'; // 31 dni
    expect(wartoPytacAllegroONumery(z({ wyslane_at: swieze }), { maPrzesylke: false, teraz: TERAZ })).toBe(true);
    expect(wartoPytacAllegroONumery(z({ wyslane_at: stare }), { maPrzesylke: false, teraz: TERAZ })).toBe(false);
  });

  // Granica jawnie: dokladnie 30 dni jeszcze pytamy. Rozstrzygniete tutaj, zeby nie zalezalo
  // od tego, ktora strona nierownosci komus wygodniej sie czytalo.
  it('dokladnie 30 dni to jeszcze pytanie', () => {
    expect(wartoPytacAllegroONumery(
      z({ wyslane_at: '2026-07-26T10:00:00Z' }), { maPrzesylke: false, teraz: TERAZ },
    )).toBe(true);
  });

  // ⚠️ NIEPARSOWALNA DATA NIE MOZE ZNACZYC „PYTAJ BEZ KONCA". Wiersz z uszkodzonym
  // `wyslane_at` jest wyslany (kolumna niepusta), wiec brak okna zamienialby go w zrodlo
  // zadania przy kazdym otwarciu karty — po cichu i dokladnie w archiwum.
  it('nieparsowalne wyslane_at to odmowa, nie pytanie bez konca', () => {
    expect(wartoPytacAllegroONumery(
      z({ wyslane_at: 'kiedys' }), { maPrzesylke: false, teraz: TERAZ },
    )).toBe(false);
  });

  it('brak zamowienia to odmowa', () => {
    expect(wartoPytacAllegroONumery(null, { maPrzesylke: false, teraz: TERAZ })).toBe(false);
  });
});
