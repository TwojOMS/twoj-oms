import { describe, it, expect } from 'vitest';
import { METODY_WZA, wolnoNadacZOms } from '../../src/domena/allegro-wysylka.js';

// Identyfikatory zmierzone 10.08.2026 na zywym koncie (`GET /shipment-management/delivery-services`),
// notatka docs/superpowers/notatki/2026-08-10-allegro-wysylka-rozpoznanie.md.
const DPD = '03f26351-f683-4db2-8895-f2c599280e3c'; // owner: ALLEGRO
const DPD_POBRANIE = '13f26351-26fb-48d4-b5dd-f2c599280e3c'; // owner: ALLEGRO
const PACZKOMAT_INPOST = '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93'; // owner: CLIENT
const KURIER24_INPOST = '5d9c7838-e05f-4dec-afdd-58e884170ba7'; // owner: CLIENT

const zamowienie = (n = {}) => ({
  sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd', anulowane: 0, ...n,
});

describe('co wolno nadac z OMS-u przez Wysylam z Allegro', () => {
  it('pozwala na Allegro Kurier DPD (AD) — usluge na umowie Allegro', () => {
    const w = wolnoNadacZOms(zamowienie(), { deliveryMethodIdZywy: DPD });
    expect(w.wolno).toBe(true);
    expect(w.deliveryMethodId).toBe(DPD);
  });

  // ⚠️ NAJWAZNIEJSZY TEST W TYM PLIKU. `owner: CLIENT` znaczy, ze Allegro wystawiloby
  // przewoz NA NASZEJ umowie InPostu — czyli drugi, platny przewoz do klienta, ktory
  // swoj ma juz oplacony w cenie dostawy.
  it.each([
    ['paczkomat', 'allegro_paczkomat', PACZKOMAT_INPOST],
    ['kurier24', 'allegro_inne', KURIER24_INPOST],
  ])('ODMAWIA metody InPostu (%s) — ona idzie na NASZEJ umowie, nie Allegro', (_opis, metoda, id) => {
    const w = wolnoNadacZOms(zamowienie({ metoda_wysylki: metoda }), { deliveryMethodIdZywy: id });
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/własnej umowie/i);
  });

  it('ODMAWIA metody, ktorej nie znamy — milczenie nie jest zgoda', () => {
    const w = wolnoNadacZOms(zamowienie(), { deliveryMethodIdZywy: 'ffffffff-0000-0000-0000-000000000000' });
    expect(w.wolno).toBe(false);
    expect(w.powod).toBeTruthy();
  });

  // ⚠️ Allegro NIE PODBIJA `updatedAt` przy zmianach (zmierzone 05.08.2026), wiec kopia
  // lokalna bywa nieswieza z definicji. Brak zywego odczytu = decyzja na danych sprzed doby.
  it.each([
    ['bez pola', {}],
    ['null', { deliveryMethodIdZywy: null }],
    ['pusty napis', { deliveryMethodIdZywy: '' }],
  ])('ODMAWIA, gdy nie znamy zywej metody (%s) — nie zgaduje z kolumny', (_opis, opcje) => {
    const w = wolnoNadacZOms(zamowienie(), opcje);
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/nie odczytał|nie odczytal/i);
  });

  it('ODMAWIA poza kanalem Allegro — nawet gdy identyfikator pasuje', () => {
    const w = wolnoNadacZOms(zamowienie({ sklep: 'pro' }), { deliveryMethodIdZywy: DPD });
    expect(w.wolno).toBe(false);
  });

  it('ODMAWIA zamowienia anulowanego', () => {
    const w = wolnoNadacZOms(zamowienie({ anulowane: 1 }), { deliveryMethodIdZywy: DPD });
    expect(w.wolno).toBe(false);
  });

  it('ODMAWIA, gdy zamowienia nie ma w ogole', () => {
    expect(wolnoNadacZOms(null, { deliveryMethodIdZywy: DPD }).wolno).toBe(false);
  });

  // ⚠️ 11.08.2026 (Zadanie 6): pobranie WESZLO, wiec odmowa z Partii 1 znika. Ta funkcja
  // przestaje o pobraniu rozstrzygac, ale MUSI je NAZWAC — cala regula pieniedzy
  // (`pobranieDoWysylki`) wisi na tej fladze, a jej brak znaczylby paczke pobraniowa
  // wyslana jak przedplacona.
  it('pozwala na pobranie i OZNACZA je jako pobraniowe', () => {
    const w = wolnoNadacZOms(zamowienie(), { deliveryMethodIdZywy: DPD_POBRANIE });
    expect(w.wolno).toBe(true);
    expect(w.pobranie).toBe(true);
  });

  it('usługę przedpłaconą oznacza jako NIE-pobraniową', () => {
    expect(wolnoNadacZOms(zamowienie(), { deliveryMethodIdZywy: DPD }).pobranie).toBe(false);
  });

  // ⚠️ WYLICZENIE JAWNE, a nie „ile wpisow" — kazde dolozenie uslugi ma wymagac SWIADOMEJ
  // zmiany tego testu. Osiem pozycji doszlo 18.09.2026; identyfikatory pochodza z pomiaru
  // (`delivery.method.id` surowych zamowien × `GET /shipment-management/delivery-services`),
  // nie z dopasowania po nazwie — w katalogu „Allegro Kurier DPD" daje CZTERY trafienia.
  it('mapa zawiera DOKLADNIE uslugi o owner=ALLEGRO — i ani jednej InPostowej', () => {
    expect(Object.keys(METODY_WZA).sort()).toEqual([
      DPD,
      DPD_POBRANIE,
      '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483', // Allegro One Box, One Kurier
      '0d83955a-4297-4169-adef-9790d53b11ff', // Allegro One Kurier - dostawa jutro
      '09164667-daa5-42dc-8087-33d7485790ac', // Allegro Automat ORLEN Paczka
      '09bcdcdb-c62a-41c4-ba42-f2c599280e3c', // Allegro Automaty Paczkowe DPD (AD)
      '0960fef9-cc88-4558-b2b2-62331a20b5b2', // Allegro Kurier DHL (AD)
      '0fe5b4af-9f09-443d-9d49-62331a20b5b2', // Allegro Automat DHL BOX 24/7 (AD)
      '0560b75e-88c3-4b79-bcf7-62331a20b5b2', // Allegro Odbiór w Punkcie DHL (AD)
      '0b257488-c85d-4507-b967-9b45ffbfa2e8', // Allegro One Box, DPD
      '16af1169-db74-4e94-a16d-f2c599280e3c', // Allegro Odbiór w Punkcie DPD Pickup pobranie (AD) — PRZ-124, zam. #1508
    ].sort());
    expect(METODY_WZA[PACZKOMAT_INPOST]).toBeUndefined();
    expect(METODY_WZA[KURIER24_INPOST]).toBeUndefined();
  });

  it('kazdy wpis mapy mowi, czy to pobranie — bo od tego zalezy odmowa', () => {
    expect(METODY_WZA[DPD].pobranie).toBe(false);
    expect(METODY_WZA[DPD_POBRANIE].pobranie).toBe(true);
  });

  // Powod jedzie na ekran do czlowieka (niezmiennik 4.9: stan bez wyjscia nie istnieje,
  // a „nie wolno" bez powodu jest dokladnie takim stanem).
  it('kazda odmowa niesie powod po polsku, nie sam falsz', () => {
    const odmowy = [
      wolnoNadacZOms(zamowienie({ sklep: 'pro' }), { deliveryMethodIdZywy: DPD }),
      wolnoNadacZOms(zamowienie({ anulowane: 1 }), { deliveryMethodIdZywy: DPD }),
      wolnoNadacZOms(zamowienie(), { deliveryMethodIdZywy: PACZKOMAT_INPOST }),
      wolnoNadacZOms(zamowienie(), {}),
    ];
    for (const o of odmowy) {
      expect(o.wolno).toBe(false);
      expect(typeof o.powod).toBe('string');
      expect(o.powod.length).toBeGreaterThan(10);
    }
  });

  it('przy odmowie NIE oddaje deliveryMethodId — zeby nikt go stamtad nie wzial', () => {
    const w = wolnoNadacZOms(zamowienie(), { deliveryMethodIdZywy: PACZKOMAT_INPOST });
    expect(w.deliveryMethodId).toBeUndefined();
  });
});
