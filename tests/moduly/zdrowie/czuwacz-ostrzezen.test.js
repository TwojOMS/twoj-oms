import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { lukiKsef, poTerminie } from '../../../src/oms/db/ostrzezenia.js';
import { ostrzezeniaFaktur } from '../../../src/domena/ostrzezenia.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import {
  createCzuwaczOstrzezen, oknoLukKsef, SUFIT_STRON_LUK, NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS,
} from '../../../src/moduly/zdrowie/services/czuwacz-ostrzezen.js';
import { ODSTEP_CZUWACZA_MS } from '../../../src/oms/bootstrap.ts';

// CZUWACZ OSTRZEŻEŃ (2026-08-29) — osobny zegar godzinowy piszący LUSTRA dla tabelki
// ostrzeżeń strony głównej: luki KSeF (przeniesione z czuwacza KSeF — krok terminów nie
// mieścił się w jego budżecie godzinowym: 54:10 + luki 5:00 + terminy 11:00 > 60:00)
// oraz faktury po terminie płatności (z pasa długów, fakturyWidok.nieoplacone).

const dok = (uuid, reszta = {}) => ({
  uuid,
  number: `${uuid}/08/2026`,
  invoice_date: '2026-08-27',
  ksef_number: null,
  client_tax_code: '1000001187',
  rodzaj: 'vat',
  ...reszta,
});

const przeterminowana = (uuid, reszta = {}) => ({
  uuid,
  number: `${uuid}/07/2026`,
  payment_date: '2026-08-10',
  left_to_pay: 99000,
  stanTerminu: 'po_terminie',
  ...reszta,
});

function zbuduj({
  db, dokumenty = [], nieoplacone = [], bladLuk = null, bladTerminow = null,
}) {
  const zakresy = [];
  const czuwacz = createCzuwaczOstrzezen({
    db,
    infakt: {
      listaFaktur: async (zakres, opts) => {
        zakresy.push({ zakres, opts });
        if (bladLuk) throw bladLuk;
        return dokumenty;
      },
    },
    fakturyWidok: {
      nieoplacone: async () => {
        if (bladTerminow) throw bladTerminow;
        return nieoplacone;
      },
    },
  });
  return { czuwacz, zakresy };
}

describe('czuwacz ostrzeżeń — lustro luk KSeF', () => {
  it('PRZ-102.26: luka B2C pojawia się po włączeniu i znika po wyłączeniu bez restartu', async () => {
    const db = openOmsDb(':memory:');
    const { czuwacz } = zbuduj({ db, dokumenty: [dok('b2c', { client_tax_code: '', client_first_name: 'Jan', gross_price: 12300 })] });
    try {
      await czuwacz.przebieg();
      expect(lukiKsef(db)).toEqual([]);
      db.prepare("INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES ('ksef.konsumenckie', '1', '2026-10-20')").run();
      await czuwacz.przebieg();
      expect(lukiKsef(db).map((d) => d.uuid)).toEqual(['b2c']);
      expect(ostrzezeniaFaktur({ luki: lukiKsef(db), dzis: '2026-10-20' })[0].typ).toBe('faktura-ksef');
      db.prepare("UPDATE ustawienia SET wartosc = '0' WHERE klucz = 'ksef.konsumenckie'").run();
      await czuwacz.przebieg();
      expect(lukiKsef(db)).toEqual([]);
    } finally { db.close(); }
  });
  it('pisze lustro barierą coWolnoWyslac: bez numeru KSeF i z NIP-em wchodzi, reszta nie', async () => {
    const db = openOmsDb(':memory:');
    zajmijWysylkeKsef(db, 'u-zarezerwowana');
    const { czuwacz } = zbuduj({
      db,
      dokumenty: [
        dok('u-luka'),
        dok('u-w-ksef', { ksef_number: '1234567890-20260827-ABC' }),
        dok('u-konsumencka', { client_tax_code: '' }),
        dok('u-zarezerwowana'),
      ],
    });
    await czuwacz.przebieg();
    const luki = lukiKsef(db);
    expect(luki.map((l) => l.uuid)).toEqual(['u-luka']);
    expect(luki[0]).toMatchObject({ numer: 'u-luka/08/2026', invoice_date: '2026-08-27' });
    db.close();
  });

  it('kolejny udany odczyt PODMIENIA lustro w całości', async () => {
    const db = openOmsDb(':memory:');
    await zbuduj({ db, dokumenty: [dok('u-1')] }).czuwacz.przebieg();
    await zbuduj({ db, dokumenty: [dok('u-2')] }).czuwacz.przebieg();
    expect(lukiKsef(db).map((l) => l.uuid)).toEqual(['u-2']);
    db.close();
  });

  it('odpowiedź niebędąca tablicą to odmowa, nie puste lustro', async () => {
    const db = openOmsDb(':memory:');
    await zbuduj({ db, dokumenty: [dok('u-1')] }).czuwacz.przebieg();
    await expect(zbuduj({ db, dokumenty: { entities: [] } }).czuwacz.przebieg())
      .rejects.toThrow(/kształcie|ksztalcie/);
    expect(lukiKsef(db).map((l) => l.uuid)).toEqual(['u-1']);
    db.close();
  });

  it('pyta o okno od pierwszego dnia poprzedniego miesiąca, po dacie wystawienia, z własnym sufitem', async () => {
    const db = openOmsDb(':memory:');
    const { czuwacz, zakresy } = zbuduj({ db });
    await czuwacz.przebieg();
    const [{ zakres, opts }] = zakresy;
    expect(zakres.pole).toBe('invoice_date');
    expect(zakres.od).toMatch(/^\d{4}-\d{2}-01$/);
    expect(zakres.do >= zakres.od).toBe(true);
    expect(opts).toEqual({ sufitStron: SUFIT_STRON_LUK });
    db.close();
  });
});

