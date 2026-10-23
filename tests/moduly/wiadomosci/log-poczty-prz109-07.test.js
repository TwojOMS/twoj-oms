import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { wiadomosciZamowienia } from '../../../src/oms/db/wiadomosci.js';
import { createWiadomosci } from '../../../src/moduly/wiadomosci/services/wiadomosci.js';
import { createPotwierdzenie } from '../../../src/moduly/wiadomosci/services/potwierdzenie.js';
import { akcjaMailKupujacy } from '../../../src/moduly/automatyzacje/akcje/mail-kupujacy.js';

const ZDANIE = 'Serwer poczty odrzucił login albo hasło. Sprawdź je w ustawieniach skrzynki u dostawcy poczty.';
const ADRES = 'kupujacy@przyklad.invalid';
const setup = (blad) => {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 9701, numer: 'LP-9701', klient: { first_name: 'Ewa', email: ADRES }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null,
    kwota_brutto: '250.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
    status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T09:15:00', termin_platnosci: '14',
    pozycje: [{ zrodlo_id: 9702, nazwa: 'Lampa', sku: 'L-1', ilosc: 1, cena_brutto: '250.00',
      cena_netto: '203.25', brutto_linii: '250.00', netto_linii: '203.25', vat: null }],
  });
  const mailer = { sendMail: async () => { throw blad; } };
  const potwierdzenie = createPotwierdzenie({ db, mailer });
  const wiadomosci = createWiadomosci({ db, mailer, config: {}, potwierdzenie });
  return { db, id, wiadomosci };
};

describe('PRZ-109.07 — trwały log błędu poczty', () => {
  for (const temat of ['przypomnienie', 'potwierdzenie']) {
    for (const [code, koncowka] of [
      ['EAUTH', `(EAUTH) — ${ZDANIE}`],
      ['E!_ABCDEFGHIJ0123456789<script>', '(E_ABCDEFGHIJ01234567) — Serwer poczty nie przyjął wiadomości (kod E_ABCDEFGHIJ01234567).'],
      [undefined, null],
    ]) {
      it(`${temat}: kod ${code ?? 'brak'} — bez treści serwera, ten sam rzucony obiekt i brak śladu wysłania`, async () => {
        const blad = Object.assign(new Error(code ? 'Invalid login: 535 sklep-login@przyklad.invalid' : 'SMTP error'), {
          code, response: '535 5.7.8 sklep-login@przyklad.invalid',
        });
        const { db, id, wiadomosci } = setup(blad);
        try {
          await expect(wiadomosci.wyslij(id, temat, { ktoKlikal: 'Anna' })).rejects.toBe(blad);
          expect(blad.code).toBe(code);
          expect(blad.zTransportuPoczty).toBe(code ? true : undefined);
          const log = db.prepare('SELECT akcja, wynik FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);
          expect(log).toHaveLength(1);
          expect(log[0].akcja).toBe(temat === 'potwierdzenie' ? 'potwierdzenie.blad' : 'wiadomosc.blad');
          const poczatek = temat === 'potwierdzenie' ? 'BŁĄD wysyłki potwierdzenia' : 'BŁĄD wysyłki „Przypomnienie o płatności"';
          expect(log[0].wynik).not.toContain('sklep-login');
          expect(log[0].wynik).not.toContain('535');
          expect(log[0].wynik).toBe(`${poczatek} do ${ADRES} (Anna): SMTP error${koncowka ? ` ${koncowka}` : ''}`);
          expect(wiadomosciZamowienia(db, id)).toHaveLength(0);
          expect(db.prepare('SELECT potwierdzenie_wyslane_at FROM zamowienia WHERE id = ?').get(id).potwierdzenie_wyslane_at).toBeNull();
        } finally { db.close(); }
      });
    }
  }

  it('automat korzysta z tego samego wpisu z kodem i nie zmienia błędu używanego przy ponowieniach', async () => {
    const blad = Object.assign(new Error('SMTP error'), { code: 'EAUTH' });
    const { db, id, wiadomosci } = setup(blad);
    try {
      const akcja = akcjaMailKupujacy({ wiadomosci: () => wiadomosci });
      await expect(akcja.wykonaj({ regula: { nazwa: 'Przypomnienie', akcja_param: { szablon: 'przypomnienie' } },
        wykonanie: { zamowienie_id: id } })).rejects.toBe(blad);
      const log = db.prepare('SELECT wynik FROM log WHERE zamowienie_id = ?').get(id);
      expect(log.wynik).toContain('(automat: Przypomnienie): SMTP error (EAUTH) — ' + ZDANIE);
      expect(blad.code).toBe('EAUTH');
    } finally { db.close(); }
  });
});
