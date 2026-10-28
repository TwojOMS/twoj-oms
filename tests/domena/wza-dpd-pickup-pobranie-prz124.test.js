import { describe, it, expect } from 'vitest';
import { METODY_WZA, wolnoNadacZOms, pobranieDoWysylki } from '../../src/domena/allegro-wysylka.js';
import { parsujGabarytAllegro, profilGabarytuAllegro, sprawdzLimityGabarytuAllegro } from '../../src/domena/gabaryty-allegro.js';

// PRZ-124 (zgloszenie właściciela 28.10.2026, zamowienie #1508): „Allegro Odbior w Punkcie DPD Pickup
// pobranie (AD)" odbijalo sie o biala liste WzA komunikatem o InPoscie — a to nie InPost.
//
// Zmierzone 28.10.2026 na koncie `allegro_szkicownia`:
//  - `GET /shipment-management/delivery-services` (310 uslug: 304 ALLEGRO, 6 CLIENT):
//    owner: ALLEGRO, carrierId: ALLEGRO, credentialsId: null,
//    cashOnDelivery: {limit: 6000, currency: PLN, paymentType: WALLET_TRANSFER, forceRequireIban: false}
//  - `GET /shipment-management/delivery-proposals/<#1508>`: receiver.point = punkt_odbioru zamowienia,
//    cashOnDelivery.amount = kwota zamowienia, deliveryType PUDO, PACKAGE 64 × 38 × 41 cm, 20 kg.
const DPD_PICKUP_POBRANIE = '16af1169-db74-4e94-a16d-f2c599280e3c';

const zamowienie = { sklep: 'allegro_szkicownia', anulowane: 0, metoda_wysylki: 'allegro_inne', kwota_pobrania: '83.29' };

const LIMITY_1508 = [{ deliveryType: 'PUDO', paymentType: 'POSTPAID', packageType: 'PACKAGE', limits: {
  cashOnDelivery: { amount: '6000', currency: 'PLN' },
  dimensions: {
    length: { value: 64, unit: 'CENTIMETER' },
    width: { value: 38, unit: 'CENTIMETER' },
    height: { value: 41, unit: 'CENTIMETER' },
  },
  weight: { value: 20, unit: 'KILOGRAMS' },
} }];

describe('PRZ-124: DPD Pickup pobranie (AD) przez „Wysyłam z Allegro”', () => {
  it('wolno nadać i jest oznaczona jako POBRANIOWA bez wymogu konta', () => {
    const w = wolnoNadacZOms(zamowienie, { deliveryMethodIdZywy: DPD_PICKUP_POBRANIE });
    expect(w.wolno, w.powod).toBe(true);
    expect(w.pobranie).toBe(true);
    expect(w.wymagaKonta).toBe(false);
    expect(METODY_WZA[DPD_PICKUP_POBRANIE].nazwa).toBe('Allegro Odbiór w Punkcie DPD Pickup pobranie (AD)');
  });

  it('pobranie idzie kwotą z podpowiedzi Allegro, bez naszego rachunku', () => {
    const w = wolnoNadacZOms(zamowienie, { deliveryMethodIdZywy: DPD_PICKUP_POBRANIE });
    const p = pobranieDoWysylki({
      pobranieUslugi: w.pobranie, wymaganeKonto: w.wymagaKonta, limit: 6000,
      cashOnDelivery: { amount: '83.29', currency: 'PLN', ownerName: null, iban: null },
    });
    expect(p).toEqual({ wolno: true, cashOnDelivery: { amount: '83.29', currency: 'PLN' } });
    // bez kwoty usługa pobraniowa NIE przechodzi — towar nie pojedzie za darmo
    expect(pobranieDoWysylki({ pobranieUslugi: w.pobranie, cashOnDelivery: null }).wolno).toBe(false);
  });

  it('ma profil gabarytu punktu: 64 × 38 cm, a L mieści się w żywym limicie z #1508', () => {
    expect(profilGabarytuAllegro(DPD_PICKUP_POBRANIE)?.dlugosc).toBe(64);
    const { paczka } = parsujGabarytAllegro({ gabaryt: 'L', waga: '1' }, DPD_PICKUP_POBRANIE);
    expect(paczka).toMatchObject({ dlugosc: 64, szerokosc: 38, wysokosc: 41 });
    expect(sprawdzLimityGabarytuAllegro(paczka, LIMITY_1508)).toEqual({ paczka });
  });
});

describe('PRZ-124: odmowa nazywa prawdziwą przyczynę', () => {
  it('usługa InPostu dalej odmawia z wyjaśnieniem o własnej umowie', () => {
    const w = wolnoNadacZOms(zamowienie, { deliveryMethodIdZywy: '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93' });
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/InPost/);
    expect(w.powod).toMatch(/własnej umowie/i);
  });

  it('nieznana usługa spoza InPostu NIE jest zrzucana na InPost', () => {
    const w = wolnoNadacZOms(zamowienie, { deliveryMethodIdZywy: 'ffffffff-0000-0000-0000-000000000000' });
    expect(w.wolno).toBe(false);
    expect(w.powod).not.toMatch(/własnej umowie/i);
    expect(w.powod).toMatch(/nie zna jeszcze/i);
    expect(w.powod).toContain('ffffffff-0000-0000-0000-000000000000');
  });
});
