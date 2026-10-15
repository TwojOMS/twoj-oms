import { describe, it, expect } from 'vitest';
import { stanKanalu } from '../../src/domena/kanal-stan.js';

// ⚠️⚠️ BARIERA WIAZANIA ZOSTAJE, ALE PYTA O COS INNEGO. Do 28.08.2026 brzmiala „zdrowego
// kanalu nie wiazemy" i to bylo za waskie: kanal moze dzialac znakomicie przy zamowieniach,
// a jednoczesnie NIE MIEC uprawnienia do Centrum wiadomosci — bo zakresy wchodza do tokenu
// wylacznie przy autoryzacji, a odswiezenie ich nie dopisuje. Bariera pyta teraz „czy kanal
// dziala I MA KOMPLET", i otwiera sie dokladnie tam, gdzie wiazanie jest potrzebne.

const zdrowy = (nad = {}) => ({
  kanal: 'allegro_szkicownia',
  polaczony: true,
  zostaloDni: 90,
  refreshWygasaAt: '2026-11-26T06:39:38.998Z',
  ostatniBlad: null,
  brakujaceUprawnienia: [],
  ...nad,
});

describe('bariera wiązania a komplet uprawnień', () => {
  it('kanał zdrowy z kompletem uprawnień — wiązać NIE WOLNO', () => {
    const s = stanKanalu(zdrowy());
    expect(s.zyje).toBe(true);
    expect(s.wolnoWiazac).toBe(false);
  });

  it('kanał zdrowy, ale BEZ uprawnienia — wiązanie się otwiera', () => {
    const s = stanKanalu(zdrowy({ brakujaceUprawnienia: ['allegro:api:messaging'] }));
    expect(s.zyje).toBe(true);
    expect(s.wolnoWiazac).toBe(true);
  });

  // ⚠️ NAZWA ZAKRESU MUSI BYC W POWODZIE. Bez niej czlowiek widzi „przewiąż" i nie wie,
  // czego brakuje ani co wcześniej dodać w aplikacji Allegro — a przewiązanie bez dodania
  // uprawnienia w aplikacji NICZEGO nie naprawi i zuzyje dzialajaca pare tokenow.
  it('powód mówi, KTÓREGO uprawnienia brakuje', () => {
    const s = stanKanalu(zdrowy({ brakujaceUprawnienia: ['allegro:api:messaging', 'allegro:api:disputes'] }));
    expect(s.powod).toContain('allegro:api:messaging');
    expect(s.powod).toContain('allegro:api:disputes');
  });

  it('brak uprawnienia to NIE awaria — kanał nadal żyje i nie jest pilny', () => {
    // Zamowienia, statusy i paczki dzialaja dalej; czerwony pas klamalby o tym, co sie dzieje.
    const s = stanKanalu(zdrowy({ brakujaceUprawnienia: ['allegro:api:messaging'] }));
    expect(s.pilne).toBe(false);
  });

  it('kanał zepsuty zostaje pilny niezależnie od uprawnień', () => {
    const s = stanKanalu(zdrowy({ ostatniBlad: 'invalid_grant', brakujaceUprawnienia: [] }));
    expect(s.pilne).toBe(true);
    expect(s.wolnoWiazac).toBe(true);
  });

  it('wygasające połączenie dalej otwiera wiązanie, tak jak dotąd', () => {
    const s = stanKanalu(zdrowy({ zostaloDni: 3 }));
    expect(s.wolnoWiazac).toBe(true);
    expect(s.uprzedzenie).toBe(true);
  });

  it('brak pola o uprawnieniach nie zmienia dotychczasowego zachowania', () => {
    const { brakujaceUprawnienia, ...bezPola } = zdrowy();
    expect(stanKanalu(bezPola).wolnoWiazac).toBe(false);
  });
});
