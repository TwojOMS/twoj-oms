import { describe, expect, it } from 'vitest';
import { ocenKandydata, wspolneTerminy, podjazdPoTerminie, diagnozaTerminow } from '../../src/domena/podjazdy.js';

const paczka = {
  id: 7, kurier: 'allegro_wza', status: 'nadana', etykieta_zpl_sciezka: '/labels/7.zpl',
  sklep: 'allegro_szkicownia', id_przesylki_kuriera: 'shipment-7', przejeta_at: null,
};
const meta = { id: 'shipment-7', deliveryMethodId: 'method-1', pickupAvailable: true, transport: ['DPD'] };

describe('kwalifikacja do podjazdu WzA', () => {
  it('dopuszcza tylko paczkę WzA z gotową etykietą i potwierdzonym ID zasobu', () => {
    expect(ocenKandydata({ przesylka: paczka, metaWza: meta, aktywneZlecenie: null })).toEqual({
      wolno: true, powod: null, grupa: 'allegro_szkicownia|method-1',
    });
    for (const zmiana of [
      { kurier: 'dpd' }, { etykieta_zpl_sciezka: null }, { przejeta_at: '2026-09-22T10:00:00Z' },
      { id_przesylki_kuriera: null },
    ]) {
      expect(ocenKandydata({ przesylka: { ...paczka, ...zmiana }, metaWza: meta }).wolno).toBe(false);
    }
  });

  it('nie dopuszcza braku pickupAvailable, innego ID ani aktywnego zlecenia', () => {
    for (const metaWza of [{ ...meta, pickupAvailable: false }, { ...meta, id: 'other' }]) {
      expect(ocenKandydata({ przesylka: paczka, metaWza }).wolno).toBe(false);
    }
    expect(ocenKandydata({ przesylka: paczka, metaWza: meta, aktywneZlecenie: { id: 5 } }).wolno).toBe(false);
  });
});

it('miniony przedział w Warszawie nie udaje nadal aktualnego podjazdu', () => {
  const termin = { date: '2026-09-22', minTime: '08:00', maxTime: '12:00' };
  expect(podjazdPoTerminie(termin, '2026-09-22T11:00:00Z')).toBe(true); // 13:00 w Warszawie
  expect(podjazdPoTerminie(termin, '2026-09-22T09:00:00Z')).toBe(false);
});

describe('wspólny termin', () => {
  const rano = { date: '2026-09-23', minTime: '08:00', maxTime: '12:00' };
  const popoludnie = { date: '2026-09-23', minTime: '12:00', maxTime: '16:00' };
  it('bierze tylko identyczną ofertę dostępną każdej paczce', () => {
    expect(wspolneTerminy([
      { shipmentId: 'a', pickupTimes: [rano, popoludnie] },
      { shipmentId: 'b', pickupTimes: [popoludnie] },
    ])).toEqual([popoludnie]);
  });
  it('brak oferty jednej paczki blokuje grupę', () => {
    expect(wspolneTerminy([
      { shipmentId: 'a', pickupTimes: [rano] },
      { shipmentId: 'b', pickupTimes: [] },
    ])).toEqual([]);
  });
});

describe('diagnoza braku wspólnego terminu', () => {
  const rano = { date: '2026-09-30', minTime: '08:00', maxTime: '12:00' };
  const popoludnie = { date: '2026-09-30', minTime: '12:00', maxTime: '16:00' };
  it('osobne elementy odpowiedzi z różnymi terminami opisuje jako różne okna', () => {
    const d = diagnozaTerminow([
      { proposals: [{ shipmentId: 'a', pickupTimes: [rano] }] },
      { proposals: [{ shipmentId: 'b', pickupTimes: [popoludnie] }] },
    ], ['a', 'b']);
    expect(d.przyczyna).toBe('rozne-okna');
    expect(d.grupAllegro).toBe(2);
    expect(d.paczki).toEqual([
      { shipmentId: 'a', grupaAllegro: 1, terminy: [rano] },
      { shipmentId: 'b', grupaAllegro: 2, terminy: [popoludnie] },
    ]);
  });
  it('wskazuje paczkę bez terminu i paczkę pominiętą w odpowiedzi', () => {
    expect(diagnozaTerminow([{ proposals: [
      { shipmentId: 'a', pickupTimes: [rano] }, { shipmentId: 'b', pickupTimes: [] },
    ] }], ['a', 'b']).przyczyna).toBe('paczka-bez-terminu');
    const d = diagnozaTerminow([{ proposals: [{ shipmentId: 'a', pickupTimes: [rano] }] }], ['a', 'b']);
    expect(d.przyczyna).toBe('paczka-bez-terminu');
    expect(d.paczki[1]).toEqual({ shipmentId: 'b', grupaAllegro: null, terminy: [] });
  });
  it('odróżnia różne okna od pustej odpowiedzi', () => {
    expect(diagnozaTerminow([{ proposals: [
      { shipmentId: 'a', pickupTimes: [rano] }, { shipmentId: 'b', pickupTimes: [popoludnie] },
    ] }], ['a', 'b']).przyczyna).toBe('rozne-okna');
    expect(diagnozaTerminow([], ['a']).przyczyna).toBe('pusta-odpowiedz');
  });
  it('wskazuje różny adres lub powtórzoną paczkę jako przyczynę blokady', () => {
    const adres = { street: 'Polna 1' };
    const grupa = { proposals: [{ shipmentId: 'a', pickupTimes: [rano] }, { shipmentId: 'b', pickupTimes: [rano] }], address: { street: 'Inna 2' } };
    expect(diagnozaTerminow([grupa], ['a', 'b'], adres).przyczyna).toBe('niezgodny-adres');
    expect(diagnozaTerminow([{ ...grupa, proposals: [...grupa.proposals, grupa.proposals[0]] }], ['a', 'b'], adres).przyczyna).toBe('niezgodny-zestaw');
  });
});
