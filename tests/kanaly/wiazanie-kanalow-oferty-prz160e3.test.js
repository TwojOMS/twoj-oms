import { describe, it, expect, vi } from 'vitest';
import { createWiazanieKanalow } from '../../src/moduly/kanaly/services/wiazanie-kanalow.js';

// PRZ-160 E3.02 (D42): bariera usługi wiązania ma tę samą regułę co ekran — zdrowe konto bez
// zgody na oferty wolno związać ponownie tylko, gdy aplikacja ma zakresy ofert I ktoś kliknął.

const zdrowyBezOfert = {
  kanal: 'allegro_polcien', polaczony: true, zostaloDni: 89, ostatniBlad: null, brakOfert: true,
};

const zbuduj = (flagi) => {
  const fn = vi.fn(async ({ naStart }) => {
    naStart({ userCode: 'polcien1', adres: 'https://allegro.pl/skojarz?code=polcien1', limitMs: 600000, wygasaAt: 1000 + 600000 });
    return new Promise(() => {});
  });
  const u = createWiazanieKanalow({
    tokenyKanalow: { allegro_polcien: { stanDlaEkranu: () => zdrowyBezOfert } },
    przeprowadz: fn,
    teraz: () => 1000,
    ...(flagi ? { flagiOfert: flagi } : {}),
  });
  return { u, fn };
};

describe('bariera wiązania a zgoda na oferty (D42)', () => {
  it('aplikacja ma oferty i kliknięto → wiązanie rusza', async () => {
    const { u, fn } = zbuduj((k) => (k === 'allegro_polcien' ? { aplikacjaMaOferty: true, chceOfert: true } : {}));
    expect((await u.rozpocznij('allegro_polcien')).ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('bez kliknięcia → odmowa bez wołania Allegro', async () => {
    const { u, fn } = zbuduj(() => ({ aplikacjaMaOferty: true, chceOfert: false }));
    const w = await u.rozpocznij('allegro_polcien');
    expect(w.ok).toBe(false);
    expect(w.powod).toMatch(/działa/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('bez flag (domyślnie) → zdrowe konto zostaje zamknięte', async () => {
    const { u, fn } = zbuduj();
    expect((await u.rozpocznij('allegro_polcien')).ok).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});
