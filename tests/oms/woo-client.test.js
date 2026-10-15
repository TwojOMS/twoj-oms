import { describe, it, expect, vi } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const odp = (status, body, naglowki = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  headers: { get: (n) => naglowki[n.toLowerCase()] ?? null },
});

function klient(res, { ck = 'ck', cs = 'cs' } = {}) {
  const fetchImpl = vi.fn().mockResolvedValue(res);
  return { c: createWooClient({ baseUrl: 'https://pro.szkicownia.pl', ck, cs, fetchImpl }), fetchImpl };
}

describe('pobierzZamowienia', () => {
  it('pyta o wszystkie statusy, rosnąco po dacie modyfikacji', async () => {
    const { c, fetchImpl } = klient(odp(200, [], { 'x-wp-totalpages': '1' }));
    await c.pobierzZamowienia({ modifiedAfter: '2026-07-29T10:00:00', page: 1 });
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain('/wp-json/wc/v3/orders');
    expect(url).toContain('modified_after=2026-07-29T10%3A00%3A00');
    expect(url).toContain('orderby=modified');
    expect(url).toContain('order=asc');
    expect(url).toContain('status=any');
    expect(url).toContain('per_page=50');
  });

  // dates_are_gmt=true: bez tego Woo liczy modified_after w czasie lokalnym sklepu, co przy
  // zmianie czasu (zimowy/letni) gubi zamowienia na zawsze — patrz komentarz w client.js.
  it('wysyła dates_are_gmt=true razem z modified_after', async () => {
    const { c, fetchImpl } = klient(odp(200, [], { 'x-wp-totalpages': '1' }));
    await c.pobierzZamowienia({ modifiedAfter: '2026-07-29T10:00:00', page: 1 });
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toContain('dates_are_gmt=true');
  });

  it('oddaje zamówienia i liczbę stron', async () => {
    const { c } = klient(odp(200, [{ id: 1 }], { 'x-wp-totalpages': '3' }));
    expect(await c.pobierzZamowienia({ page: 1 })).toEqual({ zamowienia: [{ id: 1 }], stron: 3 });
  });

  it('brak nagłówka stron → jedna strona', async () => {
    const { c } = klient(odp(200, []));
    expect((await c.pobierzZamowienia({ page: 1 })).stron).toBe(1);
  });

  // 401 to konfiguracja, nie awaria sklepu — naprawa jest zupelnie inna.
  it('401 → komunikat o kluczach', async () => {
    const { c } = klient(odp(401, { message: 'Niepoprawny klucz.' }));
    await expect(c.pobierzZamowienia({ page: 1 })).rejects.toThrow(/klucz/i);
  });

  it('sklep nieosiągalny → czytelny błąd', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const c = createWooClient({ baseUrl: 'https://pro.szkicownia.pl', ck: 'ck', cs: 'cs', fetchImpl });
    await expect(c.pobierzZamowienia({ page: 1 })).rejects.toThrow(/nieosiągalny/);
  });

  // 5xx z HTML-em (np. blad PHP) zamiast JSON-a nie moze wywalic wywolujacego —
  // res.json() rzuca, klient musi to zlapac i oddac czytelny blad ze statusem.
  it('5xx z HTML-em zamiast JSON-a nie wywala klienta', async () => {
    const { c } = klient({ status: 500, ok: false, json: async () => { throw new Error('not json'); } });
    await expect(c.pobierzZamowienia({ page: 1 })).rejects.toThrow(/500/);
  });

  // 200 z cialem, ktore NIE jest tablica, wygladaloby jak "brak nowych zamowien" —
  // dokladnie ten failure mode (zle skonfigurowany sklep), przed ktorym poller ma chronic.
  it('200 z odpowiedzią, która nie jest tablicą → czytelny błąd zamiast cichej pustej listy', async () => {
    const { c } = klient(odp(200, { code: 'rest_no_route', message: 'No route found' }));
    await expect(c.pobierzZamowienia({ page: 1 })).rejects.toThrow(/niespodziewaną odpowiedź/i);
  });

  it('200 z pustym/nie-JSON ciałem → czytelny błąd', async () => {
    const { c } = klient({ status: 200, ok: true, json: async () => { throw new Error('not json'); }, headers: { get: () => null } });
    await expect(c.pobierzZamowienia({ page: 1 })).rejects.toThrow(/niespodziewaną odpowiedź/i);
  });
});

// Prawdziwe klucze WooCommerce wygladaja jak ck_/cs_ + dlugi hex — uzywamy takiego
// ksztaltu, zeby test faktycznie cos sprawdzal, a nie zdawal sie na to, ze zaden
// ze stalych komunikatow przypadkiem nie zawiera dwoch znakow "cs".
describe('sekret nie wycieka do komunikatu błędu', () => {
  const CK = 'ck_1a2b3c4d5e6f7890abcdef1234567890abcdef12';
  const CS = 'cs_9f8e7d6c5b4a39281706f5e4d3c2b1a09876fedc';
  const authHeader = Buffer.from(`${CK}:${CS}`).toString('base64');

  function bezSekretu(err) {
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain(CK);
    expect(err.message).not.toContain(CS);
    // Naglowek Authorization to base64(ck:cs) — sam string tez nie ma prawa
    // wyciec, nawet gdyby ktos polaczyl kawalki inaczej niz surowe klucze.
    expect(err.message).not.toContain(authHeader);
  }

  it('błąd HTTP (500 z powodem ze sklepu) nie ujawnia kluczy', async () => {
    const { c } = klient(odp(500, { message: 'boom' }), { ck: CK, cs: CS });
    const err = await c.pobierzZamowienia({ page: 1 }).catch((e) => e);
    bezSekretu(err);
  });

  it('sklep nieosiągalny nie ujawnia kluczy', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const c = createWooClient({ baseUrl: 'https://pro.szkicownia.pl', ck: CK, cs: CS, fetchImpl });
    const err = await c.pobierzZamowienia({ page: 1 }).catch((e) => e);
    bezSekretu(err);
  });

  it('200 nie-tablica (błędna konfiguracja) nie ujawnia kluczy', async () => {
    const { c } = klient(odp(200, { message: 'boom' }), { ck: CK, cs: CS });
    const err = await c.pobierzZamowienia({ page: 1 }).catch((e) => e);
    bezSekretu(err);
  });
});

describe('zapis do sklepu', () => {
  it('dodajNotatke strzela POST-em w notes z notatką prywatną', async () => {
    const { c, fetchImpl } = klient(odp(201, { id: 9 }));
    await c.dodajNotatke(28079, 'DPD 123');
    expect(fetchImpl.mock.calls[0][0]).toContain('/orders/28079/notes');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ note: 'DPD 123', customer_note: false });
  });

  it('ustawStatus strzela PUT-em w zamówienie', async () => {
    const { c, fetchImpl } = klient(odp(200, { id: 28079 }));
    await c.ustawStatus(28079, 'completed');
    expect(fetchImpl.mock.calls[0][1].method).toBe('PUT');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ status: 'completed' });
  });
});
