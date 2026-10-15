import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { listaRol, rolaPoKluczu, dodajRole, przypiszRole, kluczeEkranow, odciskMacierzy } from '../../../src/moduly/ustawienia/role.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const teraz = () => new Date('2026-10-14T02:00:00Z');
function panel() {
  const p = nowyPanel();
  const idAdam = zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  // Konto założone wprost w bazie PO starcie ma ptaszki presetu (bez `api`); start aplikacji poszerzyłby je
  // do pełnej roli Administrator — tu robi to jawne przypisanie, żeby punkt wyjścia spełniał niezmiennik.
  przypiszRole(p.db, idAdam, 'administrator');
  const idEwa = zalozKonto(p.db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz' });
  return { ...p, idAdam, idEwa, admin: jako(p.db, 'adam') };
}
/** Ptaszki konta poza rolą nie mogą powstać żadną drogą panelu. */
function bezOdstepstw(db) {
  for (const k of db.prepare('SELECT id, login, rola, admin FROM konta').all()) {
    const rola = rolaPoKluczu(db, k.rola);
    expect(rola, k.login).not.toBeNull();
    expect(k.admin === 1, k.login).toBe(rola.admin);
    expect(kontoPoLoginie(db, k.login).uprawnienia, k.login).toEqual(rola.ekrany);
  }
}

describe('PRZ-068 przypisanie roli kontu', () => {
  it('zmiana roli przepisuje ptaszki i flagę admin z roli; lista pokazuje nazwę roli z bazy', async () => {
    const { db, app, idEwa, admin } = panel();
    const mag = dodajRole(db, { nazwa: 'Magazynier', kopiujZ: 'produkcja', teraz });
    const r = await post(app, `/ustawienia/konta/${idEwa}/rola`, admin, { rola: mag });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/konta?zapisano=rola');
    expect(kontoPoLoginie(db, 'ewa')).toMatchObject({ rola: mag, admin: false });
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(rolaPoKluczu(db, 'produkcja').ekrany);
    const lista = await get(app, '/ustawienia/konta?zapisano=rola', admin);
    expect(lista.body).toContain('Zmieniono rolę.');
    expect(lista.body).toContain('Magazynier');
    expect((await post(app, `/ustawienia/konta/${idEwa}/rola`, admin, { rola: 'administrator' })).statusCode).toBe(302);
    expect(kontoPoLoginie(db, 'ewa').admin).toBe(true);
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(kluczeEkranow()));
    bezOdstepstw(db);
  });

  it('nieznana rola → 404; nieistniejące konto → 404; konto bez admina → 403', async () => {
    const { db, app, idEwa, admin } = panel();
    expect((await post(app, `/ustawienia/konta/${idEwa}/rola`, admin, { rola: 'r-nieistnieje' })).statusCode).toBe(404);
    expect((await post(app, '/ustawienia/konta/9999/rola', admin, { rola: 'sprzedaz' })).statusCode).toBe(404);
    expect((await post(app, `/ustawienia/konta/${idEwa}/rola`, jako(db, 'ewa'), { rola: 'administrator' })).statusCode).toBe(403);
    expect(kontoPoLoginie(db, 'ewa').admin).toBe(false);
  });

  it('bezpieczniki: jedyny admin nie zmieni sobie roli (ostatni), drugi admin też nie odbierze sobie admina', async () => {
    const { db, app, idAdam, admin } = panel();
    const sam = await post(app, `/ustawienia/konta/${idAdam}/rola`, admin, { rola: 'sprzedaz' });
    expect(sam.statusCode).toBe(400);
    expect(sam.body).toMatch(/ostatni/i);
    zalozKonto(db, { login: 'kasia', imie: 'Kasia', haslo: 'h', rola: 'administrator', admin: true });
    const zDrugim = await post(app, `/ustawienia/konta/${idAdam}/rola`, admin, { rola: 'sprzedaz' });
    expect(zDrugim.statusCode).toBe(400);
    expect(zDrugim.body).toContain('Nie można odebrać sobie uprawnień administratora');
    expect(kontoPoLoginie(db, 'adam').admin).toBe(true);
  });

  it('stara trasa /uprawnienia daje wynik per konto przez rolę osobistą, aktualizowaną przy kolejnym zapisie', async () => {
    const { db, app, idEwa, admin } = panel();
    const przed = listaRol(db).length;
    await post(app, `/ustawienia/konta/${idEwa}/uprawnienia`, admin, { ekran: ['magazyn'] });
    const rola = kontoPoLoginie(db, 'ewa').rola;
    expect(rola).toMatch(/^r-/);
    expect(rolaPoKluczu(db, rola)).toMatchObject({ nazwa: 'Sprzedaż — Barbara' });
    expect(rolaPoKluczu(db, 'sprzedaz').ekrany.has('finanse')).toBe(false);
    await post(app, `/ustawienia/konta/${idEwa}/uprawnienia`, admin, { ekran: ['magazyn', 'finanse'] });
    expect(kontoPoLoginie(db, 'ewa').rola).toBe(rola);
    expect(rolaPoKluczu(db, rola).ekrany).toEqual(new Set(['magazyn', 'finanse']));
    expect(listaRol(db)).toHaveLength(przed + 1);
    await post(app, `/ustawienia/konta/${idEwa}/uprawnienia`, admin, { ekran: ['zamowienia'], admin: '1' });
    expect(kontoPoLoginie(db, 'ewa')).toMatchObject({ rola: 'administrator', admin: true });
    bezOdstepstw(db);
  });

  it('żadna droga panelu nie zostawia ptaszków konta poza rolą', async () => {
    const { db, app, idEwa, admin } = panel();
    await post(app, '/ustawienia/konta/nowe', admin, { login: 'pako', imie: 'Pako', haslo: 'haslo-ok', rola: 'produkcja' });
    await post(app, `/ustawienia/konta/${idEwa}/uprawnienia`, admin, { ekran: 'magazyn' });
    await post(app, '/ustawienia/role', admin, { odcisk: odciskMacierzy(db), rola: ['sprzedaz', 'produkcja'], uprawnienie: ['produkcja:przesylki'] });
    await post(app, `/ustawienia/konta/${idEwa}/rola`, admin, { rola: 'produkcja' });
    bezOdstepstw(db);
  });

  it('formularz per konto znika z ekranu (wraca tylko w błędzie starej trasy); każde konto ma wybór roli', async () => {
    const { app, idEwa, admin } = panel();
    const r = await get(app, '/ustawienia/konta', admin);
    expect(r.body).not.toMatch(/name="ekran"/);
    expect(r.body).toContain(`action="/ustawienia/konta/${idEwa}/rola"`);
  });

  it('menu użytkownika pokazuje nazwę roli z bazy', async () => {
    const { db, app } = panel();
    const mag = dodajRole(db, { nazwa: 'Magazynier', kopiujZ: 'produkcja', teraz });
    const id = zalozKonto(db, { login: 'mag', imie: 'Mag', haslo: 'h', rola: mag });
    przypiszRole(db, id, mag);
    const r = await get(app, '/', jako(db, 'mag'));
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<p class="menu-uzytkownika-rola">Magazynier</p>');
  });
});
