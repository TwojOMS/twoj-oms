import { describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { dodajWplateOkresu } from '../../../src/oms/db/platnosci.js';
import { zapiszWynikAutomatu, wstrzymajFakture } from '../../../src/moduly/faktury/db/ksef-automat.js';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programTestowy } from '../../pomoc/program-testowy.js';

const auth = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}` };
function serwer(db, wbudowany) {
  const p = programTestowy({ id: 'test' });
  p.opis = { ...p.opis, wbudowany };
  const moduly = MODULY.map((m) => m.nazwa === 'faktury' ? createModulFaktury({ fabryki: { programFakturowy: () => p } }) : m);
  return buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'fixture' } }, moduly,
    env: { OMS_TRYB: 'proba', OMS_ETYKIETY_KATALOG: '/srv/praca/kierownik-petla/tmp/cB05bb', OMS_PROFORMY_KATALOG: '/srv/praca/kierownik-petla/tmp/cB05bb' } });
}
describe('miejsce dokumentu w widokach faktur', () => {
  for (const wbudowany of [false, true]) {
    const gdzie = wbudowany ? 'w zakładce FAKTURY OMS-u' : 'w Testowniku';
    it(`przerwany automat przez trasę, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, wbudowany);
      try {
        for (const wTrakcie of [{ uuid: 'u1', numer: 'FV/1' }, null]) {
          zapiszWynikAutomatu(db, { dzien: '2026-10-20', startAt: '2026-10-20T18:01:00Z', koniecAt: null, stan: 'przerwany', wTrakcie,
            wyslane: [], niepewne: [], pominiete: [], poZasadzie: [], wstrzymane: [], blad: null });
          const r = await app.inject({ method: 'GET', url: '/faktury/ksef/automat', headers: auth });
          expect(r.statusCode).toBe(200);
          expect(r.body).toContain(`Sprawdź ${gdzie}${wTrakcie ? ', czy ta faktura ma numer KSeF' : ' dokumenty z tego dnia'}`);
        }
      } finally { await app.close(); db.close(); }
    });
    it(`wstrzymane na ekranie automatyzacji, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, wbudowany);
      try {
        wstrzymajFakture(db, { uuid: 'u1', numer: 'FV/1', dzien: '2026-10-20', powod: 'Brak adresu' });
        const r = await app.inject({ method: 'GET', url: '/ustawienia/automatyzacje/systemowe', headers: auth });
        expect(r.statusCode).toBe(200);
        // PRZ-123 K440c2: przy programie z własną wysyłką pasek odsyła do ekranu wyniku automatu.
        expect(r.body).toContain(wbudowany ? 'Co się stało i jaki jest następny krok — na' : `Popraw ${gdzie} i wyślij ręcznie`);
      } finally { await app.close(); db.close(); }
    });
    it(`okres do wyjaśnienia przez trasę, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, wbudowany);
      try {
        const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
        db.prepare("UPDATE okresy_rozliczeniowe SET ksef_status = 'do_wyjasnienia' WHERE id = ?").run(okres.id);
        const r = await app.inject({ method: 'GET', url: `/okresy/${okres.id}`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`Sprawdź RĘCZNIE ${gdzie}, czy dokument za ten miesiąc powstał`);
        expect(r.body).toContain(`skasuj go ${gdzie}`);
      } finally { await app.close(); db.close(); }
    });
    it(`rozliczenie anulowanego zamówienia w okresie, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:'); const app = serwer(db, wbudowany);
      try {
        const okres = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
        db.prepare("UPDATE okresy_rozliczeniowe SET stan = 'zafakturowany', numer = 'FV/1' WHERE id = ?").run(okres.id);
        db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, anulowane, utworzone_at) VALUES ('reczne', 1, 'R/1', '100.00', ?, 1, '2026-07-01')").run(okres.id);
        dodajWplateOkresu(db, okres.id, { kwota: '100.00', data: '2026-07-02' });
        const r = await app.inject({ method: 'GET', url: `/okresy/${okres.id}`, headers: auth });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain(`sprawdź ręcznie ${gdzie}, a NIE zwracaj pieniędzy klientowi`);
      } finally { await app.close(); db.close(); }
    });
  }
});
