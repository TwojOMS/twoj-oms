import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import {
  zapiszZamowienie, pobierzZamowienie, listaZamowien, potwierdzWplate, dopiszLog, zapiszFaktyStatusu,
} from '../../src/oms/db/zamowienia.js';

const zmapowane = {
  zrodlo_id: 1301, numer: '1301', klient: { email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: '1000001201',
  kwota_brutto: '212.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '50.00', vat: null }],
};

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('zapiszZamowienie', () => {
  it('zapisuje zamówienie z pozycjami i oddaje id', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, { surowe: true });
    const z = pobierzZamowienie(db, id);
    expect(z.numer).toBe('1301');
    expect(z.pozycje).toHaveLength(1);
    expect(z.pozycje[0].nazwa).toBe('STOP');
    expect(z.klient.email).toBe('j@k.pl');
  });

  it('drugi zapis tego samego zamówienia nie tworzy duplikatu', () => {
    const a = zapiszZamowienie(db, 'pro', zmapowane, {});
    const b = zapiszZamowienie(db, 'pro', zmapowane, {});
    expect(b).toBe(a);
    expect(listaZamowien(db)).toHaveLength(1);
  });

  it('aktualizuje pola przychodzące ze sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszZamowienie(db, 'pro', { ...zmapowane, oplacone_at: '2026-07-30T09:00:00', status_woo: 'completed' }, {});
    const z = pobierzZamowienie(db, id);
    expect(z.oplacone_at).toBe('2026-07-30T09:00:00');
    expect(z.status_woo).toBe('completed');
  });

  // Zadanie D: uwagi klienta (customer_note) sa dana ZE SKLEPU, jak reszta naglowka —
  // maja sie zapisywac PRZY WSTAWIENIU i nadpisywac normalnie przy kazdej synchronizacji,
  // bez wlasnej kolumny recznej (w odroznieniu od dostawa_reczna_json itp.).
  it('zapisuje uwagi klienta z zamówienia', () => {
    const id = zapiszZamowienie(db, 'pro', { ...zmapowane, uwagi: 'proszę zadzwonić' }, {});
    expect(pobierzZamowienie(db, id).uwagi).toBe('proszę zadzwonić');
  });

  it('poller nadpisuje uwagi przy kolejnej synchronizacji, tak jak resztę nagłówka', () => {
    const id = zapiszZamowienie(db, 'pro', { ...zmapowane, uwagi: 'stara uwaga' }, {});
    zapiszZamowienie(db, 'pro', { ...zmapowane, uwagi: 'nowa uwaga' }, {});
    expect(pobierzZamowienie(db, id).uwagi).toBe('nowa uwaga');
  });

  // To jest cala stawka pollera: praca czlowieka nie moze zniknac przy synchronizacji.
  it('NIE kasuje znaczników ręcznych przy ponownym zapisie', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszFaktyStatusu(db, id, {
      w_realizacji_at: '2026-07-29T14:00:00', zwrot_at: '2026-07-31T10:00:00',
      zwrot_powod: 'uszkodzony w transporcie', anulowane_recznie: 1,
    });
    potwierdzWplate(db, id, '2026-07-30T08:00:00');
    zapiszZamowienie(db, 'pro', zmapowane, {});
    const z = pobierzZamowienie(db, id);
    expect(z.w_realizacji_at).toBe('2026-07-29T14:00:00');
    expect(z.zwrot_at).toBe('2026-07-31T10:00:00');
    expect(z.zwrot_powod).toBe('uszkodzony w transporcie');
    expect(z.anulowane_recznie).toBe(1);
    expect(z.oplacone_recznie).toBe(1);
  });

  // Wplata potwierdzona recznie nie moze zostac wyzerowana przez sklep, ktory
  // przy przelewie tradycyjnym nigdy nie ustawi date_paid.
  it('ręcznie potwierdzona wpłata przeżywa synchronizację z pustym date_paid', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    potwierdzWplate(db, id, '2026-07-30T08:00:00');
    zapiszZamowienie(db, 'pro', { ...zmapowane, oplacone_at: null }, {});
    expect(pobierzZamowienie(db, id).oplacone_at).toBe('2026-07-30T08:00:00');
  });

  // Zadanie 4: kolumny netto obok istniejacych kolumn brutto (patrz mapowanie.js).
  it('zapisuje i odczytuje koszt dostawy netto oraz netto pozycji', () => {
    const zNetto = {
      ...zmapowane,
      koszt_dostawy_brutto: '89.90', koszt_dostawy_netto: '73.09',
      pozycje: [{ nazwa: 'STOP', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '61.50', cena_netto: '50.00', brutto_linii: '123.00', netto_linii: '100.00', vat: null }],
    };
    const id = zapiszZamowienie(db, 'pro', zNetto, {});
    const z = pobierzZamowienie(db, id);
    expect(z.koszt_dostawy_netto).toBe('73.09');
    expect(z.pozycje[0].cena_netto).toBe('50.00');
    expect(z.pozycje[0].netto_linii).toBe('100.00');
  });

  it('pozycje są podmieniane, nie doklejane', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszZamowienie(db, 'pro', zmapowane, {});
    expect(pobierzZamowienie(db, id).pozycje).toHaveLength(1);
  });

  // Zapis to jedna transakcja: naglowek i pozycje ladują razem albo wcale, inaczej
  // czytelnik (panel) moglby zlapac zamowienie bez pozycji podczas synchronizacji.
  it('nieudany zapis wycofuje calosc zmiany — naglowek i pozycje', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    const zPsutaPozycja = {
      ...zmapowane,
      status_woo: 'completed',
      pozycje: [{ nazwa: null, sku: 'ZLA', ilosc: 1, cena_brutto: '10.00', vat: null }],
    };
    expect(() => zapiszZamowienie(db, 'pro', zPsutaPozycja, {})).toThrow();
    const z = pobierzZamowienie(db, id);
    expect(z.status_woo).toBe('processing'); // naglowek nie zmienil sie
    expect(z.pozycje).toHaveLength(1); // stare pozycje NIE zostaly skasowane
    expect(z.pozycje[0].nazwa).toBe('STOP');
  });
});

