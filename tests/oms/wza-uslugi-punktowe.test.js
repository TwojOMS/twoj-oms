import { describe, it, expect } from 'vitest';
import { METODY_WZA, wolnoNadacZOms } from '../../src/domena/allegro-wysylka.js';
import { kurierzyDoWyboru, metodaNadania, wymagaWyboruKuriera } from '../../src/domena/kurier-nadania.js';
import { wybierzKuriera } from '../../src/oms/kurierzy/index.js';

// OSIEM USLUG ALLEGRO DOPUSZCZONYCH DO „Wysylam z Allegro" (zgloszenie właściciela 18.09.2026:
// „nie da sie nadac orlena i DHL z OMS").
//
// ⚠️⚠️ WSZYSTKIE IDENTYFIKATORY ZMIERZONE, NIE PRZEPISANE. Zrodlo: `delivery.method.id`
// z SUROWYCH zamowien produkcyjnych, zestawione z `GET /shipment-management/delivery-services`
// (18.09.2026, konto `allegro_szkicownia`, 305 uslug: 299 `owner: ALLEGRO`, 6 `owner: CLIENT`).
// Dopasowanie PO NAZWIE jest zawodne i dlatego go nie ma: „Allegro Kurier DPD" daje w katalogu
// CZTERY trafienia, a uslugi DHL z naszych zamowien nie pasuja do katalogu wcale, bo tam
// nazywaja sie z sufiksem „(AD)".
//
// ⛔ INPOST NIE WCHODZI I NIE MA WEJSC — to jedyne uslugi o `owner: CLIENT`, czyli na NASZEJ
// umowie. Dopisanie ich znaczyloby DRUGI, PLATNY przewoz do klienta, ktory swoj ma juz
// oplacony w cenie dostawy.

const ZMIERZONE = {
  '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483': 'Allegro One Box, One Kurier',
  '0d83955a-4297-4169-adef-9790d53b11ff': 'Allegro One Kurier - dostawa jutro',
  '09164667-daa5-42dc-8087-33d7485790ac': 'Allegro Automat ORLEN Paczka',
  '09bcdcdb-c62a-41c4-ba42-f2c599280e3c': 'Allegro Automaty Paczkowe DPD (AD)',
  '0960fef9-cc88-4558-b2b2-62331a20b5b2': 'Allegro Kurier DHL (AD)',
  '0fe5b4af-9f09-443d-9d49-62331a20b5b2': 'Allegro Automat DHL BOX 24/7 (AD)',
  '0560b75e-88c3-4b79-bcf7-62331a20b5b2': 'Allegro Odbiór w Punkcie DHL (AD)',
  '0b257488-c85d-4507-b967-9b45ffbfa2e8': 'Allegro One Box, DPD',
};

// Identyfikatory uslug InPostu — zmierzone tego samego dnia, `owner: CLIENT`.
const INPOST_CUDZA_UMOWA = [
  '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93', // Allegro Paczkomaty InPost
  'b20ef9e1-faa2-4f25-9032-adbea23e5cb9', // Allegro Paczkomaty InPost pobranie
  '5d9c7838-e05f-4dec-afdd-58e884170ba7', // Allegro Kurier24 InPost
];

const zamowienie = (metoda) => ({
  sklep: 'allegro_szkicownia', anulowane: 0, metoda_wysylki: metoda, kwota_pobrania: null,
});

describe('osiem usług punktowych i kurierskich w białej liście WzA', () => {
  for (const [id, nazwa] of Object.entries(ZMIERZONE)) {
    it(`${nazwa} wolno nadać przez WzA`, () => {
      expect(METODY_WZA[id], `brak identyfikatora ${id}`).toBeTruthy();
      const w = wolnoNadacZOms(zamowienie('allegro_punkt'), { deliveryMethodIdZywy: id });
      expect(w.wolno, w.powod).toBe(true);
    });
  }

  it('żadna z ośmiu nie jest usługą pobraniową — katalog Allegro mówi „bez pobrania"', () => {
    for (const id of Object.keys(ZMIERZONE)) {
      expect(METODY_WZA[id].pobranie, `${METODY_WZA[id].nazwa} oznaczona jako pobraniowa`).toBe(false);
    }
  });

  it('żadna nie wymaga konta do rozliczenia pobrania', () => {
    for (const id of Object.keys(ZMIERZONE)) {
      expect(METODY_WZA[id].wymagaKonta).toBe(false);
    }
  });
});

