import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { dodajZwrot, zarezerwujKorekte } from '../../../src/oms/db/zwroty.js';
import { createKorekta } from '../../../src/moduly/zwroty/services/korekta.js';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';

const auth = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
const zamowienie = (nr) => ({ zrodlo_id: nr, numer: String(nr), klient: { email: 'test@example.invalid' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '99.00',
  status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-08-01T10:00:00',
  pozycje: [{ zrodlo_id: 77, nazwa: 'Lampa', sku: 'L-1', ilosc: 1, cena_brutto: '99.00', brutto_linii: '99.00', vat: null }] });
const dokument = { uuid: 'dok-1', number: 'FV/1', invoice_date: '2026-08-01',
  services: [{ name: 'Lampa', quantity: 1, gross_price: 9900, tax_symbol: '23' }] };

function program(wbudowany, metody = {}) {
  const p = programTestowy({ id: 'test', metody });
  p.opis = { ...p.opis, wbudowany };
  return p;
}
function faktura(db, id, extra = {}) {
  db.prepare('INSERT INTO faktury (zamowienie_id, program, dokument_id, numer, utworzona_at, ksef_status, blad_opis, allegro_wyslana_at, allegro_weryfikacja, allegro_invoice_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'test', 'dok-1', extra.numer ?? 'FV/1', '2026-08-01T10:00:00Z', extra.status ?? null, extra.blad ?? null,
      extra.wyslana ?? null, extra.weryfikacja ?? null, extra.invoice ?? null);
}
function serwer(db, p) {
  const moduly = MODULY.map((m) => m.nazwa === 'faktury' ? createModulFaktury({ fabryki: { programFakturowy: () => p } }) : m);
  return buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } }, moduly,
    env: { OMS_TRYB: 'proba', OMS_ETYKIETY_KATALOG: join(tmpdir(), 'oms-test-cB05ba2'), OMS_PROFORMY_KATALOG: join(tmpdir(), 'oms-test-cB05ba2') },
    fakturaAllegro: {} });
}
const miejsce = (wbudowany) => wbudowany ? 'w zakładce FAKTURY OMS-u' : 'w Testowniku';

describe('PRZ-122 miejsca dokumentu w odpowiedziach tras', () => {
  for (const wbudowany of [true, false]) {
    it(`karta zamówienia: ponowienie PDF, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, program(wbudowany));
      try {
        const id = zapiszZamowienie(db, 'allegro_test', zamowienie(4), {});
        faktura(db, id, { wyslana: '2026-08-05T11:00:00Z', weryfikacja: 'REJECTED', invoice: 'INV-1' });
        db.prepare("UPDATE faktury SET ksef_numer = 'KS-1' WHERE zamowienie_id = ?").run(id);
        const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body.replace(/\s+/g, ' ')).toContain(`Najpierw sprawdź ${miejsce(wbudowany)}, czy PDF jest w porządku; Allegro odrzuca pliki, których nie przepuścił jego antywirus.`);
      } finally { await app.close(); db.close(); }
    });
    it(`karta zamówienia: wystawiona i do wyjaśnienia, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, program(wbudowany));
      try {
        const id = zapiszZamowienie(db, 'pro', zamowienie(1), {}); faktura(db, id);
        let r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`Treści faktury JUŻ WYSTAWIONEJ to nie zmienia — wystawiony dokument popraw KOREKTĄ ${miejsce(wbudowany)}.`);
        db.prepare("UPDATE faktury SET numer = NULL, ksef_status = 'do_wyjasnienia', blad_opis = 'Błąd' WHERE zamowienie_id = ?").run(id);
        r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`Sprawdź RĘCZNIE ${miejsce(wbudowany)}, czy dokument powstał — drugie kliknięcie to drugi dokument.`);
        // Recenzja B05ba: pasek spraw karty (kontekst.js → sprawyKarty) też dostaje miejsce z programu.
        expect(r.body).toContain(`Sprawdź ${miejsce(wbudowany)}, czy dokument powstał.`);
      } finally { await app.close(); db.close(); }
    });
    it(`ekran zwrotu: sprawdzono i nie sprawdzono, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, program(wbudowany));
      try {
        const id = zapiszZamowienie(db, 'pro', zamowienie(2), {}); faktura(db, id);
        const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
        zarezerwujKorekte(db, id, w.id, '2026-08-14T10:00:00Z');
        let r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`zlecenie zostało odrzucone. Sprawdź ${miejsce(wbudowany)} i zgłoś to, zanim zlecisz drugie.`);
        dodajZwrot(db, id, { data: '2026-08-15', kwota: '30.00', pozycje: [] });
        r = await app.inject({ method: 'GET', url: `/zamowienia/${id}/zwrot`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`Sprawdź sam ${miejsce(wbudowany)}, który zwrot ma korektę, zanim zdecydujesz, co dalej.`);
      } finally { await app.close(); db.close(); }
    });
    it(`korekta ręczna: drugi numer przy zapisanej korekcie, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, program(wbudowany));
      try {
        const id = zapiszZamowienie(db, 'pro', zamowienie(5), {}); faktura(db, id);
        const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '50.00', pozycje: [] });
        db.prepare("UPDATE zwroty SET korekta_numer = 'KOR 1' WHERE id = ?").run(w.id);
        const r = await app.inject({ method: 'POST', url: `/zamowienia/${id}/zwroty/${w.id}/korekta/reczna`, headers: { ...auth, origin: 'http://localhost' }, payload: { numer: 'KOR 2' } });
        expect(r.statusCode).toBe(400);
        expect(r.body).toContain(`Jeśli pierwszy numer jest błędny, popraw go ${miejsce(wbudowany)} i zgłoś to.`);
      } finally { await app.close(); db.close(); }
    });
    it(`lista zamówień: faktura wstrzymana przez automat KSeF, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, program(wbudowany));
      try {
        db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('ksef.automat.wstrzymane', ?, '2026-08-05T20:00:00Z')")
          .run(JSON.stringify([{ uuid: 'u1', numer: 'FV/9', powod: 'Brak NIP' }]));
        const r = await app.inject({ method: 'GET', url: '/', headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`Następny krok: popraw ${miejsce(wbudowany)} i wyślij ręcznie albo zwolnij.`);
      } finally { await app.close(); db.close(); }
    });
    it(`wyścig rezerwacji korekty, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:');
      try {
        const id = zapiszZamowienie(db, 'pro', zamowienie(3), {}); faktura(db, id);
        const w = dodajZwrot(db, id, { data: '2026-08-14', kwota: '99.00', pozycje: [{ klucz_pozycji: 's77', nazwa: 'Lampa', ilosc: 1, kwota: '99.00' }] });
        const p = program(wbudowany, { pobierzFakture: async () => { zarezerwujKorekte(db, id, w.id); return dokument; } });
        await expect(createKorekta({ db, program: p }).wystaw(id, w.id)).rejects.toThrow(`Korekta do tego zwrotu została już zlecona — sprawdź ją ${miejsce(wbudowany)}.`);
        expect(p.wystawKorekte).not.toHaveBeenCalled();
      } finally { db.close(); }
    });
  }
});