describe('zapiszFaktyStatusu', () => {
  // ⚠️ JEDEN UPDATE na komplet faktow. `oznacz()` (biala lista kolumn) i `oznaczZwrot()`
  // zniknely razem z osobnymi przyciskami „Oznacz w realizacji" / „Oznacz zwrot": dopoki
  // istnialy dwie drogi zapisu tych samych faktow, odmowy pilnujace granic recznej zmiany
  // statusu obowiazywalyby wylacznie na jednej z nich.
  it('ustawia wszystkie cztery fakty jednym zapisem', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszFaktyStatusu(db, id, {
      w_realizacji_at: '2026-07-29T14:00:00', zwrot_at: '2026-07-31T10:00:00',
      zwrot_powod: 'uszkodzony w transporcie', anulowane_recznie: 1,
    });
    const z = pobierzZamowienie(db, id);
    expect(z.w_realizacji_at).toBe('2026-07-29T14:00:00');
    expect(z.zwrot_at).toBe('2026-07-31T10:00:00');
    expect(z.zwrot_powod).toBe('uszkodzony w transporcie');
    expect(z.anulowane_recznie).toBe(1);
  });

  // Pusty powod jest DOZWOLONY (operator moze go nie znac), ale ma powstac tym samym
  // zapisem — chodzi o niepodzielnosc, nie o wymuszanie tresci.
  it('brak powodu zapisuje sie razem z data, nie osobno', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszFaktyStatusu(db, id, { w_realizacji_at: null, zwrot_at: '2026-07-31T10:00:00', zwrot_powod: null, anulowane_recznie: 0 });
    const z = pobierzZamowienie(db, id);
    expect(z.zwrot_at).toBe('2026-07-31T10:00:00');
    expect(z.zwrot_powod).toBeNull();
  });

  // Cofniecie ma kasowac fakty, a nie tylko dokladac nowe — inaczej „nowe" nigdy by nie
  // wrocilo, bo stare znaczniki dalej wygrywalyby w wyliczStatus.
  it('kasuje fakty, gdy dostanie nulle', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszFaktyStatusu(db, id, { w_realizacji_at: 'x', zwrot_at: 'y', zwrot_powod: 'z', anulowane_recznie: 1 });
    zapiszFaktyStatusu(db, id, { w_realizacji_at: null, zwrot_at: null, zwrot_powod: null, anulowane_recznie: 0 });
    const z = pobierzZamowienie(db, id);
    expect(z.w_realizacji_at).toBeNull();
    expect(z.zwrot_at).toBeNull();
    expect(z.zwrot_powod).toBeNull();
    expect(z.anulowane_recznie).toBe(0);
  });

  // ⚠️ Kolumna `anulowane` nalezy do SKLEPU. Zapis do niej zostalby i tak zdmuchniety przez
  // najblizsza synchronizacje, a po drodze skasowalby fakt przyslany przez sklep — dlatego
  // reczne anulowanie mieszka WYLACZNIE w `anulowane_recznie`.
  it('NIE dotyka kolumny `anulowane`, ktora nalezy do sklepu', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    zapiszFaktyStatusu(db, id, { w_realizacji_at: null, zwrot_at: null, zwrot_powod: null, anulowane_recznie: 1 });
    expect(db.prepare('SELECT anulowane FROM zamowienia WHERE id = ?').get(id).anulowane).toBe(0);
  });
});

