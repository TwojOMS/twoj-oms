// PRZ-168.e2 — zdania wyboru programu do faktur mówią „program do faktur”, nie „moduł faktur”.
import { describe, it, expect } from 'vitest';
import { sprawdzFormularzWyboru, wyborZPliku } from '../../src/domena/wybor-programu.js';

describe('PRZ-168.e2 teksty wyboru programu do faktur', () => {
  it('formularz z nieznaną wartością prosi o wybór z listy', () => {
    expect(sprawdzFormularzWyboru({ program: 'xyz' }).bledy).toEqual(['Wybierz program do faktur z listy.']);
  });
  it('nieznana wartość z pliku: błąd z nazwą zmiennej mówi o programie do faktur', () => {
    expect(() => wyborZPliku('infkat')).toThrow(/nieznany program do faktur „infkat”/);
  });
});
