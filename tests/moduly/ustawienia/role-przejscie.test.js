import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';
import { synchronizujRole, listaRol, rolaPoKluczu, kluczeEkranow } from '../../../src/moduly/ustawienia/role.js';
import { migawkaDostepu, nowyPanel } from '../../pomoc/konta-prz068.js';

const teraz = () => new Date('2026-10-14T02:00:00Z');
const kluczeTestowe = () => { let n = 0; return () => `r-test${String(++n).padStart(4, '0')}`; };

/** Stan jak na produkcji przed wydaniem: same tabele rdzenia, ptaszki per konto, „+ zmiany”. */
function bazaPrzedWydaniem() {
  const db = openOmsDb(':memory:');
  zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true, ekrany: ['zamowienia'] });
  zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz', ekrany: [...ekranyRoli('sprzedaz'), 'finanse'] });
  zalozKonto(db, { login: 'ola2', imie: 'Ola', haslo: 'h', rola: 'sprzedaz', ekrany: ['zamowienia'] });
  zalozKonto(db, { login: 'pako', imie: 'Pako', haslo: 'h', rola: 'produkcja' });
  zalozKonto(db, { login: 'obcy', imie: 'Obcy', haslo: 'h', rola: 'ksiegowa', ekrany: ['faktury', 'api'] });
  zalozKonto(db, { login: 'falszywy', imie: 'Fałsz', haslo: 'h', rola: 'administrator', admin: false, ekrany: ['faktury'] });
  return db;
}
const przejdz = (db, losowyKlucz = kluczeTestowe()) => { wykonajMigracje(db, [modulRdzen, modulUstawienia]); return synchronizujRole(db, { teraz, losowyKlucz }); };

describe('PRZ-068 przejście kont na role w bazie', () => {
  it('zbiór (login → ekrany, admin) jest identyczny, poza poszerzeniem administratora', () => {
    const db = bazaPrzedWydaniem();
    const przed = migawkaDostepu(db);
    const wynik = przejdz(db);
    const po = migawkaDostepu(db);
    expect(po.adam).toEqual({ admin: true, ekrany: [...kluczeEkranow()].sort() });
    for (const login of Object.keys(przed).filter((l) => l !== 'adam')) expect(po[login], login).toEqual(przed[login]);
    expect(wynik.zasiane).toBe(true);
    expect(wynik.poszerzone).toEqual(['adam']);
    expect(wynik.przejete.map((p) => p.login).sort()).toEqual(['falszywy', 'obcy', 'ola', 'ola2']);
  });

  it('zakłada trzy role z ROLE, Administrator zablokowany, role osobiste z dopiskiem przy kolizji nazw', () => {
    const db = bazaPrzedWydaniem();
    przejdz(db);
    const role = listaRol(db);
    expect(role.map((r) => r.nazwa)).toEqual(['Administrator', 'Sprzedaż', 'Produkcja', 'Sprzedaż — Ola', 'Sprzedaż — Ola (2)', 'ksiegowa — Obcy', 'Własna bez admina — Fałsz']);
    expect(rolaPoKluczu(db, 'administrator')).toMatchObject({ admin: true, zablokowana: true });
    expect([...rolaPoKluczu(db, 'produkcja').ekrany].sort()).toEqual([...ekranyRoli('produkcja')].sort());
    const falszywy = kontoPoLoginie(db, 'falszywy');
    expect(falszywy.admin).toBe(false);
    expect(rolaPoKluczu(db, falszywy.rola)).toMatchObject({ admin: false, zablokowana: false, nazwa: 'Własna bez admina — Fałsz' });
    for (const r of role.filter((x) => !['administrator', 'sprzedaz', 'produkcja'].includes(x.klucz))) expect(r.klucz).toMatch(/^r-/);
  });

  it('druga synchronizacja nic nie zmienia', () => {
    const db = bazaPrzedWydaniem();
    przejdz(db);
    const role = JSON.stringify(listaRol(db).map((r) => ({ ...r, ekrany: [...r.ekrany].sort() })));
    const dostep = migawkaDostepu(db);
    const wynik = synchronizujRole(db, { teraz, losowyKlucz: kluczeTestowe() });
    expect(wynik).toEqual({ zasiane: false, przejete: [], poszerzone: [] });
    expect(JSON.stringify(listaRol(db).map((r) => ({ ...r, ekrany: [...r.ekrany].sort() })))).toBe(role);
    expect(migawkaDostepu(db)).toEqual(dostep);
  });

  it('restart po ręcznej zmianie ptaszków nie zmienia niczyjego dostępu i nie rusza roli presetu', () => {
    const db = bazaPrzedWydaniem();
    przejdz(db);
    const ewa = kontoPoLoginie(db, 'ewa');
    ustawUprawnienia(db, ewa.id, ['magazyn']);
    const wynik = synchronizujRole(db, { teraz, losowyKlucz: kluczeTestowe() });
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn']));
    expect(kontoPoLoginie(db, 'ewa').rola).not.toBe('sprzedaz');
    expect([...rolaPoKluczu(db, 'sprzedaz').ekrany].sort()).toEqual([...ekranyRoli('sprzedaz')].sort());
    expect(wynik.przejete.map((p) => p.login)).toEqual(['ewa']);
  });

  it('baza bez tabel ról (kompozycja bez modułu ustawienia) — synchronizacja nic nie robi', () => {
    const db = bazaPrzedWydaniem();
    const przed = migawkaDostepu(db);
    expect(synchronizujRole(db, { teraz })).toEqual({ zasiane: false, przejete: [], poszerzone: [] });
    expect(migawkaDostepu(db)).toEqual(przed);
  });

  it('start aplikacji: role zasiane synchronicznie w budowie — konto założone po buildOmsServer zachowuje ptaszki i nie tworzy roli', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz', ekrany: ['magazyn'] });
    await app.ready();
    expect(db.prepare('SELECT count(*) AS n FROM role').get().n).toBe(3);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn']));
    await app.close();
  });

  it('start aplikacji na bazie sprzed wydania przechodzi na role bez zmiany dostępu', async () => {
    const db = bazaPrzedWydaniem();
    const przed = migawkaDostepu(db);
    const { app } = nowyPanel({ db });
    await app.ready();
    const po = migawkaDostepu(db);
    for (const login of Object.keys(przed).filter((l) => l !== 'adam')) expect(po[login], login).toEqual(przed[login]);
    expect(po.adam.admin).toBe(true);
    await app.close();
  });
});