describe('InPost zostaje poza WzA — to cudza umowa, nie nasza', () => {
  for (const id of INPOST_CUDZA_UMOWA) {
    it(`usługa InPostu ${id.slice(0, 8)} NIE jest w białej liście`, () => {
      expect(METODY_WZA[id]).toBeUndefined();
    });
  }

  it('próba nadania usługi InPostu przez WzA to odmowa z wyjaśnieniem', () => {
    const w = wolnoNadacZOms(zamowienie('allegro_paczkomat'), {
      deliveryMethodIdZywy: '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93',
    });
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/InPost/i);
  });
});

describe('ekran nadania proponuje WzA dla metod punktowych', () => {
  // ⚠️ Niezmiennik z kurier-nadania.js: DROGA DOMYSLNA MUSI BYC NA LISCIE WYBORU.
  // Regula bez wpisu na liscie jest niedostepna — jedyne, co dalo sie kliknac, bylo
  // nadanie NASZA umowa, czyli drugi platny przewoz.
  for (const metoda of ['allegro_punkt', 'allegro_kurier', 'allegro_inne']) {
    it(`${metoda}: „Wysyłam z Allegro" jest na liście wyboru i stoi pierwsze`, () => {
      const lista = kurierzyDoWyboru(zamowienie(metoda));
      expect(lista[0]?.klucz).toBe('wza');
    });

    it(`${metoda}: brak wskazania prowadzi do WzA, a nie do odmowy`, () => {
      const wynik = metodaNadania(zamowienie(metoda), '');
      expect(wynik.blad, `odmowa zamiast WzA: ${wynik.blad}`).toBeUndefined();
      expect(wynik.metoda).toBe(metoda);
    });

    it(`${metoda}: trafia do adaptera WzA, a nie do naszego kuriera`, () => {
      const kurierzy = { allegro_wza: { nadaj: () => {} }, dpd: { nadaj: () => {} } };
      const wybrany = wybierzKuriera(metoda, kurierzy);
      expect(wybrany.nazwa).toBe('allegro_wza');
      expect(wybrany.klient).toBe(kurierzy.allegro_wza);
    });
  }

  it('paczkomat z Allegro NADAL nadajemy sami — „oprócz paczkomatów" (decyzja właściciela 18.09)', () => {
    // `allegro_paczkomat` siedzi w NADAJEMY_SAMI i ma tam zostać: Allegro nie sprzedaje
    // na nią etykiety, więc nie ma czego dublować, a my umiemy ją nadać własną umową.
    expect(wymagaWyboruKuriera(zamowienie('allegro_paczkomat'))).toBe(false);
    expect(metodaNadania(zamowienie('allegro_paczkomat'), '').metoda).toBe('inpost_paczkomat');
  });

  it('zamówienie spoza Allegro nie zyskuje drogi WzA', () => {
    const sklepowe = { sklep: 'pro', anulowane: 0, metoda_wysylki: 'dpd', kwota_pobrania: null };
    expect(kurierzyDoWyboru(sklepowe).some((k) => k.klucz === 'wza')).toBe(false);
  });
});

describe('bariera po identyfikatorze, nie po kategorii metody', () => {
  // ⚠️ To jest sedno tej zmiany: `allegro_inne` to WOREK na wszystko, czego nie umiemy
  // nazwać. Dopuszczenie go na ścieżkę WzA jest bezpieczne WYŁĄCZNIE dlatego, że prawdziwa
  // odmowa stoi niżej i pyta o KONKRETNY identyfikator usługi z żywego odczytu.
  it('nieznana usługa Allegro to odmowa, mimo dopuszczonej metody', () => {
    const w = wolnoNadacZOms(zamowienie('allegro_inne'), {
      deliveryMethodIdZywy: '00000000-0000-0000-0000-000000000000',
    });
    expect(w.wolno).toBe(false);
  });

  it('brak odczytanego identyfikatora to odmowa, nigdy domyślna usługa', () => {
    const w = wolnoNadacZOms(zamowienie('allegro_punkt'), { deliveryMethodIdZywy: null });
    expect(w.wolno).toBe(false);
  });
});
