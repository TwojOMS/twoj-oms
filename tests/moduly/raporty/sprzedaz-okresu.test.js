import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { zapiszHistorie, ustawGranice } from '../../../src/oms/db/historia-sprzedazy.js';
import { KANALY } from '../../pomoc/raporty-historyczne-fixture.js';
import { sprzedazWOkresie } from '../../pomoc/raporty-parytetu.js';

let db;
let licznik = 0;

beforeEach(() => {
  db = openOmsDb(':memory:');
  // ⚠️ Z KANALY, nie recznie: lista urosla z 9 do 12 po pomiarze i kanal bez granicy
  // PRZERYWA raport, wiec recznie wyliczona lista rozjechalaby sie przy nastepnej zmianie.
  for (const k of KANALY) {
    ustawGranice(db, k, '2026-07-02', 'test', null);
  }
});

const wHistorii = (dzien, brutto = '100.00', konto = 9) => zapiszHistorie(db, {
  apiloId: `H${licznik += 1}`, platformAccountId: konto, numer: 'x', dzien,
  utworzoneAt: `${dzien}T10:00:00.000Z`, brutto, tagi: [], faktura: 0,
  status: 15, paymentStatus: 2, klientEmail: 'k@example.org', pozycje: [],
});

const wOms = (utworzone, kwota = '100.00', sklep = 'szkicownia') => {
  licznik += 1;
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, indywidualne)'
    + ' VALUES (?,?,?,?,?,0)',
  ).run(sklep, licznik, `O${licznik}`, kwota, utworzone);
};

// ⚠️ Osobny pomocnik od wOms wyzej (Zadanie 4, recenzja) — zamowienie OMS z prawdziwym
// klient_json i/albo pozycjami. Zaden dotychczasowy test tego nie zakladal: caly komplet
// fikstur mial klient_json = NULL i pusta liste pozycji, wiec regula wykluczen po stronie
// OMS-u (klient.imie/nazwisko/firma) i pozycjeOms nie mialy czego oznaczyc. wOms ZOSTAJE
// nietkniety — istniejace testy dalej go uzywaja bez zmian.
const wOmsZKlientem = (utworzone, { kwota = '100.00', sklep = 'szkicownia', klient = null, pozycje = [] } = {}) => {
  licznik += 1;
  const info = db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, indywidualne, klient_json)'
    + ' VALUES (?,?,?,?,?,0,?)',
  ).run(sklep, licznik, `K${licznik}`, kwota, utworzone, klient ? JSON.stringify(klient) : null);
  // ⚠️ FK pozycje.zamowienie_id MUSI byc prawdziwym `zamowienia.id` (AUTOINCREMENT), nie
  // `licznik` uzytym wyzej jako zrodlo_id — to DWIE rozne liczby. Zmierzone: pierwsza wersja
  // tego pomocnika mylila je i dostawala "FOREIGN KEY constraint failed" na kazdym wierszu
  // pozycji poza pierwszym zamowieniem w calym pliku testowym.
  const zamowienieId = Number(info.lastInsertRowid);
  for (const p of pozycje) {
    db.prepare(
      'INSERT INTO pozycje (zamowienie_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo) VALUES (?,?,?,?,?,?)',
    ).run(zamowienieId, p.nazwa, p.ilosc, p.cena_brutto, p.brutto_linii, p.zrodlo ?? 'sklep');
  }
  return zamowienieId;
};

const suma = (od, doD) => sprzedazWOkresie(db, { od, do: doD })
  .reduce((s, w) => s + w.bruttoGrosze, 0);

