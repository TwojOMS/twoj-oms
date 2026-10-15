import { describe, it, expect } from 'vitest';
import { MIERNIKI, miernik, KLUCZE_MIERNIKOW } from '../../src/domena/mierniki-celow.js';

describe('rejestr miernikow', () => {
  it('Etap 1 ma DOKLADNIE jeden miernik: reczny', () => {
    // Ta liczba jest czescia kontraktu z właścicielem (decyzja 13.09): zaden automat nie wchodzi
    // w Etapie 1. Test ma zapalic sie, gdy ktos dolozy automat bez rozmowy.
    expect(Object.keys(MIERNIKI)).toEqual(['reczny']);
  });

  it('reczny nie ma funkcji liczacej — zrodlem sa zdarzenia', () => {
    expect(miernik('reczny').policz).toBe(null);
    expect(miernik('reczny').progSwiezosciH).toBe(null);
  });

  it('KLUCZE_MIERNIKOW niesie etykiety do <select>', () => {
    expect(KLUCZE_MIERNIKOW).toEqual([{ klucz: 'reczny', etykieta: 'Ręcznie' }]);
  });
});

describe('miernik() jest fail-closed', () => {
  it('nieznany klucz oddaje null, nie rzuca i nie podstawia recznego', () => {
    // Podstawienie recznego byloby najgorsza z opcji: cel z padnietym automatem pokazalby
    // sume zdarzen (czyli ZERO, bo automat zdarzen nie pisze) i wygladalby na zaniedbany
    // zamiast na zepsuty.
    expect(miernik('wzory-sklep')).toBe(null);
    expect(miernik('')).toBe(null);
    expect(miernik(null)).toBe(null);
    expect(miernik(undefined)).toBe(null);
  });

  it('klucze z prototypu Object NIE sa miernikami', () => {
    // Bez hasOwnProperty `MIERNIKI['constructor']` oddaje funkcje, ktora ma `.policz`
    // undefined — czyli cel „liczony" przez konstruktor Obiektu, bez ani jednego bledu.
    expect(miernik('constructor')).toBe(null);
    expect(miernik('__proto__')).toBe(null);
    expect(miernik('toString')).toBe(null);
    expect(miernik('hasOwnProperty')).toBe(null);
  });
});
