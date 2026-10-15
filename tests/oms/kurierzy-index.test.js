import { describe, it, expect } from 'vitest';
import { wybierzKuriera } from '../../src/oms/kurierzy/index.js';

describe('wybierzKuriera', () => {
  it('dla obsługiwanej metody zwraca nazwę kuriera i podpiętego klienta', () => {
    const dpd = { nadaj: () => {} };
    const wynik = wybierzKuriera('dpd', { dpd });
    expect(wynik).toEqual({ nazwa: 'dpd', klient: dpd });
  });

  // ⚠️ Od 2026-08-01 pobranie NIE JEST metoda wysylki, tylko flaga obok niej — ten sam
  // kurier obsluguje paczke z inkasem i bez, a roznica siedzi w kopercie (<cod>). Stara
  // nazwa ma sie wiec odbic jak kazdy inny smiec, a nie po cichu zadzialac.
  it('stara nazwa dpd_pobranie NIE jest już metodą wysyłki', () => {
    expect(() => wybierzKuriera('dpd_pobranie', { dpd: { nadaj: () => {} } }))
      .toThrow(/dpd_pobranie.*nie jest obsługiwana/);
  });

  // Zadanie 6: paczkomat MA juz kuriera. Do tej chwili ten sam test pilnowal czegos
  // odwrotnego (metoda nieobslugiwana) — i tak bylo poprawnie, dopoki klient ShipX nie
  // istnial. Warunek nie zostal oslabiony, tylko przeniesiony na metode, ktora wpisu
  // NIGDY miec nie ma: odbior osobisty (patrz nizej).
  it('paczkomat InPost idzie do kuriera „inpost"', () => {
    const inpost = { nadaj: () => {} };
    expect(wybierzKuriera('inpost_paczkomat', { inpost })).toEqual({ nazwa: 'inpost', klient: inpost });
  });

  // ⚠️ NAJWAZNIEJSZY TEST W TYM PLIKU. `odbior_osobisty` nie ma wpisu w DLA_METODY i to
  // jest MECHANIZM ODMOWY, nie przeoczenie: klient stoi przy ladzie, wiec paczka do niego
  // to koszt, ktorego nie da sie cofnac. Dopisanie tej metody do mapy musi ten test zlamac.
  it('odbiór osobisty NIE MA kuriera — nadania nie da się z niego zrobić', () => {
    expect(() => wybierzKuriera('odbior_osobisty', { dpd: {}, inpost: {} }))
      .toThrow(/odbior_osobisty.*nie jest obsługiwana/);
  });

  it('nieobsługiwana metoda wysyłki → czytelny wyjątek', () => {
    expect(() => wybierzKuriera('nieznana', { dpd: {} }))
      .toThrow(/nieznana.*nie jest obsługiwana/);
  });

  it('paczkomat przy niepodpiętym InPoście → czytelny wyjątek, nie TypeError', () => {
    expect(() => wybierzKuriera('inpost_paczkomat', { dpd: {} }))
      .toThrow(/inpost.*nie jest skonfigurowany/);
  });

  it('obsługiwana metoda, ale kurier nieskonfigurowany → czytelny wyjątek', () => {
    expect(() => wybierzKuriera('dpd', {}))
      .toThrow(/dpd.*nie jest skonfigurowany/);
  });

  it('obsługiwana metoda, ale mapa kurierów niezdefiniowana → czytelny wyjątek, nie TypeError', () => {
    expect(() => wybierzKuriera('dpd', undefined))
      .toThrow(/dpd.*nie jest skonfigurowany/);
  });
});