describe('granica historia ↔ OMS', () => {
  it('NIE MA ZAKLADKI: ten sam dzien nie liczy sie z obu zrodel', () => {
    wHistorii('2026-07-02', '100.00');
    wOms('2026-07-02 12:00:00', '100.00');       // ten sam dzien, juz w OMS-ie
    // Granica to 2026-07-02 wlacznie → liczy sie WYLACZNIE historia.
    expect(suma('2026-07-01', '2026-07-31')).toBe(10000);
  });

  it('NIE MA DZIURY: dzien po granicy liczy sie z OMS-u', () => {
    wOms('2026-07-03 12:00:00', '250.00');
    expect(suma('2026-07-01', '2026-07-31')).toBe(25000);
  });

  it('okres przecinajacy granice sumuje obie epoki dokladnie raz', () => {
    wHistorii('2026-07-01', '100.00');
    wHistorii('2026-07-02', '100.00');
    wHistorii('2026-07-03', '100.00');           // historia PO granicy — ignorowana
    wOms('2026-07-02 12:00:00', '100.00');       // OMS PRZED granica — ignorowany
    wOms('2026-07-03 12:00:00', '100.00');
    wOms('2026-07-04 12:00:00', '100.00');
    expect(suma('2026-07-01', '2026-07-31')).toBe(40000);
  });

  it('KANAL BEZ GRANICY PRZERYWA — cicha pustka wyglada jak slaby miesiac', () => {
    db.prepare("DELETE FROM granice_historii WHERE kanal = 'SZKICOWNIA_PL'").run();
    wOms('2026-07-10 12:00:00');
    expect(() => sprzedazWOkresie(db, { od: '2026-07-01', do: '2026-07-31' }))
      .toThrow(/SZKICOWNIA_PL/);
  });
});

describe('strefa czasowa', () => {
  it('zamowienie reczne z 22:30 UTC to NASTEPNY dzien handlowy', () => {
    // 2026-07-05T22:30Z = niedziela 6 lipca 00:30 czasu polskiego.
    wOms('2026-07-05T22:30:00.000Z', '100.00', 'reczne');
    expect(suma('2026-07-06', '2026-07-06')).toBe(10000);
    expect(suma('2026-07-05', '2026-07-05')).toBe(0);
  });
});

