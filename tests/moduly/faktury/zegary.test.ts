import { describe, it, expect, vi } from 'vitest';
import { zegarKsef, zegarArchiwumSprzedazy, zegarAutomatuKsef } from '../../../src/moduly/faktury/zegary.ts';
import { POWOD_TRWA } from '../../../src/moduly/faktury/services/czuwacz-archiwum-sprzedazy.js';

describe('zegary faktur — ślad przebiegu', () => {
  it('pominięty czuwacz nie odmładza pulsu, a błąd pozostawia ślad', async () => {
    const puls = { ok: vi.fn(), blad: vi.fn() }, log = vi.fn();
    const przebieg = vi.fn().mockResolvedValueOnce({ pominiety: true }).mockRejectedValueOnce(new Error('awaria'));
    const z = zegarKsef({ czuwacz: { przebieg }, puls, log, odstepMs: 3600000 });
    await z.przebieg();
    expect(puls.ok).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('JESZCZE TRWA'));
    await z.przebieg();
    expect(puls.blad).toHaveBeenCalledWith('czuwaczKsef', expect.objectContaining({ message: 'awaria' }));
    expect(log).toHaveBeenCalledWith('czuwacz KSeF:', 'awaria');
  });
  it('archiwum loguje trwający przebieg i błąd, a nie zwykłe pominięcie pory', async () => {
    const log = vi.fn();
    const przebieg = vi.fn().mockResolvedValueOnce({ pominiety: true, powod: 'nie ta pora' })
      .mockResolvedValueOnce({ pominiety: true, powod: POWOD_TRWA }).mockRejectedValueOnce(new Error('dysk'));
    const z = zegarArchiwumSprzedazy({ czuwacz: { przebieg }, log, odstepMs: 3600000 });
    await z.przebieg(); expect(log).not.toHaveBeenCalled();
    await z.przebieg(); expect(log).toHaveBeenCalledWith('archiwum sprzedaży: pominięty —', POWOD_TRWA);
    await z.przebieg(); expect(log).toHaveBeenCalledWith('archiwum sprzedaży:', 'dysk');
  });
  it('PRZ-102.12: zegar automatu KSeF tyka co minutę, pominięcie milczy, wyjątek zostawia ślad i nie wychodzi', async () => {
    const log = vi.fn();
    const przebieg = vi.fn().mockResolvedValueOnce({ pominiety: true, powod: 'nie ta pora' }).mockRejectedValueOnce(new Error('baza'));
    const z = zegarAutomatuKsef({ automat: { przebieg }, log, odstepMs: 60000 });
    expect([z.nazwa, z.odstepMs]).toEqual(['automatKsef', 60000]);
    await z.przebieg(); expect(log).not.toHaveBeenCalled();
    await expect(z.przebieg()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('automat KSeF:', 'baza');
  });
});
