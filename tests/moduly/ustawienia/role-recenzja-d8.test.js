// PRZ-068, recenzja D8 r1: log synchronizacji, transakcja /nowe, odcisk macierzy, role osobiste jawnie,
// nazwa roli osobistej konta bez admina, odtworzenie Administratora, transakcyjność zapisu macierzy.
import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wykonajMigracje } from '../../../src/core/baza.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { ekranyRoli } from '../../../src/domena/ekrany.js';
import {
  synchronizujRole, rolaPoKluczu, listaRol, kluczeEkranow, dodajRole, przypiszRole, usunRole, odciskMacierzy, BladRoli,
} from '../../../src/moduly/ustawienia/role.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const teraz = () => new Date('2026-10-14T02:00:00Z');
const kluczeTestowe = () => { let n = 0; return () => `r-test${String(++n).padStart(4, '0')}`; };

function bazaZTabelami() {
  const db = openOmsDb(':memory:');
  wykonajMigracje(db, [modulRdzen, modulUstawienia]);
  return db;
}
/** Budowa modułu jak przy starcie, z atrapą usług innych modułów i przechwyconym logiem. */
function zbuduj(db) {
  const log = [];
  modulUstawienia.zbuduj({ db, teraz, log: (...t) => log.push(t.join(' ')), konfiguracja: { adresPanelu: null }, usluga: () => () => [] });
  return log;
}
function panel() {
  const p = nowyPanel();
  const idAdam = zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  przypiszRole(p.db, idAdam, 'administrator');
  const idEwa = zalozKonto(p.db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz' });
  return { ...p, idAdam, idEwa, admin: jako(p.db, 'adam') };
}
const ekranyPosortowane = (db, klucz) => [...rolaPoKluczu(db, klucz).ekrany].sort();

describe('PRZ-068 recenzja D8 — start modułu', () => {
  it('loguje przejęte konta (login → klucz roli) i poszerzonych administratorów; bez hashy haseł', () => {
    const db = bazaZTabelami();
    zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'tajne', rola: 'sprzedaz', ekrany: [...ekranyRoli('sprzedaz'), 'finanse'] });
    zalozKonto(db, { login: 'szef', imie: 'Szef', haslo: 'tajne', rola: 'sprzedaz', admin: true });
    const log = zbuduj(db);
    expect(log).toHaveLength(1);
    const ola = kontoPoLoginie(db, 'ola');
    expect(log[0]).toContain(`ola → ${ola.rola}`);
    expect(log[0]).toContain('szef');
    expect(log[0]).not.toMatch(/scrypt|tajne/);
  });

  it('start bez przejęć i poszerzeń nie loguje nic', () => {
    const db = bazaZTabelami();
    zbuduj(db);
    zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
    expect(zbuduj(db)).toEqual([]);
  });

  it('konto z flagą admin w roli spoza Administratora przechodzi na Administratora z pełnymi ekranami', () => {
    const db = bazaZTabelami();
    zalozKonto(db, { login: 'szef', imie: 'Szef', haslo: 'h', rola: 'sprzedaz', admin: true });
    const wynik = synchronizujRole(db, { teraz, losowyKlucz: kluczeTestowe() });
    expect(kontoPoLoginie(db, 'szef')).toMatchObject({ rola: 'administrator', admin: true });
    expect(kontoPoLoginie(db, 'szef').uprawnienia).toEqual(new Set(kluczeEkranow()));
    expect(wynik.poszerzone).toEqual(['szef']);
  });

  it('brak wiersza Administrator przy niepustej tabeli ról — start odtwarza go (zablokowany, admin, wszystkie ekrany)', async () => {
    const db = bazaZTabelami();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    synchronizujRole(db, { teraz, losowyKlucz: kluczeTestowe() });
    db.exec("DELETE FROM role_ekrany WHERE rola = 'administrator'; DELETE FROM role WHERE klucz = 'administrator'");
    expect(() => synchronizujRole(db, { teraz, losowyKlucz: kluczeTestowe() })).not.toThrow();
    expect(rolaPoKluczu(db, 'administrator')).toMatchObject({ admin: true, zablokowana: true, osobista: false, nazwa: 'Administrator' });
    expect(rolaPoKluczu(db, 'administrator').ekrany).toEqual(new Set(kluczeEkranow()));
    expect(kontoPoLoginie(db, 'adam')).toMatchObject({ rola: 'administrator', admin: true });
    db.exec("DELETE FROM role_ekrany WHERE rola = 'administrator'; DELETE FROM role WHERE klucz = 'administrator'");
    const { app } = nowyPanel({ db });
    await app.ready();
    expect(rolaPoKluczu(db, 'administrator')).toMatchObject({ admin: true, zablokowana: true });
    await app.close();
  });

  it('konto z kluczem administrator bez flagi admin dostaje rolę osobistą z nazwą mówiącą „bez admina”', () => {
    const db = bazaZTabelami();
    zalozKonto(db, { login: 'falszywy', imie: 'Fałsz', haslo: 'h', rola: 'administrator', admin: false, ekrany: ['faktury'] });
    synchronizujRole(db, { teraz, losowyKlucz: kluczeTestowe() });
    const rola = rolaPoKluczu(db, kontoPoLoginie(db, 'falszywy').rola);
    expect(rola).toMatchObject({ nazwa: 'Własna bez admina — Fałsz', admin: false, osobista: true });
    expect(rola.nazwa).not.toMatch(/^Administrator/);
  });
});

