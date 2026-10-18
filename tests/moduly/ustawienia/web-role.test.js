import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia, ustawCzynne } from '../../../src/core/bezpieczenstwo/konta.js';
import { listaRol, rolaPoKluczu, kluczeEkranow, odciskMacierzy } from '../../../src/moduly/ustawienia/role.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

function panelZKontami() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  return { ...p, admin: jako(p.db, 'adam') };
}

describe('PRZ-068 ekran Role i uprawnienia', () => {
  it('pokazuje macierz ekran × rola, liczby kont i zablokowaną kolumnę Administratora', async () => {
    const { app, admin } = panelZKontami();
    const r = await get(app, '/ustawienia/role', admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<h1>Role i uprawnienia</h1>');
    expect(r.body).toContain('zawsze pełny dostęp');
    expect(r.body).toMatch(/data-liczba-kont="sprzedaz">1</);
    expect(r.body).toMatch(/value="administrator:zamowienia" checked disabled/);
    expect(r.body).toMatch(/value="sprzedaz:magazyn" checked/);
    expect(r.body).not.toMatch(/value="produkcja:magazyn" checked/);
    // PRZ-093.05: etykieta kolumny API opisuje funkcję (dostęp dla zewnętrznej aplikacji), nie aplikację właściciela.
    expect(r.body).toContain('Dostęp przez API (zewnętrzna aplikacja)');
    expect(r.body).toMatch(/<li class="aktywna">\s*<a href="\/ustawienia\/role">/);
    expect(r.body).not.toContain('wyloguj-wszystkie');
  });

  it('konto bez flagi admin nie wchodzi ani nie zapisuje, nawet z ptaszkiem Ustawień', async () => {
    const { db, app } = panelZKontami();
    ustawUprawnienia(db, kontoPoLoginie(db, 'ewa').id, ['ustawienia']);
    const ewa = jako(db, 'ewa');
    for (const [metoda, url] of [['GET', '/ustawienia/role'], ['POST', '/ustawienia/role'], ['POST', '/ustawienia/role/nowa'], ['POST', '/ustawienia/role/produkcja/nazwa'], ['POST', '/ustawienia/role/produkcja/usun']]) {
      const r = metoda === 'GET' ? await get(app, url, ewa) : await post(app, url, ewa, { nazwa: 'x' });
      expect(r.statusCode, url).toBe(403);
    }
    const podmenu = await get(app, '/ustawienia/integracje', ewa);
    expect(podmenu.body).not.toContain('href="/ustawienia/role"');
  });

  it('jeden zapis macierzy przepisuje role i ich konta; Administratora nie da się odznaczyć; nieznany ekran po cichu odpada', async () => {
    const { db, app, admin } = panelZKontami();
    const r = await post(app, '/ustawienia/role', admin, { odcisk: odciskMacierzy(db),
      rola: ['administrator', 'sprzedaz', 'produkcja'],
      uprawnienie: ['sprzedaz:magazyn', 'produkcja:zamowienia', 'produkcja:nieznany', 'administrator:zamowienia'],
    });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('/ustawienia/role?zapisano=macierz');
    expect(rolaPoKluczu(db, 'sprzedaz').ekrany).toEqual(new Set(['magazyn']));
    expect(rolaPoKluczu(db, 'produkcja').ekrany).toEqual(new Set(['zamowienia']));
    expect(rolaPoKluczu(db, 'administrator').ekrany).toEqual(new Set(kluczeEkranow()));
    expect(kontoPoLoginie(db, 'ewa').uprawnienia).toEqual(new Set(['magazyn']));
    expect(kontoPoLoginie(db, 'adam').admin).toBe(true);
  });

  it('formularz z rolą, której już nie ma, daje 404 bez częściowego zapisu; rola spoza formularza zostaje nietknięta', async () => {
    const { db, app, admin } = panelZKontami();
    const przed = [...rolaPoKluczu(db, 'sprzedaz').ekrany].sort();
    const r = await post(app, '/ustawienia/role', admin, { odcisk: odciskMacierzy(db), rola: ['sprzedaz', 'r-nieistnieje'], uprawnienie: ['sprzedaz:magazyn'] });
    expect(r.statusCode).toBe(404);
    expect([...rolaPoKluczu(db, 'sprzedaz').ekrany].sort()).toEqual(przed);
    const tylkoSprzedaz = await post(app, '/ustawienia/role', admin, { odcisk: odciskMacierzy(db), rola: 'sprzedaz', uprawnienie: 'sprzedaz:magazyn' });
    expect(tylkoSprzedaz.statusCode).toBe(302);
    expect(rolaPoKluczu(db, 'produkcja').ekrany.has('zamowienia')).toBe(true);
  });

  it('dodaje rolę (przycięta nazwa, klucz losowy, ptaszki skopiowane), odrzuca duplikat bez względu na wielkość polskich liter', async () => {
    const { db, app, admin } = panelZKontami();
    const r = await post(app, '/ustawienia/role/nowa', admin, { nazwa: '  Magazynier  ', kopiujZ: 'produkcja' });
    expect(r.statusCode).toBe(302);
    const nowa = listaRol(db).find((x) => x.nazwa === 'Magazynier');
    expect(nowa.klucz).toMatch(/^r-[0-9a-f]{8}$/);
    expect(nowa.ekrany).toEqual(rolaPoKluczu(db, 'produkcja').ekrany);
    expect(nowa).toMatchObject({ admin: false, zablokowana: false });
    for (const nazwa of ['SPRZEDAŻ', 'magazynier', '', ' '.repeat(3), 'x'.repeat(41)]) {
      const blad = await post(app, '/ustawienia/role/nowa', admin, { nazwa });
      expect(blad.statusCode, nazwa).toBe(400);
      expect(blad.body).toContain('pas-uprzedzenie');
    }
    expect(listaRol(db)).toHaveLength(4);
    expect((await post(app, '/ustawienia/role/nowa', admin, { nazwa: 'Inna', kopiujZ: 'r-nieistnieje' })).statusCode).toBe(404);
  });

  it('zmienia nazwę roli; Administratora nie można przemianować; nieznana rola 404', async () => {
    const { db, app, admin } = panelZKontami();
    expect((await post(app, '/ustawienia/role/produkcja/nazwa', admin, { nazwa: 'Pakowanie' })).statusCode).toBe(302);
    expect(rolaPoKluczu(db, 'produkcja').nazwa).toBe('Pakowanie');
    expect((await post(app, '/ustawienia/role/administrator/nazwa', admin, { nazwa: 'Szef' })).statusCode).toBe(400);
    expect(rolaPoKluczu(db, 'administrator').nazwa).toBe('Administrator');
    expect((await post(app, '/ustawienia/role/r-nieistnieje/nazwa', admin, { nazwa: 'X' })).statusCode).toBe(404);
  });

  it('usuwa wyłącznie rolę bez żadnego konta (także wyłączonego); Administratora nigdy', async () => {
    const { db, app, admin } = panelZKontami();
    ustawCzynne(db, kontoPoLoginie(db, 'ewa').id, false);
    expect((await post(app, '/ustawienia/role/sprzedaz/usun', admin)).statusCode).toBe(400);
    expect(rolaPoKluczu(db, 'sprzedaz')).not.toBeNull();
    expect((await post(app, '/ustawienia/role/produkcja/usun', admin)).statusCode).toBe(302);
    expect(rolaPoKluczu(db, 'produkcja')).toBeNull();
    expect((await post(app, '/ustawienia/role/administrator/usun', admin)).statusCode).toBe(400);
  });
});
