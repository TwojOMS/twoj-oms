import { describe, it, expect, vi } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';

const odpowiedz = (status, dane, location = null) => ({ status, ok: status >= 200 && status < 300,
  json: async () => dane, headers: { get: (n) => n.toLowerCase() === 'location' ? location : null } });
const klient = (http) => createWooClient({ baseUrl: 'http://sklep.polcien.example', ck: 'ck_test_polcien', cs: 'cs_test_polcien', http });

describe('połączenie Woo', () => {
  it.each([[401, 'klucze'], [403, 'klucze'], [404, 'brak_api'], [500, 'siec']])('klasyfikuje HTTP %i', async (status, powod) => {
    const http = vi.fn().mockResolvedValue(odpowiedz(status, {}));
    expect(await klient(http).sprawdzPolaczenie()).toEqual({ ok: false, powod, status });
    expect(http.mock.calls[0][0]).toContain('/orders?per_page=1');
  });
  it('rozpoznaje sukces, błąd sieci i DNS', async () => {
    expect(await klient(async () => odpowiedz(200, [])).sprawdzPolaczenie()).toEqual({ ok: true });
    expect(await klient(async () => { throw new Error('ECONNREFUSED'); }).sprawdzPolaczenie()).toMatchObject({ ok: false, powod: 'siec' });
    expect(await klient(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }).sprawdzPolaczenie()).toMatchObject({ ok: false, powod: 'adres' });
    expect(await klient(async () => { throw Object.assign(new Error('TLS'), { code: 'CERT_HAS_EXPIRED' }); }).sprawdzPolaczenie()).toMatchObject({ ok: false, powod: 'certyfikat' });
    expect(await klient(async () => { throw Object.assign(new Error('TLS'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }); }).sprawdzPolaczenie()).toMatchObject({ ok: false, powod: 'adres' });
    expect(await klient(async () => { throw Object.assign(new Error('TLS'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }); }).sprawdzPolaczenie()).toMatchObject({ ok: false, powod: 'certyfikat' });
  });
  it.each(['EAI_AGAIN', 'ERR_INVALID_URL'])('klasyfikuje %s jako błąd adresu', async (code) => {
    expect(await klient(async () => { throw Object.assign(new Error('adres'), { code }); }).sprawdzPolaczenie()).toEqual({ ok: false, powod: 'adres', status: null });
  });
  it('klasyfikuje TypeError bez kodu jako błąd adresu', async () => {
    expect(await klient(async () => { throw new TypeError('adres'); }).sprawdzPolaczenie()).toEqual({ ok: false, powod: 'adres', status: null });
  });
  it('odrzuca stronę HTML z kodem 200', async () => {
    const html = { ...odpowiedz(200, null), json: async () => { throw new SyntaxError('HTML'); } };
    expect(await klient(async () => html).sprawdzPolaczenie()).toEqual({ ok: false, powod: 'brak_api', status: 200 });
    expect(await klient(async () => odpowiedz(200, {})).sprawdzPolaczenie()).toEqual({ ok: false, powod: 'brak_api', status: 200 });
  });
  it('odrzuca stronę logowania po przekierowaniu w tym samym originie', async () => {
    const html = { ...odpowiedz(200, null), json: async () => { throw new SyntaxError('HTML'); } };
    const http = vi.fn().mockResolvedValueOnce(odpowiedz(302, null, '/wp-login.php')).mockResolvedValueOnce(html);
    expect(await klient(http).sprawdzPolaczenie()).toEqual({ ok: false, powod: 'brak_api', status: 200 });
  });
  it('pobiera metody każdej strefy, w tym strefy 0 gdy API jej nie wymienia', async () => {
    const http = vi.fn(async (url) => {
      if (url.endsWith('/shipping/zones')) return odpowiedz(200, [{ id: 1, name: 'Kraj' }]);
      if (url.endsWith('/shipping/zones/0/methods')) return odpowiedz(200, [{ instance_id: 7, title: 'Pozostałe', method_id: 'flexible_shipping', enabled: true }]);
      return odpowiedz(200, [{ instance_id: 3, title: 'Kurier', method_id: 'flat_rate', enabled: false }]);
    });
    expect(await klient(http).pobierzMetodyWysylki()).toEqual([
      { strefa: 'Kraj', instanceId: 3, tytul: 'Kurier', metodaWoo: 'flat_rate', wlaczona: false },
      { strefa: 'Pozostałe lokalizacje', instanceId: 7, tytul: 'Pozostałe', metodaWoo: 'flexible_shipping', wlaczona: true },
    ]);
  });
  it('nie wysyła Authorization po przekierowaniu na inny port', async () => {
    const http = vi.fn().mockResolvedValueOnce(odpowiedz(301, null, 'http://sklep.polcien.example:1234/inny')).mockResolvedValueOnce(odpowiedz(200, []));
    expect(await klient(http).sprawdzPolaczenie()).toEqual({ ok: false, powod: 'przekierowanie', status: 200 });
    expect(http.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });
  it('z tylkoTenSamOrigin: inny origin to powód przekierowanie bez drugiego żądania', async () => {
    const http = vi.fn().mockResolvedValueOnce(odpowiedz(302, null, 'https://obcy.example/wp-json/wc/v3/orders')).mockResolvedValueOnce(odpowiedz(200, []));
    const k = createWooClient({ baseUrl: 'http://sklep.polcien.example', ck: 'ck_test_polcien', cs: 'cs_test_polcien', http, tylkoTenSamOrigin: true });
    expect(await k.sprawdzPolaczenie()).toEqual({ ok: false, powod: 'przekierowanie', status: null });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
