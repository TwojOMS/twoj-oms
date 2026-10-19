// PRZ-101.08: zamówienie jest z Allegro, gdy `sklep` ma prefiks `allegro_` (jak dotąd) ALBO jest
// kluczem kanału `typ: 'allegro'` z OMS_KANALY. Demo i piaskownica mają kanały `allegro` i
// `allegro-outlet` — bez podkreślnika — i do tej poprawki ich zamówienia szły jak sklepowe: bez
// odmowy nadania własnej, płatnej paczki, bez statusu i faktury do Allegro, bez czekania na KSeF.
import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import { czyKanalAllegro, ustawKanalyAllegro, kanalyAllegro, sprawdzZmianeMetody } from '../../src/domena/wysylka.js';
import { podzielDoNadania } from '../../src/domena/masowe.js';
import { statusDlaAllegro } from '../../src/domena/allegro-status.js';
import { wolnoWyslacDoAllegro } from '../../src/domena/allegro-faktura.js';
import { czekaNaKsef, czyWierszWZakresieKsef, warunekCzekaNaKsefSql, KOLUMNA_ZLECONA_Z_PANELU_SQL } from '../../src/domena/ksef-oczekiwanie.js';
import { odnosnikPozycji } from '../../src/domena/link-pozycji.js';
import { typZamowienia } from '../../src/domena/termin-wysylki.js';
import { ocenKandydata } from '../../src/domena/podjazdy.js';
import { alarmyNazwKanalow } from '../../src/moduly/zdrowie/bezpiecznik-kanalow.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../src/oms/db/zamowienia.js';
import { createSyncSklep } from '../../src/moduly/zamowienia/services/sync-sklep.js';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

const KANALY_DEMO = ['allegro', 'allegro-outlet'];
afterEach(() => ustawKanalyAllegro([]));

const zamowienie = (sklep, nad = {}) => ({
  id: 1, numer: '1001', sklep, zrodlo_id: 'a1b2c3', metoda_wysylki: 'allegro_dpd', przesylki: [], ...nad,
});

describe('czyKanalAllegro — prefiks albo kanał typu allegro z konfiguracji', () => {
  it('bez rejestru (testy, skrypty) — tylko prefiks, jak przed zmianą', () => {
    expect(kanalyAllegro()).toEqual([]);
    expect(czyKanalAllegro({ sklep: 'allegro_x' })).toBe(true);
    expect(czyKanalAllegro({ sklep: 'allegro' })).toBe(false);
    expect(czyKanalAllegro({ sklep: 'allegro-outlet' })).toBe(false);
  });
  it('z rejestrem: klucze demo są Allegro, prefiks dalej działa, woo i „allegrowy” nie', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    for (const sklep of ['allegro', 'allegro-outlet', 'allegro_x']) expect(czyKanalAllegro({ sklep })).toBe(true);
    for (const sklep of ['polcien', 'allegrowy', 'reczne', '', 'ALLEGRO']) expect(czyKanalAllegro({ sklep })).toBe(false);
    expect(czyKanalAllegro(null)).toBe(false);
  });
  it('zbiór podany wprost wygrywa z rejestrem (czysta funkcja)', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    expect(czyKanalAllegro({ sklep: 'allegro' }, new Set())).toBe(false);
    expect(czyKanalAllegro({ sklep: 'rynek' }, new Set(['rynek']))).toBe(true);
  });
});

