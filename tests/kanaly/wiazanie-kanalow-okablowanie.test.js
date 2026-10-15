import { describe, it, expect, vi } from 'vitest';
import { createWiazanieKanalow } from '../../src/moduly/kanaly/services/wiazanie-kanalow.js';

// ⚠️⚠️ TEN TEST ISTNIEJE, BO WIAZANIE Z PANELU NIE ZADZIALALO NIGDY, a suita byla zielona.
//
// `tests/oms/wiazanie-kanalow.test.js` wstrzykuje ATRAPE `przeprowadz`, wiec sprawdza reguly
// uslugi (bariery, mape w toku, biala liste pol) i ani razu nie dotyka prawdziwej petli
// device flow. A prawdziwa petla (`allegro/wiazanie.js`) bierze `spij` BEZ WARTOSCI DOMYSLNEJ
// — celowo, zeby test nie zasnal naprawde. Usluga tego parametru NIE PODAWALA, wiec pierwsza
// odpowiedz `authorization_pending` konczyla sie `TypeError: spij is not a function`.
//
// Objaw dla czlowieka: ekran ustawien pokazywal kod i zaraz pod nim „Wiazanie przerwane
// bledem panelu." — bez slowa o przyczynie, bo `log` tez nie byl podany (domyslnie `() => {}`).
// Zmierzone na produkcji 28.08.2026 na OBU kanalach.
//
// Dlatego ten test woła uslugę z DOMYSLNYM `przeprowadz`, czyli przez prawdziwą pętlę.

function tokenyAtrapa({ odpowiedzi }) {
  let i = 0;
  return {
    rozpocznijPowiazanie: async () => ({
      device_code: 'dev', user_code: 'kod1234', expires_in: 600, interval: 1,
      verification_uri_complete: 'https://allegro.pl/skojarz?code=kod1234',
    }),
    dokonczPowiazanie: async () => odpowiedzi[i++] ?? { gotowe: true },
    // ⚠️ Kanal MUSI byc wiazalny, inaczej bariera odrzuca zadanie zanim petla ruszy.
    // Tu: dziala, ale brakuje mu uprawnienia — dokladnie stan produkcji z 28.08.2026.
    stanDlaEkranu: () => ({
      kanal: 'allegro_szkicownia', polaczony: true, zostaloDni: 90,
      brakujaceUprawnienia: ['allegro:api:messaging'],
    }),
  };
}

const uslugaZ = (tokeny, log = () => {}) => createWiazanieKanalow({
  tokenyKanalow: { allegro_szkicownia: tokeny }, log,
});

describe('okablowanie wiązania: usługa → PRAWDZIWA pętla device flow', () => {
  it('pierwsze „authorization_pending" NIE wywraca wiązania', async () => {
    vi.useFakeTimers();
    try {
      const tokeny = tokenyAtrapa({
        odpowiedzi: [{ gotowe: false, powod: 'authorization_pending' }, { gotowe: true }],
      });
      const usluga = uslugaZ(tokeny);

      const start = await usluga.rozpocznij('allegro_szkicownia');
      expect(start.ok).toBe(true);
      expect(usluga.stan('allegro_szkicownia').userCode).toBe('kod1234');

      // Pętla śpi między próbami — bez `spij` poleciałby tu TypeError.
      await vi.advanceTimersByTimeAsync(60_000);

      // ⚠️ Sukces KASUJE wpis z mapy; błąd zostawiłby go z polem `blad`.
      expect(usluga.stan('allegro_szkicownia')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('błąd pętli TRAFIA DO LOGU, a nie w próżnię', async () => {
    vi.useFakeTimers();
    try {
      const log = vi.fn();
      const tokeny = tokenyAtrapa({ odpowiedzi: [] });
      tokeny.rozpocznijPowiazanie = async () => { throw new Error('Allegro: HTTP 503 przy /device'); };
      const usluga = createWiazanieKanalow({ tokenyKanalow: { allegro_szkicownia: tokeny }, log });

      await usluga.rozpocznij('allegro_szkicownia');
      await vi.advanceTimersByTimeAsync(1000);

      // Bez tego jedynym śladem po awarii jest zdanie „Wiązanie przerwane błędem panelu."
      // na ekranie — a przyczyny nie zna nikt.
      expect(log).toHaveBeenCalled();
      expect(String(log.mock.calls[0])).toMatch(/503|wiązanie/i);
    } finally {
      vi.useRealTimers();
    }
  });
});
