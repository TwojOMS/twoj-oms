import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { createSyncSklep } from '../../../src/moduly/zamowienia/services/sync-sklep.js';
import { ROWNOLEGLE_ODESLANIA } from '../../../src/moduly/zamowienia/lista.js';

// PRZ-094.22 (właściciel 18.10.2026: „czasami trzeba czekać dość długo”). Zmierzone lokalnie na demo z atrapą opóźnioną
// o 2 s: 50 zamówień = 151 s odpowiedzi, z czego 150,8 s to wywołania sklepu/Allegro jedno PO DRUGIM (maks. 1 naraz),
// a baza 0,5 s. Akcja masowa odsyła statusy z limitem współbieżności — różne zamówienia nie zależą od siebie,
// a w obrębie JEDNEGO zamówienia kolejność (odczyt Allegro → zapis) zostaje ta sama, bo robi ją `odeslijStatus`.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const spij = (ms) => new Promise((ok) => setTimeout(ok, ms));

const zmapowane = (id, nad = {}) => ({
  zrodlo_id: id, numer: `N-${id}`, klient: { first_name: 'Jan', last_name: 'Testowy', email: 'j@example.invalid' },
  dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Polna 1', postcode: '00-001', city: 'Testowo', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '10.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-01T09:00:00',
  pozycje: [{ nazwa: 'Szablon', sku: 'T-1', ilosc: 1, cena_brutto: '10.00', brutto_linii: '10.00', vat: null }],
  ...nad,
});

// Klient z licznikiem: ile wywołań trwa NARAZ i w jakiej kolejności zaczynały się i kończyły.
function licznik() {
  const s = { teraz: 0, maks: 0, zdarzenia: [] };
  const owin = (nazwa, fn, ms = 40) => async (...a) => {
    s.teraz++; s.maks = Math.max(s.maks, s.teraz); s.zdarzenia.push(`${nazwa}:${a[0]}:start`);
    try { await spij(ms); return await fn(...a); } finally { s.teraz--; s.zdarzenia.push(`${nazwa}:${a[0]}:koniec`); }
  };
  return { s, owin };
}

describe('akcja masowa „Zmień status” — odesłanie do sklepu/Allegro z limitem współbieżności', () => {
  let db, app, woo, allegro, l;
  const zbuduj = async () => {
    app = buildOmsServer({ db, config, poller,
      syncSklep: createSyncSklep({ db, klienci: { sklep_a: woo }, klienciKanalow: { allegro_a: allegro } }) });
    await app.ready();
  };
  beforeEach(() => {
    db = openOmsDb(':memory:');
    l = licznik();
    woo = { ustawStatus: vi.fn(l.owin('woo', async (id, status) => ({ id, status }))) };
    const stan = new Map();
    allegro = {
      pobierzStanRealizacji: vi.fn(l.owin('get', async (id) => stan.get(String(id)) ?? 'PROCESSING')),
      ustawStatusRealizacji: vi.fn(l.owin('put', async (id, st) => { stan.set(String(id), st); return null; })),
    };
  });
  const wyslij = (payload) => app.inject({ method: 'POST', url: '/zamowienia/masowe/status', headers: naglowek, payload });
  const zeSklepu = (n) => Array.from({ length: n }, (_, i) => zapiszZamowienie(db, 'sklep_a', zmapowane(5000 + i), {}));

  it('limit jest mały (3–4): nie zalewa API sklepu ani Allegro', () => {
    expect(ROWNOLEGLE_ODESLANIA).toBeGreaterThanOrEqual(3);
    expect(ROWNOLEGLE_ODESLANIA).toBeLessThanOrEqual(4);
  });

  it('12 zamówień ze sklepu: wysyłki idą równolegle, ale nigdy więcej niż limit naraz — i każde dojeżdża', async () => {
    await zbuduj();
    const ids = zeSklepu(12);
    const t = performance.now();
    const r = await wyslij({ id: ids.map(String), status: 'wyslane' });
    const ms = performance.now() - t;

    expect(r.statusCode).toBe(302);
    expect(woo.ustawStatus).toHaveBeenCalledTimes(12);
    // Liczby wprost, nie stała z kodu: na starym kodzie test ma paść na „1 naraz”, a nie na braku eksportu.
    expect(l.s.maks).toBeGreaterThanOrEqual(3);
    expect(l.s.maks).toBeLessThanOrEqual(4);
    // Po kolei: 12 × 40 ms = 480 ms samego czekania na sklep. Z limitem 4: 3 rundy ≈ 120 ms (+ baza i serwer).
    expect(ms).toBeLessThan(12 * 40 * 0.75);
    for (const id of ids) expect(pobierzZamowienie(db, id).sync_woo_blad).toBeNull();
  });

  // Kolejność na ekranie wyniku = kolejność listy (od najnowszego, tu: 5006 przed 5002), tak jak przy wysyłce po kolei.
  // 5006 odpada WOLNO, 5002 od razu — wynik zbierany „kto pierwszy skończył” odwróciłby tę kolejność.
  it('błąd jednego zamówienia nie zatrzymuje reszty, a ekran wyniku wypisuje nieudane w kolejności listy', async () => {
    await zbuduj();
    const ids = zeSklepu(8);
    const zle = new Set([5002, 5006]);
    woo.ustawStatus.mockImplementation(async (id, status) => {
      await spij(id === 5006 ? 150 : 5);
      if (zle.has(id)) throw new Error(`sklep odrzucił ${id}`);
      return { id, status };
    });

    const r = await wyslij({ id: ids.map(String), status: 'wyslane' });

    expect(r.statusCode).toBe(200);
    expect(woo.ustawStatus).toHaveBeenCalledTimes(8);
    expect(r.body).toContain('N-5002');
    expect(r.body).toContain('N-5006');
    expect(r.body.indexOf('sklep odrzucił 5006')).toBeGreaterThan(-1);
    expect(r.body.indexOf('sklep odrzucił 5006')).toBeLessThan(r.body.indexOf('sklep odrzucił 5002'));
    for (const id of ids) {
      const z = pobierzZamowienie(db, id);
      expect(z.wyslane_at).toBeTruthy(); // status w panelu zapisany zawsze
      expect(Boolean(z.sync_woo_blad)).toBe(zle.has(Number(z.zrodlo_id)));
    }
  });

  it('Allegro: w obrębie jednego zamówienia odczyt stanu zawsze kończy się PRZED zapisem — także przy równoległości', async () => {
    await zbuduj();
    const ids = Array.from({ length: 6 }, (_, i) => zapiszZamowienie(db, 'allegro_a', zmapowane(9000 + i, {
      zrodlo_id: String(9000 + i), metoda_wysylki: 'allegro_dpd', status_woo: 'READY_FOR_PROCESSING',
    }), {}));

    const r = await wyslij({ id: ids.map(String), status: 'wyslane' });

    expect(r.statusCode).toBe(302);
    expect(allegro.ustawStatusRealizacji).toHaveBeenCalledTimes(6);
    expect(l.s.maks).toBeGreaterThan(1);
    expect(l.s.maks).toBeLessThanOrEqual(4);
    for (let i = 0; i < 6; i++) {
      const id = String(9000 + i);
      expect(l.s.zdarzenia.indexOf(`get:${id}:koniec`)).toBeLessThan(l.s.zdarzenia.indexOf(`put:${id}:start`));
    }
  });
});
