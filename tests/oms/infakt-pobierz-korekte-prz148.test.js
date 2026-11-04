import { it, expect, vi } from 'vitest';
import { createInfaktClient, METODY_INFAKTU } from '../../src/oms/infakt/client.js';

it('GET jednej korekty koduje uuid i zwraca wiersz dokumentu', async () => {
  const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ uuid: 'kor-a', number: '1/KOR/11/2026',
    corrected_invoice_number: 'FV/1', invoice_date: '2026-11-04', services: [] }) }));
  const p = createInfaktClient({ apiKey: 'fikcyjny', fetchImpl });
  expect(await p.pobierzKorekte('kor /?#ą')).toEqual({ uuid: 'kor-a', number: '1/KOR/11/2026',
    corrected_invoice_number: 'FV/1', invoice_date: '2026-11-04', rodzaj: 'korekta' });
  expect(fetchImpl.mock.calls[0][0]).toBe('https://api.infakt.pl/api/v3/corrective_invoices/kor%20%2F%3F%23%C4%85.json');
  expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  expect(METODY_INFAKTU).toContain('pobierzKorekte');
});

it('brak uuid w odpowiedzi używa uuid zapytania, brak pól pozostaje pusty', async () => {
  const p = createInfaktClient({ apiKey: 'fikcyjny', fetchImpl: async () => ({ ok: true, json: async () => ({ number: 'KOR/1' }) }) });
  expect(await p.pobierzKorekte('kor-a')).toEqual({ uuid: 'kor-a', number: 'KOR/1',
    corrected_invoice_number: undefined, invoice_date: undefined, rodzaj: 'korekta' });
});

it.each([404, 500])('HTTP %s pozostaje wyjątkiem', async (status) => {
  const p = createInfaktClient({ apiKey: 'fikcyjny', fetchImpl: async () => ({ ok: false, status, json: async () => ({}) }) });
  await expect(p.pobierzKorekte('kor-a')).rejects.toMatchObject({ status });
});

it('błąd sieci pozostaje wyjątkiem', async () => {
  const p = createInfaktClient({ apiKey: 'fikcyjny', fetchImpl: async () => { throw new Error('brak sieci'); } });
  await expect(p.pobierzKorekte('kor-a')).rejects.toThrow('brak sieci');
});
