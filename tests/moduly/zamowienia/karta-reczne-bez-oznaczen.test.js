import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszZamowienie, pobierzZamowienie, dodajPozycjeReczna, zapiszNadpisaniaPozycji,
  zapiszNadpisaniaWysylki, zapiszNadpisaniaFaktury, zapiszNadpisanieWysylki,
} from '../../../src/oms/db/zamowienia.js';
import { utworzZamowienieReczne, przeliczKwoteRecznego } from '../../../src/oms/db/zamowienia-reczne.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { wierszePozycji } from '../../../src/domena/tabela-pozycji.js';
import { KLUCZ_WYSYLKI } from '../../../src/domena/wysylka-kwota.js';

// ⚠️ ZAMÓWIENIE RĘCZNE NIE OZNACZA NICZEGO JAKO „ręczne" (07.08.2026, prośba właściciela:
// „przy zamówieniach dodanych ręcznie usuń informację że »dopisana ręcznie« przy produkcie
// oraz »zmienione ręcznie« przy danych").
//
// Powód jest merytoryczny, nie kosmetyczny: oba znaczniki odpowiadają na pytanie „czym to
// się różni od tego, co przysłał SKLEP". Przy zamówieniu telefonicznym sklepu nie ma — każda
// pozycja jest dopisana ręcznie i każda wartość jest nasza — więc znacznik stał przy
// wszystkim i nie niósł ani jednej informacji.

const config = { auth: { user: 'adam', pass: 'x' } };
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zmapowane = (nad = {}) => ({
  zrodlo_id: 1301, numer: '1301', klient: { first_name: 'Jan', email: 'j@k.pl' }, dostawa: { city: 'Pęki' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '212.90',
  koszt_dostawy_brutto: '12.90', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-07-29T13:19:52',
  pozycje: [{ nazwa: 'STOP', sku: 'PRO-1', ilosc: 2, cena_brutto: '100.00', brutto_linii: '200.00', vat: null }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config, poller });
  await app.ready();
});

const karta = (id, query = '') => app.inject({ method: 'GET', url: `/zamowienia/${id}${query}`, headers: naglowek });

// Zamówienie telefoniczne z pozycją i z poprawionymi danymi — czyli DOKŁADNIE ten stan,
// w którym stary panel obwieszał kartę znacznikami.
function zamowienieReczneZPoprawkami() {
  const id = utworzZamowienieReczne(db, {
    metoda_wysylki: 'dpd',
    koszt_dostawy_brutto: '19.00',
    klient: { first_name: 'Jan', last_name: 'Kowalski', city: 'Pęki' },
    dostawa: { first_name: 'Jan', last_name: 'Kowalski', city: 'Pęki' },
  });
  dodajPozycjeReczna(db, id, {
    nazwa: 'Szablon', sku: null, ilosc: 1, cena_brutto: '61.50', brutto_linii: '61.50',
  });
  przeliczKwoteRecznego(db, id);
  // ⚠️ FIKSTURA MUSI ZAPALIĆ **KAŻDE PIĘĆ** ŹRÓDEŁ ZNACZNIKA, inaczej test niczego nie
  // sprawdza. Pierwsza wersja zapalała tylko dwa — i weryfikacja mutacyjna to pokazała:
  // przywrócenie znaczników faktury, przełącznika i metody wysyłki NIE wywalało testu, bo
  // fikstura nie miała czego oznaczyć.
  zapiszNadpisaniaWysylki(db, id, { kod: '00-650', miasto: 'Pęki' });          // adres paczki
  zapiszNadpisaniaFaktury(db, id, { firma: 'Kowalski sp. z o.o.' }, 1);        // dane nabywcy + „chce fakturę"
  zapiszNadpisanieWysylki(db, id, { metoda: 'inpost_paczkomat', pobranie: 0 }); // metoda dostawy
  zapiszNadpisaniaPozycji(db, id, { [KLUCZ_WYSYLKI]: { cena_brutto: '25.00' } }); // kwota wysyłki
  return id;
}

// Straż nad samą fiksturą: gdyby któreś nadpisanie przestało się zapisywać, testy niżej
// przechodziłyby „na pusto" — dokładnie tak, jak przechodziły do czasu weryfikacji mutacyjnej.
function fiksturaNaprawdeMaNadpisania(id) {
  const w = db.prepare(
    'SELECT dostawa_reczna_json, klient_reczny_json, chce_fakture_reczne, wysylka_reczna_json,'
    + ' pozycje_reczne_json FROM zamowienia WHERE id = ?',
  ).get(id);
  return Object.values(w).every((v) => v !== null && v !== undefined);
}

