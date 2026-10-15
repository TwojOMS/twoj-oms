import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  wierszArchiwum, wierszeMiesiaca, zapiszWiersz, oznaczSkasowana, stanArchiwumSprzedazy,
  odnotujUdanyPrzebiegArchiwum, zapiszBladArchiwum, licznikiArchiwum,
} from '../../../src/moduly/faktury/db/archiwum-sprzedazy.js';

const w = (n = {}) => ({
  uuid: 'u1', rodzaj: 'vat', numer: '12/08/2026', invoiceDate: '2026-08-03', saleDate: '2026-08-01',
  odcisk: '{"a":1}', sciezkaPdf: '2026/Sierpien/2026-08-03_12-08-2026.pdf', zapisanyAt: '2026-09-02T02:00:00Z', ...n,
});

describe('archiwum_sprzedazy', () => {
  it('zapis i odczyt po uuid', () => {
    const db = openOmsDb();
    zapiszWiersz(db, w());
    const x = wierszArchiwum(db, 'u1');
    expect(x.numer).toBe('12/08/2026');
    expect(x.sciezka_pdf).toBe('2026/Sierpien/2026-08-03_12-08-2026.pdf');
    expect(x.skasowana_at).toBeNull();
  });

  it('ponowny zapis tego samego uuid NADPISUJE odcisk i sciezke, a skasowana_at zeruje', () => {
    const db = openOmsDb();
    zapiszWiersz(db, w());
    oznaczSkasowana(db, 'u1', { at: '2026-09-03T02:00:00Z', sciezkaPdf: '2026/Sierpien/SKASOWANA_x.pdf' });
    expect(wierszArchiwum(db, 'u1').skasowana_at).toBe('2026-09-03T02:00:00Z');
    zapiszWiersz(db, w({ odcisk: '{"a":2}' }));
    const x = wierszArchiwum(db, 'u1');
    expect(x.odcisk).toBe('{"a":2}');
    expect(x.skasowana_at).toBeNull();
    expect(db.prepare('SELECT COUNT(*) c FROM archiwum_sprzedazy').get().c).toBe(1);
  });

  it('wiersze miesiaca po dacie wystawienia, bez skasowanych', () => {
    const db = openOmsDb();
    zapiszWiersz(db, w({ uuid: 'a', invoiceDate: '2026-08-01' }));
    zapiszWiersz(db, w({ uuid: 'b', invoiceDate: '2026-08-31' }));
    zapiszWiersz(db, w({ uuid: 'c', invoiceDate: '2026-09-01' }));
    zapiszWiersz(db, w({ uuid: 'd', invoiceDate: '2026-08-15' }));
    oznaczSkasowana(db, 'd', { at: 'x', sciezkaPdf: 'y' });
    expect(wierszeMiesiaca(db, '2026-08').map((r) => r.uuid)).toEqual(['a', 'b']);
  });

  it('rodzaj spoza listy jest odrzucany', () => {
    const db = openOmsDb();
    expect(() => zapiszWiersz(db, w({ rodzaj: 'proforma' }))).toThrow();
  });

  it('stan: brak wiersza = null; udany przebieg czysci blad; blad nie rusza daty sukcesu', () => {
    const db = openOmsDb();
    expect(stanArchiwumSprzedazy(db)).toBeNull();
    odnotujUdanyPrzebiegArchiwum(db, { chwila: '2026-09-02T02:10:00Z', podlogaZrobiona: true });
    let s = stanArchiwumSprzedazy(db);
    expect(s.ostatnie_udane_at).toBe('2026-09-02T02:10:00Z');
    expect(s.podloga_zrobiona_at).toBe('2026-09-02T02:10:00Z');
    zapiszBladArchiwum(db, 'inFakt 500', '2026-09-03T02:10:00Z');
    s = stanArchiwumSprzedazy(db);
    expect(s.ostatni_blad).toBe('inFakt 500');
    expect(s.ostatnie_udane_at).toBe('2026-09-02T02:10:00Z');
    odnotujUdanyPrzebiegArchiwum(db, { chwila: '2026-09-04T02:10:00Z', podlogaZrobiona: true });
    s = stanArchiwumSprzedazy(db);
    expect(s.ostatni_blad).toBeNull();
    expect(s.podloga_zrobiona_at).toBe('2026-09-02T02:10:00Z'); // nie nadpisuje pierwszej daty
  });

  it('udany przebieg bez podlogi NIE ustawia podloga_zrobiona_at', () => {
    const db = openOmsDb();
    odnotujUdanyPrzebiegArchiwum(db, { chwila: '2026-09-02T02:10:00Z', podlogaZrobiona: false });
    expect(stanArchiwumSprzedazy(db).podloga_zrobiona_at).toBeNull();
  });

  it('liczniki', () => {
    const db = openOmsDb();
    zapiszWiersz(db, w({ uuid: 'a' }));
    zapiszWiersz(db, w({ uuid: 'b' }));
    oznaczSkasowana(db, 'b', { at: 'x', sciezkaPdf: 'y' });
    expect(licznikiArchiwum(db)).toEqual({ dokumentow: 1, skasowanych: 1 });
  });
});
