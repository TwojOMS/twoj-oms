// Biała lista metod zapisujących klienta Allegro — JEDYNA bariera, na którą powołuje się
// nagłówek `src/oms/allegro/client.js`. Token niesie uprawnienia zapisu (oferty, przesyłki,
// wiadomości), więc Allegro nam NIE odmówi; odmawia ten test.
//
// Test jest DYNAMICZNY: wywołuje KAŻDĄ metodę klienta szpiegiem `fetchImpl` z „bogatą”
// odpowiedzią, zbiera (metoda HTTP, ścieżka) i porównuje zbiór ZAPISÓW (wszystko poza GET)
// z wyliczeniem niżej. Nowa metoda bez wpisu w tabeli ARGUMENTY = czerwony test, więc nie da się
// dopisać zapisu tylnymi drzwiami. PRZ-160.E3.03 dołożyło zapis ofert, zdjęć, komend i podgląd opłat.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAllegroClient } from '../../src/oms/allegro/client.js';

const ustawienia = { api: 'https://api.allegro.pl.allegrosandbox.pl', userAgent: 'OMS-polcien/1.0.0 (+https://polcien.example.test/oms/)' };
const tokeny = { waznyToken: async () => 'TOKEN' };
const ID = 'ID';
const PDF = Buffer.from('%PDF-1.4 przykład');

// Argumenty dla KAŻDEJ metody klienta — takie, żeby przeszła kontrole przed siecią.
const ARGUMENTY = {
  pobierzMojeKonto: [],
  sprawdzZakresZamowien: [{ odUtc: '2026-11-01T00:00:00Z' }],
  pobierzZamowienia: [{ od: null, kursor: null, strona: 1 }],
  pobierzPrzesylki: [ID],
  pobierzOferte: [ID],
  pobierzOferty: [],
  pobierzKategorie: [ID],
  pobierzParametryKategorii: [ID],
  pobierzStanRealizacji: [ID],
  ustawStatusRealizacji: [ID, 'SENT'],
  pobierzFakturyZamowienia: [ID],
  zglosFakture: [ID, { nazwaPliku: 'FV-1.pdf', numerFaktury: 'FV/1/2026' }],
  wyslijPlikFaktury: [ID, ID, PDF],
  pobierzPropozycjeWysylki: [ID],
  pobierzMetodeDostawy: [ID],
  utworzPrzesylke: [{ commandId: ID, input: { deliveryMethodId: 'dm' } }],
  stanTworzeniaPrzesylki: [ID],
  pobierzPrzesylkeWza: [ID],
  pobierzEtykieteWza: [[ID]],
  pobierzSledzenie: ['INPOST', ID],
  pobierzPropozycjePodjazdu: [{ shipmentIds: [ID], readyDate: '2026-11-20', address: { city: 'Przykładowo' } }],
  zlecPodjazd: [{ commandId: ID, input: { shipmentIds: [ID], pickupTime: { date: '2026-11-20' }, address: { city: 'Przykładowo' } } }],
  stanZleceniaPodjazdu: [ID],
  pobierzPodjazd: [ID],
  pobierzWatki: [],
  pobierzWiadomosci: [ID],
  wyslijWiadomosc: [ID, 'Dzień dobry'],
  deklarujZalacznikWiadomosci: ['faktura.pdf', 100],
  wgrajZalacznikWiadomosci: [ID, PDF, 'application/pdf'],
  pobierzSprawy: [],
  // PRZ-160.E3.03
  utworzOferte: [{ name: 'Lampa', external: { id: 'oms-1' } }],
  edytujOferte: [ID, { publication: { status: 'ACTIVE' } }],
  stanOperacji: [`/sale/product-offers/${ID}/operations/${ID}`],
  ofertyKonta: [],
  ofertyPoSygnaturze: ['oms-1'],
  szukajProduktow: ['5909990000014'],
  wgrajZdjecie: [Buffer.from([0xff, 0xd8]), 'image/jpeg', { ai: 0 }],
  komendaIlosci: [ID, [{ ofertaId: ID, ilosc: 1 }]],
  komendaCeny: [ID, [{ ofertaId: ID, cena: '10.00' }]],
  komendaPublikacji: [ID, ['1'], 'END'],
  wynikKomendy: ['ilosc', ID],
  pobierzCenniki: [],
  pobierzZwroty: [],
  pobierzReklamacje: [],
  pobierzGwarancje: [],
  pobierzProducentow: [],
  pobierzOsobyOdpowiedzialne: [],
  ustawieniaPodatku: [ID],
  dopasujKategorie: ['Lampy'],
  podgladOplat: [{ name: 'Lampa' }],
  oplatyOferty: [ID],
};