describe('zamówienie RĘCZNE — karta bez znaczników „ręcznie”', () => {
  it('fikstura naprawdę ma wszystkie pięć nadpisań', () => {
    expect(fiksturaNaprawdeMaNadpisania(zamowienieReczneZPoprawkami())).toBe(true);
  });

  it('pozycja nie jest podpisana „dopisana ręcznie”', async () => {
    const id = zamowienieReczneZPoprawkami();
    expect((await karta(id)).body).not.toContain('dopisana ręcznie');
    expect((await karta(id, '?edytuj=pozycje')).body).not.toContain('dopisana ręcznie');
  });

  it('dane klienta nie są podpisane „zmienione ręcznie”', async () => {
    const id = zamowienieReczneZPoprawkami();
    expect((await karta(id)).body).not.toContain('zmienione ręcznie');
    expect((await karta(id, '?edytuj=wysylka')).body).not.toContain('zmienione ręcznie');
    expect((await karta(id, '?edytuj=faktura')).body).not.toContain('zmienione ręcznie');
  });

  it('poprawiona kwota wysyłki też nie jest oznaczana', async () => {
    const id = zamowienieReczneZPoprawkami();
    const wiersz = wierszePozycji(pobierzZamowienie(db, id)).find((w) => w.wysylka);
    expect(wiersz.polaZmienione).toEqual([]);
    expect((await karta(id, '?edytuj=pozycje')).body).not.toContain('zmienione:');
  });

  // ⚠️ SAM FAKT RĘCZNOŚCI ZOSTAJE PRAWDĄ — gaśnie tylko napis. Gdyby zgasło `reczna`,
  // z wiersza zniknąłby przycisk „Usuń", a pozycja zaczęłaby się zapisywać jako różnica
  // wobec sklepu, którego nie ma.
  it('pozycja dalej JEST ręczna — przycisk „Usuń” zostaje', async () => {
    const id = zamowienieReczneZPoprawkami();
    const pozycja = wierszePozycji(pobierzZamowienie(db, id)).find((w) => !w.wysylka && !w.podsumowanie);
    expect(pozycja.reczna).toBe(true);
    expect(pozycja.oznaczReczna).toBe(false);
    expect((await karta(id, '?edytuj=pozycje')).body).toContain(`/pozycje/${pozycja.klucz}/usun`);
  });
});

describe('zamówienie ZE SKLEPU — znaczniki zostają', () => {
  it('pozycja dopisana ręcznie dalej jest podpisana', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    dodajPozycjeReczna(db, id, { nazwa: 'Dopłata', sku: null, ilosc: 1, cena_brutto: '20.00', brutto_linii: '20.00' });
    expect((await karta(id)).body).toContain('dopisana ręcznie');
  });

  it('poprawione dane klienta dalej są podpisane', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaWysylki(db, id, { kod: '00-651' });
    expect((await karta(id)).body).toContain('zmienione ręcznie');
  });

  it('poprawiona kwota wysyłki dalej jest podpisana', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    zapiszNadpisaniaPozycji(db, id, { [KLUCZ_WYSYLKI]: { cena_brutto: '25.00' } });
    const wiersz = wierszePozycji(pobierzZamowienie(db, id)).find((w) => w.wysylka);
    expect(wiersz.polaZmienione).toEqual(['cena_brutto']);
  });
});

describe('ostrzeżenie o nadanej paczce — dopiero po kliknięciu „Edytuj”', () => {
  const nadanaPaczka = (id) => db.prepare(
    "INSERT INTO przesylki (zamowienie_id, kurier, status, numer_listu, kolejnosc, utworzona_at)"
    + " VALUES (?, 'dpd', 'nadana', '0000123456789A', 1, '2026-07-30T10:00:00')",
  ).run(id);

  it('karta do odczytu jest czysta, edycja ostrzega', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    nadanaPaczka(id);
    expect((await karta(id)).body).not.toContain('paczki JUŻ NADANEJ to nie zmienia');
    // ⚠️ CAŁY OTWIERAJĄCY ZNACZNIK, nie sam tekst. Sprawdzenie po samej treści przepuszcza
    // akapit schowany atrybutem `hidden` — ostrzeżenie byłoby w kodzie strony, a operator
    // nie zobaczyłby go nigdy. Weryfikacja mutacyjna złapała dokładnie ten przypadek.
    expect((await karta(id, '?edytuj=wysylka')).body)
      .toContain('<p class="pasek-uwaga">Poprawka dotyczy dopiero KOLEJNYCH przesyłek');
  });

  // ⚠️ Treść ZOSTAŁA BEZ ZMIAN — to nie jest zmiękczenie ostrzeżenia, tylko przeniesienie go
  // tam, gdzie coś znaczy. Kurs nadanej paczki idzie po adresie z chwili nadania i żadna
  // poprawka na karcie go nie zawróci.
  it('ostrzeżenie dalej wskazuje panel DPD', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    nadanaPaczka(id);
    expect((await karta(id, '?edytuj=wysylka')).body).toMatch(/załatw to w panelu DPD/);
  });

  // Ostrzeżenie o WYSTAWIONEJ FAKTURZE to osobna sprawa i zostaje tam, gdzie było —
  // właściciel prosił wyłącznie o to przy danych do wysyłki.
  it('ostrzeżenie o wystawionej fakturze zostaje na karcie do odczytu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(), {});
    db.prepare("INSERT INTO faktury (zamowienie_id, numer, infakt_uuid, utworzona_at) VALUES (?, 'FV/1/2026', 'u1', '2026-07-30T10:00:00')").run(id);
    expect((await karta(id)).body).toContain('faktury JUŻ WYSTAWIONEJ to nie zmienia');
  });
});
