import { it, expect, vi } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const odp = (body, naglowki = {}) => ({
  status: 200,
  ok: true,
  json: async () => body,
  headers: { get: (n) => naglowki[n.toLowerCase()] ?? null },
});
const kategorie = (od, ile) =>
  Array.from({ length: ile }, (_, i) => ({ id: od + i, name: `Kategoria ${od + i}`, parent: 0, count: 1 }));

it('pobierzKategorieProduktow czyta wszystkie strony po 100 (ponad 100 kategorii) wyłącznie GET-em', async () => {
  const strony = [kategorie(1, 100), kategorie(101, 100), kategorie(201, 37)];
  const fetchImpl = vi.fn(async (adres) => {
    const strona = Number(new URL(adres).searchParams.get('page'));
    return odp(strony[strona - 1], { 'x-wp-totalpages': '3', 'x-wp-total': '237' });
  });
  const c = createWooClient({ baseUrl: 'https://pro.polcien.example.test', ck: 'ck', cs: 'cs', fetchImpl });
  const wynik = await c.pobierzKategorieProduktow();
  expect(wynik).toHaveLength(237);
  expect(wynik.at(-1)).toMatchObject({ id: 237, name: 'Kategoria 237' });
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  for (const [i, [adres, opcje]] of fetchImpl.mock.calls.entries()) {
    const u = new URL(adres);
    expect(u.pathname).toMatch(/\/products\/categories$/);
    expect(u.searchParams.get('per_page')).toBe('100');
    expect(u.searchParams.get('page')).toBe(String(i + 1));
    expect(opcje?.method ?? 'GET').toBe('GET');
  }
});

it('urwany odczyt kategorii to błąd, nie niepełna lista', async () => {
  const fetchImpl = vi.fn(async () => odp(kategorie(1, 100), { 'x-wp-totalpages': '1', 'x-wp-total': '150' }));
  const c = createWooClient({ baseUrl: 'https://pro.polcien.example.test', ck: 'ck', cs: 'cs', fetchImpl });
  await expect(c.pobierzKategorieProduktow()).rejects.toThrow(/kategorii/);
});
