import { describe, it, expect } from 'vitest';
import { zapiszCene, wartoscDoPola } from '../../src/public/szybka-cena.js';

// Skrypt szybkiej zmiany ceny na liście magazynu — część bez DOM (repo nie ma biblioteki DOM): zapis przez
// fetch i przygotowanie wartości pola. Obsługa klawiatury i komórki sprawdzana w przeglądarce.

const odpowiedz = (status, tekst) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => tekst,
});

describe('zapiszCene', () => {
  it('wysyła POST z polem cena_zl i oddaje kwotę z ostrzeżeniem', async () => {
    let wywolanie;
    const pobierz = async (adres, opcje) => {
      wywolanie = { adres, opcje };
      return odpowiedz(
        200,
        JSON.stringify({
          cena: '69,50 zł',
          cena_gr: 6950,
          ostrzezenie: 'Zmieni cenę w 2 ofertach przy najbliższym przebiegu',
        }),
      )();
    };
    const wynik = await zapiszCene('/magazyn/7/cena', '69,5', pobierz);
    expect(wynik).toEqual({ cena: '69,50 zł', ostrzezenie: 'Zmieni cenę w 2 ofertach przy najbliższym przebiegu' });
    expect(wywolanie.adres).toBe('/magazyn/7/cena');
    expect(wywolanie.opcje.method).toBe('POST');
    expect(String(wywolanie.opcje.body)).toBe('cena_zl=69%2C5');
  });

  it('odmowa walidacji (400 JSON) oddaje komunikat serwera', async () => {
    expect(await zapiszCene('/x', '', odpowiedz(400, '{"blad":"Wpisz cenę albo anuluj"}'))).toEqual({
      blad: 'Wpisz cenę albo anuluj',
    });
  });

  it('403 rdzenia (zwykły tekst) daje zdanie o uprawnieniach, a nie wyjątek', async () => {
    const wynik = await zapiszCene('/x', '10', odpowiedz(403, 'Brak uprawnień do tego ekranu'));
    expect(wynik.blad).toContain('Brak uprawnień');
  });

  it('wygasła sesja: przekierowanie na stronę logowania (200 z HTML-em) → „Sesja wygasła — odśwież stronę"', async () => {
    const logowanie = async () => ({
      ok: true,
      status: 200,
      redirected: true,
      text: async () => '<!doctype html><title>Logowanie</title><form action="/login"></form>',
    });
    expect(await zapiszCene('/x', '10', logowanie)).toEqual({ blad: 'Sesja wygasła — odśwież stronę.' });
    // Bez flagi `redirected` (np. starsza przeglądarka) strona HTML z kodem 200 też nie jest zapisem.
    expect(await zapiszCene('/x', '10', odpowiedz(200, '<!doctype html><title>Logowanie</title>'))).toEqual({
      blad: 'Sesja wygasła — odśwież stronę.',
    });
  });

  it('401 rdzenia (sesja nieważna, zwykły tekst) → „Sesja wygasła — odśwież stronę"', async () => {
    expect(await zapiszCene('/x', '10', odpowiedz(401, 'Sesja nieważna, zaloguj się ponownie'))).toEqual({
      blad: 'Sesja wygasła — odśwież stronę.',
    });
  });

  it('brak połączenia nie rzuca', async () => {
    const wynik = await zapiszCene('/x', '10', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(wynik.blad).toContain('Brak połączenia');
  });
});

describe('wartoscDoPola', () => {
  it('zdejmuje „zł” i odstępy tysięcy (także twarde spacje Intl)', () => {
    expect(wartoscDoPola('12 345,67 zł')).toBe('12345,67');
    expect(wartoscDoPola('99,00')).toBe('99,00');
    expect(wartoscDoPola(undefined)).toBe('');
  });
});
