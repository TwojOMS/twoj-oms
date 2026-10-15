import { expect, it } from 'vitest';
import { createAllegroClient } from '../../src/oms/allegro/client.js';

const sciezka = '/shipment-management/pickup-proposals';
const poczatek = `Allegro: HTTP 400 przy ${sciezka}`;
const opis = 'Numer telefonu musi zawierać prefiks międzynarodowy';
const validation = { code: 'VALIDATION_ERROR', userMessage: opis, message: 'Technical fallback', path: 'address.phone' };

function klientZ(odpowiedz) {
  const zadania = [];
  const klient = createAllegroClient({
    ustawienia: { api: 'https://allegro.example.invalid', userAgent: 'Test/1.0' },
    tokeny: { waznyToken: async () => 'SECRET-TOKEN-055' },
    fetchImpl: async (url, opcje) => { zadania.push({ url, opcje }); return odpowiedz; },
  });
  return { klient, zadania };
}
const propozycje = (klient) => klient.pobierzPropozycjePodjazdu({
  shipmentIds: ['shipment-055'], readyDate: '2026-10-09', address: { phone: '501234567' },
});
async function bladZ(errors) {
  const { klient } = klientZ({ ok: false, status: 400, json: async () => ({ errors }) });
  return propozycje(klient).catch((e) => e);
}

it('POST pokazuje userMessage i path, zachowując początek komunikatu', async () => {
  expect((await bladZ([validation])).message).toBe(`${poczatek}: ${opis} (address.phone)`);
});

it('GET korzysta z tego samego opisu i zachowuje Retry-After bez ponowienia', async () => {
  const { klient, zadania } = klientZ({ ok: false, status: 429,
    headers: new Headers({ 'Retry-After': '47', 'X-Debug': 'SECRET-HEADER' }),
    json: async () => ({ errors: [validation] }),
  });
  await expect(klient.stanZleceniaPodjazdu('cmd-055')).rejects.toMatchObject({ status: 429, retryAfterS: 47,
    message: `Allegro: HTTP 429 przy /shipment-management/pickups/create-commands/cmd-055: ${opis} (address.phone)` });
  expect(zadania).toHaveLength(1);
});

it('POST zachowuje Retry-After także po odczycie ciała odmowy', async () => {
  const { klient, zadania } = klientZ({ ok: false, status: 429, headers: new Headers({ 'Retry-After': '19' }),
    json: async () => ({ errors: [validation] }) });
  await expect(propozycje(klient)).rejects.toMatchObject({ status: 429, retryAfterS: 19 });
  expect(zadania).toHaveLength(1);
});

it.each([
  [{ message: 'Fallback', path: 'input.phone' }, 'Fallback (input.phone)'],
  [{ userMessage: '', message: 'Fallback' }, 'Fallback'],
  [{ userMessage: 'Czytelny', message: 'Technical', path: 'phone' }, 'Czytelny (phone)'],
])('message jest zastępstwem tylko przy braku userMessage: %j', async (error, wynik) => {
  expect((await bladZ([error])).message).toBe(`${poczatek}: ${wynik}`);
});

it('najwyżej trzy błędy trafiają do komunikatu', async () => {
  const blad = await bladZ([1, 2, 3, 4].map((n) => ({ userMessage: `Błąd ${n}`, path: `pole${n}` })));
  expect(blad.message).toBe(`${poczatek}: Błąd 1 (pole1); Błąd 2 (pole2); Błąd 3 (pole3)`);
});

it('cały dopisek z separatorem ma najwyżej 300 znaków', async () => {
  const blad = await bladZ([{ userMessage: 'X'.repeat(400), path: 'phone' }]);
  expect(blad.message.startsWith(`${poczatek}: `)).toBe(true);
  expect(blad.message.slice(poczatek.length).length).toBe(300);
});

it('odrzuca wszystkie pola poza userMessage/message/path i parametry URL', async () => {
  const { klient } = klientZ({ ok: false, status: 403, headers: new Headers({ Authorization: 'SECRET-HEADER' }),
    json: async () => ({ headers: { Authorization: 'SECRET-TOKEN-055' }, request: 'SECRET-BODY',
      errors: [{ ...validation, code: 'SECRET-CODE', details: 'SECRET-DETAILS' }] }) });
  const blad = await klient.pobierzZamowienia({ od: '2026-10-08', strona: 1 }).catch((e) => e);
  expect(blad.message).toBe(`Allegro: HTTP 403 przy /order/checkout-forms: ${opis} (address.phone)`);
});

it.each([
  ['brak json', {}],
  ['brak ciała', { json: async () => null }],
  ['nie JSON', { json: async () => { throw new SyntaxError('SECRET-HTML'); } }],
  ['błąd odczytu', { json: async () => { throw new Error('SECRET-READ'); } }],
  ['brak tablicy errors', { json: async () => ({ errors: 'SECRET-BODY' }) }],
  ['niepoprawne pola', { json: async () => ({ errors: [null, { userMessage: { secret: 'SECRET' }, message: 123, path: {} }] }) }],
])('%s zostawia dawny komunikat i metadane', async (_nazwa, body) => {
  const { klient } = klientZ({ ok: false, status: 400, headers: new Headers({ 'Retry-After': '17' }), ...body });
  await expect(propozycje(klient)).rejects.toMatchObject({ status: 400, retryAfterS: 17, message: poczatek });
});

it('rozpoznawanie HTTP 400 faktur nadal działa po dodaniu opisu', async () => {
  const { klient } = klientZ({ ok: false, status: 400, json: async () => ({ errors: [validation] }) });
  await expect(klient.pobierzFakturyZamowienia('order-055')).resolves.toEqual([]);
});
