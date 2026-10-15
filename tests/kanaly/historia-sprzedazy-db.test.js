import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import {
  zapiszHistorie, historiaWOknie, ustawGranice, granice,
  wczytajKursorImportu, zapiszKursorImportu,
} from '../../src/oms/db/historia-sprzedazy.js';

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zam = (n) => ({
  apiloId: n, platformAccountId: 9, numer: n, dzien: '2026-01-05',
  utworzoneAt: '2026-01-05T10:00:00.000Z', brutto: '123.00', waluta: 'PLN',
  status: 15, paymentStatus: 2, tagi: [3], klientEmail: 'a@b.pl', klientNazwa: 'A',
  faktura: 1,
  pozycje: [{ nazwa: 'Szablon', sku: 'S1', originalCode: '1|2', ilosc: 2, bruttoLinii: '100.00', typ: 1 }],
});

describe('historia sprzedazy', () => {
  it('zapisuje zamowienie razem z pozycjami', () => {
    zapiszHistorie(db, zam('WO1'));
    const [w] = historiaWOknie(db, '2026-01-01', '2026-01-31');
    expect(w.apilo_id).toBe('WO1');
    expect(w.tagi_json).toBe('[3]');
    expect(w.pozycje).toHaveLength(1);
    expect(w.pozycje[0].nazwa).toBe('Szablon');
  });

  it('DWA PRZEBIEGI DAJA TEN SAM WYNIK — import musi byc idempotentny', () => {
    zapiszHistorie(db, zam('WO1'));
    zapiszHistorie(db, zam('WO1'));
    expect(historiaWOknie(db, '2026-01-01', '2026-01-31')).toHaveLength(1);
    // ⚠️ Pozycje tez, inaczej powtorzony import podwoilby ranking produktow, nie sume.
    expect(db.prepare('SELECT COUNT(*) c FROM sprzedaz_historyczna_pozycje').get().c).toBe(1);
  });

  it('AWARIA W POLOWIE ZAPISU NIE ZOSTAWIA CZESCIOWEGO STANU — jedno zamowienie to jedna transakcja', () => {
    zapiszHistorie(db, zam('A'));
    // Druga proba na TYM SAMYM apilo_id: nowe (zle) brutto i dwie pozycje, z ktorych DRUGA
    // lamie NOT NULL na `ilosc`. Bez transakcji UPSERT naglowka i DELETE-przed-INSERT juz by
    // przeszly (kazdy `run()` to osobny autocommit), wiec baza zostalaby z brutto=999.00
    // i JEDNA pozycja ("OK") zamiast oryginalnego "Szablon" — naglowek klamalby o wlasnych
    // pozycjach, a suma zamowienia bylaby INNA niz przed nieudana proba.
    expect(() => zapiszHistorie(db, {
      ...zam('A'),
      brutto: '999.00',
      pozycje: [
        { nazwa: 'OK', sku: null, originalCode: null, ilosc: 1, bruttoLinii: '50.00', typ: 1 },
        { nazwa: 'ZLA', sku: null, originalCode: null, ilosc: null, bruttoLinii: '50.00', typ: 1 },
      ],
    })).toThrow(/NOT NULL/);
    // Rollback ma przywrocic DOKLADNIE stary stan — nie „naglowek bez pozycji", tylko stan
    // sprzed tej wywolania w calosci: stare brutto i stara, jedyna pozycja.
    const [w] = historiaWOknie(db, '2026-01-01', '2026-01-31');
    expect(w.brutto).toBe('123.00');
    expect(w.pozycje).toHaveLength(1);
    expect(w.pozycje[0].nazwa).toBe('Szablon');
  });

  it('okno jest DOMKNIETE z obu stron', () => {
    zapiszHistorie(db, { ...zam('A'), dzien: '2026-01-01' });
    zapiszHistorie(db, { ...zam('B'), dzien: '2026-01-31' });
    zapiszHistorie(db, { ...zam('C'), dzien: '2026-02-01' });
    expect(historiaWOknie(db, '2026-01-01', '2026-01-31').map((w) => w.apilo_id))
      .toEqual(['A', 'B']);
  });

  it('granice zapisuja sie i czytaja jako mapa', () => {
    ustawGranice(db, 'SZKICOWNIA_PL', '2026-07-02', 'pomiar', null);
    ustawGranice(db, 'SZKICOWNIA_PRO', '2026-07-29', 'pomiar', 'brak w Apilo');
    expect(granice(db).get('SZKICOWNIA_PL')).toBe('2026-07-02');
    expect(granice(db).get('SZKICOWNIA_PRO')).toBe('2026-07-29');
  });

  it('kursor importu przezywa zapis i odczyt', () => {
    expect(wczytajKursorImportu(db)).toEqual({ ostatniDzien: null, ostatniId: null });
    zapiszKursorImportu(db, { ostatniDzien: '2025-06-01', ostatniId: 'WO9' });
    expect(wczytajKursorImportu(db)).toEqual({ ostatniDzien: '2025-06-01', ostatniId: 'WO9' });
  });

  it('WIERSZ APILO NIE MOZE NIESC KLUCZA SKLEPOWEGO — dwie przestrzenie id w jednym PK', () => {
    expect(() => zapiszHistorie(db, { ...zam('woo:szkicownia:28225'), zrodlo: 'apilo' }))
      .toThrow(/klucz sklepowy/);
  });

  it('WIERSZ SKLEPOWY MUSI NIESC PREFIKS — inaczej nadpisze zamowienie z Apilo', () => {
    expect(() => zapiszHistorie(db, { ...zam('28225'), zrodlo: 'woo:szkicownia' }))
      .toThrow(/musi miec klucz/);
  });

  it('zapisuje zrodlo i surowy status sklepu', () => {
    zapiszHistorie(db, {
      ...zam('woo:szkicownia:28225'), zrodlo: 'woo:szkicownia', statusZrodla: 'completed',
    });
    const w = db.prepare('SELECT zrodlo, status_zrodla FROM sprzedaz_historyczna WHERE apilo_id = ?')
      .get('woo:szkicownia:28225');
    expect(w.zrodlo).toBe('woo:szkicownia');
    expect(w.status_zrodla).toBe('completed');
  });

  it('wiersz bez podanego zrodla zostaje apilowy — istniejaca baza sie nie zmienia', () => {
    zapiszHistorie(db, zam('MA260800024'));
    const w = db.prepare('SELECT zrodlo FROM sprzedaz_historyczna WHERE apilo_id = ?').get('MA260800024');
    expect(w.zrodlo).toBe('apilo');
  });
});
