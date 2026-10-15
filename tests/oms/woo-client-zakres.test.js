import { describe, it, expect } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const odp = (dane, naglowki = {}) => ({
  ok: true, status: 200, json: async () => dane,
  headers: { get: (k) => naglowki[k.toLowerCase()] ?? null },
});

describe('pobierzZamowieniaZakresu', () => {
  it('pyta o date ZLOZENIA rosnaco, w GMT i po wszystkich statusach', async () => {
    let url = null;
    const klient = createWooClient({
      baseUrl: 'https://sklep', ck: 'ck', cs: 'cs',
      fetchImpl: async (u) => { url = u; return odp([], { 'x-wp-totalpages': '1', 'x-wp-total': '0' }); },
    });
    await klient.pobierzZamowieniaZakresu({ after: '2013-12-31T23:59:59', before: '2015-01-01T00:00:01', page: 3 });
    const p = new URL(url).searchParams;
    expect(p.get('orderby')).toBe('date');
    expect(p.get('order')).toBe('asc');
    expect(p.get('status')).toBe('any');
    expect(p.get('dates_are_gmt')).toBe('true');
    expect(p.get('after')).toBe('2013-12-31T23:59:59');
    expect(p.get('before')).toBe('2015-01-01T00:00:01');
    expect(p.get('page')).toBe('3');
    expect(p.get('per_page')).toBe('100');
  });

  it('oddaje liczbe stron i lacznika z naglowkow', async () => {
    const klient = createWooClient({
      baseUrl: 'https://sklep', ck: 'ck', cs: 'cs',
      fetchImpl: async () => odp([{ id: 1 }], { 'x-wp-totalpages': '89', 'x-wp-total': '8885' }),
    });
    const w = await klient.pobierzZamowieniaZakresu({ after: 'a', before: 'b' });
    expect(w.stron).toBe(89);
    expect(w.razem).toBe(8885);
    expect(w.zamowienia).toHaveLength(1);
  });

  it('ODPOWIEDZ 200, KTORA NIE JEST TABLICA, WYWALA PRZEBIEG — nie udaje pustego sklepu', async () => {
    const klient = createWooClient({
      baseUrl: 'https://sklep', ck: 'ck', cs: 'cs',
      fetchImpl: async () => odp({ code: 'rest_forbidden' }, {}),
    });
    await expect(klient.pobierzZamowieniaZakresu({ after: 'a', before: 'b' }))
      .rejects.toThrow(/niespodziewan/);
  });
});
