import { describe, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, zapiszSzablony } from '../../../src/domena/szablony-paczek.js';
import { odczytajAutomaty, zmienAutomat, zapiszAutomaty } from '../../../src/domena/gabaryty-automatow.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-152.G11c: karta nadania i nadanie hurtem podsuwają gabaryt i wagę paczkomatu InPost
// oraz automatu Allegro z ustawienia „Paczkomaty i automaty” — z tej samej propozycji.
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const headers = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const ORLEN = '09164667-daa5-42dc-8087-33d7485790ac';
const DHL_BOX = '0fe5b4af-9f09-443d-9d49-62331a20b5b2';

const zamowienie = (n, nad = {}) => ({
  zrodlo_id: n, numer: String(n),
  klient: { email: 'j@example.test', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: 'dpd', punkt_odbioru: null, kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '99.00',
  status_woo: 'processing', oplacone_at: '2026-10-13T13:00:00', anulowane: 0,
  utworzone_at: '2026-10-13T13:13:48Z', pozycje: [], ...nad,
});

function zestaw({ automaty = null } = {}) {
  const db = openOmsDb(':memory:');
  let szablony = odczytajSzablony({});
  szablony = zmienSzablon(szablony, { nazwa: 'Duża', waga: '3', dlugosc: '110', szerokosc: '75', wysokosc: '1' }, 'duza').stan;
  szablony = ustawDomyslnySzablon(szablony, 'duza').stan;
  zapiszUstawienia(db, zapiszSzablony(szablony));
  if (automaty) {
    let stan = odczytajAutomaty({});
    for (const dane of automaty) {
      const w = zmienAutomat(stan, dane);
      expect(w.bledy).toEqual([]);
      stan = w.stan;
    }
    zapiszUstawienia(db, zapiszAutomaty(stan));
  }
  const uslugi = {};
  const nadanie = { nadaj: vi.fn().mockResolvedValue({ numerListu: 'TEST-1' }), paczkaDomyslna: { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 } };
  const kurierzy = { allegro_wza: { pobierzMetodeDostawy: vi.fn(async (z) => uslugi[z.id]) } };
  const app = buildOmsServer({ db, config, nadanie, kurierzy });
  const paczkomat = () => zapiszZamowienie(db, 'pro', zamowienie(1590, { metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'KRA01M' }), {});
  const automat = (numer, usluga) => {
    const id = zapiszZamowienie(db, 'allegro_swietlik', zamowienie(numer, { metoda_wysylki: 'allegro_punkt', punkt_odbioru: 'P1' }), {});
    uslugi[id] = usluga;
    return id;
  };
  return { app, paczkomat, automat };
}

const USTAWIENIE = [
  { cel: 'paczkomat', gabaryt: 'C', waga: '7' },
  { cel: 'allegro', gabaryt: 'M', waga: '4' },
  { cel: ORLEN, gabaryt: 'L', waga: '12' },
];

async function karta(app, id) {
  await app.ready();
  const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers });
  expect(r.statusCode).toBe(200);
  const akcja = r.body.indexOf(`action="/zamowienia/${id}/nadaj"`);
  const f = r.body.slice(r.body.lastIndexOf('<form', akcja), r.body.indexOf('</form>', akcja));
  const zaznaczone = [...f.matchAll(/name="gabaryt" value="([A-Z])" checked/g)].map((m) => m[1]);
  const waga = f.match(/<input name="waga" value="([^"]*)"/)?.[1];
  return { zaznaczone, waga, f };
}

async function hurt(app, ids) {
  await app.ready();
  const r = await app.inject({ method: 'POST', url: '/zamowienia/masowe/nadaj-podglad', headers, payload: { id: ids.map(String) } });
  expect(r.statusCode).toBe(200);
  const t = r.body.slice(r.body.indexOf('<table class="nadanie-hurtem"'), r.body.indexOf('</table>', r.body.indexOf('<table class="nadanie-hurtem"')));
  const wiersz = (id) => {
    const od = t.indexOf(`<select name="gabaryt_${id}"`);
    const kawalek = t.slice(od, t.indexOf('</td>', od));
    return {
      gabaryt: kawalek.match(/<option value="([A-Z])" selected>/)?.[1],
      waga: kawalek.match(new RegExp(`name="waga_${id}" value="([^"]*)"`))?.[1] ?? kawalek.match(/waga ([\d.]+) kg/)?.[1],
    };
  };
  return wiersz;
}

describe('PRZ-152.G11c: karta nadania — gabaryt i waga z ustawienia', () => {
  it('InPost: zaznaczony gabaryt i waga z ustawienia (nie A i nie waga szablonu kuriera)', async () => {
    const { app, paczkomat } = zestaw({ automaty: USTAWIENIE });
    const { zaznaczone, waga } = await karta(app, paczkomat());
    expect(zaznaczone).toEqual(['C']);
    expect(waga).toBe('7');
  });

  it('InPost bez ustawienia: A i waga domyślnego szablonu kuriera (jak dotąd)', async () => {
    const { app, paczkomat } = zestaw();
    const { zaznaczone, waga } = await karta(app, paczkomat());
    expect(zaznaczone).toEqual(['A']);
    expect(waga).toBe('3');
  });

  it('automat Allegro: wyjątek usługi wygrywa, pozostałe usługi z „wszystkie”', async () => {
    const { app, automat } = zestaw({ automaty: USTAWIENIE });
    const orlen = await karta(app, automat(7001, ORLEN));
    expect(orlen.zaznaczone).toEqual(['L']);
    expect(orlen.waga).toBe('12');
    expect(orlen.f).toContain(`name="delivery_method_id_allegro" value="${ORLEN}"`);
    const dhl = await karta(app, automat(7002, DHL_BOX));
    expect(dhl.zaznaczone).toEqual(['M']);
    expect(dhl.waga).toBe('4');
  });

  it('automat Allegro bez ustawienia: S i 1 kg (wartość startowa ustawienia), pole wagi dalej wymagane', async () => {
    const { app, automat } = zestaw();
    const { zaznaczone, waga, f } = await karta(app, automat(7003, ORLEN));
    expect(zaznaczone).toEqual(['S']);
    expect(waga).toBe('1');
    expect(f).toMatch(/<input name="waga" value="1"[^>]*\srequired[\s>]/);
  });
});

describe('PRZ-152.G11c: karta i hurt dają TĘ SAMĄ propozycję', () => {
  it.each([
    ['bez ustawienia', null],
    ['z ustawieniem i wyjątkiem', USTAWIENIE],
  ])('%s — paczkomat InPost, automat z wyjątkiem i automat „wszystkie”', async (_opis, automaty) => {
    const { app, paczkomat, automat } = zestaw({ automaty });
    const ids = [paczkomat(), automat(7011, ORLEN), automat(7012, DHL_BOX)];
    const wiersz = await hurt(app, ids);
    for (const id of ids) {
      const k = await karta(app, id);
      const h = wiersz(id);
      expect(h.gabaryt).toBeTruthy();
      expect(k.zaznaczone).toEqual([h.gabaryt]);
      expect(k.waga).toBe(h.waga);
    }
  });
});
