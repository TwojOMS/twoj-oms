import { describe, it, expect } from 'vitest';
import { createAllegroClient } from '../../src/oms/allegro/client.js';

const ustawienia = { api: 'https://api.allegro.pl', userAgent: 'OMS-szkicownia/1.0.0 (+https://szkicownia.pl/oms/)' };
const tokeny = { waznyToken: async () => 'TOKEN' };
const DPD = '03f26351-f683-4db2-8895-f2c599280e3c';

function klientZeSzpiegiem(odpowiedz) {
  const wolania = [];
  const domyslna = { ok: true, status: 200, json: async () => ({}) };
  const fetchImpl = async (url, opcje) => { wolania.push({ url, opcje }); return odpowiedz ?? domyslna; };
  return { klient: createAllegroClient({ ustawienia, tokeny, fetchImpl }), wolania };
}

const wejscie = (n = {}) => ({
  deliveryMethodId: DPD,
  sender: { name: 'Szkicownia' },
  receiver: { name: 'Kupujący' },
  packages: [{ type: 'PACKAGE' }],
  labelFormat: 'PDF',
  ...n,
});

describe('klient Allegro — podpowiedź danych do przesyłki', () => {
  it('pyta o propozycję po identyfikatorze zamówienia', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await klient.pobierzPropozycjeWysylki('abc-123');
    expect(wolania).toHaveLength(1);
    expect(wolania[0].url).toBe('https://api.allegro.pl/shipment-management/delivery-proposals/abc-123');
    expect(wolania[0].opcje.method).toBe('GET');
  });

  it('koduje identyfikator w ścieżce', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await klient.pobierzPropozycjeWysylki('a/b?c');
    expect(wolania[0].url).toContain('delivery-proposals/a%2Fb%3Fc');
  });
});

describe('klient Allegro — utworzenie przesyłki (WYDAJE PIENIĄDZE)', () => {
  it('wysyła POST na create-commands z commandId i input', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await klient.utworzPrzesylke({ commandId: 'cmd-1', input: wejscie() });
    expect(wolania).toHaveLength(1);
    expect(wolania[0].url).toBe('https://api.allegro.pl/shipment-management/shipments/create-commands');
    expect(wolania[0].opcje.method).toBe('POST');
    const cialo = JSON.parse(wolania[0].opcje.body);
    expect(cialo.commandId).toBe('cmd-1');
    expect(cialo.input.deliveryMethodId).toBe(DPD);
  });

  // ⚠️ `commandId` JEST KLUCZEM IDEMPOTENCJI ALLEGRO i MUSI przyjsc z rezerwacji w bazie.
  // Wylosowany w kliencie znaczy, ze ponowienie po zerwanym polaczeniu kupuje DRUGI przewoz
  // — dokladnie ta usterka, ktora ma panel Allegro (dwie etykiety do zamowienia #1140,
  // 10.08.2026) i ktorej OMS mial nie miec.
  it('ODMAWIA bez commandId — nie losuje własnego, nie leci do sieci', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await expect(klient.utworzPrzesylke({ input: wejscie() })).rejects.toThrow(/commandId/);
    expect(wolania).toHaveLength(0);
  });

  // ⚠️ Pominiete pole = usluge dobiera ALLEGRO, a nie my. Podpowiedz oddaje je jako `null`
  // (zmierzone 10.08.2026), wiec przepisanie „co przyszlo" wyslaloby wlasnie brak.
  // Zla usluga to utrata Smart u kupujacego i przewoz, ktorego nikt nie zamawial.
  it.each([[undefined], [null], ['']])('ODMAWIA bez deliveryMethodId (%s) — zanim cokolwiek poleci', async (id) => {
    const { klient, wolania } = klientZeSzpiegiem();
    await expect(klient.utworzPrzesylke({ commandId: 'cmd-1', input: wejscie({ deliveryMethodId: id }) }))
      .rejects.toThrow(/deliveryMethodId/);
    expect(wolania).toHaveLength(0);
  });

  it('niesie User-Agent, Accept i Content-Type Allegro', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await klient.utworzPrzesylke({ commandId: 'cmd-1', input: wejscie() });
    const h = wolania[0].opcje.headers;
    expect(h['User-Agent']).toBe(ustawienia.userAgent);
    expect(h.Accept).toBe('application/vnd.allegro.public.v1+json');
    expect(h['Content-Type']).toBe('application/vnd.allegro.public.v1+json');
    expect(h.Authorization).toBe('Bearer TOKEN');
  });

  it('błąd HTTP nie wynosi tokenu ani ciała odpowiedzi', async () => {
    const { klient } = klientZeSzpiegiem({ ok: false, status: 422, json: async () => ({ errors: [{ message: 'TOKEN' }] }) });
    const wywolaj = () => klient.utworzPrzesylke({ commandId: 'cmd-1', input: wejscie() });
    await expect(wywolaj()).rejects.toThrow(/HTTP 422 przy \/shipment-management\/shipments\/create-commands/);
    await expect(wywolaj()).rejects.not.toThrow(/Bearer|TOKEN/);
  });
});

describe('klient Allegro — stan tworzenia przesyłki', () => {
  it('pyta o stan po commandId', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await klient.stanTworzeniaPrzesylki('cmd-1');
    expect(wolania[0].url).toBe('https://api.allegro.pl/shipment-management/shipments/create-commands/cmd-1');
    expect(wolania[0].opcje.method).toBe('GET');
  });
});