describe('PRZ-068 recenzja D8 — role osobiste i stara trasa /uprawnienia', () => {
  it('rola założona przez admina z jednym kontem NIE jest edytowana w miejscu — konto dostaje nową rolę osobistą', async () => {
    const { db, app, idEwa, admin } = panel();
    const mag = dodajRole(db, { nazwa: 'Magazynier', kopiujZ: 'produkcja', teraz });
    przypiszRole(db, idEwa, mag);
    expect(rolaPoKluczu(db, mag).osobista).toBe(false);
    await post(app, `/ustawienia/konta/${idEwa}/uprawnienia`, admin, { ekran: ['magazyn'] });
    expect(ekranyPosortowane(db, mag)).toEqual([...ekranyRoli('produkcja')].sort());
    const nowa = kontoPoLoginie(db, 'ewa').rola;
    expect(nowa).not.toBe(mag);
    expect(rolaPoKluczu(db, nowa)).toMatchObject({ nazwa: 'Magazynier — Barbara', osobista: true, ekrany: new Set(['magazyn']) });
    const ile = listaRol(db).length;
    await post(app, `/ustawienia/konta/${idEwa}/uprawnienia`, admin, { ekran: ['magazyn', 'finanse'] });
    expect(kontoPoLoginie(db, 'ewa').rola).toBe(nowa);
    expect(listaRol(db)).toHaveLength(ile);
  });

  it('stara trasa bez admina dla konta Administratora nazywa rolę osobistą „Własna bez admina — <imię>”', async () => {
    const { db, app, admin } = panel();
    const idKasia = zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });
    przypiszRole(db, idKasia, 'administrator');
    const r = await post(app, `/ustawienia/konta/${idKasia}/uprawnienia`, admin, { ekran: ['faktury'] });
    expect(r.statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'kasia').admin).toBe(false);
    expect(rolaPoKluczu(db, kontoPoLoginie(db, 'kasia').rola)).toMatchObject({ nazwa: 'Własna bez admina — Kasia', admin: false });
  });
});

describe('PRZ-068 recenzja D8 — /ustawienia/konta/nowe w jednej transakcji', () => {
  it('awaria przy przypisaniu roli cofa założenie konta (nie zostaje konto z presetem z kodu)', async () => {
    const { db, app, admin } = panel();
    await app.ready();
    db.exec("CREATE TEMP TRIGGER awaria_roli BEFORE UPDATE OF rola ON konta BEGIN SELECT RAISE(ABORT, 'awaria'); END");
    const r = await post(app, '/ustawienia/konta/nowe', admin, { login: 'pako', imie: 'Pako', haslo: 'haslo-ok', rola: 'produkcja' });
    expect(r.statusCode).toBe(500);
    expect(kontoPoLoginie(db, 'pako')).toBeNull();
  });

  it('nowe konto dostaje ekrany roli z bazy, nie presetu z kodu', async () => {
    const { db, app, admin } = panel();
    const mag = dodajRole(db, { nazwa: 'Magazynier', teraz });
    db.prepare("INSERT INTO role_ekrany (rola, ekran) VALUES (?, 'magazyn')").run(mag);
    expect((await post(app, '/ustawienia/konta/nowe', admin, { login: 'pako', imie: 'Pako', haslo: 'haslo-ok', rola: mag })).statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'pako')).toMatchObject({ rola: mag, admin: false, uprawnienia: new Set(['magazyn']) });
  });
});

