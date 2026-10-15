import { describe, it, expect } from 'vitest';
import { poPolsku } from '../../src/domena/blad-po-polsku.js';

// ZGLOSZENIE WLASCICIELA 10.09.2026: „Poller allegro_amarka nie działa: The operation
// was aborted due to timeout". Polska ramka, angielski srodek — bo srodek pisze Node.

describe('poPolsku — angielskie frazy techniczne na ekranie', () => {
  it('tlumaczy fraze ze zgloszenia', () => {
    expect(poPolsku('The operation was aborted due to timeout'))
      .toBe('przekroczony czas oczekiwania na odpowiedź');
  });

  it('podmienia FRAGMENT zlozonego zdania, zostawiajac polska ramke', () => {
    // Tak wyglada prawdziwy wiersz z produkcji (czuwacz ostrzezen, 09.09.2026).
    expect(poPolsku('terminy płatności: inFakt nieosiągalny: The operation was aborted due to timeout'))
      .toBe('terminy płatności: inFakt nieosiągalny: przekroczony czas oczekiwania na odpowiedź');
  });

  it('tlumaczy „fetch failed" w srodku komunikatu sklepu', () => {
    expect(poPolsku('Sklep nieosiągalny: fetch failed'))
      .toBe('Sklep nieosiągalny: połączenie nie doszło do skutku');
  });

  it('zostawia nazwe serwera przy bledzie DNS — bez niej nie wiadomo, co nie odpowiada', () => {
    expect(poPolsku('getaddrinfo ENOTFOUND api.allegro.pl'))
      .toBe('nieznana nazwa serwera: api.allegro.pl');
  });

  it('dluzsza fraza wygrywa z krotsza — „connect ETIMEDOUT" nie rozpada sie na dwa kawalki', () => {
    expect(poPolsku('connect ETIMEDOUT 51.83.1.1:443'))
      .toBe('przekroczony czas nawiązywania połączenia: 51.83.1.1:443');
  });

  it('kod gniazda bez prefiksu tez ma polska nazwe', () => {
    expect(poPolsku('ECONNRESET')).toBe('połączenie zerwane');
  });

  it('frazy nieznanej NIE RUSZA — angielskie zdanie da sie wkleic w wyszukiwarke', () => {
    // ⚠️ To NIE jest luka do zalatania „na wszelki wypadek": polskie zgadywanie o komunikacie,
    // ktorego nie rozumiemy, bylo by gorsze niz oryginal. Slownik rosnie o frazy WIDZIANE.
    const obcy = 'Unexpected token < in JSON at position 0';
    expect(poPolsku(obcy)).toBe(obcy);
  });

  it('polski komunikat panelu przechodzi nietkniety', () => {
    const nasz = 'Pominięto 1 zamówienie (kursor przesunięty, same z siebie nie wrócą): zła kwota';
    expect(poPolsku(nasz)).toBe(nasz);
  });

  it('brak bledu zostaje brakiem — nigdy napisem „null"', () => {
    // Ta funkcja stoi na drodze komunikatow, ktorych najczesciej po prostu NIE MA.
    expect(poPolsku(null)).toBeNull();
    expect(poPolsku(undefined)).toBeUndefined();
    expect(poPolsku('')).toBe('');
  });

  it('„terminated" tylko jako cale slowo — nie w srodku innego wyrazu', () => {
    expect(poPolsku('terminated')).toBe('połączenie przerwane w trakcie odpowiedzi');
    expect(poPolsku('Umowa terminowa')).toBe('Umowa terminowa');
  });
});
