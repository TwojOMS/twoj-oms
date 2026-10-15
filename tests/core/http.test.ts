import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { utworzHttp } from '../../src/core/http.ts';

const adres = 'https://api.example.test/paczki';
const bezLogu = () => {};
const bezCzekania = async (_ms: number) => {};

// Transport podstawiony zamiast zewnętrznych API; zachowuje prawdziwy AbortSignal.
function wiszacyFetch() {
  return vi.fn<typeof fetch>((_adres, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
}

afterEach(() => vi.restoreAllMocks());

describe('http — sześć wymagań planu', () => {
  it('limit czasu przerywa transport i podaje host w błędzie', async () => {
    const fetchImpl = wiszacyFetch();
    const http = utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu, limitCzasuMs: 15, ponowien: 0 });
    await expect(http(adres)).rejects.toThrow(/api\.example\.test.*limit czasu/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
  }, 500);

  it('429 z Retry-After 3 czeka 3000 ms i oddaje drugą odpowiedź', async () => {
    const odpowiedz = new Response('ok');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '3' } })).mockResolvedValueOnce(odpowiedz);
    const czekaj = vi.fn(bezCzekania);
    expect(await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres)).toBe(odpowiedz);
    expect(czekaj.mock.calls).toEqual([[3000]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('trzy 503 zużywają dwa ponowienia i zwracają ostatnią odpowiedź', async () => {
    const ostatnia = new Response('ostatnia', { status: 503 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ostatnia);
    const czekaj = vi.fn(bezCzekania);
    expect(await utworzHttp({ fetchImpl, czekaj, log: bezLogu, ponowien: 2 })(adres)).toBe(ostatnia);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(czekaj.mock.calls).toEqual([[500], [1000]]);
    expect(await ostatnia.text()).toBe('ostatnia');
  });

  it('400 zwraca odpowiedź po jednej próbie bez oczekiwania', async () => {
    const odpowiedz = new Response('błąd klienta', { status: 400 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(odpowiedz);
    const czekaj = vi.fn(bezCzekania);
    expect(await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres)).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('POST bez klucza po 503 nie nadaje drugiej paczki', async () => {
    const odpowiedz = new Response('', { status: 503 });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(odpowiedz);
    const czekaj = vi.fn(bezCzekania);
    expect(await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres, { method: 'POST', body: '{}' })).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('log błędu usuwa sekrety z URL i nigdy nie zawiera Authorization', async () => {
    const sekrety = ['access_token', 'token', 'apikey', 'api_key', 'key', 'secret', 'password'];
    const query = new URLSearchParams(sekrety.map((nazwa, i) => [nazwa, `tajna-wartosc-${i}`]));
    query.set('page', '7');
    const url = `${adres}?${query}`;
    const log = vi.fn<(t: string) => void>();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(`transport ujawnił ${url} Bearer tajny-naglowek`));
    await expect(utworzHttp({ fetchImpl, czekaj: bezCzekania, log, ponowien: 0 })(url, { headers: { Authorization: 'Bearer tajny-naglowek' } })).rejects.toThrow();
    const zapis = log.mock.calls.flat().join('\n');
    expect(log).toHaveBeenCalled();
    expect(zapis).toContain('api.example.test');
    expect(zapis).toContain('page=7');
    for (let i = 0; i < sekrety.length; i++) expect(zapis).not.toContain(`tajna-wartosc-${i}`);
    expect(zapis).not.toMatch(/Authorization|Bearer|tajny-naglowek/);
    expect(fetchImpl.mock.calls[0][0]).toBe(url);
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer tajny-naglowek');
  });
});

describe('http — poprawki recenzji', () => {
  it('nieprawidłowy nagłówek nie ujawnia wartości w wyjątku ani logu', async () => {
    const log = vi.fn<(t: string) => void>();
    const fetchImpl = vi.fn<typeof fetch>();
    const url = 'https://login-marker:password-marker@api.example.test/paczki?access_token=query-marker';
    let blad: unknown;
    try {
      await utworzHttp({ fetchImpl, log })(url, {
        headers: { Authorization: 'Bearer znacznik-testowy\nw-drugiej-linii' },
      });
    } catch (e) { blad = e; }
    expect(blad).toBeInstanceOf(Error);
    expect(String(blad)).toMatch(/api\.example\.test.*nieprawidłowe nagłówki/);
    expect(String(blad)).not.toMatch(/znacznik-testowy|Bearer|Authorization|login-marker|password-marker|query-marker/);
    expect(blad).not.toHaveProperty('cause');
    expect(log.mock.calls.flat().join()).not.toMatch(/znacznik-testowy|Bearer|Authorization|login-marker|password-marker|query-marker/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { typ: 'URLSearchParams', body: () => new URLSearchParams({ pole: 'paczka' }), tresc: 'pole=paczka' },
    { typ: 'Blob', body: () => new Blob(['paczka']), tresc: 'paczka' },
    { typ: 'FormData', body: () => { const dane = new FormData(); dane.set('pole', 'paczka'); return dane; }, tresc: 'paczka' },
    { typ: 'ArrayBuffer', body: () => new TextEncoder().encode('paczka').buffer as ArrayBuffer, tresc: 'paczka' },
    { typ: 'Uint8Array', body: () => new TextEncoder().encode('paczka'), tresc: 'paczka' },
    { typ: 'Buffer', body: () => Buffer.from('paczka'), tresc: 'paczka' },
  ])('ponowienie PUT z $typ zachowuje treść', async ({ body, tresc }) => {
    const wyslane: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const request = new Request(url, init);
      wyslane.push(init?.body instanceof FormData
        ? String((await request.formData()).get('pole')) : await request.text());
      return new Response(wyslane.length === 1 ? 'przejściowy błąd' : 'ok', { status: wyslane.length === 1 ? 503 : 200 });
    });
    const wynik = await utworzHttp({ fetchImpl, log: bezLogu, czekaj: bezCzekania })(adres, { method: 'PUT', body: body() });
    expect(await wynik.text()).toBe('ok');
    expect(wyslane).toEqual([tresc, tresc]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['get', 'head', 'put', 'delete', 'post', 'patch'])('metoda %s ma takie samo prawo do ponowienia jak wielkie litery', async (method) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('ok'));
    const wynik = await utworzHttp({ fetchImpl, log: bezLogu, czekaj: bezCzekania })(adres, { method, headers: { 'Idempotency-Key': 'staly-klucz' } });
    expect(await wynik.text()).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('błąd sieci może ponowić przy odstępie równym maksCzekaniaMs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('connection reset')).mockResolvedValueOnce(new Response('ok'));
    const czekaj = vi.fn(bezCzekania);
    const wynik = await utworzHttp({ fetchImpl, czekaj, log: bezLogu, maksCzekaniaMs: 500 })(adres);
    expect(await wynik.text()).toBe('ok');
    expect(czekaj.mock.calls).toEqual([[500]]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('odrzucenie oczekiwania nawet bez wartości nie uruchamia ponowienia', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    await expect(utworzHttp({ fetchImpl, log: bezLogu, czekaj: async () => { throw undefined; } })(adres)).rejects.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    { limitCzasuMs: -1 }, { limitCzasuMs: 2_147_483_648 }, { ponowien: 0.5 },
    { ponowien: Infinity }, { maksCzekaniaMs: NaN }, { maksCzekaniaMs: -1 },
  ])('odrzuca opcje psujące timer lub liczbę prób: %j', (opcje) => {
    expect(() => utworzHttp(opcje)).toThrow(RangeError);
  });

  it('błąd sieci nie ponawia po przekroczeniu maksCzekaniaMs', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection reset'));
    const czekaj = vi.fn(bezCzekania);
    await expect(utworzHttp({ fetchImpl, czekaj, log: bezLogu, maksCzekaniaMs: 499 })(adres)).rejects.toThrow(/błąd sieci/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('niedokończone zwalnianie odpowiedzi nie blokuje ponowienia', async () => {
    const body = new ReadableStream({ cancel() { return new Promise<void>(() => {}); } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { status: 503 })).mockResolvedValueOnce(new Response('ok'));
    expect(await (await utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu })(adres)).text()).toBe('ok');
  }, 500);
  it('log i wyjątek transportu nie ujawniają dodatkowych parametrów OAuth ani fragmentu URL', async () => {
    const log = vi.fn<(t: string) => void>();
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('błąd transportu'));
    const url = `${adres}?code=oauth-A&refresh_token=oauth-B&client_secret=oauth-C&id_token=oauth-D&signature=oauth-E&sig=oauth-F&auth=oauth-G#access_token=fragment-ukryty`;
    await expect(utworzHttp({ fetchImpl, log, czekaj: bezCzekania, ponowien: 0 })(url)).rejects.toThrow(/błąd sieci/);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join()).not.toMatch(/oauth-[A-G]|fragment-ukryty/);
  });

  it.each(['web', 'node', 'iterator'])('treść jednorazowa %s przy PUT nie jest wysyłana ponownie', async (rodzaj) => {
    const body = rodzaj === 'web' ? new ReadableStream()
      : rodzaj === 'node' ? Readable.from(['paczka'])
      : (async function* () { yield 'paczka'; })();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('błąd', { status: 503 }));
    const czekaj = vi.fn(bezCzekania);
    // Rozszerzenie Undici poza DOM BodyInit, dostępne w Node (wymaga duplex).
    const init = { method: 'PUT', body, duplex: 'half' } as unknown as RequestInit;
    expect((await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres, init)).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('anulowanie przerywa także podstawione oczekiwanie, które nie kończy się samo', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
    const czekaj = async () => {
      controller.abort();
      return new Promise<void>(() => {});
    };
    await expect(utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres, { signal: controller.signal })).rejects.toThrow(/anulowan/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  }, 500);

  it('anulowanie przerywa domyślny timer Retry-After i usuwa go', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
      const wynik = utworzHttp({ fetchImpl, log: bezLogu })(adres, { signal: controller.signal });
      const sprawdzenie = expect(wynik).rejects.toThrow(/anulowan/);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await sprawdzenie;
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  }, 500);

  it.each(['1.5', '-1', '01/05/2001'])('nieprawidłowe Retry-After %s stosuje odstęp zamiast luźnego Date.parse', async (wartosc) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': wartosc } })).mockResolvedValueOnce(new Response('ok'));
    const czekaj = vi.fn(bezCzekania);
    await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres);
    expect(czekaj.mock.calls).toEqual([[500]]);
  });

  it('błąd nieprawidłowego URL nie zawiera input z tokenem', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    let blad: unknown;
    try { await utworzHttp({ fetchImpl, log: bezLogu })('nie-adres?token=ukryty-token'); }
    catch (e) { blad = e; }
    expect(blad).toBeInstanceOf(Error);
    expect(String(blad)).not.toContain('ukryty-token');
    expect(blad).not.toHaveProperty('input');
    expect(blad).not.toHaveProperty('cause');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('klucz i metoda są stałe między próbami mimo zmiany init przez wołającego', async () => {
    const init: RequestInit = { method: 'POST', headers: { 'Idempotency-Key': 'nadanie-stale' }, body: '{}' };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('ok'));
    const czekaj = async () => { init.headers = {}; init.method = 'PATCH'; };
    expect((await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres, init)).status).toBe(200);
    expect(fetchImpl.mock.calls[1][1]?.method).toBe('POST');
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe('nadanie-stale');
  });
});

