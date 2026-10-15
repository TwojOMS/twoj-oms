import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createCzuwaczKampanii, kampanieDoOdswiezenia } from '../../../src/moduly/marketing/uslugi/czuwacz-kampanii.js';
import { metaDni, ga4Dni, stanyZrodel } from '../../../src/oms/db/kampanie.js';

// Czuwacz kampanii (Etapy 1-2). Atrapy klientow — suita nie rozmawia ani z Meta, ani z GA4.
// Jawna neutralna fixture kampanii (24.08–07.09, GA4 123456789, /promocja-test).

const teraz = (dzien) => () => new Date(`${dzien}T09:00:00Z`);

const metaAtrapa = (dni) => ({ dzienneStatystyki: async () => dni, });
const ga4Atrapa = (dni) => ({ dzienneStatystyki: async () => dni });
const odmowa = (tresc) => ({ dzienneStatystyki: async () => { throw new Error(tresc); } });

const METADZIEN = {
  dzien: '2026-08-24', wydatek: '30.00', wyswietlenia: 1000, zasieg: 800, klikniecia: 40, kliknieciaLinku: 12,
};
const GA4DZIEN = { dzien: '2026-08-24', sesje: 28, uzytkownicy: 24, sesjeMeta: 5, odslonyPromo: 3 };

