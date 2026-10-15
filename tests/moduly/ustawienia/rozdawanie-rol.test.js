import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { rozdajNoweUprawnienia } from '../../../src/core/uprawnienia.ts';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { synchronizujRole, rolaPoKluczu, wstawRole, przypiszRole } from '../../../src/moduly/ustawienia/role.js';

const teraz = () => new Date('2026-10-14T02:00:00Z');
const modul = (klucz, role) => ({ nazwa: klucz, wersja: '1.0.0', wymaga: [], konfiguracja: () => ({}), migracje: [],
  uprawnienia: [{ klucz, etykieta: klucz, role }], menu: [], zbuduj: () => ({}) });
function baza() {
  const db = openOmsDb(':memory:');
  wykonajMigracje(db, [modulRdzen, modulUstawienia]);
  synchronizujRole(db, { teraz });
  wstawRole(db, { klucz: 'r-magazyn1', nazwa: 'Magazynier', ekrany: ['magazyn'], teraz });
  zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  const mag = zalozKonto(db, { login: 'mag', imie: 'Mag', haslo: 'h', rola: 'r-magazyn1', ekrany: ['magazyn'] });
  przypiszRole(db, mag, 'r-magazyn1');
  return db;
}

describe('PRZ-068 rozdawanie nowego ekranu rolom', () => {
  it('nowy klucz trafia do ról z manifestu i ich kont, nie do roli założonej przez admina (fail-closed)', () => {
    const db = baza();
    expect(rozdajNoweUprawnienia(db, [modul('nowy-ekran', ['sprzedaz'])], teraz)).toEqual(['nowy-ekran']);
    expect(rolaPoKluczu(db, 'sprzedaz').ekrany.has('nowy-ekran')).toBe(true);
    expect(rolaPoKluczu(db, 'r-magazyn1').ekrany.has('nowy-ekran')).toBe(false);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia.has('nowy-ekran')).toBe(true);
    expect(kontoPoLoginie(db, 'mag').uprawnienia.has('nowy-ekran')).toBe(false);
    expect(synchronizujRole(db, { teraz }).przejete).toEqual([]);
  });

  it('manifest z rolami admin/operator nie trafia do żadnej roli (bez mapowania, O12)', () => {
    const db = baza();
    rozdajNoweUprawnienia(db, [modul('inny-ekran', ['admin', 'operator'])], teraz);
    for (const k of ['sprzedaz', 'produkcja', 'r-magazyn1']) expect(rolaPoKluczu(db, k).ekrany.has('inny-ekran'), k).toBe(false);
  });

  it('błąd zapisu wycofuje także ptaszki ról', () => {
    const db = baza();
    db.exec("CREATE TRIGGER blokada BEFORE INSERT ON uprawnienia_rozdane BEGIN SELECT RAISE(ABORT, 'blokada'); END");
    expect(() => rozdajNoweUprawnienia(db, [modul('nowy-ekran', ['sprzedaz'])], teraz)).toThrow('blokada');
    expect(rolaPoKluczu(db, 'sprzedaz').ekrany.has('nowy-ekran')).toBe(false);
    expect(db.isTransaction).toBe(false);
  });
});