describe('klient Allegro — etykieta', () => {
  // ⚠️ Odpowiedz to BINARNY PDF. `res.json()` albo `res.text()` cicho zepsulyby plik —
  // etykieta wygladalaby na pobrana, a wydruk bylby smieciem.
  it('oddaje bajty, nie tekst', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const { klient, wolania } = klientZeSzpiegiem({
      ok: true, status: 200, arrayBuffer: async () => pdf.buffer,
      json: async () => { throw new Error('nie wolno wolac json() na PDF-ie'); },
      text: async () => { throw new Error('nie wolno wolac text() na PDF-ie'); },
    });
    const bajty = await klient.pobierzEtykieteWza(['ship-1']);
    expect(Buffer.isBuffer(bajty) || bajty instanceof Uint8Array).toBe(true);
    expect(Buffer.from(bajty).subarray(0, 4).toString()).toBe('%PDF');
    expect(wolania[0].url).toBe('https://api.allegro.pl/shipment-management/label');
    expect(wolania[0].opcje.method).toBe('POST');
    expect(JSON.parse(wolania[0].opcje.body).shipmentIds).toEqual(['ship-1']);
  });

  it('ODMAWIA pustej listy przesyłek — zanim cokolwiek poleci', async () => {
    const { klient, wolania } = klientZeSzpiegiem();
    await expect(klient.pobierzEtykieteWza([])).rejects.toThrow();
    expect(wolania).toHaveLength(0);
  });

  it('dla ZPL nie wysyła ustawień strony PDF do Allegro', async () => {
    const zpl = Buffer.from('^XA^FO20,20^FDTEST^FS^XZ');
    const { klient, wolania } = klientZeSzpiegiem({
      ok: true, status: 200, arrayBuffer: async () => zpl,
    });
    const bajty = await klient.pobierzEtykieteWza(['ship-zpl'], 'ZPL');
    expect(Buffer.from(bajty)).toEqual(zpl);
    expect(JSON.parse(wolania[0].opcje.body)).toEqual({ shipmentIds: ['ship-zpl'] });
  });
});

describe('biała lista rośnie o cztery metody — świadomie', () => {
  // ⚠️ TRZECIA KOPIA białej listy (obok `allegro-client-zapis.test.js` i
  // `allegro-client-faktura.test.js`) — i to WŁAŚNIE ONA złapała niekompletne scalenie
  // 11.08.2026. Gałąź magazynu dokładała `pobierzOferty`, gałąź WzA cztery metody
  // nadawania; git zgłosił konflikt w dwóch plikach, ale nie w tym, bo powstał wyłącznie
  // po stronie WzA. Dwa pliki poprawione, suita CZERWONA — dokładnie po to ta lista
  // stoi w trzech miejscach. Kto dopisuje metodę, poprawia WSZYSTKIE TRZY.
  it('klient ma DOKŁADNIE te metody i ani jednej więcej', () => {
    const { klient } = klientZeSzpiegiem();
    expect(Object.keys(klient).sort()).toEqual([
      'deklarujZalacznikWiadomosci',
      'pobierzEtykieteWza', 'pobierzFakturyZamowienia', 'pobierzMetodeDostawy', 'pobierzOferte',
      // Podjazdy (22.09): trzy odczyty i jedno zlecenie; kontrakt w osobnym teście.
      'pobierzOferty', 'pobierzPodjazd', 'pobierzPropozycjePodjazdu', 'pobierzPropozycjeWysylki',
      // ⚠️ `pobierzWatki` i `pobierzWiadomosci` — Centrum wiadomości (spec 2026-08-28),
      // wyłącznie odczyt (`GET /messaging/threads…`).
      // `pobierzSprawy` (28.08.2026) tylko CZYTA `GET /sale/issues` — bariera zapisu bez zmian.
      'pobierzPrzesylkeWza', 'pobierzPrzesylki', 'pobierzSledzenie', 'pobierzSprawy',
      'pobierzStanRealizacji',
      'pobierzWatki', 'pobierzWiadomosci', 'pobierzZamowienia',
      'stanTworzeniaPrzesylki', 'stanZleceniaPodjazdu',
      // Centrum wiadomosci (spec 2026-08-28): `wyslijWiadomosc` PISZE i jest
      // NIEODWRACALNE — nie wydaje pieniedzy, ale po drugiej stronie jest czlowiek,
      // ktory dostaje powiadomienie. Bariera zapisu nizej rosnie razem z nia.
      'ustawStatusRealizacji', 'utworzPrzesylke', 'wgrajZalacznikWiadomosci', 'wyslijPlikFaktury',
      'wyslijWiadomosc', 'zglosFakture', 'zlecPodjazd',
    ]);
  });

  // ⚠️ TEN ZAKAZ ZOSTAJE W MOCY. `POST /order/checkout-forms/{id}/shipments` to INNA droga:
  // dopisuje do zamowienia numer listu paczki nadanej GDZIE INDZIEJ, na NASZEJ umowie.
  // Nadawanie przez WzA jej nie potrzebuje i jej nie zdejmuje.
  it('w module NIE MA wywołania POST /order/checkout-forms/{id}/shipments', async () => {
    const { readFileSync } = await import('node:fs');
    const zrodlo = readFileSync('src/oms/allegro/client.js', 'utf8');
    expect(zrodlo).not.toMatch(/checkout-forms[^\n]*shipments[^\n]*['"]POST['"]/);
    expect(zrodlo).not.toMatch(/\/shipments['"`\s]*,\s*['"]POST['"]/);
  });
});