describe('czuwacz ostrzeżeń — lustro faktur po terminie', () => {
  it('z pasa długów bierze WYŁĄCZNIE przeterminowane i zapisuje pozostałą kwotę w groszach', async () => {
    const db = openOmsDb(':memory:');
    const { czuwacz } = zbuduj({
      db,
      nieoplacone: [
        przeterminowana('u-40'),
        przeterminowana('u-41', { payment_date: '2026-08-12', left_to_pay: 42112 }),
        przeterminowana('u-swieza', { stanTerminu: 'wkrotce' }),
        przeterminowana('u-dzisiaj', { stanTerminu: 'dzis' }),
      ],
    });
    await czuwacz.przebieg();
    const wiersze = poTerminie(db);
    expect(wiersze.map((w) => w.uuid)).toEqual(['u-40', 'u-41']);
    expect(wiersze[0]).toMatchObject({ numer: 'u-40/07/2026', payment_date: '2026-08-10', pozostalo_gr: 99000 });
    expect(wiersze[0].sprawdzona_at).toBeTruthy();
    db.close();
  });

  it('brak zaległych czyści lustro — spłacone długi znikają', async () => {
    const db = openOmsDb(':memory:');
    await zbuduj({ db, nieoplacone: [przeterminowana('u-40')] }).czuwacz.przebieg();
    await zbuduj({ db, nieoplacone: [] }).czuwacz.przebieg();
    expect(poTerminie(db)).toHaveLength(0);
    db.close();
  });
});

describe('czuwacz ostrzeżeń — izolacja kroków i zdolności', () => {
  // Awaria jednego lustra nie ma prawa zabrać drugiego — ale przebieg MUSI skończyć się
  // błędem, żeby puls zgłosił awarię (ostrzeżenie typu `integracja`).
  it('awaria luk NIE blokuje zapisu terminów, a przebieg kończy się błędem', async () => {
    const db = openOmsDb(':memory:');
    await zbuduj({ db, dokumenty: [dok('u-1')] }).czuwacz.przebieg();
    const { czuwacz } = zbuduj({
      db, bladLuk: new Error('inFakt 500'), nieoplacone: [przeterminowana('u-40')],
    });
    await expect(czuwacz.przebieg()).rejects.toThrow(/inFakt 500/);
    expect(lukiKsef(db).map((l) => l.uuid)).toEqual(['u-1']);
    expect(poTerminie(db).map((w) => w.uuid)).toEqual(['u-40']);
    db.close();
  });

  it('awaria terminów NIE blokuje zapisu luk, a przebieg kończy się błędem', async () => {
    const db = openOmsDb(':memory:');
    const { czuwacz } = zbuduj({
      db, dokumenty: [dok('u-1')], bladTerminow: new Error('pas długów padł'),
    });
    await expect(czuwacz.przebieg()).rejects.toThrow(/pas długów padł/);
    expect(lukiKsef(db).map((l) => l.uuid)).toEqual(['u-1']);
    db.close();
  });

  it('bez klienta inFaktu i widoku faktur przebieg nie robi nic i nie rzuca', async () => {
    const db = openOmsDb(':memory:');
    const czuwacz = createCzuwaczOstrzezen({ db, infakt: null, fakturyWidok: null });
    await expect(czuwacz.przebieg()).resolves.toMatchObject({ pominiety: false });
    expect(lukiKsef(db)).toHaveLength(0);
    expect(poTerminie(db)).toHaveLength(0);
    db.close();
  });

  // Ten sam strażnik, co w pollerze i czuwaczu KSeF: setInterval tyka niezależnie od tego,
  // czy poprzedni przebieg się skończył.
  it('drugi przebieg w trakcie pierwszego jest POMINIĘTY', async () => {
    const db = openOmsDb(':memory:');
    let zwolnij;
    const brama = new Promise((res) => { zwolnij = res; });
    const czuwacz = createCzuwaczOstrzezen({
      db,
      infakt: { listaFaktur: async () => { await brama; return []; } },
      fakturyWidok: null,
    });
    const pierwszy = czuwacz.przebieg();
    const drugi = await czuwacz.przebieg();
    expect(drugi).toMatchObject({ pominiety: true });
    zwolnij();
    await pierwszy;
    db.close();
  });
});

describe('okno i budżet', () => {
  it('środek roku: od pierwszego dnia poprzedniego miesiąca do dziś', () => {
    expect(oknoLukKsef('2026-08-29')).toEqual({ od: '2026-07-01', do: '2026-08-29' });
  });

  it('styczeń sięga grudnia POPRZEDNIEGO roku', () => {
    expect(oknoLukKsef('2026-01-05')).toEqual({ od: '2025-12-01', do: '2026-01-05' });
  });

  // Arytmetyka z PRAWDZIWYCH stałych klienta — podniesienie któregokolwiek limitu bez
  // policzenia skutku ma położyć panel przy starcie (strażnik w bootstrap.js), nie po
  // cichu rozjechać zegar.
  it('najgorszy przebieg mieści się między tyknięciami zegara', () => {
    expect(NAJDLUZSZY_PRZEBIEG_OSTRZEZEN_MS).toBeLessThan(ODSTEP_CZUWACZA_MS);
  });
});
