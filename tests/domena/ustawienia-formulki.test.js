// tests/oms/ustawienia-formulki.test.js
import { describe, it, expect } from 'vitest';
import {
  ustawieniaFormulki, sprawdzFormularz, MAKS_ZNAKOW_WIADOMOSCI, KLUCZE,
} from '../../src/domena/ustawienia-formulki.js';

describe('ustawienia autorespondera', () => {
  it('pusta baza daje autoresponder WYLACZONY', () => {
    expect(ustawieniaFormulki({}).wlaczona).toBe(false);
  });

  it('czyta zapisane wartosci', () => {
    const u = ustawieniaFormulki({
      [KLUCZE.wlaczony]: '1', [KLUCZE.tresc]: 'Dzien dobry', [KLUCZE.od]: '18',
      [KLUCZE.do]: '8', [KLUCZE.dni]: '1,2,3,4,5', [KLUCZE.karencja]: '15',
    });
    expect(u).toEqual({
      wlaczona: true, tresc: 'Dzien dobry', odGodziny: 18, doGodziny: 8,
      dni: [1, 2, 3, 4, 5], karencjaMin: 15,
    });
  });

  it('brak karencji daje domyslne 10 minut', () => {
    expect(ustawieniaFormulki({}).karencjaMin).toBe(10);
  });

  it('odrzuca tresc dluzsza niz limit Allegro', () => {
    const wynik = sprawdzFormularz({
      wlaczona: 'on', tresc: 'x'.repeat(MAKS_ZNAKOW_WIADOMOSCI + 1),
      od: '18', do: '8', dni: ['1'], karencja: '10',
    });
    expect(wynik.ok).toBe(false);
    expect(wynik.blad).toContain('2000');
  });

  it('przyjmuje tresc dokladnie na limicie', () => {
    const wynik = sprawdzFormularz({
      wlaczona: 'on', tresc: 'x'.repeat(MAKS_ZNAKOW_WIADOMOSCI),
      od: '18', do: '8', dni: ['1'], karencja: '10',
    });
    expect(wynik.ok).toBe(true);
  });

  it('odrzuca WLACZENIE z pusta trescia', () => {
    // ⚠️ Wlaczony autoresponder z pusta formulka wyslalby kupujacemu pusta wiadomosc.
    const wynik = sprawdzFormularz({ wlaczona: 'on', tresc: '   ', od: '18', do: '8', dni: ['1'], karencja: '10' });
    expect(wynik.ok).toBe(false);
    expect(wynik.blad).toContain('treść');
  });

  it('odrzuca WLACZENIE bez ani jednego dnia', () => {
    const wynik = sprawdzFormularz({ wlaczona: 'on', tresc: 'ok', od: '18', do: '8', dni: [], karencja: '10' });
    expect(wynik.ok).toBe(false);
    expect(wynik.blad).toContain('dzień');
  });

  it('odrzuca godzine spoza 0-23', () => {
    expect(sprawdzFormularz({ wlaczona: 'on', tresc: 'ok', od: '24', do: '8', dni: ['1'], karencja: '10' }).ok).toBe(false);
    expect(sprawdzFormularz({ wlaczona: 'on', tresc: 'ok', od: '18', do: '-1', dni: ['1'], karencja: '10' }).ok).toBe(false);
  });

  it('odrzuca ujemna karencje', () => {
    expect(sprawdzFormularz({ wlaczona: 'on', tresc: 'ok', od: '18', do: '8', dni: ['1'], karencja: '-5' }).ok).toBe(false);
  });

  it('WYLACZENIE przechodzi nawet z pusta trescia — zapisujemy stan wylaczony', () => {
    const wynik = sprawdzFormularz({ tresc: '', od: '18', do: '8', dni: [], karencja: '10' });
    expect(wynik.ok).toBe(true);
    expect(wynik.wartosci[KLUCZE.wlaczony]).toBe('0');
  });
});
