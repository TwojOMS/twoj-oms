import { describe, it, expect, vi } from 'vitest';
import { createWooClient } from '../../src/oms/woo/client.js';
import { dodajNotatkeZPowtorka } from '../../src/moduly/wysylka/services/notatka-nadania.js';
import {
  czyOdmowaZapisu, TYLKO_ODCZYT, KLUCZ_TYLKO_ODCZYT, uprawnieniaSklepu, czyTylkoOdczyt,
} from '../../src/domena/woo-uprawnienia.js';

// PRZ-149.04 (C8): sklep podłączony kluczem „Odczyt” — klient NIE wysyła żadnego zapisu,
// a klucz bez zapisu przy trybie „Zapis/odczyt” daje jeden zrozumiały komunikat bez ponawiania.

const odp = (status, body) => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
  headers: { get: () => null },
});
const klient = (res, nad = {}) => {
  const fetchImpl = vi.fn().mockResolvedValue(res);
  return { c: createWooClient({ baseUrl: 'https://sklep.polcien.example', ck: 'ck', cs: 'cs', fetchImpl, ...nad }), fetchImpl };
};

describe('uprawnieniaSklepu', () => {
  it('bez zapisanego wyboru (istniejący sklep) daje Zapis/odczyt', () => {
    expect(uprawnieniaSklepu(undefined)).toBe('zapis');
    expect(uprawnieniaSklepu({})).toBe('zapis');
    expect(uprawnieniaSklepu({ uprawnienia: 'cokolwiek' })).toBe('zapis');
    expect(uprawnieniaSklepu({ uprawnienia: 'odczyt' })).toBe('odczyt');
  });
});

describe('klient Woo w trybie Odczyt', () => {
  it('ustawStatus, dodajNotatke i zapiszProdukt odmawiają bez ani jednego żądania HTTP', async () => {
    const { c, fetchImpl } = klient(odp(200, {}), { uprawnienia: 'odczyt' });
    await expect(c.ustawStatus(4501, 'completed')).rejects.toThrow(TYLKO_ODCZYT);
    await expect(c.dodajNotatke(4501, 'Nadano')).rejects.toThrow(TYLKO_ODCZYT);
    await expect(c.zapiszProdukt('products/900', { sku: 'A-1' })).rejects.toThrow(TYLKO_ODCZYT);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(czyTylkoOdczyt(c)).toBe(true);
  });

  it('odczyt działa normalnie', async () => {
    const { c, fetchImpl } = klient(odp(200, { id: 900, sku: '' }), { uprawnienia: 'odczyt' });
    await c.pobierzProdukt('products/900');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bez opcji (sklep z env, stary sklep) klient zapisuje jak dotąd', async () => {
    const { c, fetchImpl } = klient(odp(200, {}));
    await c.ustawStatus(4501, 'completed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czyTylkoOdczyt(c)).toBe(false);
  });
});

describe('klient Woo w trybie Zapis/odczyt z kluczem tylko do odczytu', () => {
  it('403 woocommerce_rest_cannot_edit daje komunikat kreatora po JEDNEJ próbie, bez ponawiania', async () => {
    const { c, fetchImpl } = klient(odp(403, { code: 'woocommerce_rest_cannot_edit', message: 'Sorry' }));
    const czekaj = vi.fn().mockResolvedValue();
    await expect(dodajNotatkeZPowtorka(c, 4501, 'Nadano', { czekaj })).rejects.toThrow(KLUCZ_TYLKO_ODCZYT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(czekaj).not.toHaveBeenCalled();
  });

  it('401 woocommerce_rest_cannot_edit przy zmianie statusu — ten sam komunikat', async () => {
    const { c, fetchImpl } = klient(odp(401, { code: 'woocommerce_rest_cannot_edit' }));
    await expect(c.ustawStatus(4501, 'completed')).rejects.toThrow(KLUCZ_TYLKO_ODCZYT);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Prawdziwy WooCommerce przy kluczu „Odczyt” i zapisie odpowiada 401 woocommerce_rest_authentication_error
  // „…does not have write permissions.” — rozpoznajemy po treści, bo ten sam kod ma zły/odwołany klucz.
  it('401 authentication_error „does not have write permissions” przy zapisie — ten sam komunikat', async () => {
    const { c } = klient(odp(401, { code: 'woocommerce_rest_authentication_error', message: 'The API key provided does not have write permissions.' }));
    await expect(c.zapiszProdukt('products/900', { sku: 'A-1' })).rejects.toThrow(KLUCZ_TYLKO_ODCZYT);
  });

  it('401 authentication_error o złym kluczu przy zapisie zostaje „Sklep odrzucił klucz REST”', async () => {
    const { c } = klient(odp(401, { code: 'woocommerce_rest_authentication_error', message: 'Consumer key is invalid.' }));
    await expect(c.ustawStatus(4501, 'completed')).rejects.toThrow('Sklep odrzucił klucz REST');
  });

  it('401 przy ODCZYCIE zostaje dawnym „Sklep odrzucił klucz REST”', async () => {
    const { c } = klient(odp(401, { code: 'woocommerce_rest_cannot_view', message: 'zły klucz' }));
    await expect(c.pobierzProdukt('products/900')).rejects.toThrow('Sklep odrzucił klucz REST');
  });

  it('odmowa przy ODCZYCIE (GET) nigdy nie jest „kluczem tylko do odczytu”', () => {
    expect(czyOdmowaZapisu(403, { code: 'woocommerce_rest_cannot_edit' }, 'GET')).toBe(false);
    expect(czyOdmowaZapisu(401, { code: 'woocommerce_rest_cannot_edit' }, 'get')).toBe(false);
    expect(czyOdmowaZapisu(403, { code: 'woocommerce_rest_cannot_edit' }, 'PUT')).toBe(true);
  });

  it('inny 403 przy zapisie nie udaje klucza tylko do odczytu', async () => {
    const { c } = klient(odp(403, { code: 'rest_forbidden', message: 'zakaz' }));
    await expect(c.ustawStatus(4501, 'completed')).rejects.toThrow('Sklep odpowiedział 403');
  });
});
