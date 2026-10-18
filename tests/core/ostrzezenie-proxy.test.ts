import { describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';

describe('ostrzeżenie proxy raz na proces', () => {
  it.each(['x-forwarded-for', 'cf-connecting-ip'])('%s ostrzega raz także dla dwóch aplikacji, bez wartości nagłówka', async (naglowek) => {
    // Nowy moduł symuluje nowy proces dla obu możliwych pierwszych nagłówków.
    vi.resetModules();
    const { zbudujAplikacje } = await import('../../src/core/aplikacja.ts');
    const log = vi.fn();
    const bazy = [openOmsDb(':memory:'), openOmsDb(':memory:'), openOmsDb(':memory:')];
    const aplikacje = [];
    try {
      for (let i = 0; i < 3; i++) aplikacje.push(await zbudujAplikacje({
        db: bazy[i], moduly: [], env: i === 0 ? { OMS_TRUST_PROXY: '127.0.0.1' } : {}, log,
      }));
      await aplikacje[0].app.inject({ url: '/', headers: { 'x-forwarded-for': 'tajna-wartosc' } });
      expect(log).not.toHaveBeenCalled();
      await aplikacje[1].app.inject({ url: '/', headers: { [naglowek]: 'tajna-wartosc' } });
      expect(log).toHaveBeenCalledTimes(1);
      await aplikacje[1].app.inject({ url: '/', headers: { 'x-forwarded-for': 'tajna-wartosc' } });
      await aplikacje[2].app.inject({ url: '/', headers: { 'x-forwarded-for': 'tajna-wartosc' } });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain('OMS_TRUST_PROXY');
      expect(log.mock.calls[0][0]).toContain('adresy');
      expect(JSON.stringify(log.mock.calls)).not.toContain('tajna-wartosc');
    } finally {
      for (const a of aplikacje) await a.app.close();
      for (const db of bazy) db.close();
    }
  });
});
