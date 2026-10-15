import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { fakturaSkasowanaWInfakcie } from '../../../src/moduly/faktury/db/faktury.js';
import { createFakturaAllegro } from '../../../src/moduly/faktury/services/faktura-allegro.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ⚠️⚠️ WYJSCIA ZE STANOW LANCUCHA KSEF → ALLEGRO (Plan B, Zadanie 11; niezmiennik 4.9).
//
// Dwie rzeczy naraz, bo sa dwiema stronami tej samej granicy:
// 1. dokument JUZ u kupujacego zamyka „odnotuj skasowanie w inFakcie" — skasowanie faktury
//    w inFakcie NIE ZABIERA JEJ KUPUJACEMU Z RAK, a zwolnienie rezerwacji dalo by druga
//    fakture na to samo zamowienie (dwa dokumenty u kupujacego, dwa numery w ksiegowosci);
// 2. faktura, ktora czeka na KSeF w nieskonczonosc, dostaje JAWNE wyjscie — swiadoma
//    decyzja czlowieka „wyslij bez numeru KSeF", zapisana w logu zamowienia.

const PDF = Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.alloc(64)]);
const GODZINA = 60 * 60 * 1000;
const przed = (ms) => new Date(Date.now() - ms).toISOString();

// Ksztalt fikstury wziety z tests/oms/faktura-allegro.test.js: `zapiszZamowienie` wklada
// do INSERT-a caly komplet kolumn, a brakujace pola trafiaja tam jako `undefined`, czego
// node:sqlite nie zwiaze (fikstura z planu nie dawala sie wykonac ani raz).
function baza({
  sklep = 'allegro_szkicownia', chce = 1, ksefStatus = null, ksefNumer = null,
  invoiceId = null, wyslanaAt = null, utworzonaAt = przed(30 * GODZINA),
} = {}) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, sklep, {
    zrodlo_id: 'CF-1', numer: 'CF-1', kwota_brutto: '100.00', chce_fakture: chce, pozycje: [],
    klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'allegro_dpd', kwota_pobrania: null, nip: null, status_woo: null,
    oplacone_at: '2026-08-05T09:00:00', anulowane: 0, utworzone_at: '2026-08-05T08:00:00',
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_status, ksef_numer,
    allegro_invoice_id, allegro_wyslana_at, utworzona_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, 'u1', '12/08/2026', ksefStatus, ksefNumer, invoiceId, wyslanaAt, utworzonaAt);
  return { db, id };
}

const klientOk = (log = []) => ({
  pobierzFakturyZamowienia: async () => { log.push('lista'); return []; },
  zglosFakture: async (cf, dane) => { log.push(['zglos', cf, dane]); return { id: 'INV-1' }; },
  wyslijPlikFaktury: async (cf, inv, b) => {
    log.push(['plik', cf, inv, b.length]);
    return { file: { securityVerification: { status: 'WAITING' } } };
  },
});

const wpisyLogu = (db, id) =>
  db.prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id').all(id);

// ---------------------------------------------------------------------------------
// 1. TRZECIA PRZESLANKA ODMOWY KASOWANIA
// ---------------------------------------------------------------------------------
describe('„skasowałem fakturę w inFakcie" po wysłaniu do Allegro', () => {
  it('ODMAWIA, gdy dokument jest już u kupującego, i każe zrobić KOREKTĘ', () => {
    const { db, id } = baza({ wyslanaAt: '2026-08-05T11:00:00Z', invoiceId: 'INV-1' });
    expect(() => fakturaSkasowanaWInfakcie(db, id)).toThrow(/Allegro/);
    expect(() => fakturaSkasowanaWInfakcie(db, id)).toThrow(/korekt/i);
    // Wiersz ZOSTAJE — bez tego zamowienie zwolniloby sie do drugiego wystawienia.
    expect(db.prepare('SELECT * FROM faktury WHERE zamowienie_id = ?').get(id)).toBeTruthy();
  });

  // Odmowa ma mowic o ALLEGRO, a nie o KSeF: faktura wyslana decyzja „bez numeru KSeF"
  // ma obie kolumny KSeF puste, wiec stara odmowa nie odezwalaby sie ani slowem.
  it('odmawia TAKŻE fakturze wysłanej BEZ numeru KSeF (obie kolumny KSeF puste)', () => {
    const { db, id } = baza({ wyslanaAt: '2026-08-05T11:00:00Z' });
    expect(() => fakturaSkasowanaWInfakcie(db, id)).toThrow(/Allegro/);
  });

  it('DALEJ odmawia po wysyłce do KSeF (stara przesłanka nietknięta)', () => {
    const { db, id } = baza({ ksefStatus: 'sent' });
    expect(() => fakturaSkasowanaWInfakcie(db, id)).toThrow(/KSeF/);
  });

  it('numer KSeF przeczytany przez czuwacza TEŻ blokuje kasowanie', () => {
    const { db, id } = baza({ ksefNumer: 'KS-1' });
    expect(() => fakturaSkasowanaWInfakcie(db, id)).toThrow(/KSeF/);
  });

  it('faktura, której nikt nigdzie nie wysłał, dalej daje się zwolnić', () => {
    const { db, id } = baza({});
    expect(fakturaSkasowanaWInfakcie(db, id).numer).toBe('12/08/2026');
    expect(db.prepare('SELECT COUNT(*) c FROM faktury WHERE zamowienie_id = ?').get(id).c).toBe(0);
  });
});


// ---------------------------------------------------------------------------------
// SEKCJE 2 i 3 (trasa `/faktura-allegro-bez-ksef` i przycisk furtki na karcie) ZNIKNELY
// 01.09.2026 razem z sama furtka — decyzja właściciela: „fv ida zawsze z ksef", a dokument bez
// numeru wysyla sie recznie z panelu Allegro albo zakladka „Wiadomosci".
//
// Czego pilnuje dzis i GDZIE: `tests/oms/faktura-allegro.test.js` — „trasy «bez numeru
// KSeF» NIE MA — ani na karcie, ani w routerze" (404 z routera, brak adresu w HTML-u)
// oraz „odmowa o KSeF to jedno zdanie o fakcie".
// ---------------------------------------------------------------------------------
