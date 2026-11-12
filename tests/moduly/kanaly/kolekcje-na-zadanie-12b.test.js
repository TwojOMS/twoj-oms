import { it, expect } from 'vitest';
import { listaNaZadanie, mapaNaZadanie } from '../../../src/moduly/kanaly/kolekcje-na-zadanie.ts';

// PRZ-157.12b: piaskownica zagnieżdża listy na żądanie (kompozycja → atrapy → raporty). Gdy przejście listy
// pytało dostawcę przy każdym indeksie, trzy poziomy dawały setki zapytań do bazy i start ~4,4 s (demo-reset-prz083).
it('przejście listy na żądanie pyta dostawcę raz, także zagnieżdżonej', () => {
  let wolania = 0;
  const dane = [{ k: 'a' }, { k: 'b' }, { k: 'c' }, { k: 'd' }];
  const wewn = listaNaZadanie(() => { wolania += 1; return dane.map(d => ({ ...d })); });
  const srodek = listaNaZadanie(() => [...wewn]);
  const zewn = listaNaZadanie(() => srodek.filter(() => true));
  wolania = 0;
  expect([...zewn].map(d => d.k)).toEqual(['a', 'b', 'c', 'd']);
  expect(wolania).toBe(1);
  wolania = 0;
  expect(zewn.map(d => d.k).join('')).toBe('abcd');
  expect(zewn.find(d => d.k === 'c')?.k).toBe('c');
  expect(wolania).toBe(2);
});

it('lista na żądanie dalej jest tylko do odczytu i świeża', () => {
  let dane = ['x'];
  const l = listaNaZadanie(() => dane);
  expect(() => l.push('y')).toThrow(/tylko do odczytu/);
  expect(() => { l[0] = 'z'; }).toThrow(/tylko do odczytu/);
  expect(dane).toEqual(['x']);
  dane = ['p', 'q'];
  expect(l.length).toBe(2);
  expect([...l]).toEqual(['p', 'q']);
  expect(Array.isArray(l)).toBe(true);
  const m = mapaNaZadanie(() => ['k'], k => k + '!');
  expect(m.k).toBe('k!');
});
