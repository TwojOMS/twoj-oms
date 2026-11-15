// PRZ-160.E3.29: pamięć prognoz prowizji (konto, kategoria, cena) wygasa po 10 min i nie rośnie bez końca.
import { describe, it, expect } from 'vitest';
import { createOplatyAllegro } from '../../../src/moduly/magazyn/services/oplaty-allegro.js';

const wiersz = (cena) => ({ bledy: [], zadanie: { category: { id: '257' }, sellingMode: { price: { amount: String(cena) } } }, allegro: {} });

describe('PRZ-160.E3.29: pamięć prognoz prowizji', () => {
  it('wpisy po terminie wypadają przy następnym podglądzie; świeże zostają i nie pytają Allegro', async () => {
    let czas = 0;
    let zapytan = 0;
    const konto = { klucz: 'allegro:polcien', klient: { podgladOplat: async () => { zapytan += 1; return { commissions: [{ fee: { amount: '1.50' } }] }; } } };
    const oplaty = createOplatyAllegro({ teraz: () => czas });

    await oplaty.prowizje(konto, [wiersz(10), wiersz(20), wiersz(30)]);
    expect(oplaty.rozmiarPamieci()).toBe(3);
    expect(zapytan).toBe(3);

    czas = 5 * 60_000;
    const swiezy = wiersz(10);
    await oplaty.prowizje(konto, [swiezy]);
    expect(swiezy.allegro.prowizja).toBe('1,50 zł');
    expect(zapytan).toBe(3);

    czas = 11 * 60_000;
    await oplaty.prowizje(konto, [wiersz(40)]);
    expect(oplaty.rozmiarPamieci()).toBe(1);
    expect(zapytan).toBe(4);
  });
});
