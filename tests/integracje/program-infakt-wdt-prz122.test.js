// PRZ-122.TFeb: wydzielone przypadki wspólne; ciała bez zmian.
import { it, expect } from 'vitest';
import { programInfakt } from '../../src/integracje/programy/infakt.ts';

  it('inFakt zachowuje osobną serię WDT (decyzja 28.10 dotyczy tylko TwojeFaktury)', () => {
    expect(programInfakt({}).opis.wdtWSeriiFaktur).not.toBe(true);
  });
