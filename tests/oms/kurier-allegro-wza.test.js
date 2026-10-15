import { describe, it, expect } from 'vitest';
import { createAllegroWzaClient, commandIdDlaPaczki } from '../../src/oms/kurierzy/allegro-wza.js';

const DPD = '03f26351-f683-4db2-8895-f2c599280e3c';
const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const PDF = Buffer.from('%PDF-1.4 udawany');
const ZPL = Buffer.from('^XA^FO20,20^FDTEST^FS^XZ');

const propozycja = () => ({
  suggestedInput: {
    deliveryMethodId: null, // ⚠️ Allegro ZAWSZE oddaje tu null — zmierzone 10.08.2026.
    sender: { company: 'Szkicownia', street: 'ul. 1 Maja 5', postalCode: '00-650', city: 'Pęki' },
    receiver: { name: 'Kupujący', street: 'Polna 1', postalCode: '00-001', city: 'Warszawa', email: 'abc+1@allegromail.pl' },
    packages: [{ type: 'PACKAGE', length: 120, width: 80, height: 55, weight: 0.5 }],
    insurance: { amount: '79.00', currency: 'PLN' },
    cashOnDelivery: null,
    labelFormat: 'PDF',
  },
});

const propozycjaGabarytowa = (dlugosc) => ({
  ...propozycja(),
  deliveryOptions: [{ packageType: 'PACKAGE', limits: {
    dimensions: {
      length: { value: dlugosc, unit: 'CENTIMETER' },
      width: { value: 38, unit: 'CENTIMETER' },
      height: { value: 41, unit: 'CENTIMETER' },
    },
    weight: { value: 20, unit: 'KILOGRAMS' },
  } }],
});

function klientAllegro(n = {}) {
  const wolania = [];
  const zapis = (nazwa) => (...a) => { wolania.push({ nazwa, a }); };
  return {
    wolania,
    api: {
      pobierzPrzesylki: async (id) => { wolania.push({ nazwa: 'juzNadane', a: [id] }); return n.juzNadane ?? []; },
      pobierzPropozycjeWysylki: async (id) => { wolania.push({ nazwa: 'propozycja', a: [id] }); return n.propozycja ?? propozycja(); },
      utworzPrzesylke: async (arg) => { wolania.push({ nazwa: 'utworz', a: [arg] }); return n.utworz ?? {}; },
      stanTworzeniaPrzesylki: async (cmd) => {
        wolania.push({ nazwa: 'stan', a: [cmd] });
        if (n.stan) return n.stan(wolania.filter((w) => w.nazwa === 'stan').length);
        return { status: 'SUCCESS', shipmentId: 'ship-1' };
      },
      pobierzPrzesylkeWza: async (id) => { wolania.push({ nazwa: 'przesylka', a: [id] }); return n.przesylka ?? { labelFormat: 'PDF', packages: [{ waybill: 'AD0TEST123', transportingInfo: [{ carrierId: 'DPD', carrierWaybill: '1048798161135U' }] }] }; },
      pobierzEtykieteWza: async (ids) => { wolania.push({ nazwa: 'etykieta', a: [ids] }); return n.etykieta ?? PDF; },
      ...(n.api ?? {}),
      _zapis: zapis,
    },
  };
}

