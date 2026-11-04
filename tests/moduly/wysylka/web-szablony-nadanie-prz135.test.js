import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-135.05: ekran „Nadaj" pyta rejestr kurierów (punktOdbioru, formularz, etykietaDrogi)
// zamiast porównań z 'inpost_paczkomat'. Zmiana BEZ zmiany zachowania — HTML ekranu ma być
// bit w bit taki sam jak przed nią. Migawki w __migawki__/ zapisano na kodzie SPRZED zmiany
// (2e081494); po zmianie test porównuje z nimi. Dane zmyślone („Pracownia Półcień").

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };
const ID_USLUGI = '0d83955a-4297-4169-adef-9790d53b11ff';

const zamowienie = (metoda, nad = {}) => ({
  zrodlo_id: 'pc-5101', numer: 'PC-5101',
  klient: { email: 'ola@polcien.example', phone: '+48500100200' },
  dostawa: { first_name: 'Ola', last_name: 'Półcień', company: 'Pracownia Półcień', address_1: 'Cienista 3',
    postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: metoda, punkt_odbioru: metoda.includes('paczkomat') || metoda === 'allegro_punkt' ? 'WAW01M' : null,
  kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '149.00',
  status_woo: 'processing', oplacone_at: '2026-10-20T10:00:00', anulowane: 0,
  utworzone_at: '2026-10-20T09:58:00', pozycje: [], ...nad,
});

async function ekranNadania(metoda, sklep, zapytanie = '') {
  const db = openOmsDb(':memory:');
  const kurierzy = { allegro_wza: { pobierzMetodeDostawy: async () => ID_USLUGI } };
  const nadanie = createNadanie({ db, kurierzy: { dpd: { nadaj: vi.fn() } }, katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-prz135-')) });
  const serwer = buildOmsServer({ db, config, poller, nadanie, kurierzy });
  const id = zapiszZamowienie(db, sklep, zamowienie(metoda), {});
  await serwer.ready();
  const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj${zapytanie}`, headers: naglowek });
  // Tylko <main> — reszta to wspólny układ strony (CSS, menu), poza zakresem tej zmiany.
  const od = r.body.indexOf('<main');
  const doKonca = r.body.indexOf('</main>') + '</main>'.length;
  return { status: r.statusCode, body: od < 0 ? r.body : r.body.slice(od, doKonca) + '\n' };
}

describe('ekran nadania bit w bit jak przed PRZ-135.05', () => {
  const przypadki = [
    ['dpd', 'dpd', 'pro', ''],
    ['paczkomat', 'inpost_paczkomat', 'pro', ''],
    ['allegro-dpd', 'allegro_dpd', 'allegro_polcien', ''],
    ['allegro-punkt-paczkomat', 'allegro_punkt', 'allegro_polcien', '?kurier=inpost_paczkomat'],
  ];
  for (const [nazwa, metoda, sklep, zapytanie] of przypadki) {
    it(`${nazwa}: HTML identyczny z migawką`, async () => {
      const { status, body } = await ekranNadania(metoda, sklep, zapytanie);
      expect(status).toBe(200);
      await expect(body).toMatchFileSnapshot(`./__migawki__/nadaj-prz135-${nazwa}.html`);
    });
  }
});
