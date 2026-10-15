import { describe, it, expect, vi } from 'vitest';
import { createAllegroAdapter } from '../../src/oms/allegro/adapter.js';
import { createWooAdapter } from '../../src/oms/woo/adapter.js';

// Adapter jest CALA wiedza pollera o tym, jak wyglada zamowienie Allegro: ktore pole jest
// kursorem, ktore data zlozenia i jak zamienic surowe cialo na wiersz. Kazda z tych czterech
// odpowiedzi da sie pomylic tak, ze NIC SIE NIE WYWALI — poller pobierze zero zamowien albo
// wciagnie cale archiwum, a suita bedzie zielona. Dlatego kazda ma tu wlasny test.

const surowe = {
  id: '6a1b2c3d',
  updatedAt: '2026-08-04T07:17:35.018Z',
  status: 'READY_FOR_PROCESSING',
  lineItems: [{
    id: 'li-1',
    offer: { name: 'Szablon' },
    quantity: 1,
    price: { amount: '129.00', currency: 'PLN' },
    boughtAt: '2026-08-03T09:13:41.325Z',
  }],
  delivery: { method: { id: '03f26351-f683-4db2-8895-f2c599280e3c', name: 'Allegro Kurier DPD (AD)' }, cost: { amount: '0.00' } },
  payment: { type: 'ONLINE', finishedAt: '2026-08-03T09:14:00.000Z' },
  summary: { totalToPay: { amount: '129.00', currency: 'PLN' } },
};

const klientAtrapa = () => ({ pobierzZamowienia: vi.fn(async () => ({ zamowienia: [], stron: 1 })) });