const zamowienie = { id: 1125, sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd', zrodlo_id: 'ord-abc', anulowane: 0 };
const paczka = { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 };

const zbuduj = (n = {}) => {
  const { api, wolania } = klientAllegro(n);
  const k = createAllegroWzaClient({
    allegroDla: () => api,
    metodaZywa: n.metodaZywa ?? (async () => DPD),
    odstepMs: 0,
    ...(n.opcje ?? {}),
  });
  return { k, wolania };
};

describe('commandId — klucz idempotencji z rezerwacji', () => {
  // ⚠️ Dwa rownolegle klikniecia MUSZA dostac TEN SAM klucz, bo tylko wtedy Allegro odsieje
  // drugie zadanie. Klucz wyprowadzamy z `(zamowienie, kolejnosc)` — czyli z tej samej pary,
  // ktora indeks `przesylki_kolejnosc_zywa` uznaje za jedna zywa paczke.
  it('jest ten sam dla tej samej paczki tego samego zamówienia', () => {
    expect(commandIdDlaPaczki(1125, 1)).toBe(commandIdDlaPaczki(1125, 1));
  });

  it('jest RÓŻNY dla kolejnej paczki i dla innego zamówienia', () => {
    expect(commandIdDlaPaczki(1125, 1)).not.toBe(commandIdDlaPaczki(1125, 2));
    expect(commandIdDlaPaczki(1125, 1)).not.toBe(commandIdDlaPaczki(1126, 1));
  });

  it('ma kształt UUID — Allegro innego nie przyjmie', () => {
    expect(commandIdDlaPaczki(1125, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('kurier allegro_wza — nadanie', () => {
  it('odczytuje bieżącą metodę do formularza bez tworzenia przesyłki', async () => {
    const odczytane = [];
    const { k, wolania } = zbuduj({ metodaZywa: async (z) => { odczytane.push(z); return ONE_BOX; } });
    expect(await k.pobierzMetodeDostawy(zamowienie)).toBe(ONE_BOX);
    expect(odczytane).toEqual([zamowienie]);
    expect(wolania).toEqual([]);
  });

  it('nie kupuje One Box M, gdy spreparowany formularz podmienił wymiary', async () => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => ONE_BOX });
    const zafalszowana = {
      waga: 0.5, dlugosc: 110, szerokosc: 38, wysokosc: 19,
      gabaryt: 'M', oczekiwanyDeliveryMethodId: ONE_BOX,
    };
    await expect(k.nadaj({ zamowienie, paczka: zafalszowana })).rejects.toThrow(/gabaryt|wymiar/i);
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toEqual([]);
  });

  it('nie kupuje One Box M, gdy Allegro nie podało limitów dla tej paczki', async () => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => ONE_BOX });
    const oneM = {
      waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 19,
      gabaryt: 'M', oczekiwanyDeliveryMethodId: ONE_BOX,
    };
    await expect(k.nadaj({ zamowienie, paczka: oneM })).rejects.toThrow(/limit/i);
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toEqual([]);
  });

  it.each([
    [ONE_BOX, 64, 'S', 8], [ONE_BOX, 64, 'M', 19], [ONE_BOX, 64, 'L', 41],
    [ORLEN, 60, 'M', 19],
  ])('wysyła do WzA liczby dla %s, długość %i, gabaryt %s, wysokość %i', async (id, dlugosc, gabaryt, wysokosc) => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => id, propozycja: propozycjaGabarytowa(dlugosc) });
    await k.nadaj({ zamowienie, paczka: {
      waga: 0.5, dlugosc, szerokosc: 38, wysokosc,
      gabaryt, oczekiwanyDeliveryMethodId: id,
    } });
    const { input } = wolania.find((x) => x.nazwa === 'utworz').a[0];
    expect(input.packages).toEqual([{
      type: 'PACKAGE',
      length: { value: dlugosc, unit: 'CENTIMETER' },
      width: { value: 38, unit: 'CENTIMETER' },
      height: { value: wysokosc, unit: 'CENTIMETER' },
      weight: { value: 0.5, unit: 'KILOGRAMS' },
    }]);
    expect(input.packages[0]).not.toHaveProperty('gabaryt');
  });

  it('odmawia, gdy One Box na ekranie zmienił się na kuriera przed zakupem', async () => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => DPD });
    await expect(k.nadaj({ zamowienie, paczka: {
      waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 8,
      gabaryt: 'S', oczekiwanyDeliveryMethodId: ONE_BOX,
    } })).rejects.toThrow(/metoda|zmieniła/i);
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toEqual([]);
  });

  it('odmawia, gdy kurier na ekranie zmienił się na inną usługę WzA', async () => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => DPD });
    await expect(k.nadaj({ zamowienie, paczka: {
      ...paczka, oczekiwanyDeliveryMethodId: '0960fef9-cc88-4558-b2b2-62331a20b5b2',
    } })).rejects.toThrow(/metoda|zmieniła/i);
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toEqual([]);
  });

  it('nie przyjmuje gabarytu skrytki jako paczki kurierskiej', async () => {
    const { k, wolania } = zbuduj();
    await expect(k.nadaj({ zamowienie, paczka: {
      ...paczka, gabaryt: 'S', oczekiwanyDeliveryMethodId: DPD,
    } })).rejects.toThrow(/gabaryt|kurier/i);
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toEqual([]);
  });

  it('odmawia, gdy metoda Allegro zmienia się podczas przygotowania komendy', async () => {
    let odczyty = 0;
    const { k, wolania } = zbuduj({
      metodaZywa: async () => { odczyty += 1; return odczyty === 1 ? ONE_BOX : DPD; },
      propozycja: propozycjaGabarytowa(64),
    });
    await expect(k.nadaj({ zamowienie, paczka: {
      waga: 0.5, dlugosc: 64, szerokosc: 38, wysokosc: 8,
      gabaryt: 'S', oczekiwanyDeliveryMethodId: ONE_BOX,
    } })).rejects.toThrow(/metoda|zmieniła/i);
    expect(odczyty).toBe(2);
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toEqual([]);
  });

  it('kupuje przewóz i oddaje numer listu z etykietą', async () => {
    const { k, wolania } = zbuduj();
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(w.numerListu).toBe('AD0TEST123');
    expect(w.shipmentId).toBe('ship-1');
    expect(w.wTrakcieTworzenia).toBe(false);
    expect(Buffer.from(w.etykietaPdf).subarray(0, 4).toString()).toBe('%PDF');
    expect(w.etykietaZpl).toBeNull();
    expect(wolania.map((x) => x.nazwa)).toEqual(['juzNadane', 'propozycja', 'utworz', 'stan', 'przesylka', 'etykieta']);
  });

  it('po „Nadaj i drukuj” zamawia ZPL i zwraca tylko etykietę dla Zebry', async () => {
    const { k, wolania } = zbuduj({
      przesylka: { labelFormat: 'ZPL', packages: [{ waybill: 'AD0ZPL', transportingInfo: [{ carrierId: 'DPD', carrierWaybill: '104ZPL' }] }] },
      etykieta: ZPL,
    });
    const wynik = await k.nadaj({ zamowienie, paczka, kolejnosc: 1, drukowac: true });
    expect(wolania.find((x) => x.nazwa === 'utworz').a[0].input.labelFormat).toBe('ZPL');
    expect(wynik.etykietaZpl).toEqual(ZPL);
    expect(wynik.etykietaPdf).toBeNull();
    expect(wolania.filter((x) => x.nazwa === 'utworz')).toHaveLength(1);
  });

  it('nie przepuszcza PDF-u jako surowego ZPL do drukarki i zachowuje numer listu', async () => {
    const { k } = zbuduj({
      przesylka: { labelFormat: 'ZPL', packages: [{ waybill: 'AD0ZPL' }] }, etykieta: PDF,
    });
    await expect(k.nadaj({ zamowienie, paczka, drukowac: true })).rejects.toMatchObject({
      shipmentId: 'ship-1', numerListu: 'AD0ZPL',
    });
  });

  it('nie przepuszcza uciętego ZPL bez końca etykiety do kolejki', async () => {
    const { k } = zbuduj({
      przesylka: { labelFormat: 'ZPL', packages: [{ waybill: 'AD0CUT' }] },
      etykieta: Buffer.from('^XA^FO20,20^FDURWANE'),
    });
    await expect(k.nadaj({ zamowienie, paczka, drukowac: true })).rejects.toMatchObject({
      shipmentId: 'ship-1', numerListu: 'AD0CUT',
    });
  });

  it('odmawia nieznanego formatu z Allegro po zakupie, zachowując numer listu', async () => {
    const { k } = zbuduj({
      przesylka: { labelFormat: 'EPL', packages: [{ waybill: 'AD0EPL' }] },
    });
    await expect(k.nadaj({ zamowienie, paczka })).rejects.toMatchObject({
      shipmentId: 'ship-1', numerListu: 'AD0EPL',
    });
  });

  // ⚠️⚠️ Etykieta kupiona RECZNIE w panelu Allegro nie przechodzi przez nasza rezerwacje,
  // wiec `commandId` przed nia nie chroni. Pytamy Allegro, bo tylko ono wie o obu drogach.
  it('ODMAWIA, gdy Allegro ma już przesyłkę do tego zamówienia — nic nie kupuje', async () => {
    const { k, wolania } = zbuduj({ juzNadane: [{ waybill: 'AD05GHH189GZVPJHF' }] });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow(/AD05GHH189GZVPJHF/);
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  // „Nie wiem, czy paczka juz jest" MUSI znaczyc odmowe — cicha zgoda kosztuje pieniadze.
  it('ODMAWIA, gdy nie udało się sprawdzić istniejących przesyłek', async () => {
    const { k, wolania } = zbuduj({ api: { pobierzPrzesylki: async () => { throw new Error('Allegro: HTTP 503'); } } });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow();
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  // ⚠️ Podpowiedz oddaje `deliveryMethodId: null`. Przepisanie jej „jak jest" wyslaloby brak,
  // czyli oddaloby wybor uslugi Allegru — a zla usluga to utrata Smart u kupujacego.
  it('WSTAWIA deliveryMethodId z żywego odczytu, nie z podpowiedzi', async () => {
    const { k, wolania } = zbuduj();
    await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    const { input } = wolania.find((x) => x.nazwa === 'utworz').a[0];
    expect(input.deliveryMethodId).toBe(DPD);
  });

  it('używa commandId wyprowadzonego z rezerwacji, nie losowego', async () => {
    const { k, wolania } = zbuduj();
    await k.nadaj({ zamowienie, paczka, kolejnosc: 2 });
    expect(wolania.find((x) => x.nazwa === 'utworz').a[0].commandId).toBe(commandIdDlaPaczki(1125, 2));
  });

  // ⚠️ Wymiary z podpowiedzi biora sie z OFERTY i bywaja fikcyjne — zmierzone: 120×80×55 cm
  // przy 0,5 kg. O wlasnej paczce wiemy wiecej niz Allegro.
  it('bierze WŁASNE wymiary paczki, nie te z podpowiedzi', async () => {
    const { k, wolania } = zbuduj();
    await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    const p = wolania.find((x) => x.nazwa === 'utworz').a[0].input.packages[0];
    expect(p.length.value).toBe(110);
    expect(p.width.value).toBe(75);
    expect(p.height.value).toBe(1);
    expect(p.weight.value).toBe(1);
  });

  // ⚠️ Maskowany mail `@allegromail.pl` jest JEDYNYM adresem kupujacego, jaki mamy.
  it('zostawia odbiorcę z podpowiedzi — z maskowanym mailem', async () => {
    const { k, wolania } = zbuduj();
    await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    const { receiver } = wolania.find((x) => x.nazwa === 'utworz').a[0].input;
    expect(receiver.email).toBe('abc+1@allegromail.pl');
  });

  it('ODMAWIA, gdy żywy odczyt nie dał metody — zanim cokolwiek kupi', async () => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => null });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow();
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  it('ODMAWIA metody spoza białej listy — zanim cokolwiek kupi', async () => {
    const { k, wolania } = zbuduj({ metodaZywa: async () => '2488f7b7-5d1c-4d65-b85c-4cbcf253fd93' });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow(/własnej umowie/i);
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });
});

describe('kurier allegro_wza — tworzenie asynchroniczne', () => {
  it('czeka na SUCCESS, odpytując o stan', async () => {
    const { k, wolania } = zbuduj({
      stan: (n) => (n < 3 ? { status: 'IN_PROGRESS' } : { status: 'SUCCESS', shipmentId: 'ship-9' }),
    });
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(w.numerListu).toBe('AD0TEST123');
    expect(wolania.filter((x) => x.nazwa === 'stan')).toHaveLength(3);
  });

  // ⚠️ To NIE JEST blad. `services/nadanie.js` zapisuje wtedy wiersz 'w_trakcie', a czlowiek
  // domyka go przyciskiem „Sprawdz ponownie". Oznaczenie tego jako 'blad' zwolniloby indeks
  // czesciowy i pozwolilo kupic DRUGI przewoz.
  it('po wyczerpaniu prób oddaje wTrakcieTworzenia z commandId, a NIE rzuca', async () => {
    const { k } = zbuduj({ stan: () => ({ status: 'IN_PROGRESS' }), opcje: { maksProb: 2 } });
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(w.wTrakcieTworzenia).toBe(true);
    expect(w.numerListu).toBeNull();
    expect(w.shipmentId).toBe(commandIdDlaPaczki(1125, 1));
  });

  // ⚠️ NAJWAZNIEJSZY TEST TEGO PLIKU. Przewoz JUZ KOSZTOWAL. Wyjatek bez identyfikatora
  // znaczy zaplacona paczke, o ktora panel nie umie zapytac — stan bez wyjscia (4.9).
  it('wyjątek po udanym zakupie NIESIE commandId, żeby dało się zapytać ponownie', async () => {
    const { k } = zbuduj({ opcje: { maksProb: 3 }, stan: () => { throw new Error('sieć padła'); } });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toMatchObject({
      shipmentId: commandIdDlaPaczki(1125, 1),
    });
  });

  it('ERROR od Allegro rzuca z powodem, bez identyfikatora przesyłki', async () => {
    const { k } = zbuduj({ stan: () => ({ status: 'ERROR', errors: [{ userMessage: 'zły kod pocztowy' }] }) });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow(/zły kod pocztowy/);
  });
});

describe('kurier allegro_wza — konto per kanał', () => {
  // ⚠️ Kanały Allegro to OSOBNE KONTA. Przesyłka kupiona na koncie A nie istnieje dla B,
  // więc jeden klient na całą usługę znaczyłby paczkę kupioną na cudzej umowie — i nikt
  // by tego nie zobaczył, bo etykieta by powstała.
  it('bierze klienta dla TEGO zamówienia, nie jednego na usługę', async () => {
    const podane = [];
    const { api } = klientAllegro();
    const k = createAllegroWzaClient({
      allegroDla: (z) => { podane.push(z.sklep); return api; },
      metodaZywa: async () => DPD,
      odstepMs: 0,
    });
    await k.nadaj({ zamowienie: { ...zamowienie, sklep: 'allegro_amarka' }, paczka, kolejnosc: 1 });
    expect(podane).toEqual(['allegro_amarka']);
  });
});

describe('kurier allegro_wza — sprawdzenie ponowne', () => {
  // ⚠️ „Sprawdz ponownie" NIE MA PRAWA nic kupic. Dziesiec klikniec = zero nowych paczek.
  it('wyłącznie odpytuje o stan i pobiera etykietę — nigdy nie tworzy', async () => {
    const { k, wolania } = zbuduj();
    const w = await k.sprawdzPrzesylke(commandIdDlaPaczki(1125, 1), zamowienie);
    expect(w.numerListu).toBe('AD0TEST123');
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
    expect(wolania.some((x) => x.nazwa === 'propozycja')).toBe(false);
  });
});

// ⚠️⚠️ KSZTAŁT ZMIERZONY NA PIERWSZEJ PRAWDZIWEJ PACZCE (11.08.2026, `AD0LHNWJ8L661FQRL`).
//
// Pierwsza wersja szukała numeru listu w `shipment.waybill` / `waybill` odpowiedzi KOMENDY —
// pól, których Allegro nie zwraca nigdzie. Skutek na produkcji: paczka kupiona i opłacona
// kończyła jako „tworzona u kuriera", bez etykiety, mimo statusu SUCCESS. Kształt był
// ZGADNIĘTY, a atrapa w teście zwracała to, co założyłem — więc test potwierdzał założenie,
// a nie rzeczywistość. Ten opis przepisuje ODPOWIEDZI DOSŁOWNIE z produkcji.
describe('kształt odpowiedzi Allegro — przepisany z pomiaru, nie założony', () => {
  const KOMENDA_SUCCESS = {
    commandId: '47f59230-8db1-5141-93de-24dae495564a',
    status: 'SUCCESS',
    errors: null,
    shipmentId: '2ec7eb73-7ed4-4183-a83a-c6bde3edf895',
  };
  const PRZESYLKA = {
    id: '2ec7eb73-7ed4-4183-a83a-c6bde3edf895',
    deliveryMethodId: DPD,
    carrier: 'ALLEGRO',
    labelFormat: 'PDF',
    packages: [{
      waybill: 'AD0LHNWJ8L661FQRL',
      type: 'PACKAGE',
      transportingInfo: [{ carrierId: 'DPD', carrierWaybill: '1048798161135U' }],
    }],
  };

  it('odpowiedź komendy NIE NIESIE numeru listu — sam shipmentId', () => {
    expect(KOMENDA_SUCCESS).not.toHaveProperty('waybill');
    expect(KOMENDA_SUCCESS).not.toHaveProperty('shipment');
    expect(KOMENDA_SUCCESS.shipmentId).toBeTruthy();
  });

  it('numer listu bierze się z zasobu przesyłki, a nie ze statusu', async () => {
    const { k, wolania } = zbuduj({
      stan: () => KOMENDA_SUCCESS,
      przesylka: PRZESYLKA,
    });
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(w.numerListu).toBe('AD0LHNWJ8L661FQRL');
    expect(w.wTrakcieTworzenia).toBe(false);
    // Zasób przesyłki MUSI zostać odpytany — bez niego numeru nie ma skąd wziąć.
    expect(wolania.find((x) => x.nazwa === 'przesylka').a[0]).toBe(KOMENDA_SUCCESS.shipmentId);
  });

  // Numer u DPD (`1048798161135U`) jest INNY niż allegrowy „AD…" — śledzenie u przewoźnika
  // działa wyłącznie po tym drugim, więc zapisujemy oba.
  it('wyciąga też numer u przewoźnika spod transportingInfo', async () => {
    const { k } = zbuduj({ stan: () => KOMENDA_SUCCESS, przesylka: PRZESYLKA });
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(w.numerPrzewoznika).toBe('1048798161135U');
  });

  // Przesyłka bez numeru to dalej „w toku", a NIE błąd — inaczej wiersz poszedłby na 'blad',
  // zwolnił indeks częściowy i pozwolił kupić DRUGI przewóz do tego samego zamówienia.
  it('SUCCESS bez numeru w przesyłce zostaje „w toku", z shipmentId do ponowienia', async () => {
    const { k } = zbuduj({
      stan: () => KOMENDA_SUCCESS,
      przesylka: { id: KOMENDA_SUCCESS.shipmentId, packages: [{ type: 'PACKAGE' }] },
      opcje: { maksProb: 2 },
    });
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(w.wTrakcieTworzenia).toBe(true);
    expect(w.numerListu).toBeNull();
  });
});

// ⚠️⚠️ TYPY MUSZĄ PASOWAĆ DO KOLUMN — awaria PO ZAKUPIE jest najdroższa z możliwych.
//
// 11.08.2026, zamówienia 1142 i 1145: adapter oddawał `surowa` jako OBIEKT, a kolumna
// `przesylki.odpowiedz_surowa` jest tekstowa. `node:sqlite` rzucił „Provided value cannot be
// bound to SQLite parameter 4" — DOPIERO PO tym, jak przewóz u Allegro powstał i kosztował.
// Na karcie stanęło „błąd techniczny panelu", a paczka była kupiona. Ta sama rodzina co
// pułapka z `ksef_data` (notatka 2026-08-05, §1.2).
describe('wynik nadania nadaje się do zapisania w bazie', () => {
  const POLA_TEKSTOWE = ['numerListu', 'shipmentId', 'surowa', 'numerPrzewoznika'];

  it('każde pole idące do kolumny tekstowej JEST tekstem albo nullem', async () => {
    const { k } = zbuduj();
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    for (const pole of POLA_TEKSTOWE) {
      expect(
        `${pole}: ${w[pole] === null || typeof w[pole] === 'string' ? 'ok' : typeof w[pole]}`,
      ).toBe(`${pole}: ok`);
    }
  });

  it('surowa jest tekstem, z którego da się odzyskać odpowiedź Allegro', async () => {
    const { k } = zbuduj();
    const w = await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    expect(typeof w.surowa).toBe('string');
    expect(JSON.parse(w.surowa).packages[0].waybill).toBe('AD0TEST123');
  });

  // Ta sama droga wraca ze „Sprawdź ponownie" — a to WŁAŚNIE tam wysypało się drugi raz.
  it('sprawdzPrzesylke też oddaje surową jako tekst', async () => {
    const { k } = zbuduj();
    const w = await k.sprawdzPrzesylke(commandIdDlaPaczki(1125, 1), zamowienie);
    expect(typeof w.surowa).toBe('string');
  });
});

// ⚠️⚠️ W KOLUMNIE `id_przesylki_kuriera` ŻYJĄ DWA RÓŻNE IDENTYFIKATORY (zam. 1145, 11.08.2026).
//
// Droga udana zapisuje `shipmentId`, droga awaryjna zapisuje to, co niósł wyjątek — raz
// `commandId`, raz `shipmentId`. „Sprawdź ponownie" pytało zawsze jak o `commandId`, więc
// paczka KUPIONA I GOTOWA (etykieta widoczna w panelu Allegro) wisiała jako „tworzona
// u kuriera", bez wyjścia (4.9). Nie zgadujemy po kształcie UUID-a — PYTAMY.
describe('„Sprawdź ponownie" przyjmuje OBA identyfikatory', () => {
  const SHIP = '5350e75b-0f7a-4149-bc39-9b9f53fa1b60';
  const CMD = '7af0b507-8870-500b-828b-741af1bcba27';
  const PACZKI = { labelFormat: 'PDF', packages: [{ waybill: 'AD0REAL', transportingInfo: [{ carrierWaybill: '104REAL' }] }] };

  it('po opóźnionym utworzeniu bierze ZPL z formatu przesyłki, bez ponownego zakupu', async () => {
    const { k, wolania } = zbuduj({
      przesylka: { ...PACZKI, labelFormat: 'ZPL' }, etykieta: ZPL,
    });
    const wynik = await k.sprawdzPrzesylke(SHIP, zamowienie);
    expect(wynik.etykietaZpl).toEqual(ZPL);
    expect(wynik.etykietaPdf).toBeNull();
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  it('nie myli awarii etykiety gotowej przesyłki z commandId', async () => {
    const { k, wolania } = zbuduj({
      przesylka: { ...PACZKI, labelFormat: 'ZPL' },
      api: {
        pobierzEtykieteWza: async () => { throw new Error('etykieta chwilowo niedostępna'); },
        stanTworzeniaPrzesylki: async () => { throw new Error('błędny fallback do commandId'); },
      },
    });
    await expect(k.sprawdzPrzesylke(SHIP, zamowienie)).rejects.toMatchObject({
      message: 'etykieta chwilowo niedostępna', numerListu: 'AD0REAL', shipmentId: SHIP,
    });
    expect(wolania.some((x) => x.nazwa === 'stan')).toBe(false);
  });

  it('dociąga paczkę, gdy w bazie leży shipmentId', async () => {
    const { k, wolania } = zbuduj({
      api: {
        pobierzPrzesylkeWza: async (id) => {
          wolania.push({ nazwa: 'przesylka', a: [id] });
          if (id !== SHIP) throw new Error('Allegro: HTTP 404');
          return PACZKI;
        },
        stanTworzeniaPrzesylki: async () => { throw new Error('Allegro: HTTP 404 — to NIE jest commandId'); },
      },
    });
    const w = await k.sprawdzPrzesylke(SHIP, zamowienie);
    expect(w.numerListu).toBe('AD0REAL');
    expect(w.wTrakcieTworzenia).toBe(false);
  });

  it('dalej działa, gdy w bazie leży commandId — droga po komendzie zostaje', async () => {
    const { k, wolania } = zbuduj({
      api: {
        pobierzPrzesylkeWza: async (id) => {
          wolania.push({ nazwa: 'przesylka', a: [id] });
          if (id === CMD) throw new Error('Allegro: HTTP 404 — to jest commandId, nie przesyłka');
          return PACZKI;
        },
        stanTworzeniaPrzesylki: async (id) => {
          wolania.push({ nazwa: 'stan', a: [id] });
          return { commandId: CMD, status: 'SUCCESS', errors: null, shipmentId: SHIP };
        },
      },
    });
    const w = await k.sprawdzPrzesylke(CMD, zamowienie);
    expect(w.numerListu).toBe('AD0REAL');
    expect(w.shipmentId).toBe(SHIP);
  });

  // Obie drogi muszą oddać TEN SAM kształt — inaczej „Sprawdź ponownie" zapisywałoby wiersz
  // inaczej niż pierwsze nadanie.
  it('obie drogi oddają ten sam komplet pól', async () => {
    const { k } = zbuduj();
    const poKomendzie = await k.sprawdzPrzesylke(commandIdDlaPaczki(1125, 1), zamowienie);
    expect(Object.keys(poKomendzie).sort()).toEqual([
      'etykietaPdf', 'etykietaZpl', 'numerListu', 'numerPrzewoznika', 'shipmentId', 'surowa',
      'wTrakcieTworzenia',
    ]);
  });
});

// ⚠️⚠️ POBRANIE OD STRONY ADAPTERA (Zadanie 6, 11.08.2026). Zmierzone na zamówieniu #1148.
describe('kurier allegro_wza — pobranie', () => {
  const DPD_POBRANIE = '13f26351-26fb-48d4-b5dd-f2c599280e3c';
  const KONTO = { nazwa: 'Lumina Marek Zywiecki', rachunek: '34109010140000000000000000' };

  const zPobraniem = (n = {}) => {
    const { api, wolania } = klientAllegro({
      ...n,
      api: {
        pobierzPropozycjeWysylki: async (id) => {
          wolania.push({ nazwa: 'propozycja', a: [id] });
          return {
            suggestedInput: {
              ...propozycja().suggestedInput,
              // `in`, nie `??` — atrapa musi umieć oddać JAWNE `null`, a nie tylko „brak".
              cashOnDelivery: 'cod' in n ? n.cod : { amount: '83.99', currency: 'PLN', ownerName: null, iban: null },
            },
            deliveryOptions: [{ deliveryType: 'DOOR', paymentType: 'POSTPAID', limits: { cashOnDelivery: { amount: '6000', currency: 'PLN' } } }],
          };
        },
        ...(n.api ?? {}),
      },
    });
    const k = createAllegroWzaClient({
      allegroDla: () => api,
      metodaZywa: async () => (n.metoda ?? DPD_POBRANIE),
      pobranieNadawca: n.konto ?? KONTO,
      odstepMs: 0,
    });
    return { k, wolania };
  };

  // ⚠️⚠️ BEZ NASZEGO KONTA. Zgłoszenie właściciela 11.08.2026: „pobranie idzie na konto
  // allegro a nie na nasze" — potwierdzone pomiarem (`WALLET_TRANSFER`, `forceRequireIban:
  // false`) i dokumentacją Allegro: „środki w ramach pobrania (COD) otrzymasz na swoje
  // subkonto w Allegro". Pierwsza wersja wysyłała tam nasz IBAN.
  it('wysyła inkaso z SAMĄ kwotą Allegro — bez naszego rachunku', async () => {
    const { k, wolania } = zPobraniem();
    await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    const { input } = wolania.find((x) => x.nazwa === 'utworz').a[0];
    expect(input.deliveryMethodId).toBe(DPD_POBRANIE);
    expect(input.cashOnDelivery).toEqual({ amount: '83.99', currency: 'PLN' });
    expect(JSON.stringify(input)).not.toContain('6069');
  });

  // ⚠️ Limit bierzemy z TEJ SAMEJ podpowiedzi, ktora dala kwote — nie ze stalej w kodzie.
  it('ODMAWIA ponad limit z podpowiedzi — nic nie kupuje', async () => {
    const { k, wolania } = zPobraniem({ cod: { amount: '6000.01', currency: 'PLN' } });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow(/limit/i);
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  it('ODMAWIA, gdy operator wpisał inną kwotę — nic nie kupuje', async () => {
    const { k, wolania } = zPobraniem();
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1, kwotaPobrania: '8399' }))
      .rejects.toThrow(/8399/);
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  // ⚠️ NAJWAZNIEJSZY TEST TEGO OPISU. Podpowiedz Allegro niesie `cashOnDelivery` takze przy
  // uslugach przedplaconych; rozlozenie jej przez `...p` przemycaloby inkaso tam, gdzie
  // regula wlasnie orzekla, ze go nie ma — albo, przy odwrotnej pomylce, gubiloby je.
  it('przy usłudze PRZEDPŁACONEJ z kwotą w podpowiedzi — ODMAWIA, nie przemyca', async () => {
    const { k, wolania } = zPobraniem({ metoda: DPD });
    await expect(k.nadaj({ zamowienie, paczka, kolejnosc: 1 })).rejects.toThrow(/przedpłacona/i);
    expect(wolania.some((x) => x.nazwa === 'utworz')).toBe(false);
  });

  it('przy usłudze przedpłaconej bez kwoty wysyła cashOnDelivery: null JAWNIE', async () => {
    const { k, wolania } = zPobraniem({ metoda: DPD, cod: null });
    await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    const { input } = wolania.find((x) => x.nazwa === 'utworz').a[0];
    expect(input).toHaveProperty('cashOnDelivery');
    expect(input.cashOnDelivery).toBeNull();
  });

  // Brak konta w konfiguracji NIE JEST tu przeszkodą — usługa go nie potrzebuje. Panel,
  // który by tu odmawiał, blokowałby nadanie bez powodu.
  it('nadaje także wtedy, gdy panel nie ma skonfigurowanego rachunku', async () => {
    const { k, wolania } = zPobraniem({ konto: { nazwa: '', rachunek: '' } });
    await k.nadaj({ zamowienie, paczka, kolejnosc: 1 });
    const { input } = wolania.find((x) => x.nazwa === 'utworz').a[0];
    expect(input.cashOnDelivery).toEqual({ amount: '83.99', currency: 'PLN' });
  });
});

describe('kurier allegro_wza deklaruje brak śledzenia', () => {
  // ⚠️ Flaga, a nie brak metody — patrz uzasadnienie w adapterze i w web/routes/zamowienia.js.
  it('ma bezSledzenia: true i NIE udaje, że umie oddać status', () => {
    const { k } = zbuduj();
    expect(k.bezSledzenia).toBe(true);
    expect(k.statusPrzesylki).toBeUndefined();
  });
});
