import { expect, it } from 'vitest';
import { createAllegroClient } from '../../src/oms/allegro/client.js';

// PRZ-055: biała lista pól (userMessage/message/path) nie chroni przed tokenem odbitym
// WEWNĄTRZ dozwolonego pola. Komunikat ląduje w bazie i na ekranie (niezmiennik 4.10).
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyX25hbWUiOiJ0ZXN0LTA1NSJ9.c2lnbmF0dXJhLXRlc3Rvd2EtMDU1';
const sciezka = '/shipment-management/pickup-proposals';
const poczatek = `Allegro: HTTP 400 przy ${sciezka}`;

function klientZ(errors, token = TOKEN, status = 400) {
  return createAllegroClient({
    ustawienia: { api: 'https://allegro.example.invalid', userAgent: 'Test/1.0' },
    tokeny: { waznyToken: async () => token },
    fetchImpl: async () => ({ ok: false, status, json: async () => ({ errors }) }),
  });
}
const propozycje = (klient) => klient.pobierzPropozycjePodjazdu({
  shipmentIds: ['shipment-055'], readyDate: '2026-10-09', address: { phone: '+48501234567' },
}).catch((e) => e);

it('token odbity w userMessage zapisu jest ukryty, reszta opisu zostaje', async () => {
  const blad = await propozycje(klientZ([{ userMessage: `Niepoprawny token ${TOKEN} w żądaniu`, path: 'address.phone' }]));
  expect(blad.message).toBe(`${poczatek}: Niepoprawny token [ukryto] w żądaniu (address.phone)`);
  expect(blad.message).not.toContain(TOKEN);
});

it('nagłówek autoryzacji odbity w message odczytu jest ukryty', async () => {
  const klient = klientZ([{ message: `Authorization: Bearer ${TOKEN}` }]);
  const blad = await klient.stanZleceniaPodjazdu('cmd-055').catch((e) => e);
  expect(blad.message).toBe('Allegro: HTTP 400 przy /shipment-management/pickups/create-commands/cmd-055: Authorization: [ukryto]');
  expect(blad.message).not.toMatch(/Bearer/i);
  expect(blad.message).not.toContain(TOKEN);
});

it('Bearer z innym tokenem niż bieżący też nie trafia do komunikatu', async () => {
  const blad = await propozycje(klientZ([{ message: 'Bearer stary-token-123 wygasł' }]));
  expect(blad.message).toBe(`${poczatek}: [ukryto] wygasł`);
});

it('token w polu path jest ukryty', async () => {
  const blad = await propozycje(klientZ([{ userMessage: 'Zły parametr', path: `headers.${TOKEN}` }]));
  expect(blad.message).toBe(`${poczatek}: Zły parametr (headers.[ukryto])`);
});

it('ucięcie do 300 znaków nie zostawia początku tokenu', async () => {
  // Token zaczyna się w 290. znaku opisu: maskowanie po ucięciu zostawiłoby jego prefiks.
  const blad = await propozycje(klientZ([{ userMessage: 'X'.repeat(290) + TOKEN }]));
  expect(blad.message.slice(poczatek.length).length).toBeLessThanOrEqual(300);
  expect(blad.message).not.toContain(TOKEN.slice(0, 6));
});

it('token we wszystkich trzech błędach jest ukryty w każdym', async () => {
  const blad = await propozycje(klientZ([1, 2, 3].map((n) => ({ userMessage: `${n}:${TOKEN}` }))));
  expect(blad.message).toBe(`${poczatek}: 1:[ukryto]; 2:[ukryto]; 3:[ukryto]`);
});

it('krótki token z przeniesionego testu (TOKEN) też jest ukryty, początek bez zmian', async () => {
  const blad = await propozycje(klientZ([{ message: 'TOKEN' }], 'TOKEN', 422));
  expect(blad.message).toBe('Allegro: HTTP 422 przy /shipment-management/pickup-proposals: [ukryto]');
  expect(blad.message).not.toMatch(/Bearer|TOKEN/);
});
