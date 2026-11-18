import { it, expect } from 'vitest';
import { nowyPanel, jako, get, post } from '../../pomoc/panel-konta-testowe.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';

const liczniki = (html) => {
  const bok = html.slice(
    html.indexOf('<div class="oms-menu-desktop">'),
    html.indexOf('<details class="oms-menu-mobile"'),
  );
  return Object.fromEntries(
    [...bok.matchAll(/<span class="licznik" data-status="([a-z_]+)">([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]),
  );
};

it('błędny POST Ustawień zachowuje liczby statusów z GET w obu wersjach menu', async () => {
  const { db, app } = nowyPanel();
  try {
    zalozKonto(db, {
      login: 'admin_testowy',
      imie: 'Administrator',
      haslo: 'test',
      rola: 'administrator',
      admin: true,
    });
    const admin = jako(db, 'admin_testowy');
    zapiszZamowienie(
      db,
      'test',
      {
        zrodlo_id: 1,
        numer: 'TEST-1',
        klient: { first_name: 'Jan', last_name: 'Przykładowy' },
        dostawa: {},
        metoda_wysylki: 'dpd',
        kwota_pobrania: null,
        chce_fakture: 0,
        nip: null,
        kwota_brutto: '50.00',
        status_woo: 'processing',
        oplacone_at: null,
        anulowane: 0,
        utworzone_at: new Date().toISOString(),
        pozycje: [],
      },
      {},
    );
    const ekran = await get(app, '/ustawienia/moduly', admin);
    expect(ekran.statusCode).toBe(200);
    const wzor = liczniki(ekran.body);
    expect(wzor.wszystkie).toBe('1');
    expect(wzor.nowe).toBe('1');

    const blad = await post(app, '/ustawienia/moduly', admin, { modul: 'klienci', wlacz: 'bledne' });
    expect(blad.statusCode).toBe(400);
    expect(blad.headers.location).toBeUndefined();
    expect(blad.body).toContain('musi mieć wartość 1 albo 0');
    expect(liczniki(blad.body)).toEqual(wzor);
    const telefon = blad.body.slice(blad.body.indexOf('<details class="oms-menu-mobile"'));
    expect(telefon).toMatch(/<span class="licznik">1<\/span>/);
  } finally {
    await app.close();
    db.close();
  }
});
