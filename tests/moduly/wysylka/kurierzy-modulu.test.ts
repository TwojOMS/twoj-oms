import { it, expect, vi } from 'vitest';
import { wczytajKurierow, zbudujKurierow } from '../../../src/moduly/wysylka/kurierzy.ts';

it('rozdziela kontrakt kanału śledzenia od zamówienia przekazywanego do WZA', async () => {
  const klient = () => ({
    pobierzPrzesylkeWza: vi.fn().mockResolvedValue({ labelFormat: 'PDF', packages: [{ waybill: 'LIST-1' }] }),
    pobierzEtykieteWza: vi.fn().mockResolvedValue(Buffer.from('%PDF-test')),
    pobierzSledzenie: vi.fn().mockResolvedValue({ waybills: [] }),
    utworzPrzesylkeWza: vi.fn(),
  });
  const a = klient(), b = klient();
  const kurierzy = zbudujKurierow(wczytajKurierow({}), { allegro_a: a, allegro_b: b });
  const wynik = await kurierzy.allegro_wza!.sprawdzPrzesylke!('shipment-b', { sklep: 'allegro_b' });
  expect(wynik.numerListu).toBe('LIST-1');
  expect(b.pobierzPrzesylkeWza).toHaveBeenCalledWith('shipment-b');
  expect(a.pobierzPrzesylkeWza).not.toHaveBeenCalled();
  await kurierzy.allegro!.statusPrzesylki('LIST-A', { kanal: 'allegro_a', carrier: 'DPD' });
  expect(a.pobierzSledzenie).toHaveBeenCalledWith('DPD', 'LIST-A');
  expect(b.pobierzSledzenie).not.toHaveBeenCalled();
  expect(a.utworzPrzesylkeWza).not.toHaveBeenCalled();
  expect(b.utworzPrzesylkeWza).not.toHaveBeenCalled();
});

it('przy braku podpiętego konta WZA odmawia przed płatną operacją', async () => {
  const kurierzy = zbudujKurierow(wczytajKurierow({}), { allegro_a: {} });
  await expect(kurierzy.allegro_wza!.sprawdzPrzesylke!('ship', { sklep: 'allegro_nieistniejace' })).rejects.toThrow('panel niczego nie nadał');
});

it('mapa InPost nie przekazuje zamówienia jako wewnętrznej odpowiedzi ShipX', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (url: string | URL | Request) => {
    if (String(url).includes('/label?format=pdf')) return new Response('%PDF-test');
    if (String(url).includes('/label?format=zpl')) return new Response('^XA^XZ');
    return new Response(JSON.stringify({ id: 'ship', tracking_number: 'LIST-INPOST' }));
  });
  vi.stubGlobal('fetch', fetch);
  try {
    const config = wczytajKurierow({ INPOST_TOKEN: 'test', INPOST_ORGANIZACJA: '1',
      DPD_NADAWCA_NAZWA: 'Test', DPD_NADAWCA_ULICA: 'Testowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Testowo' });
    const kurierzy = zbudujKurierow(config, {});
    const wynik = kurierzy.inpost!.sprawdzPrzesylke!('ship', { sklep: 'sklep' });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await wynik).numerListu).toBe('LIST-INPOST');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[0]).toContain('/shipments/ship');
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
