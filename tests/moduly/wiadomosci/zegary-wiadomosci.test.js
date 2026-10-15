import { describe, it, expect, vi } from 'vitest';
import { uruchomZegary } from '../../pomoc/bootstrap-parytetu.ts';

// PIATY I SZOSTY ZEGAR — poller Centrum wiadomosci i czuwacz formulki (spec 2026-08-28).
//
// ⚠️ `.catch` przy KAZDYM zegarze jest obowiazkowy: odrzucona obietnica w `setInterval` to
// nieobsluzone odrzucenie, ktore w Node 24 KLADZIE PROCES — czyli caly OMS.

describe('zegary wiadomości Allegro', () => {
  it('rejestruje poller wiadomości i czuwacz formułki', () => {
    const ustawInterwal = vi.fn(() => 1);
    uruchomZegary({
      pollerWiadomosci: { przebieg: async () => ({}) },
      czuwaczFormulki: { przebieg: async () => ({}) },
      ustawInterwal,
    });
    expect(ustawInterwal).toHaveBeenCalledTimes(2);
  });

  it('odrzucona obietnica pollera NIE wywala procesu', async () => {
    const zadania = [];
    const ustawInterwal = (fn) => { zadania.push(fn); return 1; };
    const log = vi.fn();
    uruchomZegary({
      pollerWiadomosci: { przebieg: async () => { throw new Error('bum'); } },
      ustawInterwal,
      log,
    });
    zadania[0]();
    await new Promise((r) => setImmediate(r));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('poller wiadomości'), 'bum');
  });

  it('odrzucona obietnica czuwacza formułki też jest złapana', async () => {
    const zadania = [];
    const ustawInterwal = (fn) => { zadania.push(fn); return 1; };
    const log = vi.fn();
    uruchomZegary({
      czuwaczFormulki: { przebieg: async () => { throw new Error('bum') } },
      ustawInterwal,
      log,
    });
    zadania[0]();
    await new Promise((r) => setImmediate(r));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('autoresponder'), 'bum');
  });

  // ⚠️ WSTRZYMANIE BEZPIECZNIKA MUSI ZOSTAWIC SLAD — inaczej autoresponder, ktory stanal,
  // wyglada DOKLADNIE tak samo jak spokojny dzien bez wiadomosci.
  it('wstrzymany bezpiecznik zostawia ślad w logu', async () => {
    const zadania = [];
    const ustawInterwal = (fn) => { zadania.push(fn); return 1; };
    const log = vi.fn();
    uruchomZegary({
      czuwaczFormulki: { przebieg: async () => ({ wstrzymany: true }) },
      ustawInterwal,
      log,
    });
    zadania[0]();
    await new Promise((r) => setImmediate(r));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/WSTRZYMANY/));
  });

  it('normalny przebieg czuwacza NIE zasypuje logu', async () => {
    const zadania = [];
    const ustawInterwal = (fn) => { zadania.push(fn); return 1; };
    const log = vi.fn();
    uruchomZegary({
      czuwaczFormulki: { przebieg: async () => ({ wyslane: 0, wstrzymany: false }) },
      ustawInterwal,
      log,
    });
    zadania[0]();
    await new Promise((r) => setImmediate(r));
    expect(log).not.toHaveBeenCalled();
  });

  it('BRAK obu usług nie rejestruje zegara — panel bez ALLEGRO_* ma wstać', () => {
    const ustawInterwal = vi.fn(() => 1);
    uruchomZegary({ ustawInterwal });
    expect(ustawInterwal).not.toHaveBeenCalled();
  });
});
