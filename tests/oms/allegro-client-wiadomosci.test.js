import { describe, it, expect } from 'vitest';
import {
  createAllegroClient, LIMIT_STRONY_WATKOW, LIMIT_ZAPYTANIA_WIADOMOSCI_MS,
} from '../../src/oms/allegro/client.js';

const tokeny = { waznyToken: async () => 'TOKEN' };
const UA = 'PrzykladowyPanel/0.0.0 (+https://przyklad.invalid/panel)';
const ustawienia = { api: 'https://api.przyklad', userAgent: UA };

function szpieg(cialo) {
  const wywolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wywolania.push({ url, opcje });
    return { ok: true, status: 200, json: async () => cialo };
  };
  return { wywolania, fetchImpl };
}

describe('klient Allegro — Centrum wiadomosci', () => {
  it('pyta o watki z limitem 20 i offsetem, z naglowkami wymaganymi przez Allegro', async () => {
    const { wywolania, fetchImpl } = szpieg({ threads: [{ id: 't1' }], totalCount: 1 });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    const wynik = await k.pobierzWatki({ offset: 40 });

    expect(wywolania[0].url).toContain('/messaging/threads');
    expect(wywolania[0].url).toContain(`limit=${LIMIT_STRONY_WATKOW}`);
    expect(wywolania[0].url).toContain('offset=40');
    expect(wywolania[0].opcje.headers['User-Agent']).toBe(UA);
    expect(wywolania[0].opcje.headers.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(wywolania[0].opcje.method).toBe('GET');
    expect(wynik.watki).toEqual([{ id: 't1' }]);
    expect(wynik.razem).toBe(1);
  });

  it('brak totalCount oddaje razem = null, a nie 0', async () => {
    // ⚠️ 0 znaczyloby „nie ma watkow" i zatrzymaloby stronicowanie po pierwszej stronie.
    const { fetchImpl } = szpieg({ threads: [{ id: 't1' }] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    expect((await k.pobierzWatki({ offset: 0 })).razem).toBe(null);
  });

  it('pyta o wiadomosci konkretnego watku', async () => {
    const { wywolania, fetchImpl } = szpieg({ messages: [{ id: 'm1', text: 'czesc' }] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });

    const wynik = await k.pobierzWiadomosci('t1', { offset: 0 });

    expect(wywolania[0].url).toContain('/messaging/threads/t1/messages');
    expect(wynik.wiadomosci).toEqual([{ id: 'm1', text: 'czesc' }]);
  });

  it('identyfikator watku jest KODOWANY do adresu', async () => {
    const { wywolania, fetchImpl } = szpieg({ messages: [] });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    await k.pobierzWiadomosci('a/b c', { offset: 0 });
    expect(wywolania[0].url).toContain('/messaging/threads/a%2Fb%20c/messages');
  });

  it('blad HTTP niesie kod i sciezke, a NIGDY tokenu', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const k = createAllegroClient({ ustawienia, tokeny, fetchImpl });
    await expect(k.pobierzWatki({ offset: 0 })).rejects.toThrow(/HTTP 403/);
    await expect(k.pobierzWatki({ offset: 0 })).rejects.not.toThrow(/TOKEN/);
  });

  it('limit odczytu wiadomosci jest dodatni i skonczony', () => {
    expect(LIMIT_ZAPYTANIA_WIADOMOSCI_MS).toBeGreaterThan(0);
    expect(Number.isFinite(LIMIT_ZAPYTANIA_WIADOMOSCI_MS)).toBe(true);
  });
});
