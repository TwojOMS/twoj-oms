import { describe, it, expect } from 'vitest';
import { naTelefonInPost } from '../../src/domena/telefon.js';

describe('naTelefonInPost', () => {
  // Ksztalty wprost z rozpoznania (zamowienie 28045: WooCommerce '+48500900008',
  // przesylka InPostu '500900008') plus warianty z odstepami i myslnikami, jakie
  // WooCommerce potrafi oddac z pol formularza.
  it.each([
    ['+48500900008', '500900008'],
    ['500 900 008', '500900008'],
    ['48500900008', '500900008'],
    ['0048500900008', '500900008'],
    ['500-900-008', '500900008'],
    ['(500) 900 008', '500900008'],
    ['+48 500 900 008', '500900008'],
    ['0048 500 900 008', '500900008'],
  ])('sprowadza %s do %s', (surowy, oczekiwany) => {
    expect(naTelefonInPost(surowy)).toBe(oczekiwany);
  });

  // Przypadek brzegowy z planu: dziewiec cyfr ZACZYNAJACYCH SIE od '48' to prawdziwy
  // numer, nie numer z prefiksem kraju. Zdjecie dwoch pierwszych cyfr zostawilo by
  // siedem cyfr — nie dziewiec — wiec prefiksu TU zdejmowac nie wolno.
  it('nie zjada dwoch pierwszych cyfr numeru, ktory przypadkiem zaczyna sie od 48', () => {
    expect(naTelefonInPost('486969004')).toBe('486969004');
  });

  // Wszystko, czego nie da sie jednoznacznie sprowadzic do dziewieciu cyfr, ma rzucac
  // GLOSNO — to jest sedno zadania (patrz kod pocztowy w DPD, gdzie odrzucenie bylo
  // ciche). Zaden z tych przypadkow nie ma prawa oddac obcietej wartosci ani null.
  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    ['', 'pusty string'],
    ['   ', 'same odstepy'],
    ['69690045', 'osiem cyfr'],
    ['6969004512', 'dziesiec cyfr'],
    ['696900abc', 'litery w numerze'],
    ['+1 234 567 8900', 'numer zagraniczny'],
  ])('rzuca bledem operatora dla: %s (%s)', (surowy) => {
    expect(() => naTelefonInPost(surowy)).toThrow();
    try {
      naTelefonInPost(surowy);
      expect.unreachable('naTelefonInPost mial rzucic');
    } catch (e) {
      // dlaOperatora=true jest tym, co pozwala pokazac komunikat na ekranie (bledy.js) —
      // blad techniczny (TypeError itp.) zostalby tam ZAMASKOWANY na „blad techniczny
      // panelu", wiec test musi pilnowac WLASNIE tej flagi, nie tylko faktu rzucenia.
      expect(e.dlaOperatora).toBe(true);
      expect(e.message).toMatch(/dziewięć cyfr/);
    }
  });
});
