import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';

const AUTH = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
};
const POST = {
  ...AUTH,
  origin: 'http://localhost',
  'content-type': 'application/x-www-form-urlencoded',
};
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

function powrotZMenu(body) {
  const poczatek = body.indexOf('<form method="post" action="/motyw"');
  const menu = body.slice(poczatek, body.indexOf('</form>', poczatek));
  const dopasowanie = menu.match(/name="powrot" value="([^"]*)"/);
  expect(dopasowanie, 'menu nie niesie adresu powrotu dla motywu').not.toBeNull();
  return dopasowanie[1].replaceAll('&amp;', '&');
}

const cialoPodgladu = () => new URLSearchParams([
  ['data', '2026-09-14'],
  ['powod', 'nie pasuje'],
  ['klucz', 's77'],
  ['nazwa', 'Kot 70x100'],
  ['ilosc', '1'],
  ['pozycja_kwota', '99.00'],
]).toString();

describe('menu motywu na ekranach renderowanych przez POST', () => {
  let app;
  let id;

  beforeEach(async () => {
    const db = openOmsDb(':memory:');
    id = zapiszZamowienie(db, 'pro', {
      zrodlo_id: 7301,
      numer: '7301',
      klient: { email: 'klient@example.test' },
      dostawa: {},
      metoda_wysylki: 'dpd',
      kwota_pobrania: null,
      chce_fakture: 0,
      nip: null,
      kwota_brutto: '99.00',
      koszt_dostawy_brutto: '0.00',
      koszt_dostawy_netto: '0.00',
      status_woo: 'processing',
      oplacone_at: null,
      anulowane: 0,
      utworzone_at: '2026-09-14T08:00:00Z',
      pozycje: [{
        zrodlo_id: 77,
        nazwa: 'Kot 70x100',
        sku: 'PRO-KOT-001',
        ilosc: 1,
        cena_brutto: '99.00',
        brutto_linii: '99.00',
        vat: null,
      }],
    }, {});
    app = buildOmsServer({ db, config });
    await app.ready();
  });

  it('po podgladzie zwrotu wraca GET-em na ekran, z ktorego wyslano formularz', async () => {
    const ekranZwrotu = `/zamowienia/${id}/zwrot?powrot=${encodeURIComponent('/?status=nowe')}`;
    const podglad = await app.inject({
      method: 'POST',
      url: `/zamowienia/${id}/zwrot/podglad`,
      headers: { ...POST, referer: `http://localhost${ekranZwrotu}` },
      payload: cialoPodgladu(),
    });
    expect(podglad.statusCode).toBe(200);

    const cel = powrotZMenu(podglad.body);
    expect(cel).toBe(ekranZwrotu);

    const motyw = await app.inject({
      method: 'POST', url: '/motyw', headers: POST, payload: new URLSearchParams({ powrot: cel }).toString(),
    });
    expect(motyw.statusCode).toBe(302);
    expect(motyw.headers.location).toBe(ekranZwrotu);

    const powrot = await app.inject({ method: 'GET', url: motyw.headers.location, headers: AUTH });
    expect(powrot.statusCode).toBe(200);
  });

  it('na odmowie ustawien wraca GET-em do sekcji ustawien', async () => {
    const ekranUstawien = '/ustawienia/zamowienia-i-wysylka?sekcja=paczka';
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer: `http://localhost${ekranUstawien}` },
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });
    expect(odmowa.statusCode).toBe(400);

    const cel = powrotZMenu(odmowa.body);
    expect(cel).toBe(ekranUstawien);
    const motyw = await app.inject({
      method: 'POST', url: '/motyw', headers: POST, payload: new URLSearchParams({ powrot: cel }).toString(),
    });
    const powrot = await app.inject({ method: 'GET', url: motyw.headers.location, headers: AUTH });
    expect(powrot.statusCode).toBe(200);
  });

  it('porownuje caly origin razem z portem', async () => {
    const ekranUstawien = '/ustawienia/zamowienia-i-wysylka?sekcja=paczka';
    const wspolne = {
      ...POST,
      host: '127.0.0.1:3998',
      origin: 'http://127.0.0.1:3998',
    };
    const tenSamPort = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...wspolne, referer: `http://127.0.0.1:3998${ekranUstawien}` },
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });
    expect(powrotZMenu(tenSamPort.body)).toBe(ekranUstawien);

    const obcyPort = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...wspolne, referer: `http://127.0.0.1:3999${ekranUstawien}` },
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });
    expect(powrotZMenu(obcyPort.body)).toBe('/');
  });

  it('odrzuca Referer prowadzacy tylko do POST i bierze bezpieczny powrot z ciala', async () => {
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer: 'http://localhost/ustawienia/paczka' },
      payload: new URLSearchParams({
        waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5',
        powrot: '/ustawienia/zamowienia-i-wysylka?sekcja=paczka',
      }).toString(),
    });

    expect(powrotZMenu(odmowa.body)).toBe('/ustawienia/zamowienia-i-wysylka?sekcja=paczka');
  });

  it('dla obcego Referer i ciala prowadzacego tylko do POST wraca na liste', async () => {
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer: 'https://obcy.example/ustawienia/zamowienia-i-wysylka' },
      payload: new URLSearchParams({
        waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5', powrot: '/ustawienia/paczka',
      }).toString(),
    });

    expect(powrotZMenu(odmowa.body)).toBe('/');
  });

  it('czysci zlosliwy zagniezdzony powrot z Referer i zachowuje pozostale query', async () => {
    const referer = 'http://localhost/ustawienia/zamowienia-i-wysylka'
      + '?edytuj=paczka&powrot=https%3A%2F%2Fobcy.example%2Fhaslo';
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer },
      payload: new URLSearchParams({
        waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5',
        powrot: '/?powrot=%2F%3Fstatus%3Dnowe',
      }).toString(),
    });

    expect(powrotZMenu(odmowa.body)).toBe('/ustawienia/zamowienia-i-wysylka?edytuj=paczka');
  });

  it('usuwa wszystkie duplikaty zagniezdzonego powrotu z Referer', async () => {
    const referer = 'http://localhost/ustawienia/zamowienia-i-wysylka'
      + '?edytuj=paczka&powrot=%2F%3Fstatus%3Dnowe&powrot=%2F%3Fstatus%3Dgotowe';
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer },
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });

    expect(powrotZMenu(odmowa.body)).toBe('/ustawienia/zamowienia-i-wysylka?edytuj=paczka');
  });

  it('bez Referer i bez powrotu w ciele uzywa listy', async () => {
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: POST,
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });

    expect(powrotZMenu(odmowa.body)).toBe('/');
  });

  // ⚠️ FASTIFY 5 (2026-09-29): `app.hasRoute` porownuje WZORZEC definicji trasy
  // (`/zamowienia/:id`), a nie konkretna sciezke. Adres karty z numerem przestal pasowac
  // i powrot po cichu spadal na liste — bez bledu i bez sladu w logu. Trzy przypadki nizej
  // rozdzielaja: karta z Referer, karta z pola `powrot`, adres o ksztalcie karty, ktory
  // trasa GET nie jest (strażnik ma go dalej odrzucac).
  it('z karty zamowienia wraca na te karte, nie na liste', async () => {
    const karta = `/zamowienia/${id}`;
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer: `http://localhost${karta}` },
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });
    expect(powrotZMenu(odmowa.body)).toBe(karta);

    const motyw = await app.inject({
      method: 'POST', url: '/motyw', headers: POST, payload: new URLSearchParams({ powrot: karta }).toString(),
    });
    expect(motyw.statusCode).toBe(302);
    expect(motyw.headers.location).toBe(karta);
    const powrot = await app.inject({ method: 'GET', url: motyw.headers.location, headers: AUTH });
    expect(powrot.statusCode).toBe(200);
  });

  it('bierze karte z pola powrot, gdy Referer nie ma', async () => {
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: POST,
      payload: new URLSearchParams({
        waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5', powrot: `/zamowienia/${id}`,
      }).toString(),
    });
    expect(powrotZMenu(odmowa.body)).toBe(`/zamowienia/${id}`);
  });

  it('odrzuca adres o ksztalcie karty, ktory nie jest trasa GET', async () => {
    const odmowa = await app.inject({
      method: 'POST',
      url: '/ustawienia/paczka',
      headers: { ...POST, referer: `http://localhost/zamowienia/${id}/nie-ma-takiej` },
      payload: new URLSearchParams({ waga: '0', dlugosc: '100', szerokosc: '70', wysokosc: '5' }).toString(),
    });
    expect(powrotZMenu(odmowa.body)).toBe('/');
  });
});
