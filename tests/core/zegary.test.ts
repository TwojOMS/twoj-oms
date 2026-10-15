import { describe, it, expect } from 'vitest';
import { uruchomZegary } from '../../src/core/zegary.ts';

const sztucznyInterwal = () => {
  const wywolania: (() => void)[] = [];
  const odstepy: number[] = [];
  const ustawInterwal = ((fn: () => void, ms: number) => {
    wywolania.push(fn); odstepy.push(ms);
    return wywolania.length as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  return { ustawInterwal, odstepy, tyknij: () => wywolania.forEach((f) => f()) };
};
const mikro = () => new Promise((r) => setImmediate(r));

describe('uruchomZegary', () => {
  it('czeka na pierwszy odstęp i pomija tyknięcie podczas poprzedniego przebiegu', async () => {
    let zwolnij!: () => void;
    let startow = 0;
    const logi: string[] = [];
    const { ustawInterwal, odstepy, tyknij } = sztucznyInterwal();
    const uchwyty = uruchomZegary([{ nazwa: 'poller', odstepMs: 1000, przebieg: () => {
      startow++; return new Promise<void>((r) => { zwolnij = r; });
    } }], { ustawInterwal, log: (t) => logi.push(t) });
    expect(startow).toBe(0);
    expect(odstepy).toEqual([1000]);
    expect(uchwyty).toEqual([1]);
    tyknij(); tyknij();
    expect(startow).toBe(1);
    expect(logi).toEqual(['zegar poller: poprzedni przebieg jeszcze trwa — pomijam']);
    zwolnij(); await mikro();
    tyknij(); expect(startow).toBe(2);
    zwolnij(); await mikro();
  });
  it.each(['synchroniczny', 'odrzucona obietnica'])('po błędzie %s zegar działa dalej i loguje nazwę', async (rodzaj) => {
    let startow = 0;
    const logi: string[] = [];
    const { ustawInterwal, tyknij } = sztucznyInterwal();
    uruchomZegary([{ nazwa: 'ksef', odstepMs: 1000, przebieg: () => {
      startow++;
      if (rodzaj === 'synchroniczny') throw new Error('503');
      return Promise.reject(new Error('503'));
    } }], { ustawInterwal, log: (t) => logi.push(t) });
    expect(tyknij).not.toThrow(); await mikro();
    expect(tyknij).not.toThrow(); await mikro();
    expect(startow).toBe(2);
    expect(logi).toEqual(['zegar ksef: 503', 'zegar ksef: 503']);
  });
});