describe('potwierdzWplate', () => {
  it('ustawia date i flage recznosci jednym zapisem', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    potwierdzWplate(db, id, '2026-07-30T08:00:00');
    const z = pobierzZamowienie(db, id);
    expect(z.oplacone_at).toBe('2026-07-30T08:00:00');
    expect(z.oplacone_recznie).toBe(1);
  });
});

describe('dopiszLog', () => {
  it('zapisuje wpis z akcją i wynikiem', () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane, {});
    dopiszLog(db, id, { akcja: 'nadanie', wynik: 'OK' });
    const wpisy = db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].akcja).toBe('nadanie');
  });
});

// Zadanie „strona główna": kolumna "Produkty" na liście czyta nazwy pozycji, więc
// listaZamowien() musi je nosić — do dziś nie niosła w ogóle (karta dociągała je
// osobno, przez pobierzZamowienie).
describe('listaZamowien — pozycje', () => {
  it('każde zamówienie niesie swoje pozycje', () => {
    const id1 = zapiszZamowienie(db, 'pro', zmapowane, {});
    const id2 = zapiszZamowienie(db, 'pro', {
      ...zmapowane, zrodlo_id: 1302, numer: '1302',
      pozycje: [{ nazwa: 'PAUZA', sku: 'PRO-PAUZA-001', ilosc: 1, cena_brutto: '30.00', vat: null }],
    }, {});

    const lista = listaZamowien(db);
    const z1 = lista.find((z) => z.id === id1);
    const z2 = lista.find((z) => z.id === id2);
    expect(z1.pozycje.map((p) => p.nazwa)).toEqual(['STOP']);
    expect(z2.pozycje.map((p) => p.nazwa)).toEqual(['PAUZA']);
  });

  it('zamówienie bez pozycji niesie pustą listę, nie null/undefined', () => {
    const id = zapiszZamowienie(db, 'pro', { ...zmapowane, pozycje: [] }, {});
    const z = listaZamowien(db).find((zz) => zz.id === id);
    expect(z.pozycje).toEqual([]);
  });

  // ⚠️ TO JEST TEN TEST, KTÓRY MA ZŁAPAĆ ZAPYTANIE PO POZYCJE OSOBNO DLA KAZDEGO WIERSZA
  // (brief zadania „strona główna": "Lista musi zostać wydajna"). Licząc TYLKO zapytania
  // wspominające tabelę `pozycje`, a nie WSZYSTKIE `db.prepare` (przesyłki i faktura są
  // dziś per-wiersz i to osobna, nietykana w tym zadaniu sprawa) — dodanie kolejnych
  // czterech zamówień nie ma prawa dołożyć ani jednego zapytania o pozycje.
  it('nie odpytuje bazy o pozycje osobno dla każdego wiersza (zapytanie wsadowe)', () => {
    for (let i = 0; i < 5; i += 1) {
      zapiszZamowienie(db, 'pro', { ...zmapowane, zrodlo_id: 2000 + i, numer: String(2000 + i) }, {});
    }
    const oryginalnyPrepare = db.prepare.bind(db);
    let zapytaniaOPozycje = 0;
    db.prepare = (sql, ...reszta) => {
      if (sql.includes('pozycje')) zapytaniaOPozycje += 1;
      return oryginalnyPrepare(sql, ...reszta);
    };
    try {
      const lista = listaZamowien(db);
      expect(lista).toHaveLength(5);
    } finally {
      db.prepare = oryginalnyPrepare;
    }
    expect(zapytaniaOPozycje).toBe(1);
  });
});