describe('adapter kanału Allegro', () => {
  // Poller nie ma prawa wiedziec, z kim rozmawia (Etap 4) — wiec adapter Allegro musi miec
  // DOKLADNIE ten sam zestaw metod, co adapter WooCommerce. Brakujaca metoda konczy sie
  // `kanal.zlozoneZ is not a function` dopiero na produkcji, przy pierwszym zamowieniu.
  it('ma ten sam kontrakt, co adapter WooCommerce', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    const woo = createWooAdapter({ woo: {}, mapowanie: {} });
    expect(Object.keys(a).sort()).toEqual(Object.keys(woo).sort());
    for (const k of Object.keys(woo)) expect(typeof a[k]).toBe('function');
  });

  // ⚠️ `kursor` i `od` to DWIE ROZNE RZECZY i adapter przekazuje je OSOBNO. Sklejenie ich
  // tutaj (`kursor ?? od`, jak robi Woo) znaczyloby, ze na PUSTYM STANIE klient trafia
  // w galaz „mam kursor" i pyta o wszystko zmodyfikowane od daty startowej, czyli o cale
  // archiwum konta (775 zamowien w chwili rozpoznania). Klient Allegro sam wybiera galaz.
  it('przekazuje `od`, `kursor` i `strona` do klienta bez sklejania', async () => {
    const klient = klientAtrapa();
    const a = createAllegroAdapter({ klient });

    await a.pobierzStrone({ od: '2026-07-01T00:00:00', kursor: null, strona: 1 });

    expect(klient.pobierzZamowienia).toHaveBeenCalledTimes(1);
    expect(klient.pobierzZamowienia.mock.calls[0][0]).toEqual({
      od: '2026-07-01T00:00:00', kursor: null, strona: 1,
    });
  });

  it('kursor zapisany przechodzi do klienta niezmieniony', async () => {
    const klient = klientAtrapa();
    const a = createAllegroAdapter({ klient });

    await a.pobierzStrone({ od: '2026-07-01T00:00:00', kursor: '2026-08-01T10:00:00Z', strona: 3 });

    expect(klient.pobierzZamowienia.mock.calls[0][0]).toEqual({
      od: '2026-07-01T00:00:00', kursor: '2026-08-01T10:00:00Z', strona: 3,
    });
  });

  // Wynik klienta oddajemy BEZ dotykania — poller czyta `{ zamowienia, stron }`. Adapter,
  // ktory zgubilby `stron`, przeczytalby zawsze wylacznie pierwsza strone.
  it('oddaje wynik klienta w postaci, ktorej oczekuje poller', async () => {
    const klient = { pobierzZamowienia: vi.fn(async () => ({ zamowienia: [surowe], stron: 8 })) };
    const a = createAllegroAdapter({ klient });

    expect(await a.pobierzStrone({ od: null, kursor: null, strona: 1 })).toEqual({ zamowienia: [surowe], stron: 8 });
  });

  // ⚠️ KURSOR IDZIE ZA DATA MODYFIKACJI (`updatedAt`), NIE ZA DATA ZLOZENIA. Pomylka tych
  // dwoch pol jest cicha w obie strony: kursor z `boughtAt` cofalby okno przy kazdym
  // zamowieniu zmienionym po zlozeniu (oplata, anulowanie) i czytalby je w kolko.
  it('kursor bierze z updatedAt, a nie z daty złożenia', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    expect(a.kursorZ(surowe)).toBe('2026-08-04T07:17:35.018Z');
    expect(a.kursorZ(surowe)).not.toBe(surowe.lineItems[0].boughtAt);
  });

  it('brak updatedAt daje null, a nie undefined ani wyjątek', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    // `undefined` przepuszczone dalej zapisaloby sie do `stan_pollera.zsynchronizowane_do`
    // jako wiazanie, ktorego node:sqlite nie przyjmuje.
    expect(a.kursorZ({})).toBeNull();
    expect(a.kursorZ(null)).toBeNull();
  });

  // ⚠️ PODLOGA IDZIE PO DACIE ZLOZENIA, ktora sie NIE ZMIENIA — i u Allegro nie ma jej na
  // poziomie zamowienia, tylko przy pierwszej pozycji. `zlozoneZ` oddajace null oznacza
  // podloge WYLACZONA (poller: `zeStarego` przepuszcza wtedy wszystko), czyli cale archiwum
  // na liscie roboczej — i ani jednego bledu.
  it('data złożenia pochodzi z lineItems[0].boughtAt', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    expect(a.zlozoneZ(surowe)).toBe('2026-08-03T09:13:41.325Z');
    expect(a.zlozoneZ(surowe)).not.toBe(surowe.updatedAt);
  });

  it('brak pozycji nie wywraca odczytu daty złożenia', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    expect(a.zlozoneZ({})).toBeNull();
    expect(a.zlozoneZ({ lineItems: [] })).toBeNull();
    expect(a.zlozoneZ(null)).toBeNull();
  });

  // `mapuj` ma wolac mapowanie Allegro Z WSTRZYKNIETYM `metodaZId` — bez niego mapowanie
  // rzuca, a z podmienionym slownikiem kolumna `metoda_wysylki` dostaje wartosc, ktorej nie
  // zna ani filtr listy, ani bramka recznej zmiany metody.
  it('mapuje surowe zamówienie na model panelu, ze słownikiem metod', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    const w = a.mapuj(surowe);
    expect(w.zrodlo_id).toBe('6a1b2c3d');
    expect(w.kwota_brutto).toBe('129.00');
    expect(w.metoda_wysylki).toBe('allegro_dpd');
    expect(w.utworzone_at).toBe('2026-08-03T09:13:41.325Z');
    expect(w.pozycje).toHaveLength(1);
  });

  // Nieznane `id` metody NIE MA PRAWA zatrzymac kanalu — panel i tak nie nadaje tych paczek.
  it('nieznana metoda dostawy nie wywraca mapowania', () => {
    const a = createAllegroAdapter({ klient: klientAtrapa() });
    const w = a.mapuj({ ...surowe, delivery: { method: { id: 'cos-nowego', name: 'Allegro Kurier Jutro' } } });
    expect(w.metoda_wysylki).toBe('allegro_inne');
  });
});
