import { describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { createFakturaOkresu } from '../../../src/moduly/faktury/services/faktura-okresu.js';
import { createWysylkaKsef } from '../../../src/moduly/faktury/services/wysylka-ksef.js';
import { createFaktura } from '../../../src/moduly/faktury/services/faktura.js';
import { programTestowy } from '../../pomoc/program-testowy.js';

function program(wbudowany, metody = {}) {
  const p = programTestowy({ id: 'test', metody });
  p.opis = { ...p.opis, wbudowany };
  return p;
}
function baza() {
  const db = openOmsDb(':memory:');
  const okres = zapewnijOkres(db, { klientKlucz: 'polcien', rok: 2026, miesiac: 7 });
  db.prepare("INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id, utworzone_at, klient_json) VALUES ('reczne', 1, 'R/1', '100.00', ?, '2026-07-01', ?)")
    .run(okres.id, JSON.stringify({ address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' }));
  const id = db.prepare("SELECT id FROM zamowienia WHERE numer = 'R/1'").get().id;
  db.prepare("INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo) VALUES (?, 'Lampa', 1, '100.00', '100.00', 'reczna')").run(id);
  return { db, okres, id };
}
describe('miejsce dokumentu w komunikatach usług', () => {
  for (const wbudowany of [false, true]) {
    const gdzie = wbudowany ? 'w zakładce FAKTURY OMS-u' : 'w Testowniku';
    it(`brak klienta okresu, wbudowany=${wbudowany}`, async () => {
      const { db, okres } = baza(); const p = program(wbudowany, { przygotujNabywce: async () => null });
      const zdanie = wbudowany
        ? 'W OMS-ie nie ma klienta o NIP 1234500011 — dodaj go z danymi do faktury na ekranie Stali klienci i ponów wystawienie.'
        : 'W Testowniku nie ma klienta o NIP 1234500011 — załóż go tam raz, ręcznie, i ponów wystawienie.';
      try {
        await expect(createFakturaOkresu({ db, program: p }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(zdanie);
        expect(p.wystaw).not.toHaveBeenCalled();
      } finally { db.close(); }
    });
    it(`kolizja faktury zamówienia, wbudowany=${wbudowany}`, () => {
      const { db, id } = baza(); const p = program(wbudowany);
      try {
        rozpocznijFakture(db, id);
        db.prepare("UPDATE faktury SET ksef_status = 'do_wyjasnienia' WHERE zamowienie_id = ?").run(id);
        expect(() => rozpocznijFakture(db, id, { nazwa: p.opis.nazwa, program: p })).toThrow(`Sprawdź RĘCZNIE ${gdzie}`);
        db.prepare("UPDATE faktury SET ksef_status = 'w_toku', utworzona_at = '2000-01-01' WHERE zamowienie_id = ?").run(id);
        expect(() => rozpocznijFakture(db, id, { nazwa: p.opis.nazwa, program: p })).toThrow(`Sprawdź RĘCZNIE ${gdzie}`);
      } finally { db.close(); }
    });
    // Recenzja B05bb: przez usługę — pilnuje, że `wystaw` podaje program do rezerwacji (faktura.js).
    it(`kolizja przez usługę wystawienia, wbudowany=${wbudowany}`, async () => {
      const { db, id } = baza(); const p = program(wbudowany);
      try {
        db.prepare('UPDATE zamowienia SET okres_rozliczeniowy_id = NULL, chce_fakture = 1 WHERE id = ?').run(id);
        rozpocznijFakture(db, id);
        db.prepare("UPDATE faktury SET ksef_status = 'do_wyjasnienia' WHERE zamowienie_id = ?").run(id);
        await expect(createFaktura({ db, program: p }).wystaw(id)).rejects.toThrow(`Sprawdź RĘCZNIE ${gdzie}`);
      } finally { db.close(); }
    });
    it(`okres do wyjaśnienia, wbudowany=${wbudowany}`, async () => {
      const { db, okres } = baza(); const p = program(wbudowany);
      try {
        db.prepare("UPDATE okresy_rozliczeniowe SET ksef_status = 'do_wyjasnienia' WHERE id = ?").run(okres.id);
        await expect(createFakturaOkresu({ db, program: p }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(`Sprawdź RĘCZNIE ${gdzie}`);
      } finally { db.close(); }
    });
    it(`faktura pojedyncza w okresie, wbudowany=${wbudowany}`, async () => {
      const { db, okres, id } = baza(); const p = program(wbudowany);
      try {
        rozpocznijFakture(db, id);
        await expect(createFakturaOkresu({ db, program: p }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(`rozstrzygnij najpierw tamten dokument ${gdzie}`);
      } finally { db.close(); }
    });
    it(`pusta odpowiedź wystawienia okresu, wbudowany=${wbudowany}`, async () => {
      const { db, okres } = baza(); const p = program(wbudowany, { wystaw: async () => ({}) });
      try {
        await expect(createFakturaOkresu({ db, program: p }).wystaw(okres.id, { nip: '1234500011' })).rejects.toThrow(`Sprawdź RĘCZNIE ${gdzie}`);
      } finally { db.close(); }
    });
    it(`odrzucenie KSeF, wbudowany=${wbudowany}`, async () => {
      const { db } = baza(); const p = program(wbudowany, { wyslijDokumentDoKsef: async () => { throw Object.assign(new Error('odrzucono'), { status: 422 }); } });
      try {
        const d = { uuid: 'u1', number: 'FV/1', rodzaj: 'vat', client_tax_code: '1234500011' };
        const u = createWysylkaKsef({ db, program: p, fakturyWidok: { dokumenty: async () => [d] }, log: () => {} });
        const wynik = await u.wyslij({ uuids: ['u1'], miesiac: '2026-07', pole: 'invoice_date' });
        expect(wynik.pominiete[0].powod).toContain(`Popraw dane ${gdzie}`);
      } finally { db.close(); }
    });
    it(`błąd oznaczenia zapłaty, wbudowany=${wbudowany}`, async () => {
      const db = openOmsDb(':memory:');
      const p = program(wbudowany, { oznaczZaplacona: async () => { throw new Error('awaria'); } });
      try {
        const id = zapiszZamowienie(db, 'pro', { zrodlo_id: 10, numer: '10', klient: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Lampowa 1', postcode: '00-950', city: 'Warszawa' }, dostawa: {},
          metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
          status_woo: 'processing', oplacone_at: '2026-07-01', anulowane: 0,
          pozycje: [{ zrodlo_id: 1, nazwa: 'Lampa', sku: 'L1', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00', vat: null }] }, {});
        await createFaktura({ db, program: p }).wystaw(id, { termin: 'zaplacone' });
        const wpisy = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'faktura'").all(id).map((w) => w.wynik).join(' ');
        expect(wpisy).toContain(wbudowany ? gdzie : `ręcznie ${gdzie}`);
        const zdanie = wbudowany
          ? 'jako opłaconej — w zakładce FAKTURY OMS-u będzie widoczna jako NIEOPŁACONA. Zapłaty nie da się w OMS-ie zapisać ręcznie — przekaż ten wpis osobie, która utrzymuje OMS. Faktura jest w porządku'
          : 'jako opłaconej — w Testowniku zostanie na liście jako NIEOPŁACONA. Przestaw jej status ręcznie w Testowniku. Faktura jest w porządku';
        expect(wpisy).toContain(zdanie);
      } finally { db.close(); }
    });
    it(`niepewna wysyłka i awaria zapisu jej śladu, wbudowany=${wbudowany}`, async () => {
      const { db, id } = baza(); const p = program(wbudowany, { wyslijDokumentDoKsef: async () => { throw new Error('timeout'); } });
      try {
        const d = { uuid: 'u1', number: 'FV/1', rodzaj: 'vat', client_tax_code: '1234500011', zamowienie: { id, numer: 'R/1' } };
        const u = createWysylkaKsef({ db, program: p, fakturyWidok: { dokumenty: async () => [d] }, log: () => {} });
        await u.wyslij({ uuids: ['u1'], miesiac: '2026-07', pole: 'invoice_date' });
        const log = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'ksef'").all(id).map((w) => w.wynik).join(' ');
        expect(log).toContain(`Sprawdź ${gdzie}, zanim wyślesz ponownie`);
        db.prepare('DELETE FROM wysylki_ksef WHERE uuid = ?').run('u1');
        db.exec("CREATE TRIGGER blad_sladu BEFORE INSERT ON log WHEN NEW.wynik LIKE '%NIE WIADOMO%' BEGIN SELECT RAISE(FAIL, 'awaria'); END");
        const wynik = await u.wyslij({ uuids: ['u1'], miesiac: '2026-07', pole: 'invoice_date' });
        expect(wynik.blad).toContain(`sprawdź ${gdzie} tym pilniej`);
      } finally { db.close(); }
    });
  }
});
