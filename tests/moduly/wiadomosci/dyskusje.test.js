import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  createOdswiezanieSpraw, sprawyOtwarte, STATUSY_OTWARTE,
} from '../../../src/moduly/wiadomosci/services/dyskusje.js';

// ⚠️⚠️ RUSZTOWANIE NA DWA MIESIACE. Od 28.10.2026 Allegro wprowadza Problemy z zakupem do
// Centrum wiadomosci jako typ watku POST_PURCHASE_ISSUE, obslugiwany WYLACZNIE przez
// /messaging. Wtedy ten modul, `pobierzSprawy` w kliencie i tabela `allegro_sprawy` maja
// zostac SKASOWANE — alternatywa dla rusztowania byly dwa miesiace slepoty na sprawy,
// ktore maja terminy.

const teraz = () => new Date('2026-08-28T21:00:00Z');

const sprawa = (id, status, typ = 'DISPUTE') => ({
  id, type: typ, status, buyer: { login: 'kup' },
  checkoutForm: { id: 'zam-1' }, openedDate: '2026-08-27T10:00:00Z',
});

const klient = (sprawy) => ({ pobierzSprawy: async () => ({ sprawy, razem: sprawy.length }) });

describe('dyskusje i reklamacje', () => {
  it('zapisuje sprawy z obu kanałów do lustra', async () => {
    const db = openOmsDb(':memory:');
    const o = createOdswiezanieSpraw({
      db,
      klienci: {
        allegro_szkicownia: klient([sprawa('d1', 'DISPUTE_ONGOING')]),
        allegro_amarka: klient([sprawa('c1', 'CLAIM_SUBMITTED', 'CLAIM')]),
      },
      teraz,
    });
    await o.przebieg();
    expect(sprawyOtwarte(db)).toHaveLength(2);
  });

  it('sprawy zamknięte NIE trafiają na listę otwartych', async () => {
    const db = openOmsDb(':memory:');
    const o = createOdswiezanieSpraw({
      db, klienci: { allegro_szkicownia: klient([sprawa('d1', 'DISPUTE_CLOSED')]) }, teraz,
    });
    await o.przebieg();
    expect(sprawyOtwarte(db)).toHaveLength(0);
  });

  it('zmiana statusu AKTUALIZUJE wpis, nie dubluje', async () => {
    const db = openOmsDb(':memory:');
    const kanal = { pobierzSprawy: async () => ({ sprawy: [sprawa('d1', 'DISPUTE_ONGOING')], razem: 1 }) };
    await createOdswiezanieSpraw({ db, klienci: { allegro_szkicownia: kanal }, teraz }).przebieg();
    kanal.pobierzSprawy = async () => ({ sprawy: [sprawa('d1', 'DISPUTE_CLOSED')], razem: 1 });
    await createOdswiezanieSpraw({ db, klienci: { allegro_szkicownia: kanal }, teraz }).przebieg();

    expect(db.prepare('SELECT COUNT(*) AS n FROM allegro_sprawy').get().n).toBe(1);
    expect(sprawyOtwarte(db)).toHaveLength(0);
  });

  it('ta sama sprawa na DWÓCH kontach to dwa osobne wpisy', async () => {
    // ⚠️ Klucz to para (kanal, issue_id). Nic nie gwarantuje rozłączności identyfikatorów
    // między kontami, a sklejenie pokazałoby jeden spór zamiast dwóch.
    const db = openOmsDb(':memory:');
    await createOdswiezanieSpraw({
      db,
      klienci: {
        allegro_szkicownia: klient([sprawa('d1', 'DISPUTE_ONGOING')]),
        allegro_amarka: klient([sprawa('d1', 'DISPUTE_ONGOING')]),
      },
      teraz,
    }).przebieg();
    expect(db.prepare('SELECT COUNT(*) AS n FROM allegro_sprawy').get().n).toBe(2);
  });

  it('awaria kanału nie zabija drugiego', async () => {
    const db = openOmsDb(':memory:');
    const o = createOdswiezanieSpraw({
      db,
      klienci: {
        allegro_szkicownia: { pobierzSprawy: async () => { throw new Error('Allegro: HTTP 403 przy /sale/issues'); } },
        allegro_amarka: klient([sprawa('d2', 'DISPUTE_ONGOING')]),
      },
      teraz,
    });
    const wynik = await o.przebieg();
    expect(sprawyOtwarte(db)).toHaveLength(1);
    expect(wynik.bledy[0]).toContain('HTTP 403');
  });

  it('brak uprawnienia do /sale/issues NIE wywala przebiegu', async () => {
    // ⚠️ Przed przewiązaniem kanałów o `allegro:api:disputes` ten zasób odda 403 na obu
    // kontach. Przebieg ma to znieść i oddać błędy, a nie odrzucić obietnicy.
    const db = openOmsDb(':memory:');
    const pad = { pobierzSprawy: async () => { throw new Error('Allegro: HTTP 403 przy /sale/issues'); } };
    const wynik = await createOdswiezanieSpraw({
      db, klienci: { allegro_szkicownia: pad, allegro_amarka: pad }, teraz,
    }).przebieg();
    expect(wynik.bledy).toHaveLength(2);
    expect(wynik.zapisane).toBe(0);
  });

  it('lista statusów otwartych zawiera spór trwający i nierozstrzygnięty oraz zgłoszoną reklamację', () => {
    expect(STATUSY_OTWARTE).toContain('DISPUTE_ONGOING');
    expect(STATUSY_OTWARTE).toContain('DISPUTE_UNRESOLVED');
    expect(STATUSY_OTWARTE).toContain('CLAIM_SUBMITTED');
    expect(STATUSY_OTWARTE).not.toContain('DISPUTE_CLOSED');
    expect(STATUSY_OTWARTE).not.toContain('CLAIM_ACCEPTED');
  });
});
