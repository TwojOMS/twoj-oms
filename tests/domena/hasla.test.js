import { describe, it, expect } from 'vitest';
import { zahaszuj, zgodneHaslo } from '../../src/domena/hasla.js';

describe('hasla (scrypt z node:crypto)', () => {
  it('zgadza sie z wlasnym haslem', () => {
    const zapis = zahaszuj('tajne-haslo');
    expect(zgodneHaslo('tajne-haslo', zapis)).toBe(true);
  });

  it('odmawia przy zlym hasle', () => {
    expect(zgodneHaslo('inne', zahaszuj('tajne-haslo'))).toBe(false);
  });

  it('dwa zapisy TEGO SAMEGO hasla sa rozne — sol jest losowa', () => {
    expect(zahaszuj('x')).not.toBe(zahaszuj('x'));
  });

  it('nie wpada w panike na smieciu zamiast zapisu', () => {
    expect(zgodneHaslo('x', '')).toBe(false);
    expect(zgodneHaslo('x', 'bzdura')).toBe(false);
    expect(zgodneHaslo('x', null)).toBe(false);
  });

  it('zapis nie zawiera hasla otwartym tekstem', () => {
    expect(zahaszuj('jawne-haslo')).not.toContain('jawne-haslo');
  });

  // ⚠️ Regresja po recenzji: zapis z PUSTYM ogonem (`...$<sol>$`) dawal `oczekiwany.length === 0`.
  // `scryptSync(cokolwiek, sol, 0, ...)` NIE rzuca — oddaje bufor zerowej dlugosci — a
  // `timingSafeEqual` na dwoch pustych buforach oddaje `true`. Skutek: KAZDE haslo pasowalo
  // do takiego wiersza. Ten test musi dawac `false` niezaleznie od podanego hasla.
  it('zapis z PUSTYM kluczem NIE przepuszcza zadnego hasla (dziura zamknieta)', () => {
    expect(zgodneHaslo('cokolwiek', 'scrypt$16384$8$1$c29sc29s$')).toBe(false);
    expect(zgodneHaslo('inne-haslo', 'scrypt$16384$8$1$c29sc29s$')).toBe(false);
  });

  it('odmawia przy innym prefiksie niz scrypt', () => {
    expect(zgodneHaslo('x', 'bcrypt$16384$8$1$c29s$a2V5')).toBe(false);
  });

  it('odmawia, gdy parametry N/r/p nie sa liczbami', () => {
    expect(zgodneHaslo('x', 'scrypt$abc$def$ghi$c29s$a2V5')).toBe(false);
  });

  it('odmawia przy niepoprawnym base64 w kluczu', () => {
    // Buffer.from(..., 'base64') na Node NIE rzuca na smieciu — po cichu odcina znaki
    // spoza alfabetu base64. Wpisujemy znaki calkowicie spoza base64, zeby dekodowanie
    // nadal dalo bufor INNEJ (nie oczekiwanej 32-bajtowej) dlugosci i test mial sens.
    expect(zgodneHaslo('x', 'scrypt$16384$8$1$c29sc29s$!!!!!!!!')).toBe(false);
  });

  it('odmawia przy zapisie o wlasciwej strukturze, ale skroconym kluczu (16B zamiast 32B)', () => {
    const kluczSzesnascieBajtow = Buffer.alloc(16, 7).toString('base64');
    const sol = Buffer.alloc(16, 1).toString('base64');
    expect(zgodneHaslo('x', `scrypt$16384$8$1$${sol}$${kluczSzesnascieBajtow}`)).toBe(false);
  });

  // ⚠️ TRZY KSZTALTY SMIECIA, KTORE ZACHOWUJA SIE POPRAWNIE, ALE NIKT ICH NIE PILNOWAL.
  // Recenzja zamkniecia obejscia uwierzytelniania przeszla je RECZNIE i potwierdzila, ze
  // kazdy oddaje `false` — ale suita nie miala na nie ani jednej asercji, wiec regresja
  // w ktorymkolwiek przeszlaby na zielono. Klasa bledu jest ta sama, co przy pustym kluczu
  // wyzej: sprawdzone jest to, co ktos akurat wpisal do testu, a nie cala klasa wejsc.
  it('odmawia przy niepoprawnym base64 w SOLI, nie tylko w kluczu', () => {
    const klucz = Buffer.alloc(32, 9).toString('base64');
    expect(zgodneHaslo('x', `scrypt$16384$8$1$!!!!!!!!$${klucz}`)).toBe(false);
  });

  it('odmawia przy pustej soli', () => {
    const klucz = Buffer.alloc(32, 9).toString('base64');
    expect(zgodneHaslo('x', `scrypt$16384$8$1$$${klucz}`)).toBe(false);
  });

  // ⚠️ `N` ogromne rzuca `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` NATYCHMIAST, a nie zawiesza
  // procesu na godzinach liczenia — zmierzone. Ten test pilnuje obu rzeczy naraz: odmowy
  // i tego, ze odmowa jest natychmiastowa (vitest przerwalby go limitem czasu).
  it('odmawia przy ujemnym i przy ogromnym N, bez wyjatku i bez zawieszenia', () => {
    const sol = Buffer.alloc(16, 1).toString('base64');
    const klucz = Buffer.alloc(32, 9).toString('base64');
    expect(zgodneHaslo('x', `scrypt$-1$8$1$${sol}$${klucz}`)).toBe(false);
    expect(zgodneHaslo('x', `scrypt$1073741824$8$1$${sol}$${klucz}`)).toBe(false);
  });
});