describe('netto i wykluczenia', () => {
  it('netto to brutto podzielone przez 1,23', () => {
    wOms('2026-07-10 12:00:00', '123.00');
    expect(sprzedazWOkresie(db, { od: '2026-07-10', do: '2026-07-10' })[0].nettoGrosze)
      .toBe(10000);
  });

  it('WDT: Alfatrend ma stawke 0%, wiec netto = brutto', () => {
    zapiszHistorie(db, {
      apiloId: 'WDT1', platformAccountId: 12, dzien: '2026-06-01',
      utworzoneAt: '2026-06-01T10:00:00.000Z', brutto: '123.00', tagi: [],
      klientEmail: 'peter.novak@alfatrend.sk', status: 15, paymentStatus: 2, pozycje: [],
    });
    const [w] = sprzedazWOkresie(db, { od: '2026-06-01', do: '2026-06-01' });
    expect(w.nettoGrosze).toBe(12300);
  });

  it('anulowane (21) i ZDUPLIKOWANE (18) wypadaja z sumy', () => {
    zapiszHistorie(db, {
      apiloId: 'ANU', platformAccountId: 9, dzien: '2026-06-01',
      utworzoneAt: '2026-06-01T10:00:00.000Z', brutto: '500.00', tagi: [],
      status: 21, paymentStatus: 2, pozycje: [],
    });
    zapiszHistorie(db, {
      apiloId: 'DUP', platformAccountId: 9, dzien: '2026-06-01',
      utworzoneAt: '2026-06-01T10:00:00.000Z', brutto: '500.00', tagi: [],
      status: 18, paymentStatus: 2, pozycje: [],
    });
    expect(suma('2026-06-01', '2026-06-01')).toBe(0);
  });

  it('zamowienia wlasne i testowe wypadaja z KAZDEGO KPI, nie tylko z kanalow', () => {
    zapiszHistorie(db, {
      apiloId: 'W', platformAccountId: 9, dzien: '2026-06-02',
      utworzoneAt: '2026-06-02T10:00:00.000Z', brutto: '900.00', tagi: [],
      klientEmail: 'wlasciciel@example.com', status: 15, paymentStatus: 2, pozycje: [],
    });
    zapiszHistorie(db, {
      apiloId: 'T', platformAccountId: 9, dzien: '2026-06-02',
      utworzoneAt: '2026-06-02T10:00:00.000Z', brutto: '900.00', tagi: [],
      klientNazwa: 'Test PSM Sp z oo', status: 15, paymentStatus: 2, pozycje: [],
    });
    expect(suma('2026-06-02', '2026-06-02')).toBe(0);
  });

  it('anulowane RECZNIE w OMS-ie tez wypada', () => {
    licznik += 1;
    db.prepare(
      'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at,'
      + " anulowane_recznie, indywidualne) VALUES ('reczne',?,?,'400.00','2026-07-10 12:00:00','2026-07-11T00:00:00.000Z',0)",
    ).run(licznik, `A${licznik}`);
    expect(suma('2026-07-10', '2026-07-10')).toBe(0);
  });

  // ⚠️ Zadanie 4, recenzja — dziura w pokryciu: zaden test wyzej nie zaklada zamowienia
  // OMS-u z wypelnionym klient_json ani z pozycjami. Kolumny sa dobre (klient_json +
  // klient_reczny_json), ale klucze wewnatrz maja byc kompletem Woo billing: first_name,
  // last_name, company, email — tak samo jak w domain/mapowanie.js (surowe.billing),
  // domain/allegro-mapowanie.js (adresPanelu) i domain/nowe-zamowienie.js (rozbijNazwe +
  // company). Ponizsze testy padaly na kodzie SPRZED poprawki: sklejony napis czytal
  // klient.imie/nazwisko/firma, ktore w tym ksztalcie sa ZAWSZE undefined.
  it('OMS: firma "Lumina…" w klient_json wypada ze sprzedazy', () => {
    wOmsZKlientem('2026-07-10 12:00:00', {
      kwota: '500.00',
      klient: { company: 'Lumina Marek Zywiecki' },
    });
    expect(suma('2026-07-10', '2026-07-10')).toBe(0);
  });

  it('OMS: first_name "Test" + last_name "PSM" w klient_json zapala regule "test psm"', () => {
    wOmsZKlientem('2026-07-10 12:00:00', {
      kwota: '300.00',
      klient: { first_name: 'Test', last_name: 'PSM' },
    });
    expect(suma('2026-07-10', '2026-07-10')).toBe(0);
  });

  // Znalezisko 2: port reguly z raporty/src/klasyfikacja.mjs byl niepelny — WZORCE_TESTOWE
  // ma tam DWA wzorce na mail (@example.com I ^testpsm), a sprzedaz-okresu.js miala tylko
  // pierwszy. NAZWY_TESTOWE nie ratuje: leci na nazwe, nie na mail, a samo 'testpsm@...'
  // nie zawiera podlancucha 'test psm' (brak spacji).
  it('OMS: adres "testpsm@…" wypada (port wzorca /^testpsm/i z raporty/klasyfikacja.mjs)', () => {
    wOmsZKlientem('2026-07-10 12:00:00', {
      kwota: '700.00',
      klient: { email: 'testpsm@cokolwiek.pl' },
    });
    expect(suma('2026-07-10', '2026-07-10')).toBe(0);
  });

  it('OMS: klient WDT (Alfatrend) w klient_json ma netto rowne brutto, nie brutto / 1,23', () => {
    wOmsZKlientem('2026-07-10 12:00:00', {
      kwota: '123.00',
      klient: {
        email: 'peter.novak@alfatrend.sk', first_name: 'Peter', last_name: 'Novak', company: 'Alfatrend',
      },
    });
    const [w] = sprzedazWOkresie(db, { od: '2026-07-10', do: '2026-07-10' });
    expect(w.nettoGrosze).toBe(12300);
  });

  it('OMS: zamowienie z pozycjami oddaje je w polu pozycje, w groszach', () => {
    wOmsZKlientem('2026-07-10 12:00:00', {
      kwota: '246.00',
      pozycje: [{
        nazwa: 'Szablon A4', ilosc: 2, cena_brutto: '123.00', brutto_linii: '246.00',
      }],
    });
    const [w] = sprzedazWOkresie(db, { od: '2026-07-10', do: '2026-07-10' });
    expect(w.pozycje).toEqual([{
      nazwa: 'Szablon A4', ilosc: 2, typ: 1, bruttoGrosze: 24600,
    }]);
  });
});

