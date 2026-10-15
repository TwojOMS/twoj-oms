import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { METODY_WYSYLKI, sprawdzZmianeMetody } from '../../../src/domena/wysylka.js';
import { wybierzKuriera } from '../../../src/oms/kurierzy/index.js';

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: String(id), klient: { first_name: 'Jan', last_name: 'Kowalski' },
  dostawa: { city: 'Pęki' }, metoda_wysylki: 'odbior_osobisty', kwota_pobrania: null,
  chce_fakture: 0, nip: null, kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, metoda_platnosci: 'Gotówka',
  utworzone_at: '2026-07-31T09:00:00',
  pozycje: [{ nazwa: 'STOP', sku: 'S1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }],
  ...nad,
});

describe('odbiór osobisty', () => {
  it('jest metodą, którą panel zna', () => {
    expect(METODY_WYSYLKI).toContain('odbior_osobisty');
  });

  it('da się ustawić ręcznie i NIE wymaga kwoty pobrania', () => {
    const { nadpisanie, blad } = sprawdzZmianeMetody('odbior_osobisty', false, '');
    expect(blad).toBeNull();
    expect(nadpisanie).toEqual({ metoda: 'odbior_osobisty', pobranie: 0 });
  });

  // ⚠️ SEDNO ZADANIA: paczka do klienta, który stoi przy ladzie, to pomyłka kosztująca
  // prawdziwe pieniądze i nieodwracalna (DPD odmawia ponownego nadania z tą referencją).
  it('NIE MA kuriera — nadanie odbija się z czytelnym powodem', () => {
    expect(() => wybierzKuriera('odbior_osobisty', { dpd: {} }))
      .toThrow(/nie jest obsługiwana/);
  });

  it('rejestracja przesyłki nadanej poza panelem też jest odmawiana', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config, poller });
    await app.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(5101), {});
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/reczna`,
      headers: naglowek, payload: { numer_listu: '0000123456789A' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.body).toMatch(/odbior|odbiór/i);
    expect(db.prepare('SELECT COUNT(*) n FROM przesylki').get().n).toBe(0);
  });

  it('przy zwykłej wysyłce rejestracja dalej działa', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config, poller });
    await app.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(5102, { metoda_wysylki: 'dpd' }), {});
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/przesylki/reczna`,
      headers: naglowek, payload: { numer_listu: '0000123456789A' },
    });
    expect(r.statusCode).toBe(302);
    expect(db.prepare('SELECT COUNT(*) n FROM przesylki').get().n).toBe(1);
  });
});

describe('przypomnienie o paragonie', () => {
  // ⚠️ ASERCJA NA CALYM `r.body` JEST NIENOSNA — arkusz stylow jedzie w <style> ukladu
  // i trafia do KAZDEJ strony. 17.08.2026 doszla do niego regula `.udzial-czesc--paragon`
  // (paski faktura/paragon w raportach) i natychmiast:
  //   • test NEGATYWNY zaczal padac, choc karta zachowuje sie poprawnie,
  //   • test POZYTYWNY stal sie bezwartosciowy — przechodzilby takze wtedy, gdyby
  //     przypomnienie zniknelo z karty, bo slowo „paragon" jest teraz w kazdym arkuszu.
  // Obie asercje celuja od tej pory w TRESC strony, nie w jej kod zrodlowy.
  const tresc = (body) => body.split('</style>').pop();

  it('sprzedaż na miejscu z chęcią faktury dostaje przypomnienie', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config, poller });
    await app.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(5201, { chce_fakture: 1, nip: '6762432557' }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(tresc(r.body)).toContain('paragon');
  });

  it('wysyłka kurierem przypomnienia NIE dostaje', async () => {
    const db = openOmsDb(':memory:');
    const app = buildOmsServer({ db, config, poller });
    await app.ready();
    const id = zapiszZamowienie(db, 'pro', zmapowane(5202, {
      metoda_wysylki: 'dpd', chce_fakture: 1, nip: '6762432557',
    }), {});
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: naglowek });
    expect(tresc(r.body)).not.toContain('paragon');
  });
});
