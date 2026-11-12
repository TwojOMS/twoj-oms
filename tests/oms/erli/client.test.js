import { describe, it, expect, vi } from 'vitest';
import { createErliClient } from '../../../src/oms/erli/client.js';

const adresApi = 'https://api.polcien.example/svc/shop-api/';
const kluczApi = 'fikcyjny-klucz-testowy';
const id = 'PC-ERLI-0001';
const paczka = { orderId: id, dimensions: { width: 100, height: 200, length: 300, weight: 1000 }, shipping: { typeId: 'erliPaczkomat', postingPointId: 1 } };
const zewnetrzna = { orderId: id, vendor: 'dpd', trackingNumber: '12345678901234' };
const sklep = { id: 1000001, name: 'Pracownia Półcień', active: true, externalMatchingPolicy: 'disabled', scopes: ['order'], markets: ['pl'] };
const data = '2026-11-11T08:00:00Z';
const zamowienie = { id, status: 'purchased', sellerStatus: 'created', currency: 'PLN', market: 'pl', items: [], returns: [], delivery: { name: 'Paczkomat', typeId: 'erliPaczkomat', price: 1000, cod: false }, totalPrice: 1000, created: data, updated: data };
const adres = { firstName: 'Ala', lastName: 'Zmyślonowicz', street: 'Fikcyjna', buildingNumber: '1', city: 'Testowo', zip: '00-000', pickupType: 'courier', phoneNumber: '000000000', email: 'ala@polcien.example' };
const odpowiedzPaczki = { id: 1, ...paczka, type: 'internal', status: 'preparing', createdAt: data, updatedAt: data, shipping: { ...paczka.shipping, sender: adres, receiver: adres, registeredAt: data } };
const filtr = { filter: { field: 'orderId', operator: '=', value: id } };
function przygotuj(dane = [], status = 200, headers = {}) {
  const fetchImpl = vi.fn(async () => new Response(status === 204 ? null : JSON.stringify(dane), { status, headers }));
  const log = vi.fn();
  const czekaj = vi.fn();
  return { klient: createErliClient({ adresApi, kluczApi, wersja: '1.2.3', fetchImpl, log, czekaj }), fetchImpl, log, czekaj };
}

