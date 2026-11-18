import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createWooClient } from '../../src/oms/woo/client.js';

const fixture = (nazwa) => JSON.parse(readFileSync(new URL(`../fixtures/woo/${nazwa}.json`, import.meta.url), 'utf8'));
const pozycje = Array.from({ length: 230 }, (_, i) => ({ id: 8000 + i, stock_quantity: i }));
function klient(odpowiedz, uprawnienia = 'zapis') {
  const http = vi.fn(async (url, opcje) => ({ ok: true, status: 200, json: async () => odpowiedz(url, opcje) }));
  return {
    http,
    woo: createWooClient({ baseUrl: 'https://sklep.polcien.invalid', ck: 'test', cs: 'test', http, uprawnienia }),
  };
}

describe('E4.04 — zawężony klient stanów Woo', () => {
  it.each([null, 7000])('230 odczytów i zapisów dzieli na 100/100/30, rodzic %s', async (rodzic) => {
    const { woo, http } = klient((url, opcje) =>
      opcje.method === 'POST'
        ? { update: JSON.parse(opcje.body).update }
        : new URL(url).searchParams
            .get('include')
            .split(',')
            .map((id) => ({ id: Number(id), manage_stock: true, stock_quantity: 4 })),
    );
    const stany =
      rodzic === null
        ? await woo.pobierzStany(pozycje.map((p) => p.id))
        : await woo.pobierzStanyWariantow(
            rodzic,
            pozycje.map((p) => p.id),
          );
    expect(stany).toHaveLength(230);
    const sciezka = `/wp-json/wc/v3/products${rodzic === null ? '' : `/${rodzic}/variations`}`;
    expect(http.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(Array(3).fill(sciezka));
    expect(http.mock.calls.map(([url]) => new URL(url).searchParams.get('include').split(',').length)).toEqual([
      100, 100, 30,
    ]);
    expect(http.mock.calls.every(([url]) => new URL(url).searchParams.get('per_page') === '100')).toBe(true);
    http.mockClear();
    expect(await woo.zapiszStanyHurtem(rodzic, pozycje)).toEqual(pozycje.map(({ id }) => ({ id, ok: true })));
    expect(http.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(Array(3).fill(`${sciezka}/batch`));
    expect(http.mock.calls.map(([, opcje]) => JSON.parse(opcje.body).update.length)).toEqual([100, 100, 30]);
    expect(http.mock.calls.flatMap(([, opcje]) => JSON.parse(opcje.body).update)).toEqual(pozycje);
  });

  it('odrzuca pełny produkt także na końcu listy przed pierwszym żądaniem', async () => {
    const { woo, http } = klient(() => ({}));
    for (const pole of ['manage_stock', 'name', 'sku', 'price', 'stock_status']) {
      await expect(
        woo.zapiszStanyHurtem(null, [...pozycje, { id: 9999, stock_quantity: 2, [pole]: true }]),
      ).rejects.toThrow(/pole/i);
    }
    expect(http).not.toHaveBeenCalled();
  });

  it('klucz Odczyt nie wysyła żadnego zapisu', async () => {
    const { woo, http } = klient(() => ({}), 'odczyt');
    await expect(woo.zapiszStanyHurtem(null, pozycje)).rejects.toMatchObject({ name: 'WooTylkoOdczyt' });
    expect(http).not.toHaveBeenCalled();
  });

  it('odrzuca ujemną i niecałkowitą ilość przed pierwszym żądaniem', async () => {
    const { woo, http } = klient(() => ({}));
    for (const ilosc of [-1, 1.5, '3', null]) {
      await expect(woo.zapiszStanyHurtem(null, [...pozycje, { id: 9999, stock_quantity: ilosc }])).rejects.toThrow(
        /ilość/i,
      );
    }
    expect(http).not.toHaveBeenCalled();
  });

  it('błąd HTTP drugiej paczki oznacza tylko ją, wyniki pozostałych paczek zostają', async () => {
    let n = 0;
    const http = vi.fn(async (url, opcje) =>
      ++n === 2
        ? { ok: false, status: 503, json: async () => ({ message: 'Przeciążenie' }) }
        : { ok: true, status: 200, json: async () => ({ update: JSON.parse(opcje.body).update }) },
    );
    const woo = createWooClient({
      baseUrl: 'https://sklep.polcien.invalid',
      ck: 'test',
      cs: 'test',
      http,
      uprawnienia: 'zapis',
    });
    const wynik = await woo.zapiszStanyHurtem(null, pozycje).catch((e) => ({ wyjatek: e.message }));
    expect(wynik).not.toHaveProperty('wyjatek');
    expect(http).toHaveBeenCalledTimes(3);
    expect(wynik.slice(0, 100).every((w) => w.ok)).toBe(true);
    expect(wynik.slice(100, 200).every((w) => !w.ok && /503/.test(w.blad))).toBe(true);
    expect(wynik.slice(200).every((w) => w.ok)).toBe(true);
  });

  it('błąd i brak odpowiedzi jednej pozycji nie udają sukcesu', async () => {
    const { woo } = klient(() => ({ update: [{ id: 8000 }, { id: 8001, error: { message: 'Brak produktu' } }] }));
    expect(await woo.zapiszStanyHurtem(null, pozycje.slice(0, 3))).toEqual([
      { id: 8000, ok: true },
      { id: 8001, ok: false, blad: 'Brak produktu' },
      { id: 8002, ok: false, blad: expect.any(String) },
    ]);
  });

  it('czyta bez konwersji true, false, parent, null i ujemny stan z fixtures W1/W2 i P22', async () => {
    const produkty = fixture('e4-dok-produkty');
    const warianty = fixture('e4-dok-warianty');
    const p22 = fixture('e4-p22-bez-stanow');
    const { woo } = klient((url) => (new URL(url).pathname.includes('/variations') ? warianty : produkty));
    expect(await woo.pobierzStany(produkty.map((p) => p.id))).toEqual(produkty);
    expect(
      await woo.pobierzStanyWariantow(
        7000,
        warianty.map((p) => p.id),
      ),
    ).toEqual(warianty);
    const { woo: bezStanow } = klient((url) =>
      new URL(url).pathname.includes('/variations') ? [p22.wariant] : [p22.produkt],
    );
    expect((await bezStanow.pobierzStany([p22.produkt.id]))[0]).toMatchObject({
      manage_stock: false,
      stock_quantity: null,
    });
    expect((await bezStanow.pobierzStanyWariantow(p22.produkt.id, [p22.wariant.id]))[0]).toMatchObject({
      manage_stock: false,
      stock_quantity: null,
    });
  });

  it('puste listy nie robią żądań; wadliwa lista odpowiedzi przerywa odczyt', async () => {
    const { woo, http } = klient(() => ({}));
    expect(await woo.pobierzStany([])).toEqual([]);
    expect(await woo.pobierzStanyWariantow(7000, [])).toEqual([]);
    expect(await woo.zapiszStanyHurtem(null, [])).toEqual([]);
    expect(http).not.toHaveBeenCalled();
    await expect(woo.pobierzStany([8000])).rejects.toThrow(/list/i);
  });
});