describe('PRZ-068 recenzja D8 — zapis macierzy', () => {
  it('formularz niesie odcisk stanu macierzy', async () => {
    const { db, app, admin } = panel();
    const r = await get(app, '/ustawienia/role', admin);
    expect(odciskMacierzy(db)).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body).toContain(`<input type="hidden" name="odcisk" value="${odciskMacierzy(db)}">`);
  });

  it('odcisk sprzed zmiany (druga karta) → 409 z komunikatem, bez zapisu', async () => {
    const { db, app, admin } = panel();
    const stary = odciskMacierzy(db);
    const druga = await post(app, '/ustawienia/role', admin, { odcisk: stary, rola: ['sprzedaz', 'produkcja'], uprawnienie: ['sprzedaz:magazyn', ...ekranyRoli('produkcja').map((e) => `produkcja:${e}`)] });
    expect(druga.statusCode).toBe(302);
    const poDrugiej = { sprzedaz: ekranyPosortowane(db, 'sprzedaz'), produkcja: ekranyPosortowane(db, 'produkcja') };
    const r = await post(app, '/ustawienia/role', admin, { odcisk: stary, rola: ['sprzedaz', 'produkcja'], uprawnienie: ['produkcja:faktury'] });
    expect(r.statusCode).toBe(409);
    expect(r.body).toContain('Uprawnienia zmieniły się w międzyczasie — odśwież i zaznacz ponownie');
    expect(r.body).toContain(`name="odcisk" value="${odciskMacierzy(db)}"`);
    expect({ sprzedaz: ekranyPosortowane(db, 'sprzedaz'), produkcja: ekranyPosortowane(db, 'produkcja') }).toEqual(poDrugiej);
  });

  it('brak odcisku → 409 bez zapisu', async () => {
    const { db, app, admin } = panel();
    const przed = ekranyPosortowane(db, 'sprzedaz');
    const r = await post(app, '/ustawienia/role', admin, { rola: 'sprzedaz', uprawnienie: 'sprzedaz:magazyn' });
    expect(r.statusCode).toBe(409);
    expect(ekranyPosortowane(db, 'sprzedaz')).toEqual(przed);
  });

  it('awaria w połowie zapisu (druga rola) nie zostawia pierwszej roli zapisanej', async () => {
    const { db, app, admin } = panel();
    await app.ready();
    const przed = { sprzedaz: ekranyPosortowane(db, 'sprzedaz'), produkcja: ekranyPosortowane(db, 'produkcja') };
    const dostepAgi = kontoPoLoginie(db, 'ewa').uprawnienia;
    db.exec("CREATE TEMP TRIGGER awaria_macierzy BEFORE INSERT ON role_ekrany WHEN NEW.rola = 'produkcja' BEGIN SELECT RAISE(ABORT, 'awaria'); END");
    const r = await post(app, '/ustawienia/role', admin, { odcisk: odciskMacierzy(db), rola: ['sprzedaz', 'produkcja'], uprawnienie: ['sprzedaz:magazyn', 'produkcja:faktury'] });
    expect(r.statusCode).toBe(500);
    expect({ sprzedaz: ekranyPosortowane(db, 'sprzedaz'), produkcja: ekranyPosortowane(db, 'produkcja') }).toEqual(przed);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(dostepAgi);
  });
});

describe('PRZ-068 recenzja D8 — strażnik admina w /rola', () => {
  it('konto bez flagi admin, ale z ptaszkiem Ustawień (strażnik globalny przepuszcza), nie nada sobie Administratora', async () => {
    const { db, app, idEwa } = panel();
    ustawUprawnienia(db, idEwa, ['ustawienia']);
    const r = await post(app, `/ustawienia/konta/${idEwa}/rola`, jako(db, 'ewa'), { rola: 'administrator' });
    expect(r.statusCode).toBe(403);
    expect(kontoPoLoginie(db, 'ewa')).toMatchObject({ rola: 'sprzedaz', admin: false });
  });
});

describe('PRZ-068 recenzja D8 — rola zablokowana', () => {
  it('Administratora nie można usunąć nawet bez żadnego konta', () => {
    const db = bazaZTabelami();
    synchronizujRole(db, { teraz });
    expect(() => usunRole(db, 'administrator')).toThrow(BladRoli);
    try { usunRole(db, 'administrator'); } catch (e) { expect(e.kod).toBe('zablokowana'); }
    expect(rolaPoKluczu(db, 'administrator')).not.toBeNull();
  });
});
