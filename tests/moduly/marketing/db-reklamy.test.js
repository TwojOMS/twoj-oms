import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszPolaczenie, polaczenia, zapiszDni, dni,
  zapiszTransakcje, transakcje, zapiszStan, stanPolaczenia,
  potwierdzoneZamowienia,
} from '../../../src/oms/db/reklamy.js';

const polaczenie = (kontoId, kanal, waluta = 'PLN') => ({
  typ: 'ga4', kontoId, kanal, waluta, strefa: 'Europe/Warsaw', sekretRef: 'klucz-testowy',
});

describe('lustro reklam oddzielne dla każdej instalacji i konta', () => {
  it('nie łączy tego samego ID kampanii z dwóch właściwości', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszPolaczenie(db, polaczenie('property-a', 'sklep_a'));
    const b = zapiszPolaczenie(db, polaczenie('property-b', 'sklep_b', 'EUR'));
    zapiszDni(db, { typ: 'ga4', polaczenieId: a.id, pobranoAt: '2026-09-23T00:00:00Z',
      wiersze: [{ dzien: '2026-09-22', kampaniaId: '42', nazwa: 'A', koszt: '10.00', klikniecia: 4, wyswietlenia: 100 }] });
    zapiszDni(db, { typ: 'ga4', polaczenieId: b.id, pobranoAt: '2026-09-23T00:00:00Z',
      wiersze: [{ dzien: '2026-09-22', kampaniaId: '42', nazwa: 'B', koszt: '20.00', klikniecia: 8, wyswietlenia: 200 }] });
    expect(dni(db, { typ: 'ga4', kampaniaId: '42' })).toHaveLength(2);
    expect(dni(db, { typ: 'ga4', polaczenieId: a.id })[0].koszt).toBe('10.00');
    expect(dni(db, { typ: 'ga4', polaczenieId: b.id })[0].koszt).toBe('20.00');
    db.close();
  });

  it('odrzuca podwójne połączenie konta i nadpisuje dojrzewający dzień', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszPolaczenie(db, polaczenie('property-a', 'sklep_a'));
    expect(() => zapiszPolaczenie(db, polaczenie('property-a', 'sklep_b'))).toThrow();
    const podstawa = { typ: 'ga4', polaczenieId: a.id, pobranoAt: '2026-09-23T00:00:00Z' };
    zapiszDni(db, { ...podstawa, wiersze: [{ dzien: '2026-09-22', kampaniaId: '42', koszt: '10.00' }] });
    zapiszDni(db, { ...podstawa, wiersze: [{ dzien: '2026-09-22', kampaniaId: '42', koszt: '11.25' }] });
    expect(dni(db, { typ: 'ga4', polaczenieId: a.id })).toMatchObject([{ koszt: '11.25' }]);
    expect(polaczenia(db)).toHaveLength(1);
    db.close();
  });

  it('zapisuje transakcje i stan źródła bez poświadczenia w lustrze', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszPolaczenie(db, polaczenie('property-a', 'sklep_a'));
    zapiszTransakcje(db, { polaczenieId: a.id, pobranoAt: '2026-09-23T00:00:00Z',
      wiersze: [{ dzien: '2026-09-22', kampaniaId: '42', transactionId: '1451', przychod: '97.40' }] });
    zapiszStan(db, { polaczenieId: a.id, ostatniaProbaAt: '2026-09-23T00:00:00Z',
      ostatniSukcesAt: '2026-09-23T00:00:00Z', kodBledu: null });
    expect(transakcje(db, { polaczenieId: a.id })[0]).toMatchObject({ transactionId: '1451', przychod: '97.40' });
    expect(stanPolaczenia(db, a.id).ostatniSukcesAt).toBe('2026-09-23T00:00:00Z');
    expect(JSON.stringify(dni(db, { typ: 'ga4' }))).not.toContain('klucz-testowy');
    db.close();
  });

  it('potwierdza transakcję w przypiętym kanale, nawet gdy sklep zapisał wejście bezpośrednie', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszPolaczenie(db, polaczenie('property-a', 'pro'));
    const insert = db.prepare(`INSERT INTO zamowienia
      (sklep,zrodlo_id,numer,kwota_brutto,atrybucja_json,utworzone_at) VALUES (?,?,?,?,?,?)`);
    insert.run('pro', 1451, '1451', '144.80', JSON.stringify({ source: 'direct' }), '2026-09-22T12:00:00Z');
    insert.run('szkicownia', 1451, '1451', '999.00', null, '2026-09-22T12:00:00Z');
    const order = db.prepare("SELECT id FROM zamowienia WHERE sklep = 'pro' AND numer = '1451'").get();
    db.prepare(`INSERT INTO pozycje (zamowienie_id,nazwa,ilosc,cena_brutto,brutto_linii,netto_linii,zrodlo)
      VALUES (?,?,?,?,?,?,?)`).run(order.id, 'Produkt', 2, '59.90', '119.80', '97.40', 'sklep');
    expect(potwierdzoneZamowienia(db, { polaczenieId: a.id, transactionIds: ['1451'] }))
      .toMatchObject({ przychod: '97.40', przychodBrutto: '144.80', liczba: 1, niepotwierdzone: 0,
        zamowienia: [{ kwota: '97.40', kwotaBrutto: '144.80', status: 'potwierdzone' }] });
    db.close();
  });

  it('sumuje netto wielu produktów, ale brak netto jednej pozycji nie zamienia w zero ani brutto', () => {
    const db = openOmsDb(':memory:');
    const a = zapiszPolaczenie(db, polaczenie('property-a', 'pro'));
    const insertOrder = db.prepare(`INSERT INTO zamowienia
      (sklep,zrodlo_id,numer,kwota_brutto,utworzone_at) VALUES ('pro',?,?,?,?)`);
    insertOrder.run(1451, '1451', '144.80', '2026-09-22T12:00:00Z');
    insertOrder.run(1452, '1452', '50.00', '2026-09-22T13:00:00Z');
    const lines = db.prepare(`INSERT INTO pozycje (zamowienie_id,nazwa,ilosc,cena_brutto,netto_linii,zrodlo)
      VALUES (?,?,?,?,?,?)`);
    const id1 = db.prepare("SELECT id FROM zamowienia WHERE numer = '1451'").get().id;
    const id2 = db.prepare("SELECT id FROM zamowienia WHERE numer = '1452'").get().id;
    lines.run(id1, 'A', 1, '61.50', '50.00', 'sklep');
    lines.run(id1, 'B', 1, '58.30', '47.40', 'sklep');
    lines.run(id2, 'C', 1, '50.00', null, 'sklep');
    const result = potwierdzoneZamowienia(db, { polaczenieId: a.id, transactionIds: ['1451', '1452'] });
    expect(result).toMatchObject({ przychod: null, przychodBrutto: '194.80', liczba: 2,
      powod: 'BRAK_KWOTY_NETTO', zamowienia: [
        { kwota: '97.40', status: 'potwierdzone' },
        { kwota: null, status: 'potwierdzone' },
      ] });
    db.close();
  });

  it('nie liczy anulowanego zamówienia ani obcej waluty jako potwierdzonego przychodu', () => {
    const db = openOmsDb(':memory:');
    const pln = zapiszPolaczenie(db, polaczenie('property-a', 'pro'));
    const eur = zapiszPolaczenie(db, polaczenie('property-b', 'pro', 'EUR'));
    db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,kwota_brutto,anulowane,utworzone_at)
      VALUES ('pro',1451,'1451','144.80',1,'2026-09-22T12:00:00Z')`).run();
    expect(potwierdzoneZamowienia(db, { polaczenieId: pln.id, transactionIds: ['1451'] }).przychod).toBe('0.00');
    expect(potwierdzoneZamowienia(db, { polaczenieId: eur.id, transactionIds: ['1451'] }).przychod).toBeNull();
    db.close();
  });
});