// DOKŁADNIE te zapisy wolno robić. Każda zmiana tej listy to decyzja, nie poprawka testu.
const ZAPISY = [
  // Plan B (05.08.2026): status realizacji i faktura.
  'PUT /order/checkout-forms/{id}/fulfillment',
  'POST /order/checkout-forms/{id}/invoices',
  'PUT /order/checkout-forms/{id}/invoices/{id}/file',
  // „Wysyłam z Allegro” (11.08.2026) — create-commands KUPUJE przewóz.
  'POST /shipment-management/shipments/create-commands',
  'POST /shipment-management/label',
  // Podjazdy (22.09.2026).
  'POST /shipment-management/pickup-proposals',
  'POST /shipment-management/pickups/create-commands',
  // Centrum wiadomości (28.08.2026) — wiadomość do człowieka, nieodwracalna.
  'POST /messaging/message-attachments',
  'PUT /messaging/message-attachments/{id}',
  'POST /messaging/threads/{id}/messages',
  // PRZ-160.E3.03 — wystawianie ofert (bez kasowania: D38).
  'POST /sale/product-offers',
  'PATCH /sale/product-offers/{id}',
  'POST upload:/sale/images',
  'PUT /sale/offer-quantity-change-commands/{id}',
  'PUT /sale/offer-price-change-commands/{id}',
  'PUT /sale/offer-publication-commands/{id}',
  // Prognoza prowizji: POST, ale bez skutku po stronie Allegro.
  'POST /pricing/offer-fee-preview',
].sort();

const BOGATA = {
  id: ID, offers: [], totalCount: 0, checkoutForms: [], shipments: [], tasks: [], products: [], threads: [],
  messages: [], issues: [], invoices: [], parameters: [], location: 'https://obraz.example.test/1', expiresAt: '2026-11-20T00:00:00Z',
  shippingRates: [], returnPolicies: [], impliedWarranties: [], warranties: [], responsibleProducers: [],
  responsiblePersons: [], matchingCategories: [], quotes: [], commissions: [],
};

function szpieg() {
  const wolania = [];
  const fetchImpl = async (url, opcje = {}) => {
    wolania.push({ url, metoda: opcje.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === 'location' ? `/sale/product-offers/${ID}/operations/${ID}` : null) },
      json: async () => structuredClone(BOGATA),
      arrayBuffer: async () => new ArrayBuffer(4),
    };
  };
  return { k: createAllegroClient({ ustawienia, tokeny, fetchImpl }), wolania };
}

function znormalizuj({ url, metoda }) {
  const u = new URL(url);
  const host = u.host.startsWith('upload.') ? 'upload:' : '';
  const sciezka = u.pathname.split('/').map((s) => (s === ID ? '{id}' : s)).join('/');
  return `${metoda} ${host}${sciezka}`;
}

async function wywolajWszystkie() {
  const { k, wolania } = szpieg();
  for (const [nazwa, argumenty] of Object.entries(ARGUMENTY)) {
    try { await k[nazwa](...argumenty); } catch { /* liczy się tylko to, co wyszło do sieci */ }
  }
  return { k, wolania };
}

describe('biała lista metod zapisujących', () => {
  it('każda metoda klienta ma wpis w tabeli argumentów (nowa metoda = świadoma decyzja tutaj)', () => {
    const { k } = szpieg();
    expect(Object.keys(k).sort()).toEqual(Object.keys(ARGUMENTY).sort());
  });

  it('każda metoda wychodzi do sieci (tabela argumentów przechodzi kontrole przed siecią)', async () => {
    for (const [nazwa, argumenty] of Object.entries(ARGUMENTY)) {
      const { k, wolania } = szpieg();
      try { await k[nazwa](...argumenty); } catch { /* jw. */ }
      expect(wolania.length, nazwa).toBeGreaterThan(0);
    }
  });

  it('zbiór (metoda, ścieżka) wszystkich zapisów jest równy wyliczeniu', async () => {
    const { wolania } = await wywolajWszystkie();
    const zapisy = [...new Set(wolania.filter((w) => w.metoda !== 'GET').map(znormalizuj))].sort();
    expect(zapisy).toEqual(ZAPISY);
  });

  it('żadne wywołanie nie ma metody DELETE (D38: ofert nie kasujemy, tylko kończymy)', async () => {
    const { wolania } = await wywolajWszystkie();
    expect(wolania.filter((w) => w.metoda.toUpperCase() === 'DELETE')).toEqual([]);
    const zrodlo = readFileSync(new URL('../../src/oms/allegro/client.js', import.meta.url), 'utf8');
    expect(zrodlo).not.toMatch(/['"`]DELETE['"`]/);
  });

  it('POST /order/checkout-forms/{id}/shipments dalej zakazane (druga, płatna przesyłka)', async () => {
    const { wolania } = await wywolajWszystkie();
    expect(wolania.map(znormalizuj)).not.toContain('POST /order/checkout-forms/{id}/shipments');
  });

  it('upload zdjęć idzie wyłącznie na host upload.<środowisko API>', async () => {
    const { wolania } = await wywolajWszystkie();
    const hosty = new Set(wolania.map((w) => new URL(w.url).host));
    expect([...hosty].sort()).toEqual(['api.allegro.pl.allegrosandbox.pl', 'upload.allegro.pl.allegrosandbox.pl']);
  });
});
