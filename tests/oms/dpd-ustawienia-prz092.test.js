// PRZ-092 — dwie rzeczy klienta DPD potrzebne formularzowi w Ustawieniach:
//   1) typ etykiety: „10×15” (LBL_PRINTER, jak dotąd) albo „A4” — dotyczy WYŁĄCZNIE PDF-a;
//      ZPL dla Zebry zostaje w LBL_PRINTER, bo innego formatu Zebra nie wydrukuje;
//   2) sprawdzPolaczenie() — jedno żądanie bez skutków (findPostalCodeV1), które odpowiada
//      „dane logowania przyjęte / odrzucone”, zanim klient nada pierwszą płatną paczkę.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDpdClient } from '../../src/oms/kurierzy/dpd.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const LOGIN = '99999999';
const HASLO = 'SEKRETNE-HASLO';
const FID = '278216';
const nadawca = { nazwa: 'Pracownia Testowa', ulica: 'Zmyślona 1', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' };
const zamowienie = {
  numer: '501', kwota_brutto: '100.00', kwota_pobrania: null,
  dostawa: { first_name: 'Anna', last_name: 'Nowak', address_1: 'Polna 1', postcode: '00-001', city: 'Warszawa', country: 'PL' },
  klient: { email: 'a@example.invalid', phone: '+48500600700' },
};
const paczka = { waga: 1, dlugosc: 40, szerokosc: 30, wysokosc: 10 };

function klient(odpowiedzi, override = {}) {
  const fetchImpl = vi.fn();
  odpowiedzi.forEach((o) => (o instanceof Error ? fetchImpl.mockRejectedValueOnce(o) : fetchImpl.mockResolvedValueOnce(o)));
  return { c: createDpdClient({ url: 'https://dpd/api', login: LOGIN, haslo: HASLO, fid: FID, nadawca, fetchImpl, ...override }), fetchImpl };
}
const OK = () => [odp(200, fixture('v10-ok.xml')), odp(200, fixture('v4-ok.xml')), odp(200, fixture('v4-ok-zpl.xml'))];
const formatStrony = (cialo) => /<outputDocPageFormatV1>([^<]+)</.exec(cialo)?.[1];

describe('typ etykiety', () => {
  it('A4: PDF na kartce A4, ZPL dalej w formacie etykiety', async () => {
    const { c, fetchImpl } = klient(OK(), { formatEtykiety: 'A4' });
    await c.nadaj({ zamowienie, paczka });
    expect(formatStrony(fetchImpl.mock.calls[1][1].body)).toBe('A4');
    expect(fetchImpl.mock.calls[2][1].body).toContain('<outputDocFormatV1>ZPL</outputDocFormatV1>');
    expect(formatStrony(fetchImpl.mock.calls[2][1].body)).toBe('LBL_PRINTER');
  });

  it('bez ustawienia zostaje 10×15 (LBL_PRINTER) — instalacje z .env nie widzą zmiany', async () => {
    const { c, fetchImpl } = klient(OK());
    await c.nadaj({ zamowienie, paczka });
    expect(formatStrony(fetchImpl.mock.calls[1][1].body)).toBe('LBL_PRINTER');
  });

  it('nieznany typ etykiety odmawia przy budowie klienta, nie przy pierwszej paczce', () => {
    expect(() => klient([], { formatEtykiety: 'A6' })).toThrow('formatEtykiety');
  });
});

const ODP_KOD_OK = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
  + '<ns2:findPostalCodeV1Response xmlns:ns2="http://dpdservices.dpd.com.pl/"><return><status>OK</status></return>'
  + '</ns2:findPostalCodeV1Response></soap:Body></soap:Envelope>';
// Kształt błędu logowania z produkcji (komentarz przy oczysc() w dpd.js): faultstring niesie login.
const ODP_ZLY_LOGIN = `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
  + `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Login failed for login: ${LOGIN} (masterFid ${FID})</faultstring></soap:Fault>`
  + '</soap:Body></soap:Envelope>';

describe('sprawdzPolaczenie', () => {
  it('pyta wyłącznie findPostalCodeV1 kodem nadawcy — bez numeru listu, bez etykiety', async () => {
    const { c, fetchImpl } = klient([odp(200, ODP_KOD_OK)]);
    await expect(c.sprawdzPolaczenie()).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cialo = fetchImpl.mock.calls[0][1].body;
    expect(cialo).toContain('<dpd:findPostalCodeV1>');
    expect(cialo).toContain('<zipCode>00950</zipCode>');
    expect(cialo).toContain(`<masterFid>${FID}</masterFid>`);
    expect(cialo).not.toMatch(/generatePackagesNumbers|generateSpedLabels|generateProtocol/);
  });

  it('odrzucone logowanie: czytelny błąd bez loginu, hasła i FID-u', async () => {
    const { c } = klient([odp(500, ODP_ZLY_LOGIN)]);
    const e = await c.sprawdzPolaczenie().catch((x) => x);
    expect(e.dlaOperatora).toBe(true);
    expect(e.message).toContain('DPD odrzuciło żądanie');
    for (const sekret of [LOGIN, HASLO, FID]) expect(e.message).not.toContain(sekret);
  });

  it('brak sieci: „DPD nieosiągalne”, nie sukces', async () => {
    const { c } = klient([new Error('getaddrinfo ENOTFOUND dpd')]);
    await expect(c.sprawdzPolaczenie()).rejects.toThrow('DPD nieosiągalne');
  });

  it('HTTP 200 bez <return> (np. strona błędu pośrednika) nie jest sukcesem', async () => {
    const { c } = klient([odp(200, '<html>Brama</html>')]);
    await expect(c.sprawdzPolaczenie()).rejects.toThrow('nie rozpoznaję');
  });
});
