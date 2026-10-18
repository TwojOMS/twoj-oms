// PRZ-093.10 — createInfaktClient.sprawdzPolaczenie(): przycisk „Sprawdź połączenie” na ekranie Ustawienia →
// Integracje → inFakt. Jedno żądanie GET pierwszej strony listy faktur (to samo, którym startuje listaFaktur —
// zmierzone na żywym koncie 06.08.2026), nic nie wystawia. Odpowiedź z pliku tests/oms/fixtures/infakt/ (zmyślona).
// Klucz API nie może dojść do komunikatu, nawet gdy inFakt odbije go w treści błędu.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInfaktClient, METODY_INFAKTU } from '../../src/oms/infakt/client.js';

const STRONA = JSON.parse(readFileSync(new URL('./fixtures/infakt/lista-faktur-strona.json', import.meta.url), 'utf8'));
const KLUCZ = 'zmyslony0klucz0api0infakt0prz093000000a1';
const odp = (status, cialo) => ({ ok: status >= 200 && status < 300, status, json: async () => cialo });

describe('PRZ-093.10 inFakt: sprawdzenie połączenia', () => {
  it('sukces: jedno GET /v3/invoices.json?offset=0 z kluczem w nagłówku, wynik bez danych faktur', async () => {
    const fetchImpl = vi.fn(async () => odp(200, STRONA));
    const wynik = await createInfaktClient({ apiKey: KLUCZ, fetchImpl }).sprawdzPolaczenie();
    expect(wynik).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [adres, init] = fetchImpl.mock.calls[0];
    expect(adres).toBe('https://api.infakt.pl/api/v3/invoices.json?offset=0');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['X-inFakt-ApiKey']).toBe(KLUCZ);
  });

  it('odpowiedź 200 bez metainfo.total_count (np. strona pośrednika) to nie „działa”', async () => {
    const fetchImpl = vi.fn(async () => odp(200, { komunikat: 'strona logowania sieci hotelowej' }));
    const e = await createInfaktClient({ apiKey: KLUCZ, fetchImpl }).sprawdzPolaczenie().catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('nie rozpoznaję odpowiedzi');
  });

  for (const status of [401, 403]) {
    it(`HTTP ${status} z kluczem odbitym w treści: czytelny powód, klucza w komunikacie brak`, async () => {
      const fetchImpl = vi.fn(async () => odp(status, { error: `Invalid API key ${KLUCZ}`, message: `klucz ${KLUCZ} odrzucony` }));
      const e = await createInfaktClient({ apiKey: KLUCZ, fetchImpl }).sprawdzPolaczenie().catch((x) => x);
      expect(e.dlaOperatora).toBe(true);
      expect(e.status).toBe(status);
      expect(e.message).toContain('nie przyjął klucza API');
      // Asercja na wartości logicznej: porażka nie wypisze klucza w raporcie testu.
      expect(e.message.includes(KLUCZ), 'klucz w komunikacie').toBe(false);
      expect(e.message.includes('zmyslony0klucz'), 'fragment klucza w komunikacie').toBe(false);
    });
  }

  it('inny błąd HTTP (500) też bez klucza w komunikacie', async () => {
    const fetchImpl = vi.fn(async () => odp(500, { error: `awaria przy ${KLUCZ}` }));
    const e = await createInfaktClient({ apiKey: KLUCZ, fetchImpl }).sprawdzPolaczenie().catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('500');
    expect(e.message.includes(KLUCZ), 'klucz w komunikacie').toBe(false);
  });

  it('METODY_INFAKTU to dokładnie metody klienta (pośrednik z Ustawień ich używa)', () => {
    const klient = createInfaktClient({ apiKey: 'x', fetchImpl: async () => { throw new Error('sieć'); } });
    expect([...METODY_INFAKTU].sort()).toEqual(Object.keys(klient).filter((k) => typeof klient[k] === 'function').sort());
  });
});
