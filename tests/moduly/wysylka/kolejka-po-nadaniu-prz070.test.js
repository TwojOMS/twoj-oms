import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { wstawEtykieteDoKolejki } from '../../../src/moduly/wysylka/services/kolejka-po-nadaniu.js';

// PRZ-070: kolejka druku po nadaniu — jedna funkcja dla karty („Nadaj i drukuj") i hurtu.
const zmapowane = {
  zrodlo_id: 1589, numer: '1589', klient: {}, dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null,
  chce_fakture: 0, nip: null, kwota_brutto: '104.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-13T13:13:48Z', pozycje: [],
};
let db;
let id;
beforeEach(() => {
  db = openOmsDb(':memory:');
  id = zapiszZamowienie(db, 'pro', zmapowane, {});
});
const log = () => db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'kolejka-druku.dodanie'")
  .all(id).map((r) => r.wynik);
const kolejka = () => db.prepare('SELECT przesylka_id FROM kolejka_druku').all().map((r) => r.przesylka_id);
const nadana = (kolejnosc, zpl) => {
  const p = rozpocznijPrzesylke(db, id, 'dpd', kolejnosc);
  zakonczPrzesylke(db, p.id, {
    numerListu: `L${kolejnosc}`, etykietaSciezka: `/${kolejnosc}.pdf`, etykietaZplSciezka: zpl, surowa: null,
  });
  return p.id;
};

describe('PRZ-070: kolejka druku po nadaniu', () => {
  it('paczka z ZPL trafia do kolejki, wpis w logu taki jak dotąd na karcie', () => {
    const p = nadana(1, '/1.zpl');
    expect(wstawEtykieteDoKolejki(db, id, 1, 'Nadaj i drukuj')).toBe('w_kolejce');
    expect(kolejka()).toEqual([p]);
    expect(log()).toEqual(['OK (Nadaj i drukuj)']);
  });

  it('bez ZPL nic nie wstawia i mówi to w logu', () => {
    nadana(1, null);
    expect(wstawEtykieteDoKolejki(db, id, 1, 'Nadaj i drukuj — hurt')).toBe('brak_zpl');
    expect(kolejka()).toEqual([]);
    expect(log()).toEqual(['BRAK ZPL — nie dodano do kolejki (Nadaj i drukuj — hurt)']);
  });

  it('bierze paczkę o PODANYM numerze, nie ostatnią w tabeli', () => {
    nadana(1, null);
    nadana(2, '/2.zpl');
    expect(wstawEtykieteDoKolejki(db, id, 1, 'x')).toBe('brak_zpl');
    expect(kolejka()).toEqual([]);
  });

  it('awaria bazy nie rzuca — nadanie już stoi, wynik „blad”', () => {
    nadana(1, '/1.zpl');
    db.exec('DROP TABLE kolejka_druku');
    expect(wstawEtykieteDoKolejki(db, id, 1, 'Nadaj i drukuj')).toBe('blad');
    expect(log()[0]).toMatch(/^BŁĄD: /);
  });
});
