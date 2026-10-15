import { describe, expect, it } from 'vitest';
import { createAllegroClient } from '../../src/oms/allegro/client.js';

const ustawienia = {
  api: 'https://api.allegro.pl',
  userAgent: 'OMS-szkicownia/1.0.0 (+https://szkicownia.pl/oms/)',
};
const tokeny = { waznyToken: async () => 'TOKEN-PODJAZD' };
const adres = { companyName: 'Szkicownia', street: 'Testowa', zipCode: '32-600', city: 'Oświęcim', countryCode: 'PL' };
const pickupTime = { date: '2026-09-23', minTime: '09:00', maxTime: '13:00' };

function klientZeSzpiegiem(odpowiedzi = [{ ok: true, status: 200, json: async () => ({}) }]) {
  const wolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wolania.push({ url, opcje });
    return odpowiedzi.shift();
  };
  return { klient: createAllegroClient({ ustawienia, tokeny, fetchImpl }), wolania };
}

describe('klient Allegro — podjazdy Wysyłam z Allegro', () => {
  it('pobiera propozycje dokładnym POST-em z adresem i gotową datą', async () => {
    const { klient, wolania } = klientZeSzpiegiem([{ ok: true, status: 200, json: async () => ({ pickupProposals: [] }) }]);

    await expect(klient.pobierzPropozycjePodjazdu({
      shipmentIds: ['shipment-1', 'shipment-2'], readyDate: '2026-09-23', address: adres,
    })).resolves.toEqual({ pickupProposals: [] });

    expect(wolania).toHaveLength(1);
    expect(wolania[0].url).toBe('https://api.allegro.pl/shipment-management/pickup-proposals');
    expect(wolania[0].opcje.method).toBe('POST');
    expect(wolania[0].opcje.headers).toMatchObject({
      Authorization: 'Bearer TOKEN-PODJAZD',
      Accept: 'application/vnd.allegro.public.v1+json',
      'Content-Type': 'application/vnd.allegro.public.v1+json',
      'User-Agent': ustawienia.userAgent,
    });
    expect(JSON.parse(wolania[0].opcje.body)).toEqual({
      shipmentIds: ['shipment-1', 'shipment-2'], readyDate: '2026-09-23', address: adres,
    });
  });

  it('zleca raz z trwałym commandId, pickupTime i adresem — bez wycofanych pól', async () => {
    const { klient, wolania } = klientZeSzpiegiem([{ ok: true, status: 200, json: async () => ({ commandId: 'cmd-1', status: 'IN_PROGRESS' }) }]);

    await klient.zlecPodjazd({
      commandId: 'cmd-1',
      input: { shipmentIds: ['shipment-1'], pickupTime, address: adres },
    });

    expect(wolania).toHaveLength(1);
    expect(wolania[0].url).toBe('https://api.allegro.pl/shipment-management/pickups/create-commands');
    expect(wolania[0].opcje.method).toBe('POST');
    const body = JSON.parse(wolania[0].opcje.body);
    expect(body).toEqual({ commandId: 'cmd-1', input: { shipmentIds: ['shipment-1'], pickupTime, address: adres } });
    expect(body.input).not.toHaveProperty('pickupDateProposalId');
    expect(body.input).not.toHaveProperty('proposalItems');
  });

  it('odrzuca wycofany kontrakt przed POST-em', async () => {
    const { klient, wolania } = klientZeSzpiegiem();

    await expect(klient.zlecPodjazd({
      commandId: 'cmd-1',
      input: { shipmentIds: ['shipment-1'], pickupTime, address: adres, pickupDateProposalId: 'old' },
    })).rejects.toThrow(/pickupDateProposalId/);
    expect(wolania).toHaveLength(0);
  });

  it('nie ponawia POST-u i przekazuje Retry-After z odmowy', async () => {
    const { klient, wolania } = klientZeSzpiegiem([{
      ok: false, status: 429, headers: new Headers({ 'Retry-After': '47' }), json: async () => ({}),
    }]);

    await expect(klient.zlecPodjazd({
      commandId: 'cmd-1', input: { shipmentIds: ['shipment-1'], pickupTime, address: adres },
    })).rejects.toMatchObject({ status: 429, retryAfterS: 47 });
    expect(wolania).toHaveLength(1);
  });

  it('czyta status istniejącej komendy i szczegóły podjazdu przez GET', async () => {
    const { klient, wolania } = klientZeSzpiegiem([
      { ok: true, status: 200, json: async () => ({ commandId: 'cmd/id', status: 'SUCCESS', pickupId: 'pickup-1' }) },
      { ok: true, status: 200, json: async () => ({ id: 'pickup/a' }) },
    ]);

    await expect(klient.stanZleceniaPodjazdu('cmd/id')).resolves.toMatchObject({ status: 'SUCCESS' });
    await expect(klient.pobierzPodjazd('pickup/a')).resolves.toEqual({ id: 'pickup/a' });

    expect(wolania.map((w) => [w.url, w.opcje.method])).toEqual([
      ['https://api.allegro.pl/shipment-management/pickups/create-commands/cmd%2Fid', 'GET'],
      ['https://api.allegro.pl/shipment-management/pickups/pickup%2Fa', 'GET'],
    ]);
  });

  it('przekazuje Retry-After z odpowiedzi IN_PROGRESS', async () => {
    const { klient } = klientZeSzpiegiem([{
      ok: true, status: 200, headers: new Headers({ 'Retry-After': '1800' }),
      json: async () => ({ id: 'cmd-1', status: 'IN_PROGRESS' }),
    }]);
    await expect(klient.stanZleceniaPodjazdu('cmd-1'))
      .resolves.toMatchObject({ id: 'cmd-1', status: 'IN_PROGRESS', retryAfterS: 1800 });
  });
});
