import { describe, expect, it } from 'vitest';
import { dowodPrzejecia } from '../../src/domena/przejecie-przesylki.js';

describe('dowód fizycznego przejęcia', () => {
  it('nie myli rejestracji ani nieznanego kodu z ruchem', () => {
    for (const code of ['PENDING', 'UNKNOWN_FROM_API']) {
      expect(dowodPrzejecia({ zrodlo: 'allegro', zdarzenia: [{ code, occurredAt: '2026-09-22T08:00:00Z' }] })).toBeNull();
    }
  });
  it('rozpoznaje znany ruch nawet gdy najnowszy kod jest nieznany', () => {
    expect(dowodPrzejecia({ zrodlo: 'allegro', zdarzenia: [
      { code: 'IN_TRANSIT', occurredAt: '2026-09-22T08:00:00Z' },
      { code: 'NEW_FROM_API', occurredAt: '2026-09-22T09:00:00Z' },
    ] })).toEqual({ zrodlo: 'allegro', kod: 'IN_TRANSIT', zdarzenieAt: '2026-09-22T08:00:00Z' });
  });
  it('DPD rozróżnia rejestrację od fizycznego przyjęcia w oddziale', () => {
    expect(dowodPrzejecia({ zrodlo: 'dpd', zdarzenia: [
      { opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', at: '2026-09-22T08:00:00.000' },
    ] })).toBeNull();
    expect(dowodPrzejecia({ zrodlo: 'dpd', zdarzenia: [
      { opis: 'Zarejestrowano dane przesyłki, przesyłka jeszcze nie nadana', at: '2026-09-22T08:00:00.000' },
      { opis: 'Przyjęcie przesyłki w oddziale DPD', at: '2026-09-22T12:00:00.000' },
    ] })).toEqual({ zrodlo: 'dpd', kod: 'PRZYJECIE_W_ODDZIALE', zdarzenieAt: '2026-09-22T12:00:00.000' });
  });
});
