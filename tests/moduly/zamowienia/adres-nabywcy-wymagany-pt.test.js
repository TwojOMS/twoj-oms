import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { createFakturaHurtem } from '../../../src/moduly/faktury/services/faktura-hurtem.js';
import { podzielDoFaktury } from '../../../src/domena/masowe.js';
import { dodajWplateReczna } from '../../../src/oms/db/platnosci.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-126.PT5: bez adresu nabywcy (ulica, kod dla PL, miasto) nie ma faktury — szary przycisk
// na karcie z powodem i odnośnikiem do „Dane do faktury”, odmowa POST przed rezerwacją numeru
// i przed programem, odmowa per zamówienie w hurcie. Dane zmyślone. Część TwojeFaktury (licznik
// serii) jest w tests/integracje/adres-nabywcy-twojefaktury-pt5.test.js — na liście wycięcia.

const headers = { authorization: 'Basic ' + Buffer.from('operator:fixture').toString('base64'), origin: 'http://localhost' };
const ADRES = { address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' };
const BEZ = { address_1: '', postcode: '', city: '' };
const ZDANIE = 'Brak adresu nabywcy (ulica, kod pocztowy, miasto)';
const POZYCJA = { nazwa: 'Lampa testowa', sku: 'LT-1', ilosc: 1, cena_brutto: '129.00', brutto_linii: '129.00', vat: null };

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Sieć zabroniona')); });
const sprzatanie = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of sprzatanie.splice(0)) await f();
});

function zamowienie(db, { zrodlo, klient = BEZ, oplacone = false }) {
  const id = zapiszZamowienie(db, 'reczne', { zrodlo_id: zrodlo, numer: `PT5-${zrodlo}`,
    klient: { company: 'Pracownia Półcień', first_name: 'Ala', last_name: 'Przykładowa', ...klient },
    dostawa: { address_1: 'Dostawcza 2', postcode: '00-951', city: 'Warszawa' },
    metoda_wysylki: 'dpd', kwota_pobrania: null, nip: null, status_woo: 'processing', oplacone_at: null,
    kwota_brutto: '129.00', koszt_dostawy_brutto: '0.00', chce_fakture: 1, anulowane: 0,
    utworzone_at: `2026-10-28T10:00:0${zrodlo % 10}`, pozycje: [POZYCJA] }, {});
  if (oplacone) {
    dodajWplateReczna(db, id, { kwota: '129.00', data: '2026-10-28' });
  }
  return id;
}

async function panelInfakt() {
  const db = openOmsDb(':memory:');
  const infakt = { znajdzKlientaPoNip: vi.fn().mockResolvedValue(null), zalozKlienta: vi.fn().mockResolvedValue(555),
    wystaw: vi.fn().mockResolvedValue({ uuid: 'fixture-pt5', numer: 'FV/PT5', ksefStatus: null }) };
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } },
    poller: { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) }, faktura: createFaktura({ db, infakt }) });
  sprzatanie.push(async () => { await app.close(); db.close(); });
  await app.ready();
  return { db, app, infakt };
}
const przycisk = (html) => html.match(/<button\b[^>]*>Wystaw fakturę<\/button>/)?.[0];
const powod = (html) => html.match(/<p class="wyjasnienie" id="powod-wystawienia-faktury">([\s\S]*?)<\/p>/)?.[1];
const liczFaktury = (db, id) => db.prepare('SELECT count(*) AS n FROM faktury WHERE zamowienie_id=?').get(id).n;

it('karta bez adresu: szary przycisk, powód z brakami i odnośnik do danych do faktury', async () => {
  const p = await panelInfakt();
  const id = zamowienie(p.db, { zrodlo: 1 });
  const r = await p.app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers });
  expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
  expect(przycisk(r.body)).toContain('disabled');
  expect(przycisk(r.body)).toContain('aria-describedby="powod-wystawienia-faktury"');
  expect(powod(r.body)).toBe(`${ZDANIE} — <a href="#dane-faktury">uzupełnij dane do faktury</a>.`);
  expect(r.body).toContain('id="dane-faktury"');
  expect(r.body).not.toContain('id="wystaw-fakture"');
});

it('POST bez adresu: odmowa z tym zdaniem, bez rezerwacji i bez wywołania programu', async () => {
  const p = await panelInfakt();
  const id = zamowienie(p.db, { zrodlo: 2 });
  const r = await p.app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers });
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain(ZDANIE);
  expect(liczFaktury(p.db, id)).toBe(0);
  expect(p.infakt.wystaw).not.toHaveBeenCalled();
  expect(p.infakt.zalozKlienta).not.toHaveBeenCalled();
});

it('po uzupełnieniu adresu w „Dane do faktury” przycisk aktywny i POST wystawia jedną fakturę', async () => {
  const p = await panelInfakt();
  const id = zamowienie(p.db, { zrodlo: 3 });
  const zapis = await p.app.inject({ method: 'POST', url: `/zamowienia/${id}/dane/faktura`,
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'firma=Pracownia+P%C3%B3%C5%82cie%C5%84&nip=&ulica=Lampowa+1&kod=00-950&miasto=Warszawa&email=&chce_fakture=1' });
  expect(zapis.statusCode, zapis.body.slice(0, 300)).toBe(302);
  const r = await p.app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers });
  expect(przycisk(r.body)).not.toContain('disabled');
  expect(r.body).not.toContain('id="powod-wystawienia-faktury"');
  expect((await p.app.inject({ method: 'POST', url: `/zamowienia/${id}/faktura`, headers })).statusCode).toBe(302);
  expect(liczFaktury(p.db, id)).toBe(1);
  expect(p.infakt.wystaw).toHaveBeenCalledTimes(1);
});

it('faktury hurtem: jedno z adresem wystawione, drugie bez adresu w odmowach z tym zdaniem', async () => {
  const p = await panelInfakt();
  const bez = zamowienie(p.db, { zrodlo: 6, oplacone: true });
  const z = zamowienie(p.db, { zrodlo: 7, klient: ADRES, oplacone: true });
  const wiersze = [bez, z].map((id) => pobierzZamowienie(p.db, id));
  const podzial = podzielDoFaktury(wiersze);
  expect(podzial.doWystawienia.map((w) => w.id)).toEqual([z]);
  expect(podzial.pominiete).toEqual([expect.objectContaining({ id: bez, powod: expect.stringContaining(ZDANIE) })]);
  // Usługa hurtu dostaje obie (np. stan sprzed sekund) — odmowa i tak przychodzi z tej samej reguły.
  const wynik = await createFakturaHurtem({ faktura: createFaktura({ db: p.db, infakt: p.infakt }) }).wystawWiele(wiersze);
  expect(wynik.wystawione.map((w) => w.id)).toEqual([z]);
  expect(wynik.bledy).toEqual([expect.objectContaining({ id: bez, powod: expect.stringContaining(ZDANIE) })]);
  expect(liczFaktury(p.db, bez)).toBe(0);
  expect(p.infakt.wystaw).toHaveBeenCalledTimes(1);
});
