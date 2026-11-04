import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createInfaktClient, METODY_INFAKTU } from '../../src/oms/infakt/client.js';

const odmowa = JSON.parse(readFileSync(new URL('../dane/prz147-korekta-422.json', import.meta.url), 'utf8'));
const odpowiedz = (status, dane) => ({ ok: status < 400, status, json: async () => dane });
const klient = (dane, status = 200) => createInfaktClient({ apiKey: 'fikcyjny', fetchImpl: vi.fn(async () => odpowiedz(status, dane)) });

describe('status zlecenia korekty PRZ-147', () => {
  it('PRZ-148: odpowiedź 422 sale_type ma polską nazwę pola', async () => {
    expect(await klient({ processing_code: 422, invoice_errors: {
      sale_type: ['Proszę określić rodzaj sprzedaży.'],
    } }).statusKorekty('REF-WDT')).toEqual({ stan: 'odrzucona', uuid: null, bledy: [
      { pole: 'rodzaj sprzedaży', komunikaty: ['Proszę określić rodzaj sprzedaży.'] },
    ] });
  });
  it('422 z zapisanej odpowiedzi daje odrzucenie i polskie pola', async () => {
    expect(await klient(odmowa).statusKorekty('REF-TEST')).toEqual({ stan: 'odrzucona', uuid: null, bledy: [
      { pole: 'klient', komunikaty: ['Proszę wybrać klienta.'] },
      { pole: 'powód korekty', komunikaty: ['Proszę podać powód korekty.'] },
    ] });
  });
  it.each([200, 201])('%s z uuid oznacza wystawioną', async (processing_code) => {
    expect(await klient({ processing_code, invoice_uuid: 'kor-test' }).statusKorekty('REF')).toEqual({ stan: 'wystawiona', uuid: 'kor-test', bledy: [] });
  });
  it.each([100, 120, 140])('%s oznacza w toku', async (processing_code) => {
    expect((await klient({ processing_code }).statusKorekty('REF')).stan).toBe('w_toku');
  });
  it.each([500, 999, 201, 400])('%s bez dowodu wyniku oznacza nieznany', async (processing_code) => {
    expect((await klient({ processing_code }).statusKorekty('REF')).stan).toBe('nieznany');
  });
  it('422 bez szczegółów jest pewną odmową', async () => {
    expect((await klient({ processing_code: 422 }).statusKorekty('REF')).stan).toBe('odrzucona');
  });
  it('inne 4xx wymaga niepustych błędów; tłumaczy wszystkie znane pola', async () => {
    const invoice_errors = Object.fromEntries(['services', 'corrected_invoice_number', 'corrected_invoice_date', 'base', 'nowe_pole'].map((p) => [p, ['Błąd.']]));
    const status = await klient({ processing_code: 400, invoice_errors }).statusKorekty('REF');
    expect(status.stan).toBe('odrzucona');
    expect(status.bledy.map((b) => b.pole)).toEqual(['pozycje', 'numer faktury korygowanej', 'data faktury korygowanej', 'dokument', 'nowe_pole']);
    expect((await klient({ processing_code: 400, invoice_errors: { base: [] } }).statusKorekty('REF')).stan).toBe('nieznany');
  });
  it('HTTP 404 daje nieznany, inne błędy HTTP rzucają', async () => {
    expect((await klient({}, 404).statusKorekty('REF')).stan).toBe('nieznany');
    await expect(klient({}, 500).statusKorekty('REF')).rejects.toMatchObject({ status: 500 });
  });
  it('błąd sieci pozostaje wyjątkiem', async () => {
    const p = createInfaktClient({ apiKey: 'fikcyjny', fetchImpl: async () => { throw new Error('brak sieci'); } });
    await expect(p.statusKorekty('REF')).rejects.toThrow('brak sieci');
  });
  it('GET ma dokładną ścieżkę z zakodowaną referencją; pusta nie pyta API', async () => {
    const fetchImpl = vi.fn(async () => odpowiedz(200, { processing_code: 100 }));
    const p = createInfaktClient({ apiKey: 'fikcyjny', fetchImpl });
    expect((await p.statusKorekty('')).stan).toBe('nieznany');
    expect(fetchImpl).not.toHaveBeenCalled();
    await p.statusKorekty('REF /?#ą');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.infakt.pl/api/v3/async/corrective_invoices/status/REF%20%2F%3F%23%C4%85.json');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
    expect(METODY_INFAKTU).toContain('statusKorekty');
    expect(METODY_INFAKTU).toHaveLength(16);
  });
});
