// PRZ-093.09 — „Sprawdź połączenie” kuriera InPost z Ustawień: sprawdzPolaczenie() klienta ShipX.
// Jedno żądanie GET /organizations/{id} — odczyt organizacji, niczego nie nadaje i nie tworzy. Ten adres i pole
// `services` w odpowiedzi są zmierzone na żywym koncie (src/domena/usluga-inpost.js); fikstura
// tests/oms/fixtures/inpost/organizacja.json ma ten kształt, wartości są zmyślone. Ani jedno żądanie nie idzie do InPostu.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInpostClient } from '../../src/oms/kurierzy/inpost.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ORGANIZACJA_JSON = readFileSync(join(__dir, 'fixtures', 'inpost', 'organizacja.json'), 'utf8');

const TOKEN = 'eyJZMYSLONY.TOKEN-PRZ093.NIE-MA-PRAWA-WYCIEC';
const ORGANIZACJA = 4242;
const URL_API = 'https://shipx.test/v1/';
const nadawca = { nazwa: 'Pracownia Testowa', ulica: 'Zmyślona 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL',
  phone: '000000000', email: 'nadawca@example.invalid' };
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

function klient(odpowiedzi, override = {}) {
  const fetchImpl = vi.fn();
  odpowiedzi.forEach((o) => (o instanceof Error ? fetchImpl.mockRejectedValueOnce(o) : fetchImpl.mockResolvedValueOnce(o)));
  return { c: createInpostClient({ url: URL_API, token: TOKEN, organizacja: ORGANIZACJA, nadawca, fetchImpl, ...override }), fetchImpl };
}

describe('PRZ-093.09 createInpostClient.sprawdzPolaczenie', () => {
  it('jedno GET /organizations/{id} z tokenem — bez POST, bez przesyłek', async () => {
    const { c, fetchImpl } = klient([odp(200, ORGANIZACJA_JSON)]);
    await expect(c.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [adres, opcje] = fetchImpl.mock.calls[0];
    expect(adres).toBe('https://shipx.test/v1/organizations/4242'); // końcowy ukośnik adresu nie podwaja się
    expect(opcje.method ?? 'GET').toBe('GET');
    expect(opcje.body).toBeUndefined();
    expect(opcje.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(adres).not.toMatch(/shipments|dispatch_orders/u);
  });

  it('odrzucony token (401): czytelny błąd dla operatora, bez tokenu nawet w echu serwera', async () => {
    const { c } = klient([odp(401, JSON.stringify({ status: 401, error: 'unauthorized', message: `Token is missing or invalid: ${TOKEN}` }))]);
    const e = await c.sprawdzPolaczenie().catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('InPost odrzucił');
    expect(e.message).toContain('401');
    expect(e.message).not.toContain(TOKEN);
  });

  it('obca organizacja (403/404): komunikat nazywa numer organizacji', async () => {
    for (const status of [403, 404]) {
      const { c } = klient([odp(status, JSON.stringify({ status, error: 'access_forbidden', message: 'Access forbidden' }))]);
      const e = await c.sprawdzPolaczenie().catch((x) => x);
      expect(e.dlaOperatora, String(status)).toBe(true);
      expect(e.message, String(status)).toContain('4242');
    }
  });

  // Recenzja 09 (P3): gałąź 403/404 też maskuje token, gdy serwer go odbija w treści.
  it('403/404 z tokenem w treści odpowiedzi: komunikat bez tokenu', async () => {
    for (const status of [403, 404]) {
      const echo = JSON.stringify({ status, error: 'access_forbidden', message: `Organization not available for token ${TOKEN}` });
      const { c } = klient([odp(status, echo)]);
      const e = await c.sprawdzPolaczenie().catch((x) => x);
      expect(e.dlaOperatora, String(status)).toBe(true);
      expect(e.message, String(status)).toContain('4242');
      expect(e.message.includes(TOKEN), `${status}: token w komunikacie`).toBe(false);
      expect(e.message, String(status)).toContain('***');
    }
  });

  it('odpowiedź dla innej organizacji niż wpisana nie jest sukcesem', async () => {
    const inna = JSON.stringify({ ...JSON.parse(ORGANIZACJA_JSON), id: 777 });
    const { c } = klient([odp(200, inna)]);
    await expect(c.sprawdzPolaczenie()).rejects.toThrow('777');
  });

  it('HTTP 200 bez `services` (np. strona pośrednika) nie jest sukcesem', async () => {
    const { c } = klient([odp(200, '<html>Brama</html>')]);
    await expect(c.sprawdzPolaczenie()).rejects.toThrow('nie rozpoznaję');
  });

  it('brak sieci: „InPost nieosiągalny”, bez tokenu', async () => {
    const { c } = klient([new Error(`getaddrinfo ENOTFOUND shipx.test ${TOKEN}`)]);
    const e = await c.sprawdzPolaczenie().catch((x) => x);
    expect(e.message).toContain('InPost nieosiągalny');
    expect(e.message).not.toContain(TOKEN);
  });
});