// Zamowienie ze sklepu z JEDNA pozycja i nadpisaniami w `pozycje_reczne_json`. Osobny
// pomocnik od wOmsZKlientem, bo tamten nie zna ani `zrodlo_id` (z niego powstaje klucz
// nadpisania), ani kolumny z nadpisaniami, ani kosztu dostawy.
const zeSklepuZNadpisaniem = (utworzone, {
  kwota = '100.00', pozycja = null, nadpisania = null, kosztDostawy = null,
} = {}) => {
  licznik += 1;
  const info = db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, utworzone_at, indywidualne,'
    + ' pozycje_reczne_json, koszt_dostawy_brutto) VALUES (?,?,?,?,?,0,?,?)',
  ).run('szkicownia', licznik, `N${licznik}`, kwota, utworzone,
    nadpisania ? JSON.stringify(nadpisania) : null, kosztDostawy);
  const zamowienieId = Number(info.lastInsertRowid);
  if (pozycja) {
    db.prepare(
      'INSERT INTO pozycje (zamowienie_id, zrodlo_id, nazwa, ilosc, cena_brutto, brutto_linii, zrodlo)'
      + " VALUES (?,?,?,?,?,?,'sklep')",
    ).run(zamowienieId, pozycja.zrodlo_id, pozycja.nazwa, pozycja.ilosc,
      pozycja.cena_brutto, pozycja.brutto_linii);
  }
  return zamowienieId;
};

