import { describe, it, expect, vi } from 'vitest';
import { createInfaktClient } from '../../src/oms/infakt/client.js';
import * as klientInfaktu from '../../src/oms/infakt/client.js';
import { readFileSync } from 'node:fs';

const zapisana422 = JSON.parse(readFileSync(new URL('../dane/prz147-korekta-422.json', import.meta.url), 'utf8'));
const klient = {
  client_id: 14701, client_company_name: 'Pracownia Półcień',
  client_first_name: 'Jan', client_last_name: 'Przykładowy',
  client_street: 'Testowa', client_street_number: '7', client_flat_number: '2',
  client_city: 'Przykładowo', client_post_code: '00-001',
  client_tax_code: '1111111111', client_country: 'PL',
};

const odpowiedz = (status, cialo) => ({
  ok: status < 400, status,
  json: async () => cialo,
  arrayBuffer: async () => Buffer.from(JSON.stringify(cialo)),
  text: async () => JSON.stringify(cialo),
});

describe('wystawienie korekty', () => {
  it.each(['mistake', 'other', 'zwrot towaru', '', undefined])('dobiera symbol powodu: %s', (powod) => {
    expect(klientInfaktu.symbolPowoduKorekty(powod)).toBe(powod === 'mistake' ? 'mistake' : 'other');
  });

  it('odczytuje nabywcę faktury bez utraty pól klienta', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz(200, { ...klient, uuid: 'fv-prz147' }));
    const infakt = createInfaktClient({ apiKey: 'k', fetchImpl });
    expect(await infakt.pobierzFakture('fv-prz147')).toMatchObject(klient);
  });

  it('wysyła kopertę corrective_invoice i uzupełnia pola z zapisanej odmowy 422', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(odpowiedz(201, { invoice_task_reference_number: 'REF-PRZ147' }));
    const infakt = createInfaktClient({ apiKey: 'k', fetchImpl });
    const payload = {
      client_id: klient.client_id, correction_reason: 'zwrot towaru',
      corrected_invoice_number: 'FV-PRZYKLAD-147',
      services: [
        { name: 'Lampa', group: 1, correction: false, quantity: 2, gross_price: 20000 },
        { name: 'Lampa', group: 1, correction: true, quantity: 1, gross_price: 10000 },
      ],
    };
    await infakt.wystawKorekte(payload);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(Object.keys(body)).toEqual(['corrective_invoice']);
    expect(body.corrective_invoice).toEqual({ ...payload, correction_reason: 'other' });
    for (const pole of Object.keys(zapisana422.invoice_errors)) {
      expect(body.corrective_invoice).toHaveProperty(pole);
      if (pole === 'correction_reason') expect(['mistake', 'other']).toContain(body.corrective_invoice[pole]);
      else expect(body.corrective_invoice[pole]).toBeTruthy();
    }
    expect(payload.correction_reason).toBe('zwrot towaru');
  });

  // ⚠️ 201 to PRZYJECIE ZLECENIA, nie dokument — zmierzone pustym cialem na zywym koncie
  // (notatka 2026-08-14-oms-zwroty-pomiar.md). Ten test pilnuje, ze klient NIE zmysla numeru.
  it('idzie na zasob ASYNCHRONICZNY i oddaje referencje zadania, NIE numer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odpowiedz(201, { invoice_task_reference_number: 'REF-1', processing_code: 100 }),
    );
    const infakt = createInfaktClient({ apiKey: 'k', fetchImpl });
    const wynik = await infakt.wystawKorekte({ corrected_invoice_number: 'FV 1/08/2026' });
    const [url, opcje] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.infakt.pl/api/v3/async/corrective_invoices.json');
    expect(opcje.method).toBe('POST');
    expect(wynik.referencja).toBe('REF-1');
    expect(wynik.numer).toBeNull();
  });

  it('odmowa inFaktu zamienia sie w blad DLA OPERATORA, z trescia powodu', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      odpowiedz(422, { errors: { correction_reason: ['nie może być puste'] } }),
    );
    const infakt = createInfaktClient({ apiKey: 'k', fetchImpl });
    await expect(infakt.wystawKorekte({})).rejects.toMatchObject({ dlaOperatora: true });
  });
});
