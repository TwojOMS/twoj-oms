import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, zapiszSzablony } from '../../../src/domena/szablony-paczek.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const headers = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const adres = { nazwa: 'Jan Kowalski', company: 'Jan Kowalski', ulica: 'Polna 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL', phone: '+48500600700', email: 'j@k.pl' };

function zestaw(metoda = 'dpd') {
  const db = openOmsDb(':memory:');
  let stan = odczytajSzablony({});
  stan = zmienSzablon(stan, { nazwa: 'Mała', waga: '0,5', dlugosc: '30', szerokosc: '20', wysokosc: '10' }, 'mala').stan;
  stan = ustawDomyslnySzablon(stan, 'mala').stan;
  zapiszUstawienia(db, zapiszSzablony(stan));
  const z = {
    zrodlo_id: metoda === 'dpd' ? 3101 : 3102, numer: metoda === 'dpd' ? '3101' : '3102',
    klient: { email: 'j@k.pl', phone: '+48500600700' },
    dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
    metoda_wysylki: metoda, punkt_odbioru: metoda === 'inpost_paczkomat' ? 'KRA01M' : null,
    kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
    status_woo: 'processing', oplacone_at: '2026-07-29T13:00:00', anulowane: 0,
    utworzone_at: '2026-07-29T13:19:52', pozycje: [],
  };
  const id = zapiszZamowienie(db, 'pro', z, {});
  const nadanie = { nadaj: vi.fn().mockResolvedValue({ numerListu: 'TEST-123' }), paczkaDomyslna: { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 } };
  const app = buildOmsServer({ db, config, nadanie });
  return { app, db, id, nadanie };
}

describe('wybór szablonu podczas nadania', () => {
  it('DPD pokazuje nazwane opcje, a pola startują z aktualnego domyślnego zestawu', async () => {
    const { app, id } = zestaw();
    await app.ready();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers });
    const pole = r.body.slice(r.body.indexOf('<h3>Waga i wymiary</h3>'), r.body.indexOf('</section>', r.body.indexOf('<h3>Waga i wymiary</h3>')));

    expect(r.statusCode).toBe(200);
    expect(pole).toContain('id="szablon-paczki"');
    expect(pole).toContain('Paczka domyślna');
    expect(pole).toContain('Mała');
    expect(pole).toContain('data-dlugosc="30"');
    expect(pole).toContain('name="dlugosc" value="30"');
  });

  it('InPost A/B/C nie pokazuje wyboru nazwanych szablonów', async () => {
    const { app, id } = zestaw('inpost_paczkomat');
    await app.ready();
    const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="gabaryt"');
    expect(r.body).not.toContain('id="szablon-paczki"');
  });

  it('zmiana wyboru wpisuje cztery liczby, a ręczna poprawka przełącza na własne wymiary', async () => {
    const { app, id } = zestaw();
    await app.ready();
    const body = (await app.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj`, headers })).body;
    const pozycja = body.indexOf("const wybor = document.getElementById('szablon-paczki');");
    const script = pozycja < 0 ? '' : body.slice(body.lastIndexOf('<script>', pozycja) + 8, body.indexOf('</script>', pozycja));
    expect(script).toBeTruthy();
    const nasluch = {};
    const pola = Object.fromEntries(['waga', 'dlugosc', 'szerokosc', 'wysokosc'].map((nazwa) => [nazwa, {
      value: '', addEventListener: (typ, handler) => { nasluch[`${nazwa}:${typ}`] = handler; },
    }]));
    const formularz = { elements: { namedItem: (nazwa) => pola[nazwa] } };
    const wybor = {
      value: 'mala', selectedOptions: [{ dataset: { waga: '0.5', dlugosc: '30', szerokosc: '20', wysokosc: '10' } }],
      closest: () => formularz, addEventListener: (typ, handler) => { nasluch[`wybor:${typ}`] = handler; },
    };
    runInNewContext(script, { document: { getElementById: () => wybor } });

    nasluch['wybor:change']();
    expect(Object.fromEntries(Object.entries(pola).map(([nazwa, pole]) => [nazwa, pole.value])))
      .toEqual({ waga: '0.5', dlugosc: '30', szerokosc: '20', wysokosc: '10' });
    nasluch['dlugosc:input']();
    expect(wybor.value).toBe('');
  });

  it('POST przekazuje poprawione ręcznie liczby, nie ukryty ID szablonu', async () => {
    const { app, id, nadanie } = zestaw();
    await app.ready();
    const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/nadaj`, headers,
      payload: { ...adres, kolejnosc: '1', waga: '0,7', dlugosc: '35', szerokosc: '21', wysokosc: '11', szablon: 'mala' } });

    expect(r.statusCode).toBe(302);
    expect(nadanie.nadaj).toHaveBeenCalledOnce();
    expect(nadanie.nadaj.mock.calls[0][1]).toEqual({ waga: 0.7, dlugosc: 35, szerokosc: 21, wysokosc: 11 });
  });

  it('podgląd nadania masowego pokazuje nazwę i wymiary domyślnego zestawu', async () => {
    const { app, id } = zestaw();
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/zamowienia/masowe/nadaj-podglad', headers, payload: { id: String(id) } });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Mała');
    expect(r.body).toContain('30 × 20 × 10 cm');
  });
});