// RAPORT MA LICZYĆ TO SAMO, CO FAKTURA (23.08.2026).
//
// ⚠️ POWÓD ISTNIENIA TEGO BLOKU: raport brał kolumnę `kwota_brutto` — kwotę ZE SKLEPU, która
// z założenia nie rośnie od naszych dopisków — a faktura liczy `kwotaOczekiwanaGrosze`.
// Zmierzone na produkcji: zamówienie 28171 z 3.08 ma na fakturze 654,00 zł, a w raporcie
// miało 429,00 zł, bo dopisana ręcznie pozycja za 225,00 zł nie podnosiła tamtej kolumny.
// ⚠️ Na 23.08.2026 poprawka rusza dokładnie JEDNO zamówienie (+225,00 zł) — dwa pozostałe
// rozjazdy w bazie to zamówienia własne, wykluczone z raportu przez `czyTestowe`.
describe('raport liczy zamówienie tak samo jak faktura', () => {
  it('pozycja dopisana ręcznie podnosi sprzedaż — tak jak podnosi fakturę', () => {
    wOmsZKlientem('2026-08-03 12:00:00', {
      kwota: '429.00',
      pozycje: [
        { nazwa: 'logo 1,2,3', ilosc: 3, cena_brutto: '65.00', brutto_linii: '195.00' },
        { nazwa: 'logo mniejsze 4,5,6', ilosc: 3, cena_brutto: '55.00', brutto_linii: '165.00' },
        { nazwa: 'wysyłka kurierem DPD', ilosc: 1, cena_brutto: '19.00', brutto_linii: '19.00' },
        { nazwa: 'Realizacja priorytetowa', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00' },
        { nazwa: 'logo większe 1,2,3', ilosc: 3, cena_brutto: '75.00', brutto_linii: '225.00', zrodlo: 'reczna' },
      ],
    });
    expect(suma('2026-08-03', '2026-08-03')).toBe(65400);
  });

  // Zamowienie ze sklepu z pozycja PRZECENIONA na karcie. Nadpisanie nie mieszka w wierszu
  // pozycji, tylko w kolumnie `zamowienia.pozycje_reczne_json` pod kluczem `s<zrodlo_id>`
  // (domain/pozycje-reczne.js) — raport czytajacy surowe wiersze widzi cene SKLEPOWA i rozni
  // sie od faktury, ktora liczy po nalozeniu nadpisan.
  it('pozycja ze sklepu przeceniona na karcie liczy sie po cenie z karty', () => {
    zeSklepuZNadpisaniem('2026-08-03 12:00:00', {
      kwota: '100.00',
      pozycja: {
        zrodlo_id: 501, nazwa: 'Szablon', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
      },
      nadpisania: { s501: { cena_brutto: '150.00' } },
    });
    expect(suma('2026-08-03', '2026-08-03')).toBe(15000);
  });

  // Wysylka jest edytowalna tak samo jak pozycje (07.08.2026, prosba wlasciciela) i ma
  // w `kwotaOczekiwanaGrosze` WLASNY czlon roznicowy. Dwie paczki zamiast jednej to realna
  // doplata klienta, wiec raport ma ja widziec — a bez kolumny `koszt_dostawy_brutto`
  // w zapytaniu cena sklepowa czyta sie jako brak i cala roznica wychodzi zerowa.
  it('nadpisana liczba paczek podnosi sprzedaz o doplate za wysylke', () => {
    zeSklepuZNadpisaniem('2026-08-03 12:00:00', {
      kwota: '119.00',
      kosztDostawy: '19.00',
      pozycja: {
        zrodlo_id: 502, nazwa: 'Szablon', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
      },
      nadpisania: { wysylka: { ilosc: 2 } },
    });
    expect(suma('2026-08-03', '2026-08-03')).toBe(13800);
  });

  // ⚠️ STRAŻNIKI, nie nowa funkcja: oba przypadki dzialaly przed 23.08 i maja dzialac dalej.
  // Pierwszy pilnuje galezi `sklep === 'reczne'` w kwotaOczekiwanaGrosze (zamowienie reczne
  // nie ma pozycji sklepowych, wiec czlon roznicowy policzylby kazda pozycje DRUGI RAZ),
  // drugi — zamowienia swiezo pobranego, ktoremu poller nie zdazyl jeszcze wstawic pozycji.
  it('zamowienie reczne liczy sie ze swojej kwoty, nie z sumy pozycji', () => {
    wOmsZKlientem('2026-08-03 12:00:00', {
      kwota: '500.00',
      sklep: 'reczne',
      pozycje: [{
        nazwa: 'Szablon', ilosc: 1, cena_brutto: '500.00', brutto_linii: '500.00', zrodlo: 'reczna',
      }],
    });
    expect(suma('2026-08-03', '2026-08-03')).toBe(50000);
  });

  it('zamowienie ze sklepu bez ani jednej pozycji liczy sie z kwoty sklepu, nie jako zero', () => {
    zeSklepuZNadpisaniem('2026-08-03 12:00:00', { kwota: '250.00' });
    expect(suma('2026-08-03', '2026-08-03')).toBe(25000);
  });

  // Ranking produktow i licznik sztuk ida z TYCH SAMYCH pozycji, co kwota — wiec przeceniona
  // linia ma w rankingu wazyc tyle, ile pokazuje karta. Inaczej jedno zamowienie mowiloby
  // w raporcie dwiema cenami tej samej pozycji.
  it('ranking pokazuje pozycje po cenie z karty, nie po sklepowej', () => {
    zeSklepuZNadpisaniem('2026-08-03 12:00:00', {
      kwota: '100.00',
      pozycja: {
        zrodlo_id: 503, nazwa: 'Szablon', ilosc: 1, cena_brutto: '100.00', brutto_linii: '100.00',
      },
      nadpisania: { s503: { cena_brutto: '150.00' } },
    });
    const [w] = sprzedazWOkresie(db, { od: '2026-08-03', do: '2026-08-03' });
    expect(w.pozycje).toEqual([{
      nazwa: 'Szablon', ilosc: 1, typ: 1, bruttoGrosze: 15000,
    }]);
  });
});