describe('skutki dla kanałów demo (rejestr ustawiony)', () => {
  it('odmowa przestawienia zamówienia Allegro na dostawę, którą panel sam nadaje', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    for (const sklep of [...KANALY_DEMO, 'allegro_a']) {
      expect(sprawdzZmianeMetody('dpd', false, '', '', zamowienie(sklep)).blad).toMatch(/przyszło z Allegro/);
    }
    expect(sprawdzZmianeMetody('dpd', false, '', '', zamowienie('polcien')).blad).toBeNull();
  });
  it('nadanie hurtem pomija zamówienie Allegro z ręcznie ustawioną metodą sklepową', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    const { doNadania, pominiete } = podzielDoNadania([
      zamowienie('allegro', { id: 1, metoda_wysylki: 'dpd' }),
      zamowienie('allegro-outlet', { id: 2, metoda_wysylki: 'dpd' }),
      zamowienie('polcien', { id: 3, metoda_wysylki: 'dpd' }),
    ]);
    expect(pominiete.map(p => p.id)).toEqual([1, 2]);
    expect(pominiete[0].powod).toMatch(/z Allegro/);
    expect(doNadania.map(z => z.id)).toEqual([3]);
  });
  it('status realizacji idzie do Allegro', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    expect(statusDlaAllegro(zamowienie('allegro', { wyslane_at: '2026-10-18T10:00:00Z' }), null)).toBe('SENT');
    expect(statusDlaAllegro(zamowienie('polcien', { wyslane_at: '2026-10-18T10:00:00Z' }), null)).toBeNull();
  });
  it('„Wyślij do Allegro” przy fakturze dostępne dla kanału demo', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    const z = (sklep) => zamowienie(sklep, { chce_fakture: 1, faktura: null });
    expect(wolnoWyslacDoAllegro(z('allegro-outlet')).powod).not.toMatch(/nie przyszło z Allegro/);
    expect(wolnoWyslacDoAllegro(z('polcien')).powod).toMatch(/nie przyszło z Allegro/);
  });
  it('faktura z kanału demo czeka na KSeF jak allegrowa', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    const z = (sklep) => ({ sklep, chce_fakture: 1, anulowane: 0, faktura: { numer: 'FV/1', infakt_uuid: 'u1', ksef_numer: null, allegro_wyslana_at: null } });
    expect(czekaNaKsef(z('allegro'))).toBe(true);
    expect(czekaNaKsef(z('polcien'))).toBe(false);
    expect(czyWierszWZakresieKsef({ sklep: 'allegro-outlet', zlecona_z_panelu: 0 })).toBe(true);
  });
  it('link pozycji prowadzi do oferty Allegro, termin liczy się jak Allegro, podjazd zna konto', () => {
    ustawKanalyAllegro(['rynek']);
    expect(odnosnikPozycji({ sklep: 'rynek' }, { ofertaId: '123' })?.adres).toMatch(/allegro/);
    expect(typZamowienia({ sklep: 'rynek', pozycje: [] })).toBe('allegro');
    expect(typZamowienia({ sklep: 'polcien', pozycje: [] })).toBe('krotki');
    // produkcja: luźna reguła terminu bez zmian
    expect(typZamowienia({ sklep: 'Allegro_B', pozycje: [] })).toBe('allegro');
    const paczka = { kurier: 'allegro_wza', status: 'nadana', etykieta_zpl_sciezka: '/l.zpl', sklep: 'rynek', id_przesylki_kuriera: 's1' };
    const meta = { id: 's1', deliveryMethodId: 'm1', pickupAvailable: true, transport: ['DPD'] };
    expect(ocenKandydata({ przesylka: paczka, metaWza: meta }).wolno).toBe(true);
    expect(ocenKandydata({ przesylka: { ...paczka, sklep: 'polcien' }, metaWza: meta }).powod).toBe('Nieznane konto Allegro.');
  });
  it('strażnik PRZ-062 nie alarmuje o kanale typu allegro bez prefiksu; sklep „allegro…” dalej alarmuje', () => {
    expect(alarmyNazwKanalow([{ klucz: 'allegro', typ: 'allegro' }, { klucz: 'rynek', typ: 'allegro' }])).toEqual([]);
    expect(alarmyNazwKanalow([{ klucz: 'allegrowy', typ: 'woo' }])).toHaveLength(1);
  });
});