describe('http — doprecyzowania i granice ponowień', () => {
  it('POST bez klucza po przekroczeniu limitu czasu wysyła tylko raz', async () => {
    const fetchImpl = wiszacyFetch();
    const czekaj = vi.fn(bezCzekania);
    await expect(utworzHttp({ fetchImpl, czekaj, log: bezLogu, limitCzasuMs: 15 })(adres, { method: 'POST', body: '{}' })).rejects.toThrow(/limit czasu/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  }, 500);

  it.each(['GET', 'HEAD', 'PUT', 'DELETE', 'POST', 'PATCH'])('%s z prawem do ponowienia po 503 zachowuje treść i klucz', async (method) => {
    const odpowiedz = new Response('ok');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(odpowiedz);
    const init = { method, headers: new Headers({ 'idempotency-key': 'nadanie-123' }), ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{"paczka":1}' }) };
    expect(await utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu })(adres, init)).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]?.body).toBe(init.body);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get('Idempotency-Key')).toBe('nadanie-123');
  });

  it.each(['GET', 'HEAD', 'PUT', 'DELETE'])('%s bez klucza wolno ponawiać po 429', async (method) => {
    const odpowiedz = new Response('ok');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(odpowiedz);
    expect(await utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu })(adres, { method })).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['POST', 'PATCH'])('%s bez klucza nie ponawia ani 429, ani błędu sieci', async (method) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }));
    const http = utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu });
    expect((await http(adres, { method })).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear().mockRejectedValue(new TypeError('connection reset'));
    await expect(http(adres, { method })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('PATCH z pustym kluczem nie jest idempotentny', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    expect((await utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu })(adres, { method: 'PATCH', headers: [['Idempotency-Key', ' ']] })).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['GET', 'POST'])('%s uprawniony do ponowień odzyskuje odpowiedź po błędzie sieci', async (method) => {
    const odpowiedz = new Response('ok');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('connection reset')).mockResolvedValueOnce(odpowiedz);
    const czekaj = vi.fn(bezCzekania);
    expect(await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres, { method, headers: { 'Idempotency-Key': 'operacja-1' } })).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(czekaj.mock.calls).toEqual([[500]]);
  });

  it('GET po timeout ma nowy sygnał i może odzyskać odpowiedź', async () => {
    const fetchImpl = wiszacyFetch();
    const odpowiedz = new Response('ok');
    const wiszenie = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementationOnce(wiszenie).mockResolvedValue(odpowiedz);
    expect(await utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu, limitCzasuMs: 15 })(adres)).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1]?.signal).not.toBe(fetchImpl.mock.calls[0][1]?.signal);
    expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(false);
  }, 500);

  it('domyślnie wyczerpuje dwa ponowienia błędu sieci i ustawia 30000 ms', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection reset'));
    await expect(utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu })(adres)).rejects.toThrow(/api\.example\.test/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls).toEqual([[30000], [30000], [30000]]);
  });

  it('Retry-After w formacie daty HTTP używa różnicy wobec aktualnego czasu', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 30, 10));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': 'Wed, 30 Sep 2026 10:00:04 GMT' } })).mockResolvedValueOnce(new Response('ok'));
    const czekaj = vi.fn(bezCzekania);
    expect((await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres)).status).toBe(200);
    expect(czekaj.mock.calls).toEqual([[4000]]);
  });

  it.each(['61', 'Wed, 30 Sep 2026 11:00:00 GMT'])('Retry-After %s ponad 60 s zwraca 429 bez oczekiwania', async (wartosc) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 30, 10));
    const odpowiedz = new Response('spróbuj później', { status: 429, headers: { 'Retry-After': wartosc } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(odpowiedz);
    const czekaj = vi.fn(bezCzekania);
    expect(await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres)).toBe(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
    expect(await odpowiedz.text()).toBe('spróbuj później');
  });

  it('maksCzekaniaMs pozwala obniżyć limit, a równość jest dozwolona', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(new Response('ok'));
    const czekaj = vi.fn(bezCzekania);
    expect((await utworzHttp({ fetchImpl, czekaj, log: bezLogu, maksCzekaniaMs: 2000 })(adres)).status).toBe(200);
    expect(czekaj.mock.calls).toEqual([[2000]]);
    fetchImpl.mockClear().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '3' } }));
    czekaj.mockClear();
    expect((await utworzHttp({ fetchImpl, czekaj, log: bezLogu, maksCzekaniaMs: 2000 })(adres)).status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it.each(['0', 'Wed, 30 Sep 2026 09:59:00 GMT'])('Retry-After %s nie tworzy ujemnego oczekiwania', async (wartosc) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 8, 30, 10));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': wartosc } })).mockResolvedValueOnce(new Response('ok'));
    const czekaj = vi.fn(bezCzekania);
    await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres);
    expect(czekaj.mock.calls).toEqual([[0]]);
  });

  it('błędne Retry-After stosuje odstęp wykładniczy', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': 'jutro' } })).mockResolvedValueOnce(new Response('ok'));
    const czekaj = vi.fn(bezCzekania);
    await utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres);
    expect(czekaj.mock.calls).toEqual([[500]]);
  });

  it('zewnętrzne anulowanie przerywa żądanie bez ponowienia', async () => {
    const controller = new AbortController();
    const fetchImpl = wiszacyFetch();
    const czekaj = vi.fn(bezCzekania);
    const wynik = utworzHttp({ fetchImpl, czekaj, log: bezLogu })(adres, { signal: controller.signal });
    const sprawdzenie = expect(wynik).rejects.toThrow(/anulowan/);
    controller.abort(new Error('sekret użytkownika'));
    await sprawdzenie;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('anulowanie podczas oczekiwania nie uruchamia kolejnego żądania', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    await expect(utworzHttp({ fetchImpl, log: bezLogu, czekaj: async () => { controller.abort(); } })(adres, { signal: controller.signal })).rejects.toThrow(/anulowan/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('log odpowiedzi HTTP usuwa powtórzone i wielkoliterowe sekrety oraz dane logowania URL', async () => {
    const log = vi.fn<(t: string) => void>();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 400 }));
    await utworzHttp({ fetchImpl, czekaj: bezCzekania, log })('https://login-ukryty:haslo-ukryte@api.example.test/?TOKEN=sekret-A&token=sekret-B&api%5Fkey=sekret-C');
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join()).not.toMatch(/login-ukryty|haslo-ukryte|sekret-[ABC]/);
  });

  it('odrzucana odpowiedź jest zwalniana przed ponowieniem', async () => {
    let anulowana = false;
    const body = new ReadableStream({ cancel() { anulowana = true; } });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body, { status: 503 })).mockImplementationOnce(async () => {
      expect(anulowana).toBe(true);
      return new Response('ok');
    });
    expect(await (await utworzHttp({ fetchImpl, czekaj: bezCzekania, log: bezLogu })(adres)).text()).toBe('ok');
  });
});
