import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInfaktClient } from '../../src/oms/infakt/client.js';
import { createVies } from '../../src/oms/services/vies.js';

// Wyłącznie syntetyczne identyfikatory, bez połączeń z API.
const nip = '9876543210';
const vat = '123987456';
const sprzedawca = '0123456789';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('PRZ-042 — rzeczywista diagnostyka HTTP integracji', () => {
  it.each(['odpowiedz', 'siec'])('inFakt %s: logi i błąd operatora ukrywają nip_eq także odbity w treści', async rodzaj => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async adres => {
      if (rodzaj === 'siec') throw new Error(`ECONNRESET dla ${nip}: ${adres}`, { cause: { code: 'ECONNRESET', message: nip } });
      return new Response(JSON.stringify({ errors: { nip: [`Nieprawidłowy filtr ${nip}, adres ${adres}`] } }), { status: 422 });
    });
    vi.stubGlobal('fetch', fetch);
    const blad = await createInfaktClient({ apiKey: 'klucz-syntetyczny' }).znajdzKlientaPoNip(nip).catch(e => e);
    // Komunikat klienta jest przeznaczony dla operatora i może być logowany przez wołającego.
    console.warn(blad.message);
    expect(blad).toBeInstanceOf(Error);
    expect(blad.dlaOperatora).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://api.infakt.pl/api/v3/clients.json?q%5Bnip_eq%5D=${nip}`);
    expect(log.mock.calls).toHaveLength(2);
    for (const [komunikat] of log.mock.calls) {
      expect(komunikat).not.toContain(nip);
      expect(komunikat).not.toContain('klucz-syntetyczny');
    }
    expect(log.mock.calls[0][0]).toContain('HTTP GET https://api.infakt.pl/api/v3/clients.json');
    expect(log.mock.calls[0][0]).toContain(rodzaj === 'siec' ? 'błąd sieci' : 'status 422');
    expect(blad.message).toContain(rodzaj === 'siec' ? 'inFakt nieosiągalny' : 'inFakt odrzucił wyszukanie klienta (422): Nieprawidłowy filtr');
  });

  it.each(['odpowiedz', 'siec'])('VIES %s: wszystkie logi bez VAT kontrahenta i NIP sprzedawcy', async rodzaj => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(async adres => {
      if (rodzaj === 'siec') throw new Error(`Błąd DE${vat}, ${sprzedawca}, ${adres}`);
      return new Response(JSON.stringify({ message: `Błąd DE${vat}, ${sprzedawca}, ${adres}` }), { status: 503 });
    });
    vi.stubGlobal('fetch', fetch);
    const wynik = await createVies({ nipSprzedawcy: sprzedawca }).sprawdz(`DE${vat}`);
    expect(wynik.wynik).toBe('niedostepny');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/DE/vat/${vat}?requesterMemberStateCode=PL&requesterNumber=${sprzedawca}`);
    expect(log.mock.calls).toHaveLength(1);
    for (const [komunikat] of log.mock.calls) {
      expect(komunikat).not.toContain(vat);
      expect(komunikat).not.toContain(sprzedawca);
      expect(komunikat).toContain('HTTP GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/DE/vat/');
      expect(komunikat).toContain(rodzaj === 'siec' ? 'błąd sieci' : 'status 503');
    }
  });
});