describe('SQL KSeF dzieli po kanale tak samo jak predykat', () => {
  function baza() {
    const db = openOmsDb(':memory:');
    const idy = {};
    for (const [i, sklep] of ['allegro', 'allegro-outlet', 'allegro_x', 'polcien', 'allegrowy'].entries()) {
      const id = zapiszZamowienie(db, sklep, {
        zrodlo_id: `${sklep}-${i}`, numer: String(3000 + i), klient: { first_name: 'Jan' }, dostawa: {}, metoda_wysylki: 'dpd',
        kwota_pobrania: null, chce_fakture: 1, nip: null, kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
        status_woo: 'processing', oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-18T09:00:00', pozycje: [],
      }, {});
      db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?,?,?,?)').run(id, `u${i}`, `FV/${i}`, '2026-10-18T10:00:00Z');
      idy[id] = sklep;
    }
    return { db, idy };
  }
  const zSqla = (db) => db.prepare(`SELECT f.zamowienie_id, z.sklep, ${KOLUMNA_ZLECONA_Z_PANELU_SQL} FROM faktury f
    JOIN zamowienia z ON z.id = f.zamowienie_id WHERE ${warunekCzekaNaKsefSql()}`).all().filter(czyWierszWZakresieKsef).map(w => w.sklep).sort();

  it('z rejestrem demo: allegro i allegro-outlet liczą się jak Allegro', () => {
    ustawKanalyAllegro(KANALY_DEMO);
    const { db } = baza();
    try { expect(zSqla(db)).toEqual(['allegro', 'allegro-outlet', 'allegro_x']); } finally { db.close(); }
  });
  it('bez rejestru: tylko prefiks (produkcja bez zmian), SQL identyczny jak przed zmianą', () => {
    const { db } = baza();
    try { expect(zSqla(db)).toEqual(['allegro_x']); } finally { db.close(); }
    expect(warunekCzekaNaKsefSql()).not.toContain(' IN (');
  });
  it('rejestr z samymi kluczami allegro_* (produkcja) daje SQL identyczny jak bez rejestru', () => {
    const bez = warunekCzekaNaKsefSql();
    ustawKanalyAllegro(['allegro_a', 'allegro_b']);
    expect(warunekCzekaNaKsefSql()).toBe(bez);
  });
});

describe('usługa statusu i budowa aplikacji', () => {
  it('zmiana statusu zamówienia z kanału demo trafia do klienta Allegro (atrapa)', async () => {
    ustawKanalyAllegro(KANALY_DEMO);
    const db = openOmsDb(':memory:');
    try {
      const id = zapiszZamowienie(db, 'allegro-outlet', {
        zrodlo_id: 'aaaa-1', numer: '4001', klient: { first_name: 'Jan' }, dostawa: {}, metoda_wysylki: 'allegro_dpd',
        kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '100.00', koszt_dostawy_brutto: '0.00',
        status_woo: 'READY_FOR_PROCESSING', oplacone_at: '2026-10-18T09:00:00Z', anulowane: 0, utworzone_at: '2026-10-18T09:00:00', pozycje: [],
      }, {});
      db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-10-18T12:00:00Z', id);
      const allegro = { pobierzStanRealizacji: vi.fn(async () => 'PROCESSING'), ustawStatusRealizacji: vi.fn(async () => {}) };
      const woo = { ustawStatus: vi.fn(async () => {}) };
      const wynik = await createSyncSklep({ db, klienci: { 'allegro-outlet': woo }, klienciKanalow: { 'allegro-outlet': allegro } }).odeslijStatus(id);
      expect(wynik).toEqual({ wyslany: 'SENT' });
      expect(allegro.ustawStatusRealizacji).toHaveBeenCalledWith('aaaa-1', 'SENT');
      expect(woo.ustawStatus).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it('zbudowanie aplikacji z OMS_KANALY ustawia rejestr z kanałów typu allegro', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env: {
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_USER: 'serwis108', OMS_PASS: 'syntetyczne-108',
      OMS_PROFORMY_KATALOG: os.tmpdir(), OMS_ETYKIETY_KATALOG: os.tmpdir(),
      OMS_KANALY: JSON.stringify([{ klucz: 'allegro', typ: 'allegro', prefiks: 'ALG' }, { klucz: 'allegro-outlet', typ: 'allegro', prefiks: 'ALO' },
        { klucz: 'polcien', typ: 'woo', prefiks: 'PLC' }]),
    } });
    try {
      expect(kanalyAllegro().sort()).toEqual(['allegro', 'allegro-outlet']);
      expect(czyKanalAllegro({ sklep: 'allegro-outlet' })).toBe(true);
      expect(czyKanalAllegro({ sklep: 'polcien' })).toBe(false);
    } finally { await z.app.close(); z.db.close(); fetchSpy.mockRestore(); }
  });
});
