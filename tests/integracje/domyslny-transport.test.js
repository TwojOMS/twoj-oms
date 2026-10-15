import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDpdClient } from '../../src/oms/kurierzy/dpd.js';
import { createInpostClient } from '../../src/oms/kurierzy/inpost.js';
import { createInfaktClient } from '../../src/oms/infakt/client.js';
import { createKsefClient } from '../../src/oms/ksef/client.js';
import { createGusClient } from '../../src/oms/gus/client.js';
import { createVies } from '../../src/oms/services/vies.js';
import { sprawdzLacznosc } from '../../src/oms/services/lacznosc.js';
import { createAllegroClient } from '../../src/oms/allegro/client.js';
import { createTokeny } from '../../src/oms/allegro/tokeny.js';
import { utworzHttp } from '../../src/core/http.ts';

const url = 'https://przyklad.invalid';
const nadawca = { nazwa: 'Test', ulica: 'Testowa 1', kod: '00-001', miasto: 'Test', kraj: 'PL', phone: '+48500100200', email: 'test@przyklad.invalid' };
const ustawienia = { api: url, auth: url, clientId: 'test', clientSecret: 'sekret-testowy', userAgent: 'Test/1 (+https://przyklad.invalid)' };
const dpd = () => createDpdClient({ url, login: 'test', haslo: 'test', fid: '1', infoUrl: url, channel: '1', nadawca });
const infakt = () => createInfaktClient({ apiKey: 'test', baseUrl: url });
const ksef = () => createKsefClient({ token: 'test', nip: '1234563218', baseUrl: url });
const tokeny = () => createTokeny({ db: {}, kanal: 'test', ustawienia });
const nadajDpd = () => dpd().nadaj({ zamowienie: { numer: '1', kwota_pobrania: null }, paczka: { waga: 1, dlugosc: 10, szerokosc: 10, wysokosc: 10 }, adres: nadawca });
const xmlKsef = () => ksef().pobierzXml({ accessToken: 'test', ksefNumber: 'test' });
const lacznosc = () => sprawdzLacznosc({ cele: [{ nazwa: 'test', host: 'przyklad.invalid', url }], lookup: async () => ({ address: '127.0.0.1' }) });

function zegar() {
  vi.useFakeTimers();
  // Native AbortSignal.timeout nie podlega zegarowi Vitest. Zachowujemy
  // semantykę sygnału i prawdziwe żądania czasu, sterując tylko zegarem.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const kontroler = new AbortController();
    setTimeout(() => kontroler.abort(new DOMException('testowy timeout', 'TimeoutError')), ms);
    return kontroler.signal;
  });
}

function wiszacyFetch() {
  const f = vi.fn((_adres, init) => new Promise((_resolve, reject) => {
    const signal = init.signal;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('domyślny transport wszystkich pozostałych klientów', () => {
  const wywolania = [
    ['DPD', () => dpd().statusPrzesylki('test')],
    ['InPost', () => createInpostClient({ url, token: 'test', organizacja: 1, nadawca }).statusPrzesylki('test')],
    ['inFakt', () => infakt().pobierzFakture('test')],
    ['KSeF', xmlKsef],
    ['GUS', () => createGusClient({ url, klucz: 'test' }).zaloguj()],
    ['VIES', () => createVies({ nipSprzedawcy: 'PL1234563218', baseUrl: url }).sprawdz('DE123456789')],
    ['łączność', lacznosc],
    ['Allegro', () => createAllegroClient({ ustawienia, tokeny: { waznyToken: async () => 'test' } }).pobierzZamowienia({ strona: 1, od: null, kursor: null })],
  ];
  it.each(wywolania)('%s używa wspólnego http bez aliasu fetchImpl i nie ponawia 503', async (_nazwa, wywolaj) => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: 'test' }), { status: 503 }));
    vi.stubGlobal('fetch', f);
    await wywolaj().catch(() => {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(new URL(f.mock.calls[0][0]).hostname).toBe('przyklad.invalid');
    // Goły fetch otrzymałby zwykły obiekt nagłówków lub brak nagłówków.
    expect(f.mock.calls[0][1].headers).toBeInstanceOf(Headers);
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([['DPD', nadajDpd], ['inFakt', () => infakt().pobierzFakture('test')], ['KSeF', xmlKsef]])('%s zachowuje pełne 60 s operacji', async (_nazwa, wywolaj) => {
    zegar();
    const f = wiszacyFetch();
    let zakonczone = false;
    const wynik = wywolaj().then(wartosc => ({ wartosc }), blad => ({ blad })).finally(() => { zakonczone = true; });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f).toHaveBeenCalledTimes(1);
    expect(zakonczone).toBe(false);
    expect(f.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(zakonczone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await wynik).blad).toBeInstanceOf(Error);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('GUS podaje operatorowi właściwy powód po 10 s', async () => {
    zegar(); wiszacyFetch();
    const wynik = createGusClient({ url, klucz: 'test' }).zaloguj().catch(blad => blad);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await wynik).message).toContain('GUS nie odpowiedział w 10 sekund');
    expect((await wynik).dlaOperatora).toBe(true);
  });

  it('łączność podaje przekroczony limit 5 s, a nie błąd sieci', async () => {
    zegar(); wiszacyFetch();
    const wynik = lacznosc();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await wynik)[0].komunikat).toMatch(/^Przekroczony limit czasu \(5 s\)/);
  });

  it('device flow zachowuje bezpieczny kod sieci bez surowej przyczyny', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sekret-testowy', { cause: { code: 'ECONNRESET', message: 'sekret-testowy' } }); }));
    const wynik = await tokeny().dokonczPowiazanie('test');
    expect(wynik.gotowe).toBe(false);
    expect(wynik.powod).toContain('ECONNRESET');
    expect(JSON.stringify(wynik)).not.toContain('sekret-testowy');
  });
});

describe('http — bezpieczne metadane błędów', () => {
  it.each(['AbortError', 'TimeoutError'])('zachowuje name %s bez message/cause', async name => {
    vi.stubGlobal('fetch', vi.fn(async () => { const e = new Error('SEKRET', { cause: new Error('SEKRET') }); e.name = name; throw e; }));
    const blad = await utworzHttp({ ponowien: 0, log: () => {} })(url).catch(e => e);
    expect(blad.name).toBe(name);
    expect(blad.message).not.toContain('SEKRET');
    expect(blad.cause).toBeUndefined();
  });
  it.each(['ENOTFOUND', 'ECONNRESET', 'CERT_HAS_EXPIRED', 'A'.repeat(64)])('przenosi tylko bezpieczny code %s', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('SEKRET', { cause: { code } }); }));
    const blad = await utworzHttp({ ponowien: 0, log: () => {} })(url).catch(e => e);
    expect(blad.code).toBe(code);
    expect(blad.message).not.toContain('SEKRET');
    expect(blad.cause).toBeUndefined();
  });
  it.each(['sekret token', 'https://sekret.invalid', 'A'.repeat(65), '', 123])('odrzuca code poza ścisłym formatem (%s)', async code => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('SEKRET'), { code }); }));
    const blad = await utworzHttp({ ponowien: 0, log: () => {} })(url).catch(e => e);
    expect(blad.code).toBeUndefined();
    expect(blad.message).not.toContain('SEKRET');
    expect(blad.cause).toBeUndefined();
  });
});
