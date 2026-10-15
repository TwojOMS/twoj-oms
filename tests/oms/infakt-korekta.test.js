import { describe, it, expect, vi } from 'vitest';
import { createInfaktClient } from '../../src/oms/infakt/client.js';

const odpowiedz = (status, cialo) => ({
  ok: status < 400, status,
  json: async () => cialo,
  arrayBuffer: async () => Buffer.from(JSON.stringify(cialo)),
  text: async () => JSON.stringify(cialo),
});

describe('wystawienie korekty', () => {
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
