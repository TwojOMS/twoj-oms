import { describe, it, expect } from 'vitest';
import { okresCelu, RYTMY } from '../../src/domena/cele-okres.js';

describe('okresCelu — rytm tygodniowy', () => {
  it('tydzien zaczyna sie w PONIEDZIALEK, tak jak tygodnieOkresu w raportach', () => {
    // 2026-09-13 to niedziela — najtrudniejszy przypadek, bo getUTCDay() daje dla niej 0.
    expect(okresCelu('tydzien', '2026-09-13')).toEqual({ od: '2026-09-07', do: '2026-09-13' });
  });

  it('poniedzialek jest PIERWSZYM dniem swojego tygodnia, nie ostatnim poprzedniego', () => {
    expect(okresCelu('tydzien', '2026-09-07')).toEqual({ od: '2026-09-07', do: '2026-09-13' });
  });

  it('tydzien przechodzi przez przelom roku bez gubienia dni', () => {
    // 2026-12-31 to czwartek; tydzien 28.12.2026 – 03.01.2027.
    expect(okresCelu('tydzien', '2026-12-31')).toEqual({ od: '2026-12-28', do: '2027-01-03' });
  });
});

describe('okresCelu — rytm miesieczny', () => {
  it('oddaje pelny miesiac', () => {
    expect(okresCelu('miesiac', '2026-09-13')).toEqual({ od: '2026-09-01', do: '2026-09-30' });
  });

  it('luty przestepny ma 29 dni — bez recznego warunku', () => {
    expect(okresCelu('miesiac', '2028-02-10')).toEqual({ od: '2028-02-01', do: '2028-02-29' });
  });
});

describe('okresCelu — rytm jednorazowy', () => {
  it('oddaje daty celu', () => {
    expect(okresCelu('jednorazowy', '2026-09-13', { odDnia: '2026-09-01', doDnia: '2026-09-30' }))
      .toEqual({ od: '2026-09-01', do: '2026-09-30' });
  });

  it('brak dat znaczy „od zawsze, bez terminu", a nie blad', () => {
    expect(okresCelu('jednorazowy', '2026-09-13')).toEqual({ od: null, do: null });
  });
});

describe('okresCelu — fail-closed', () => {
  it('nieznany rytm RZUCA, nie oddaje po cichu pustego okresu', () => {
    // Pusty okres przeszedlby dalej jako „zero zdarzen", czyli cel bez postepu — a to
    // wyglada dokladnie jak „nikt nic nie zrobil". Blad ma wyjsc przy zapisie, nie na kaflu.
    expect(() => okresCelu('kwartal', '2026-09-13')).toThrow(/nieznany rytm/);
  });
});

describe('RYTMY', () => {
  it('lista rytmow zgadza sie z tym, co obsluguje okresCelu', () => {
    // Jedna lista dla walidacji trasy i dla <select>. Rozjazd dalby formularz oferujacy
    // rytm, ktory `okresCelu` odrzuca — blad widoczny dopiero po kliknieciu „Zaloz cel".
    expect(RYTMY).toEqual(['tydzien', 'miesiac', 'jednorazowy']);
    for (const rytm of RYTMY) {
      expect(() => okresCelu(rytm, '2026-09-13')).not.toThrow();
    }
  });
});