describe('klient HTTP ERLI', () => {
  it.each([
    ['mojSklep', [], 'GET', '/me', undefined, sklep],
    ['zmianyZamowien', [{ types: ['orderCreated'] }], 'POST', '/orders/changes/_search', { types: ['orderCreated'] }, [{ id: 'zmiana-1', shopId: 1000001, created: data, read: false, type: 'orderCreated', payload: zamowienie }]],
    ['oznaczPrzeczytane', [{ lastMessageId: 'zmiana-1' }], 'POST', '/orders/changes/mark-read', { lastMessageId: 'zmiana-1' }, 1],
    ['szukajZamowien', [{ pagination: { sortField: 'updated', after: '1794355200;1x1', order: 'ASC', limit: 200 } }], 'POST', '/orders/_search', { pagination: { sortField: 'updated', after: '1794355200;1x1', order: 'ASC', limit: 200 } }, [zamowienie]],
    ['pobierzZamowienie', [id], 'GET', `/orders/${id}`, undefined, zamowienie],
    ['ustawStatusSprzedawcy', [id, 'sent'], 'PATCH', `/orders/${id}/status`, { status: 'sent' }, undefined],
    ['utworzPaczkiZewnetrzne', [[zewnetrzna]], 'POST', '/shipping/external', [zewnetrzna], [{ id: 1, orderId: id }]],
    ['edytujPaczkeZewnetrzna', [1, { vendor: 'dpd', trackingNumber: '12345678901234' }], 'PATCH', '/shipping/external/1', { vendor: 'dpd', trackingNumber: '12345678901234' }, { id: 1, ...zewnetrzna }],
    ['usunPaczkeZewnetrzna', [1], 'DELETE', '/shipping/external/1', undefined, undefined],
    ['metodyDostawy', [], 'GET', '/dictionaries/deliveryMethods', undefined, [{ id: 'dpd', name: 'Kurier testowy', vendor: 'dpd', cod: false, targetMarket: 'pl' }]],
    ['metodyErli', [], 'GET', '/dictionaries/shippingMethods', undefined, [{ id: 'erliPaczkomat', name: 'Paczkomat', groupId: 'erliPaczkomat', operator: 'INPOST', cod: false }]],
    ['cennikiDostaw', [], 'GET', '/delivery/priceLists', undefined, [{ id: 1, name: 'Cennik testowy' }]],
    ['punktyNadania', [], 'GET', '/shipping/postingPoints', undefined, [{ id: 1, name: 'Punkt testowy' }]],
    ['utworzPaczki', [[paczka]], 'POST', '/shipping/parcels/', [paczka], [odpowiedzPaczki]],
    ['szukajPaczek', [filtr], 'POST', '/shipping/parcels/_search', filtr, [{ ...odpowiedzPaczki, shipping: { ...odpowiedzPaczki.shipping, waybills: ['https://pliki.polcien.example/1.pdf'] } }]],
    ['anulujPaczke', [1], 'DELETE', '/shipping/parcels/1', undefined, { ...odpowiedzPaczki, status: 'canceled' }],
    ['protokolyOdbioru', [[1, 2]], 'GET', '/shipping/pickupProtocols?parcelIds=1%2C2', undefined, { url: 'https://pliki.polcien.example/protokol.pdf' }],
  ])('%s: ścieżka, metoda, ciało i odpowiedź', async (metoda, args, http, sciezka, body, odpowiedz) => {
    const { klient, fetchImpl } = przygotuj(odpowiedz, odpowiedz === undefined ? 204 : 200);
    expect(await klient[metoda](...args)).toEqual(odpowiedz);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(adresApi.replace(/\/$/, '') + sciezka);
    expect(init.method).toBe(http);
    expect(init.body).toBe(body === undefined ? undefined : JSON.stringify(body));
    expect(init.headers.get('Authorization')).toBe(`Bearer ${kluczApi}`);
    expect(init.headers.get('User-Agent')).toBe('TwojOMS/1.2.3 (+https://twojoms.pl)');
    expect(init.headers.has('X-ERLI-MARKET')).toBe(false);
    if (body !== undefined) expect(init.headers.get('Content-Type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['metodyDostawy', { vendor: 'dpd', cod: false }, 'vendor=dpd&cod=false'],
    ['metodyErli', { groupId: 'erliPaczkomat', cod: true }, 'groupId=erliPaczkomat&cod=true'],
    ['punktyNadania', { id: 1, isDefault: false }, 'id=1&isDefault=false'],
  ])('%s przesyła filtry query', async (metoda, query, suffix) => {
    const { klient, fetchImpl } = przygotuj();
    await klient[metoda](query);
    expect(fetchImpl.mock.calls[0][0]).toContain(`?${suffix}`);
  });

  it.each([true, false])('pobiera etykietę jako Buffer, autoryzacja=%s', async zAutoryzacja => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70, 0, 255])));
    const klient = createErliClient({ adresApi, kluczApi, fetchImpl });
    const url = 'https://api.polcien.example/etykieta.pdf';
    const wynik = await klient.pobierzEtykiete(url, { zAutoryzacja });
    expect(Buffer.isBuffer(wynik)).toBe(true);
    expect([...wynik]).toEqual([37, 80, 68, 70, 0, 255]);
    expect(fetchImpl.mock.calls[0][0]).toBe(url);
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(fetchImpl.mock.calls[0][1].headers.get('Authorization')).toBe(zAutoryzacja ? `Bearer ${kluczApi}` : null);
  });

  it('domyślnie autoryzuje etykietę', async () => {
    const { klient, fetchImpl } = przygotuj();
    await klient.pobierzEtykiete('https://api.polcien.example/1.pdf');
    expect(fetchImpl.mock.calls[0][1].headers.get('Authorization')).toBe(`Bearer ${kluczApi}`);
  });

  it.each([
    ['https://pliki.polcien.example/1.pdf', null],
    ['http://api.polcien.example/1.pdf', null],
    ['https://erli.pl.polcien.example/1.pdf', null],
    ['https://evilerli.pl/1.pdf', null],
    ['https://api.polcien.example:444/1.pdf', null],
    ['https://etykiety.sandbox.erli.dev/1.pdf', `Bearer ${kluczApi}`],
    ['https://erli.pl/svc/1.pdf', `Bearer ${kluczApi}`],
  ])('klucz do etykiety tylko dla zaufanego hosta: %s', async (url, oczekiwany) => {
    const { klient, fetchImpl } = przygotuj();
    await klient.pobierzEtykiete(url);
    expect(fetchImpl.mock.calls[0][1].headers.get('Authorization')).toBe(oczekiwany);
  });

  it.each([
    ['inboxSzukaj', [{ types: ['orderCreated'] }], 'POST', '/inbox/_search'],
    ['inboxOznacz', [{ lastMessageId: 'a'.repeat(24) }], 'POST', '/inbox/mark-read'],
    ['pobierzProdukt', ['PC-OF-1'], 'GET', '/products/PC-OF-1'],
    ['cennikiDostawSzczegoly', [], 'GET', '/delivery/priceListsDetails'],
  ])('%s woła właściwą ścieżkę', async (metoda, argumenty, method, sciezka) => {
    const { klient, fetchImpl } = przygotuj({});
    await klient[metoda](...argumenty);
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://api.polcien.example/svc/shop-api${sciezka}`);
    expect(fetchImpl.mock.calls[0][1].method).toBe(method);
  });

  it('pobierzProdukt zwraca null przy 404, inne błędy przepuszcza ze statusem', async () => {
    expect(await przygotuj({}, 404).klient.pobierzProdukt('PC-OF-9')).toBeNull();
    await expect(przygotuj({}, 500).klient.pobierzProdukt('PC-OF-9')).rejects.toMatchObject({ status: 500 });
  });

  it('błąd 404 niesie status (przełączenie na /inbox, D1)', async () => {
    await expect(przygotuj({}, 404).klient.zmianyZamowien()).rejects.toMatchObject({ status: 404, message: 'ERLI: błąd HTTP 404.' });
  });

  it.each(['created', 'canceled', 'readyToProcess', 'inProgress', 'sent', 'readyToPickup', 'received', 'returned', 'returningToSender', 'unknown'])('przyjmuje sellerStatus %s', async status => {
    const { klient } = przygotuj(null, 204);
    await expect(klient.ustawStatusSprzedawcy(id, status)).resolves.toBeUndefined();
  });

  it('odrzuca literówkę sellerStatus przed siecią', async () => {
    const { klient, fetchImpl } = przygotuj();
    await expect(klient.ustawStatusSprzedawcy(id, 'cancelled')).rejects.toThrow(/status sprzedawcy/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['utworzPaczkiZewnetrzne', 'edytujPaczkeZewnetrzna'])('%s odrzuca nieznanego vendora', async metoda => {
    const { klient, fetchImpl } = przygotuj();
    const dane = { ...zewnetrzna, vendor: 'literowka' };
    await expect(metoda === 'utworzPaczkiZewnetrzne' ? klient[metoda]([dane]) : klient[metoda](1, dane)).rejects.toThrow(/przewoźnik/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['inpost', 'pocztaPolska', 'dhl', 'dpd', 'ups', 'gls', 'orlen', 'pocztex24', 'ambroExpress', 'pekaes', 'tntExpress', 'schenker', 'dsv', 'dts', 'geis', 'fedex', 'jasFBG', 'patronService', 'raben', 'rhenus', 'rohligSuus', 'hellmann'])('wymaga trackingNumber: %s', async vendor => {
    const { klient, fetchImpl } = przygotuj();
    await expect(klient.utworzPaczkiZewnetrzne([{ orderId: id, vendor, trackingNumber: ' ' }])).rejects.toThrow(/numer.*śledzenia/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['ownTransport', 'selfPickup'])('dopuszcza %s bez numeru', async vendor => {
    const { klient, fetchImpl } = przygotuj();
    await klient.utworzPaczkiZewnetrzne([{ orderId: id, vendor, status: 'sent' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, {}, { ...paczka.dimensions, width: undefined }, { ...paczka.dimensions, width: 2001 }, { ...paczka.dimensions, height: 2001 }, { ...paczka.dimensions, length: 2001 }, { ...paczka.dimensions, weight: 700001 }, { ...paczka.dimensions, weight: 0 }])('odrzuca niepoprawne wymiary lub wagę %j', async dimensions => {
    const { klient, fetchImpl } = przygotuj();
    await expect(klient.utworzPaczki([{ ...paczka, dimensions }])).rejects.toThrow(/wymiary|waga/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('wysyła graniczne mm i g bez przeliczeń', async () => {
    const { klient, fetchImpl } = przygotuj();
    const dane = [{ ...paczka, dimensions: { width: 2000, height: 2000, length: 2000, weight: 700000 } }];
    await klient.utworzPaczki(dane);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(dane);
  });

  it('429: rozpoznawalny limit, Retry-After 7, bez ponowienia i czekania', async () => {
    const { klient, fetchImpl, czekaj } = przygotuj([], 429, { 'Retry-After': '7' });
    await expect(klient.mojSklep()).rejects.toMatchObject({ kod: 'ERLI_429', status: 429, retryAfterS: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('400 pokazuje kod i opis bez klucza, ciała i danych osobowych', async () => {
    const { klient, log } = przygotuj([{ errorCode: 1102, errorMessage: 'Nie udało się stworzyć przesyłki' }], 400);
    const dane = [{ ...paczka, shipping: { ...paczka.shipping, receiver: { lastName: 'Zmyślonowicz' } } }];
    const blad = await klient.utworzPaczki(dane).catch(e => e);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.message).toBe('1102 — Nie udało się stworzyć przesyłki');
    expect(blad.message + JSON.stringify(log.mock.calls)).not.toContain(kluczApi);
    expect(blad.message + JSON.stringify(log.mock.calls)).not.toContain('Zmyślonowicz');
  });

  it('usuwa klucz i odbite nazwisko także z opisu błędu serwera', async () => {
    const { klient, log } = przygotuj([{ errorCode: 1102, errorMessage: `Błąd ${kluczApi} Zmyślonowicz` }], 400);
    const blad = await klient.utworzPaczki([{ ...paczka, shipping: { ...paczka.shipping, receiver: adres } }]).catch(e => e);
    expect(blad.message).toBe('1102 — Błąd [ukryto] [ukryto]');
    expect(JSON.stringify(log.mock.calls)).not.toContain(kluczApi);
  });

  it('krótkie i słownikowe wartości ciała nie psują opisu błędu', async () => {
    const { klient } = przygotuj([{ errorCode: 1213, errorMessage: 'Błąd walidacji: waga 1000 g, typ erliPaczkomat' }], 400);
    const dane = [{ ...paczka, shipping: { ...paczka.shipping, receiver: { ...adres, buildingNumber: '1', flatNumber: 'a' } } }];
    const blad = await klient.utworzPaczki(dane).catch(e => e);
    expect(blad.message).toBe('1213 — Błąd walidacji: waga 1000 g, typ erliPaczkomat');
  });

  it.each([
    [{ polishMessage: 'Zamówienie nie istnieje', message: 'Order not found' }, 'ERLI: Zamówienie nie istnieje (HTTP 404)'],
    [{ error: { polishMessage: 'Stan zamrożony' } }, 'ERLI: Stan zamrożony (HTTP 404)'],
    [{ message: 'Order not found' }, 'ERLI: Order not found (HTTP 404)'],
    [{ polishMessage: `Klucz ${kluczApi}` }, 'ERLI: Klucz [ukryto] (HTTP 404)'],
    [{}, 'ERLI: błąd HTTP 404.'],
  ])('opis błędu: polishMessage, potem message, potem kod (%j)', async (cialo, oczekiwany) => {
    const { klient } = przygotuj(cialo, 404);
    await expect(klient.pobierzZamowienie(id)).rejects.toMatchObject({ status: 404, message: oczekiwany });
  });

  it('202 bez ciała to sukces', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 202 }));
    const klient = createErliClient({ adresApi, kluczApi, fetchImpl });
    await expect(klient.ustawStatusSprzedawcy(id, 'sent')).resolves.toBeUndefined();
  });

  it('bez klucza odmawia przed siecią', async () => {
    const fetchImpl = vi.fn();
    await expect(createErliClient({ adresApi, kluczApi: '', fetchImpl }).mojSklep()).rejects.toThrow(/brak klucza/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([[9, 100], [1000, 0]])('odrzuca granice paczki: waga %s, wymiar %s', async (weight, width) => {
    const { klient, fetchImpl } = przygotuj();
    await expect(klient.utworzPaczki([{ ...paczka, dimensions: { ...paczka.dimensions, weight, width } }])).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('błąd sieci nie ujawnia wiadomości ani cause z fetch', async () => {
    const log = vi.fn();
    const klient = createErliClient({ adresApi, kluczApi, log, fetchImpl: async () => { throw new Error(kluczApi); } });
    await expect(klient.mojSklep()).rejects.toThrow('ERLI: błąd połączenia.');
    expect(JSON.stringify(log.mock.calls)).not.toContain(kluczApi);
  });

  it('limit czasu przerywa wstrzyknięty fetch i daje polski komunikat', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
      const klient = createErliClient({ adresApi, kluczApi, fetchImpl });
      const wynik = expect(klient.mojSklep()).rejects.toThrow('ERLI: przekroczono limit czasu 30 s.');
      controller.abort(new DOMException('limit', 'TimeoutError'));
      await wynik;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  it('nie przenosi bankAccount z zamówień i payloadów zmian', async () => {
    const dane = [{ payload: { ...zamowienie, returns: [{ reason: 'other', comment: 'Test', bankAccount: 'fikcyjne-konto' }] } }];
    const { klient } = przygotuj(dane);
    expect(await klient.zmianyZamowien()).toEqual([{ payload: { ...zamowienie, returns: [{ reason: 'other', comment: 'Test' }] } }]);
    expect(dane[0].payload.returns[0]).toHaveProperty('bankAccount');
  });

  it('ustawia limit 30 s również dla wstrzykniętego fetch', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await przygotuj().klient.mojSklep();
      expect(timeout).toHaveBeenCalledWith(30000);
    } finally { timeout.mockRestore(); }
  });
});