function wstawKampanieTestowa(db) {
  db.prepare(`INSERT INTO kampanie (kod,nazwa,od_dnia,do_dnia,sklep,cel_uzyc,ga4_wlasciwosc,ga4_sciezka,fale_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('promo-test','Kampania testowa','2026-08-24','2026-09-07','sklep-test',10,
    '123456789','/promocja-test',JSON.stringify([
      {od:'2026-08-26',napis:'start reklam'}, {od:'2026-08-30',napis:'fala 2'}, {od:'2026-09-04',napis:'fala 3'}
    ]));
}

let db;
beforeEach(() => { db = openOmsDb(':memory:'); wstawKampanieTestowa(db); });

describe('kampanieDoOdswiezenia', () => {
  const k = { od_dnia: '2026-08-24', do_dnia: '2026-09-07' };

  it('bierze kampanię, która trwa', () => {
    expect(kampanieDoOdswiezenia([k], '2026-08-25')).toHaveLength(1);
  });

  it('nie pyta o kampanię, która jeszcze nie wystartowała', () => {
    expect(kampanieDoOdswiezenia([k], '2026-08-20')).toHaveLength(0);
  });

  // ⚠️ Liczby dojrzewaja jeszcze przez dobe po koncu — kampania zamknieta wczoraj MA byc
  // odswiezona, inaczej ostatni dzien zostaje na niepelnych danych na zawsze.
  it('odświeża jeszcze dwa dni po zakończeniu, potem przestaje', () => {
    expect(kampanieDoOdswiezenia([k], '2026-09-09')).toHaveLength(1);
    expect(kampanieDoOdswiezenia([k], '2026-09-10')).toHaveLength(0);
  });
});

describe('czuwacz kampanii — zapis do lustra', () => {
  it('zapisuje dni Meta i GA4 dla kampanii, która trwa', async () => {
    const czuwacz = createCzuwaczKampanii({
      db, meta: metaAtrapa([METADZIEN]), ga4: ga4Atrapa([GA4DZIEN]), teraz: teraz('2026-08-25'),
    });
    await czuwacz.przebieg();

    expect(metaDni(db, 'promo-test')).toMatchObject([{ dzien: '2026-08-24', wydatek: '30.00', wyswietlenia: 1000 }]);
    expect(ga4Dni(db, 'promo-test')).toMatchObject([{ dzien: '2026-08-24', sesje: 28, sesje_meta: 5, odslony_promo: 3 }]);
  });

  // ⚠️ Statystyki dnia dojrzewaja — drugi przebieg ma NADPISAC, nie dopisac drugiego wiersza.
  it('ponowny przebieg nadpisuje ten sam dzień, nie dubluje go', async () => {
    const pierwszy = createCzuwaczKampanii({ db, meta: metaAtrapa([METADZIEN]), teraz: teraz('2026-08-25') });
    await pierwszy.przebieg();
    const drugi = createCzuwaczKampanii({
      db, meta: metaAtrapa([{ ...METADZIEN, wydatek: '45.50' }]), teraz: teraz('2026-08-25'),
    });
    await drugi.przebieg();

    const dni = metaDni(db, 'promo-test');
    expect(dni).toHaveLength(1);
    expect(dni[0].wydatek).toBe('45.50');
  });

  it('nie pyta o kampanię sprzed okna (żadnego zapisu)', async () => {
    const czuwacz = createCzuwaczKampanii({
      db, meta: metaAtrapa([METADZIEN]), ga4: ga4Atrapa([GA4DZIEN]), teraz: teraz('2026-08-20'),
    });
    expect(await czuwacz.przebieg()).toMatchObject({ kampanii: 0 });
    expect(metaDni(db, 'promo-test')).toEqual([]);
  });

  it('nieskonfigurowane źródło po prostu nie pyta (panel bez Mety działa)', async () => {
    const czuwacz = createCzuwaczKampanii({ db, meta: null, ga4: ga4Atrapa([GA4DZIEN]), teraz: teraz('2026-08-25') });
    await czuwacz.przebieg();
    expect(metaDni(db, 'promo-test')).toEqual([]);
    expect(ga4Dni(db, 'promo-test')).toHaveLength(1);
  });
});

describe('czuwacz kampanii — awarie i ślad', () => {
  // ⚠️⚠️ SEDNO: wygasly klucz Google nie ma prawa zabrac ekranowi wydatkow z Mety.
  it('awaria GA4 NIE zabiera danych z Mety', async () => {
    const czuwacz = createCzuwaczKampanii({
      db, meta: metaAtrapa([METADZIEN]), ga4: odmowa('Google odmówił tokenu: invalid_grant'), teraz: teraz('2026-08-25'),
    });
    const wynik = await czuwacz.przebieg();

    expect(metaDni(db, 'promo-test')).toHaveLength(1);
    expect(wynik.ga4.blad).toMatch(/invalid_grant/);
    const stany = stanyZrodel(db);
    expect(stany.meta.ostatni_blad).toBeNull();
    expect(stany.ga4.ostatni_blad).toMatch(/invalid_grant/);
  });

  it('awaria Mety NIE zabiera danych z GA4', async () => {
    const czuwacz = createCzuwaczKampanii({
      db, meta: odmowa('Meta odmówiła (OAuthException): token wygasł'), ga4: ga4Atrapa([GA4DZIEN]), teraz: teraz('2026-08-25'),
    });
    await czuwacz.przebieg();
    expect(ga4Dni(db, 'promo-test')).toHaveLength(1);
    expect(stanyZrodel(db).meta.ostatni_blad).toMatch(/OAuthException/);
  });

  // ⚠️ Nieudana proba NIE MOZE skasowac znacznika ostatniego SUKCESU — po nim ekran mowi,
  // jak stare sa liczby, ktore pokazuje.
  it('nieudana próba zostawia znacznik ostatniego udanego pobrania', async () => {
    await createCzuwaczKampanii({ db, meta: metaAtrapa([METADZIEN]), teraz: teraz('2026-08-25') }).przebieg();
    const poSukcesie = stanyZrodel(db).meta.ostatni_sukces_at;
    expect(poSukcesie).toBeTruthy();

    await createCzuwaczKampanii({ db, meta: odmowa('sieć padła'), teraz: teraz('2026-08-25') }).przebieg();
    const poAwarii = stanyZrodel(db).meta;
    expect(poAwarii.ostatni_sukces_at).toBe(poSukcesie);
    expect(poAwarii.ostatni_blad).toBe('sieć padła');
  });

  it('udany przebieg po awarii kasuje błąd', async () => {
    await createCzuwaczKampanii({ db, meta: odmowa('sieć padła'), teraz: teraz('2026-08-25') }).przebieg();
    await createCzuwaczKampanii({ db, meta: metaAtrapa([METADZIEN]), teraz: teraz('2026-08-25') }).przebieg();
    expect(stanyZrodel(db).meta.ostatni_blad).toBeNull();
  });

  // Kampania bez wlasciwosci GA4 to nie awaria, tylko kampania, ktorej nikt nie kazal
  // mierzyc — czerwony pasek przy kazdym przebiegu nauczylby operatora go ignorowac.
  it('kampania bez właściwości GA4 nie zostawia śladu o błędzie', async () => {
    db.prepare("UPDATE kampanie SET ga4_wlasciwosc = NULL WHERE kod = 'promo-test'").run();
    const czuwacz = createCzuwaczKampanii({ db, ga4: ga4Atrapa([GA4DZIEN]), teraz: teraz('2026-08-25') });
    await czuwacz.przebieg();
    expect(stanyZrodel(db).ga4).toBeUndefined();
  });
});

describe('czuwacz kampanii — okno zapytania', () => {
  it('pyta od początku kampanii do DZIŚ, nie do końca okna (bez przyszłości)', async () => {
    let zapytanie = null;
    const meta = { dzienneStatystyki: async (p) => { zapytanie = p; return []; } };
    await createCzuwaczKampanii({ db, meta, teraz: teraz('2026-08-25') }).przebieg();
    expect(zapytanie).toMatchObject({ od: '2026-08-24', do: '2026-08-25' });
  });

  it('po zakończeniu kampanii pyta do jej ostatniego dnia', async () => {
    let zapytanie = null;
    const meta = { dzienneStatystyki: async (p) => { zapytanie = p; return []; } };
    await createCzuwaczKampanii({ db, meta, teraz: teraz('2026-09-08') }).przebieg();
    expect(zapytanie).toMatchObject({ od: '2026-08-24', do: '2026-09-07' });
  });

  it('przekazuje ścieżkę strony promocji do GA4', async () => {
    let zapytanie = null;
    const ga4 = { dzienneStatystyki: async (p) => { zapytanie = p; return []; } };
    await createCzuwaczKampanii({ db, ga4, teraz: teraz('2026-08-25') }).przebieg();
    expect(zapytanie).toMatchObject({ wlasciwosc: '123456789', sciezkaPromo: '/promocja-test' });
  });

  it('zawężenie do wskazanych kampanii reklamowych jedzie do klienta Meta', async () => {
    db.prepare("UPDATE kampanie SET meta_kampanie = '111, 222' WHERE kod = 'promo-test'").run();
    let zapytanie = null;
    const meta = { dzienneStatystyki: async (p) => { zapytanie = p; return []; } };
    await createCzuwaczKampanii({ db, meta, teraz: teraz('2026-08-25') }).przebieg();
    expect(zapytanie.kampanie).toEqual(['111', '222']);
  });
});
