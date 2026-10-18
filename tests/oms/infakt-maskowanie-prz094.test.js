import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { createInfaktClient, METODY_INFAKTU } from '../../src/oms/infakt/client.js';
import { poPolsku } from '../../src/domena/blad-po-polsku.js';

// Wyłącznie fikcyjny klucz; znaki specjalne odróżniają formę jawną od kodowanej.
const KLUCZ = 'fikcyjny/klucz+infakt=09403';
const KODOWANY = encodeURIComponent(KLUCZ);
const echo = `invalid api key ${KLUCZ}; URL ${KODOWANY}`;
const argumenty = {
  znajdzKlientaPoNip: ['1234567890'], zalozKlienta: [{}], wystaw: [{}], wystawKorekte: [{}],
  oznaczZaplacona: ['demo'], pobierzPdf: ['demo'], pobierzPdfKorekty: ['demo'], pobierzFakture: ['demo'],
  listaFaktur: [{}], listaKorekt: [{}], listaNieoplaconych: [], iluMaNumer: ['FV-demo'],
  wyslijDokumentDoKsef: ['demo'], sprawdzPolaczenie: [],
};
function bezSekretu(wartosc) {
  const tekst = inspect(wartosc, { depth: 30 });
  expect(tekst.includes(KLUCZ), 'jawny klucz opuścił klienta').toBe(false);
  expect(tekst.includes(KODOWANY), 'kodowany klucz opuścił klienta').toBe(false);
}

