// tests/oms/infakt-lista.test.js
import { describe, it, expect } from 'vitest';
import {
  createInfaktClient, STRONA_INFAKTU, SUFIT_STRON, ROWNOLEGLE_STRON,
} from '../../src/oms/infakt/client.js';

// ⚠️⚠️ NAJWAŻNIEJSZY TEST TEJ GAŁĘZI. inFakt IGNORUJE parametr `limit` — zmierzone 06.08.2026
// dla limit=10/25/50/100/200: za każdym razem `count: 10` przy `total_count: 64`. Klient, który
// weźmie pierwszą stronę i uzna ją za komplet, pokaże „cały czerwiec" jako 10 z 64 faktur —
// bez błędu, bez ostrzeżenia, z poprawnie wyglądającą tabelą.
function fakeInfakt({ total, wolania = [] }) {
  return async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
    wolania.push(url);
    const entities = [];
    for (let i = offset; i < Math.min(offset + STRONA_INFAKTU, total); i += 1) {
      entities.push({ uuid: `u${i}`, number: `${i}/06/2026`, gross_price: 100, ksef_number: null });
    }
    return { ok: true, status: 200, json: async () => ({ metainfo: { count: entities.length, total_count: total }, entities }) };
  };
}

describe('listaFaktur', () => {
  it('oddaje KOMPLET dokumentów, nie pierwszą stronę', async () => {
    const wolania = [];
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeInfakt({ total: 64, wolania }) });
    const wynik = await c.listaFaktur({ od: '2026-06-01', do: '2026-06-30' });
    expect(wynik).toHaveLength(64);
    expect(wolania).toHaveLength(7); // 64 dokumenty / 10 na stronę
  });

  it('filtruje po dacie wystawienia albo po dacie sprzedaży', async () => {
    const wolania = [];
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeInfakt({ total: 3, wolania }) });
    await c.listaFaktur({ od: '2026-06-01', do: '2026-06-30', pole: 'sale_date' });
    expect(decodeURIComponent(wolania[0])).toContain('q[sale_date_gteq]=2026-06-01');
    expect(decodeURIComponent(wolania[0])).toContain('q[sale_date_lteq]=2026-06-30');
    expect(decodeURIComponent(wolania[0])).not.toContain('invoice_date_gteq');
  });

  it('oznacza rodzaj dokumentu, żeby widok nie zgadywał po numerze', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeInfakt({ total: 1 }) });
    expect((await c.listaFaktur({ od: '2026-06-01', do: '2026-06-30' }))[0].rodzaj).toBe('vat');
  });

  it('ODMAWIA zamiast oddać cichą część, gdy wynik przekracza sufit stron', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeInfakt({ total: (SUFIT_STRON + 1) * STRONA_INFAKTU }) });
    await expect(c.listaFaktur({ od: '2020-01-01', do: '2026-12-31' }))
      .rejects.toThrow(/zaw[eę]ź|za du[żz]o|sufit/i);
  });

  it('pusty wynik to pusta tablica, nigdy wyjątek', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeInfakt({ total: 0 }) });
    expect(await c.listaFaktur({ od: '2026-06-01', do: '2026-06-30' })).toEqual([]);
  });

  // Krok luk KSeF w czuwaczu (2026-08-29) ma WŁASNY, ciaśniejszy budżet czasu niż ekran —
  // sufit per wywołanie pozwala mu odmówić wcześniej, zanim przebieg godzinowy się rozjedzie.
  // Ta sama zasada, co przy sufcie globalnym: cicha część wyniku wygląda jak komplet.
  it('sufit stron per wywołanie zawęża odmowę, nie luzuje jej', async () => {
    const c = createInfaktClient({ apiKey: 'x', fetchImpl: fakeInfakt({ total: 3 * STRONA_INFAKTU }) });
    await expect(c.listaFaktur({ od: '2026-06-01', do: '2026-08-31' }, { sufitStron: 2 }))
      .rejects.toThrow(/zaw[eę]ź|za du[żz]o|sufit/i);
    // Ten sam zakres bez własnego sufitu przechodzi — trzy strony to daleko od globalnych 60.
    expect(await c.listaFaktur({ od: '2026-06-01', do: '2026-08-31' })).toHaveLength(3 * STRONA_INFAKTU);
  });

  // ⚠️ Ten sam blad co brak walidacji `limit`, tylko wpuszczony inna droga: zepsuta
  // odpowiedz inFaktu zamiast ignorowanego parametru. Bez straznika `Number(undefined ?? 0)`
  // i `Number('duzo')` daja `NaN`, `NaN > SUFIT_STRON` jest FALSZEM (sufit cicho pomijany),
  // a petla `for (s = 1; s < NaN; ...)` w ogole sie nie wykonuje — funkcja oddalaby dokladnie
  // 10 wierszy z pierwszej strony jako komplet, bez bledu i bez ostrzezenia.
  it('brak albo zepsuty total_count daje ODMOWĘ, nie cichą pierwszą stronę', async () => {
    const bezTotalCount = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        metainfo: { count: 10 },
        entities: Array.from({ length: 10 }, (_, i) => ({ uuid: `u${i}`, number: `${i}/06/2026` })),
      }),
    });
    const cBrak = createInfaktClient({ apiKey: 'x', fetchImpl: bezTotalCount });
    await expect(cBrak.listaFaktur({ od: '2026-06-01', do: '2026-06-30' }))
      .rejects.toThrow(/nie poda[łl]|policzy[ćc]/i);

    const zTekstowymTotalCount = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        metainfo: { count: 10, total_count: 'dużo' },
        entities: Array.from({ length: 10 }, (_, i) => ({ uuid: `u${i}`, number: `${i}/06/2026` })),
      }),
    });
    const cTekst = createInfaktClient({ apiKey: 'x', fetchImpl: zTekstowymTotalCount });
    await expect(cTekst.listaFaktur({ od: '2026-06-01', do: '2026-06-30' }))
      .rejects.toThrow(/nie poda[łl]|policzy[ćc]/i);
  });

  // Sufit rownoleglosci jest zmierzonym kompromisem (patrz komentarz przy ROWNOLEGLE_STRON
  // w kliencie), nie przypadkiem. Ten test lapie regresje typu "Promise.all na WSZYSTKICH
  // offsetach naraz", ktora zniknelaby w kazdym tescie liczacym tylko wynik koncowy.
  it('równoległość zapytań o kolejne strony nie przekracza ROWNOLEGLE_STRON', async () => {
    const total = 200; // 20 stron — wystarczy porcji, żeby złapać przekroczenie limitu
    let wLocie = 0;
    let maxWLocie = 0;
    const fetchImpl = async (url) => {
      wLocie += 1;
      maxWLocie = Math.max(maxWLocie, wLocie);
      const offset = Number(new URL(url).searchParams.get('offset') ?? 0);
      // Odpowiedź asynchroniczna CELOWO: bez niej wszystkie wywołania w partii
      // wykonałyby się „na raz" w tej samej mikrotasce i test niczego by nie złapał.
      await new Promise((r) => setImmediate(r));
      const entities = [];
      for (let i = offset; i < Math.min(offset + STRONA_INFAKTU, total); i += 1) {
        entities.push({ uuid: `u${i}`, number: `${i}/06/2026` });
      }
      wLocie -= 1;
      return { ok: true, status: 200, json: async () => ({ metainfo: { count: entities.length, total_count: total }, entities }) };
    };
    const c = createInfaktClient({ apiKey: 'x', fetchImpl });
    const wynik = await c.listaFaktur({ od: '2026-06-01', do: '2026-06-30' });
    expect(wynik).toHaveLength(200);
    expect(maxWLocie).toBeLessThanOrEqual(ROWNOLEGLE_STRON);
  });
});