describe('PRZ-094.03 maskowanie na wyjściu klienta inFaktu', () => {
  it('obejmuje każdą publiczną metodę', () => {
    expect(Object.keys(argumenty).sort()).toEqual([...METODY_INFAKTU].sort());
  });
  for (const metoda of Object.keys(argumenty)) {
    for (const status of [401, 422]) {
      it(`${metoda}: odpowiedź HTTP ${status} nie ujawnia obu form klucza`, async () => {
        const klient = createInfaktClient({ apiKey: KLUCZ, http: async () => new Response(
          JSON.stringify({ error: echo }), { status },
        ) });
        const e = await klient[metoda](...argumenty[metoda]).catch((blad) => blad);
        expect(e).toBeInstanceOf(Error);
        expect(e.status).toBe(status);
        expect(e.dlaOperatora).toBe(true);
        expect(e.message).toContain('inFakt');
        expect(e.stack).toEqual(expect.any(String));
        bezSekretu(e);
        expect(e.message).toContain('[klucz API]');
      });
    }
  }
  it('awaria transportu JSON i PDF: komunikat oraz stack bez klucza', async () => {
    const klient = createInfaktClient({ apiKey: KLUCZ, http: async () => { throw new Error(echo); } });
    for (const metoda of ['wystaw', 'pobierzPdf']) {
      const e = await klient[metoda](...argumenty[metoda]).catch((blad) => blad);
      expect(e.status).toBeUndefined();
      expect(e.dlaOperatora).toBe(true);
      expect(e.message).toContain('inFakt nieosiągalny:');
      bezSekretu(e);
    }
  });
  it('błąd odczytu PDF: zachowuje rodzaj i metadane, maskuje stack, response i rekurencyjne cause', async () => {
    const przyczyna = Object.assign(new Error(echo), { response: { body: echo } });
    przyczyna.cause = przyczyna;
    const oryginal = Object.assign(new TypeError(echo, { cause: przyczyna }), { status: 502, code: 'E_DEMO', body: echo });
    const klient = createInfaktClient({ apiKey: KLUCZ, http: async () => ({
      ok: true, arrayBuffer: async () => { throw oryginal; },
    }) });
    const e = await klient.pobierzPdf('demo').catch((blad) => blad);
    expect(e).toBeInstanceOf(TypeError);
    expect(e.name).toBe('TypeError');
    expect(e.status).toBe(502);
    expect(e.code).toBe('E_DEMO');
    expect(e.stack).toContain('TypeError:');
    expect(e.cause).toBeInstanceOf(Error);
    expect(e.cause.response.body).toContain('[klucz API]');
    bezSekretu(e);
    expect(oryginal.message).toBe(echo); // nie zmieniamy obcego błędu
  });
  for (const [nazwa, komunikat, polski] of [
    ['TimeoutError', 'The operation was aborted due to timeout', 'przekroczony czas oczekiwania na odpowiedź'],
    ['AbortError', 'This operation was aborted', 'żądanie przerwane'],
  ]) {
    it(`DOMException ${nazwa} przy odczycie PDF: czytelny błąd i ten sam polski komunikat`, async () => {
      const oryginal = new DOMException(`${komunikat}; ${echo}`, nazwa);
      expect(Object.hasOwn(oryginal, 'message')).toBe(false);
      const klient = createInfaktClient({ apiKey: KLUCZ, fetchImpl: async () => ({
        ok: true, arrayBuffer: async () => { throw oryginal; },
      }) });
      const e = await klient.pobierzPdf('demo').catch((blad) => blad);
      expect(() => e.message, 'odczyt message nie może rzucać').not.toThrow();
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(DOMException);
      expect(e.name).toBe(nazwa);
      expect(e.code).toBe(oryginal.code);
      expect(e.dlaOperatora).toBeUndefined();
      expect(e.message).toBe(`${komunikat}; invalid api key [klucz API]; URL [klucz API]`);
      expect(String(e)).toBe(`${nazwa}: ${e.message}`);
      expect(`${e}`).toBe(String(e));
      expect(e.stack).toBe(oryginal.stack.split(KLUCZ).join('[klucz API]').split(KODOWANY).join('[klucz API]'));
      expect(poPolsku(e.message)).toBe(`${polski}; invalid api key [klucz API]; URL [klucz API]`);
      expect(poPolsku(e.message)).toBe(poPolsku(oryginal.message).split(KLUCZ).join('[klucz API]').split(KODOWANY).join('[klucz API]'));
      bezSekretu(e);
    });
  }
  it('błąd z odziedziczonym message i code także dostaje działający Error', async () => {
    class BladOdczytu extends Error {
      #kod = 'E_ODCZYT';
      get message() { return echo; }
      get code() { return this.#kod; }
    }
    const klient = createInfaktClient({ apiKey: KLUCZ, fetchImpl: async () => ({
      ok: true, arrayBuffer: async () => { throw new BladOdczytu(); },
    }) });
    const e = await klient.pobierzPdf('demo').catch((blad) => blad);
    expect(e).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(e)).toBe(Error.prototype);
    expect(e.code).toBe('E_ODCZYT');
    expect(e.message).toBe('invalid api key [klucz API]; URL [klucz API]');
    expect(String(e)).toBe(`Error: ${e.message}`);
    bezSekretu(e);
  });
  it('ucina zbyt głębokie cause bez pozostawiania niezamaskowanego ogona', async () => {
    let cause = new Error(echo);
    for (let i = 0; i < 20; i++) cause = new Error(echo, { cause });
    const klient = createInfaktClient({ apiKey: KLUCZ, http: async () => ({
      ok: true, arrayBuffer: async () => { throw cause; },
    }) });
    const e = await klient.pobierzPdf('demo').catch((blad) => blad);
    bezSekretu(e);
    let glebokosc = 0;
    for (let p = e; p && typeof p === 'object'; p = p.cause) glebokosc++;
    expect(glebokosc).toBeLessThanOrEqual(10);
  });
  it('tablica szczegółów w cause nie zmienia statusu ani rodzaju błędu', async () => {
    const klient = createInfaktClient({ apiKey: KLUCZ, http: async () => ({
      ok: true, arrayBuffer: async () => { throw Object.assign(new TypeError(echo, {
        cause: { errors: [echo, { body: echo }] },
      }), { status: 502 }); },
    }) });
    const e = await klient.pobierzPdf('demo').catch((blad) => blad);
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(TypeError);
    expect(Array.isArray(e.cause.errors)).toBe(true);
    expect(e.cause.errors[0]).toContain('[klucz API]');
    bezSekretu(e);
  });
  it('błąd przed transportem (serializacja żądania) także przechodzi przez maskowanie', async () => {
    const klient = createInfaktClient({ apiKey: KLUCZ });
    const e = await klient.wystaw({ toJSON() { throw new TypeError(echo); } }).catch((blad) => blad);
    expect(e).toBeInstanceOf(TypeError);
    expect(e.dlaOperatora).toBeUndefined();
    bezSekretu(e);
  });
  for (const apiKey of ['', 'a', '1234567']) {
    it(`krótki klucz (${apiKey.length}) nie niszczy komunikatu`, async () => {
      const klient = createInfaktClient({ apiKey, http: async () => new Response(JSON.stringify({ error: 'awaria 1234567' }), { status: 422 }) });
      await expect(klient.wystaw({})).rejects.toThrow('awaria 1234567');
    });
  }
});
