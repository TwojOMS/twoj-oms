import { describe, it, expect } from 'vitest';
// ⚠️ Projekt NIE uzywa better-sqlite3 — baza stoi na wbudowanym node:sqlite, a testy
// otwieraja ja przez openOmsDb(':memory:'), ktore zaklada komplet tabel i migracje.
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { mapujZamowienieAllegro } from '../../../src/domena/allegro-mapowanie.js';
import { adresOdbiorcy, brakujacePolaAdresu } from '../../../src/domena/adres-odbiorcy.js';

const baza = () => { return openOmsDb(':memory:'); };
const zam = (nadpisz = {}) => ({
  zrodlo_id: 'abc', numer: 'abc', klient: { imie: 'Jan' }, dostawa: { miasto: 'Pęki' },
  metoda_wysylki: 'allegro_dpd', pobranie: 0, kwota_pobrania: null,
  punkt_odbioru: null, punkt_odbioru_opis: null, chce_fakture: 1, nip: '549',
  kwota_brutto: '99.00', koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00',
  status_woo: 'READY_FOR_PROCESSING', metoda_platnosci: 'ONLINE', indywidualne: 0,
  anulowane: 0, oplacone_at: null, utworzone_at: '2026-08-01T10:00:00Z', uwagi: null,
  pozycje: [], ...nadpisz,
});

const czytaj = (db, sklep = 'allegro_szkicownia') => db
  .prepare('SELECT * FROM zamowienia WHERE sklep = ?').get(sklep);

// =================================================================================
// CZESC 1 — WARSTWA ZAPISU (db/zamowienia.js)
//
// Regula jest tu CELOWO NAJPROSTSZA Z MOZLIWYCH: `null`/`undefined` nie nadpisuje, wszystko
// inne nadpisuje. Ta sciezka jest WSPOLNA dla wszystkich kanalow — jada nia zywe sklepy,
// na ktorych panel naprawde nadaje DPD i InPost — wiec nie wolno jej uczyc, „co znaczy pusty
// adres" w konkretnym kanale. To wie mapowanie (czesc 2).
// =================================================================================

describe('zapis: brak danych u źródła nie kasuje danych u nas', () => {
  it('gdy kanał przestanie oddawać adres (null), panel go NIE KASUJE', () => {
    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam(), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zam({ klient: null, dostawa: null }), {});

    const w = czytaj(db);
    expect(JSON.parse(w.klient_json)).toEqual({ imie: 'Jan' });
    expect(JSON.parse(w.dostawa_json)).toEqual({ miasto: 'Pęki' });
  });

  it('ale ZMIANA danych dalej nadpisuje — to nie jest zamrożenie', () => {
    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam(), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zam({ klient: { imie: 'Anna' } }), {});

    expect(JSON.parse(czytaj(db).klient_json)).toEqual({ imie: 'Anna' });
  });

  it('brak klucza w ogóle (undefined) też nie kasuje', () => {
    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam(), {});
    const bez = zam();
    delete bez.klient;
    delete bez.dostawa;
    zapiszZamowienie(db, 'allegro_szkicownia', bez, {});

    const w = czytaj(db);
    expect(JSON.parse(w.klient_json)).toEqual({ imie: 'Jan' });
    expect(JSON.parse(w.dostawa_json)).toEqual({ miasto: 'Pęki' });
  });

  it('ochrona działa POLE PO POLU: pusty klient nie blokuje aktualizacji dostawy', () => {
    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam(), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zam({ klient: null, dostawa: { miasto: 'Oświęcim' } }), {});

    const w = czytaj(db);
    expect(JSON.parse(w.klient_json)).toEqual({ imie: 'Jan' });
    expect(JSON.parse(w.dostawa_json)).toEqual({ miasto: 'Oświęcim' });
  });

  // --- granice reguly ---------------------------------------------------------------

  it('INSERT NIE jest chroniony — puste zakładane zamówienie zostaje puste', () => {
    const db = baza();
    // Przy zakladaniu wiersza nie ma czego chronic. Wartosc ma wyladowac w bazie taka,
    // jaka przyszla — inaczej „brak adresu" nie dalby sie odroznic od „adres jeszcze
    // nie doczytany".
    zapiszZamowienie(db, 'allegro_szkicownia', zam({ klient: null, dostawa: null }), {});
    const w = czytaj(db);
    // ⚠️ SPRAWDZAMY SUROWA KOLUMNE, NIE `JSON.parse` — bo to jedyne miejsce, w ktorym widac
    // roznice: SQL-owy NULL i tekst 'null' oba parsuja sie do `null`, wiec test na wartosci
    // sparsowanej przepuscilby rozlanie ochrony na INSERT (mutacja przezyla dokladnie tak).
    // Roznica jest realna: druga sciezka INSERT-u (db/zamowienia-reczne.js) zapisuje tu
    // `JSON.stringify(dane.klient ?? null)`, czyli tekst 'null'. Dwa zrodla tego samego
    // wiersza musza wpisywac to samo, inaczej „brak adresu" da sie w bazie zapytac
    // dwoma roznymi warunkami i jeden z nich bedzie klamal.
    expect(w.klient_json).toBe('null');
    expect(w.dostawa_json).toBe('null');

    zapiszZamowienie(db, 'allegro_szkicownia', zam(), {});
    expect(JSON.parse(czytaj(db).klient_json)).toEqual({ imie: 'Jan' });
  });

  // ⚠️ Regula ma NIE ROZLAC sie na inne kolumny: pusty `status_woo`, `nip` czy
  // `punkt_odbioru` to AWARIA zrodla, a nie brak danych osobowych, i ma byc widoczna.
  // Zamrozenie ich na ostatniej niepustej wartosci ukryloby zepsuty kanal. Dla `nip`
  // i `punkt_odbioru` to jest JAWNY DLUG, nazwany w przewodniku 4.7a — nie przeoczenie.
  it('reguła dotyczy WYŁĄCZNIE klient_json i dostawa_json', () => {
    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam({
      nip: '5492443180', status_woo: 'READY_FOR_PROCESSING',
      punkt_odbioru: 'KRA01A', punkt_odbioru_opis: 'Paczkomat, Rynek 1',
      koszt_dostawy_brutto: '15.00', metoda_platnosci: 'ONLINE', uwagi: 'proszę o fakturę',
      oplacone_at: '2026-08-01T11:00:00Z',
    }), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zam({
      nip: null, status_woo: null, punkt_odbioru: null, punkt_odbioru_opis: null,
      koszt_dostawy_brutto: null, metoda_platnosci: null, uwagi: null, oplacone_at: null,
    }), {});

    const w = czytaj(db);
    expect(w.nip).toBe(null);
    expect(w.status_woo).toBe(null);
    expect(w.punkt_odbioru).toBe(null);
    expect(w.punkt_odbioru_opis).toBe(null);
    expect(w.koszt_dostawy_brutto).toBe(null);
    expect(w.metoda_platnosci).toBe(null);
    expect(w.uwagi).toBe(null);
    expect(w.oplacone_at).toBe(null);
  });

  // Kanaly nie moga sobie nawzajem mieszac w danych — `sklep` + `zrodlo_id` to klucz
  // wiersza, a oba te testy uzywaja tego samego `zrodlo_id`.
  it('ochrona nie przecieka między kanałami', () => {
    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam(), {});
    zapiszZamowienie(db, 'pro', zam({ klient: { imie: 'Ewa' } }), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zam({ klient: null }), {});

    expect(JSON.parse(czytaj(db, 'allegro_szkicownia').klient_json)).toEqual({ imie: 'Jan' });
    expect(JSON.parse(czytaj(db, 'pro').klient_json)).toEqual({ imie: 'Ewa' });
  });
});

// =================================================================================
// CZESC 2 — WOOCOMMERCE MA DZIALAC DOKLADNIE JAK PRZED TA ZMIANA
//
// pro.szkicownia.pl i szkicownia.pl to ZYWE sklepy, prawdziwe paczki i prawdziwe nadania DPD
// oraz InPost. Wyczyszczony w sklepie blok `shipping` MA zejsc do panelu — bo `surowyAdres`
// (domain/adres-odbiorcy.js) czyta adres WYLACZNIE z bloku `dostawa`, a `brakujacePolaAdresu`
// jest JEDYNYM bezpiecznikiem przed nadaniem paczki bez adresu. Zamrozony STARY adres
// rozbraja ten bezpiecznik i podstawia na ekranie nadania cos, co wyglada wiarygodnie.
// =================================================================================

const wooKlient = {
  first_name: 'Anna', last_name: 'Nowak', company: '', address_1: 'Polna 3',
  address_2: '', postcode: '30-001', city: 'Kraków', country: 'PL',
  email: 'anna@example.com', phone: '600100200',
};
// Blok `shipping` wyczyszczony w adminie sklepu: WooCommerce zwraca KLUCZE z pustymi
// napisami, a `country` jest tam PRAWDZIWA dana sklepu, nie naszym domyslem.
const wooWyczyszczony = {
  first_name: '', last_name: '', company: '', address_1: '', address_2: '',
  postcode: '', city: '', country: '',
};

describe('WooCommerce: zachowanie bez zmian', () => {
  it('adres ze sklepu dalej się odświeża — i pojedyncze pole da się wyczyścić', () => {
    const db = baza();
    zapiszZamowienie(db, 'pro', zam({ klient: wooKlient, dostawa: { ...wooKlient } }), {});
    zapiszZamowienie(db, 'pro', zam({
      klient: { ...wooKlient, address_1: 'Polna 5' },
      dostawa: { ...wooKlient, address_1: 'Polna 5', city: 'Wieliczka' },
    }), {});

    const w = czytaj(db, 'pro');
    expect(JSON.parse(w.klient_json).address_1).toBe('Polna 5');
    expect(JSON.parse(w.dostawa_json).city).toBe('Wieliczka');

    zapiszZamowienie(db, 'pro', zam({
      klient: { ...wooKlient, address_1: 'Polna 5', phone: '' },
      dostawa: { ...wooKlient, address_1: 'Polna 5', city: 'Wieliczka' },
    }), {});
    expect(JSON.parse(czytaj(db, 'pro').klient_json).phone).toBe('');
  });

  // ⚠️ TO JEST TEST POWROTU DO ZACHOWANIA SPRZED CALEJ TEJ ZMIANY. Wersja z predykatem
  // skanujacym pola bloku ZAMRAZALA tutaj stary adres — i to na kanale, na ktorym panel
  // naprawde nadaje paczki.
  it('wyczyszczony w sklepie blok shipping SCHODZI do panelu (bezpiecznik nadania działa)', () => {
    const db = baza();
    zapiszZamowienie(db, 'pro', zam({ klient: wooKlient, dostawa: { ...wooKlient } }), {});
    zapiszZamowienie(db, 'pro', zam({ klient: wooKlient, dostawa: wooWyczyszczony }), {});

    const dostawa = JSON.parse(czytaj(db, 'pro').dostawa_json);
    expect(dostawa.address_1).toBe('');
    expect(dostawa.city).toBe('');

    // I skutek, dla ktorego to w ogole ma znaczenie: ekran nadania MUSI odmowic, a nie
    // pokazac wiarygodny STARY adres.
    const adres = adresOdbiorcy({ dostawa, klient: wooKlient, dostawa_reczna_json: null });
    expect(brakujacePolaAdresu(adres)).toEqual(['ulica', 'kod', 'miasto']);
  });

  it('pusty obiekt {} w bloku sklepu też schodzi — pustka nie jest brakiem', () => {
    const db = baza();
    zapiszZamowienie(db, 'pro', zam({ klient: wooKlient, dostawa: { ...wooKlient } }), {});
    zapiszZamowienie(db, 'pro', zam({ klient: wooKlient, dostawa: {} }), {});

    expect(JSON.parse(czytaj(db, 'pro').dostawa_json)).toEqual({});
  });
});

// =================================================================================
// CZESC 3 — DECYZJA „CO ZNACZY PUSTY ADRES" MIESZKA W MAPOWANIU ALLEGRO
//
// Tu jest sedno zadania. Dane osobowe kupujacego Allegro WYGASAJA, a poller chodzi co dwie
// minuty. Blok `klient` NIGDY nie sklada sie z samego adresu: `klientAllegro` dokleja `email`
// z `buyer`, a `dostawaAllegro` — `phone` z koperty dostawy. Mail jest adresem POSREDNIKA
// („…@allegromail.pl"), czyli polem z NAJWIEKSZA szansa na przezycie anonimizacji.
// =================================================================================

const kwota = (a) => ({ amount: a, currency: 'PLN' });
const mapowanie = { metodaZId: () => ({ metoda: 'allegro_dpd', etykieta: 'Allegro DPD' }) };

const surowe = ({ buyerAddress, deliveryAddress, invoice = null, buyer = {} } = {}) => ({
  id: 'e2a1-…', status: 'READY_FOR_PROCESSING',
  payment: { type: 'ONLINE', finishedAt: '2026-08-01T11:00:00Z' },
  buyer: {
    email: 'a1b2c3@allegromail.pl', firstName: null, lastName: null, phoneNumber: null,
    address: buyerAddress, ...buyer,
  },
  delivery: {
    method: { id: 'm-1', name: 'Allegro Kurier DPD' }, cost: kwota('0.00'),
    address: deliveryAddress,
  },
  invoice: invoice ?? { required: false },
  lineItems: [{
    id: 'li-1', offer: { name: 'Szablon', external: null }, quantity: 1,
    price: kwota('99.00'), tax: { rate: '23.00' }, boughtAt: '2026-08-01T10:00:00Z',
  }],
  surcharges: [],
  summary: { totalToPay: kwota('99.00') },
});

// Adres, ktory Allegro oddaje normalnie.
const kopertaPelna = () => ({
  firstName: 'Jan', lastName: 'Kowalski', street: 'Rynek 1', zipCode: '00-650',
  city: 'Pęki', countryCode: 'PL', phoneNumber: '600100200',
});
// Ta sama koperta PO WYGASNIECIU danych: struktura zostaje, pola sa wyzerowane.
// ⚠️ `countryCode` ZOSTAJE — kod kraju nie jest dana osobowa, wiec ma najwieksze szanse
// przezyc anonimizacje, a jego wliczenie unicestwiloby cala ochrone.
const kopertaWygasla = (dodatkowe = {}) => ({
  firstName: null, lastName: null, street: null, zipCode: null, city: null,
  countryCode: 'PL', ...dodatkowe,
});

describe('mapowanie Allegro: wygasła koperta to BRAK adresu, nie adres pusty', () => {
  // ⚠️ SEDNO CALEGO ZADANIA. Zostaje SAM MAIL POSREDNIKA — pole, ktore `klientAllegro`
  // dokleja z `buyer`, a nie z adresu. Regula liczaca pola GOTOWEGO bloku widzialaby tu
  // „tresc" i przepuscila skasowanie adresu dokladnie tak, jak przed cala ta zmiana.
  it('koperta nabywcy z samym mailem @allegromail.pl → klient = null', () => {
    const z = mapujZamowienieAllegro(surowe({ buyerAddress: kopertaWygasla() }), mapowanie);
    expect(z.klient).toBe(null);
  });

  it('koperta dostawy z samym telefonem → dostawa = null (telefon to nie adres)', () => {
    const z = mapujZamowienieAllegro(
      surowe({ deliveryAddress: kopertaWygasla({ phoneNumber: '600100200' }) }),
      mapowanie,
    );
    expect(z.dostawa).toBe(null);
  });

  it('wygasły adres faktury też daje null, mimo że nazwa firmy została w invoice', () => {
    // `invoice.address` jest na 39 z 60 zamowien i wtedy to ON jest podstawa bloku `klient`.
    const z = mapujZamowienieAllegro(surowe({
      buyerAddress: kopertaWygasla(),
      invoice: { required: true, address: { street: null, zipCode: null, city: null, countryCode: 'PL', company: { taxId: '1234563218' } } },
    }), mapowanie);
    expect(z.klient).toBe(null);
    // ...a `nip` z tego samego bloku wyzeruje sie CICHO — jawny dlug, przewodnik 4.7a.
    expect(z.nip).toBe('1234563218');
  });

  it('brak całego bloku adresu (undefined) dalej daje null', () => {
    const z = mapujZamowienieAllegro(surowe({}), mapowanie);
    expect(z.klient).toBe(null);
    expect(z.dostawa).toBe(null);
  });

  // --- GORNA GRANICA: gdzie ochrona ma sie KONCZYC ----------------------------------

  // ⚠️ Bez tego testu mozna wylaczyc z liczenia dowolne pole (np. `email` i `phone`)
  // i wszystko dalej swieci na zielono — czyli ochrona rozlewa sie na bloki, w ktorych
  // zostala sama tresc NIEADRESOWA, a nikt tego nie zauwazy.
  it('GÓRNA GRANICA: jedno prawdziwe pole (samo miasto) → blok schodzi i NADPISUJE', () => {
    const z = mapujZamowienieAllegro(surowe({
      buyerAddress: kopertaWygasla({ city: 'Oświęcim' }),
      deliveryAddress: kopertaWygasla({ city: 'Oświęcim' }),
    }), mapowanie);
    expect(z.klient?.city).toBe('Oświęcim');
    expect(z.dostawa?.city).toBe('Oświęcim');
    // Nadpisanie jest CALYM BLOKIEM: stara ulica ma zniknac, nie doklejac sie.
    expect(z.klient.address_1).toBe(null);

    const db = baza();
    zapiszZamowienie(db, 'allegro_szkicownia', zam({
      klient: { city: 'Pęki', address_1: 'Rynek 1' }, dostawa: { city: 'Pęki', address_1: 'Rynek 1' },
    }), {});
    zapiszZamowienie(db, 'allegro_szkicownia', zam({ klient: z.klient, dostawa: z.dostawa }), {});
    expect(JSON.parse(czytaj(db).klient_json).city).toBe('Oświęcim');
    expect(JSON.parse(czytaj(db).klient_json).address_1).toBe(null);
  });

  it('GÓRNA GRANICA: samo nazwisko odbiorcy to też dana — blok schodzi', () => {
    // Swiadomy wybor kierunku (patrz komentarz przy `adresPanelu`): nie wiemy, czy przy
    // paczkomacie koperta dostawy niesie ulice, a blok oddawany jako `null` przy KAZDEJ
    // synchronizacji znaczylby brak nazwiska odbiorcy na paczce.
    const z = mapujZamowienieAllegro(surowe({
      deliveryAddress: kopertaWygasla({ lastName: 'Kowalski', phoneNumber: '600100200' }),
    }), mapowanie);
    expect(z.dostawa?.last_name).toBe('Kowalski');
  });

  it('GÓRNA GRANICA: normalny ruch przechodzi w całości — nic nie jest zamrożone', () => {
    const z = mapujZamowienieAllegro(surowe({
      buyerAddress: kopertaPelna(), deliveryAddress: kopertaPelna(),
    }), mapowanie);
    expect(z.klient.address_1).toBe('Rynek 1');
    expect(z.klient.email).toBe('a1b2c3@allegromail.pl');
    expect(z.dostawa.city).toBe('Pęki');
    expect(z.dostawa.phone).toBe('600100200');
  });
});

// ⚠️ Mapowanie i zapis musza sie ZLOZYC. Kazda z tych warstw z osobna moze byc poprawna,
// a razem dawac skasowany adres — dokladnie to zdarzylo sie w pierwszym podejsciu.
describe('mapowanie + zapis razem: adres przeżywa wygaśnięcie danych', () => {
  it('drugi przebieg pollera po wygaśnięciu danych NIE KASUJE adresu na karcie', () => {
    const db = baza();
    const pelne = mapujZamowienieAllegro(
      surowe({ buyerAddress: kopertaPelna(), deliveryAddress: kopertaPelna() }),
      mapowanie,
    );
    zapiszZamowienie(db, 'allegro_szkicownia', { ...pelne, zrodlo_id: 'a-1', pozycje: [] }, {});

    // ...dwie minuty pozniej Allegro oddaje juz tylko mail posrednika i telefon.
    const wygasle = mapujZamowienieAllegro(
      surowe({
        buyerAddress: kopertaWygasla(),
        deliveryAddress: kopertaWygasla({ phoneNumber: '600100200' }),
      }),
      mapowanie,
    );
    zapiszZamowienie(db, 'allegro_szkicownia', { ...wygasle, zrodlo_id: 'a-1', pozycje: [] }, {});

    const w = czytaj(db);
    expect(JSON.parse(w.klient_json).address_1).toBe('Rynek 1');
    expect(JSON.parse(w.dostawa_json).city).toBe('Pęki');

    // I to, co naprawde ma znaczenie: ekran nadania dalej ma komplet adresu.
    const adres = adresOdbiorcy({
      dostawa: JSON.parse(w.dostawa_json), klient: JSON.parse(w.klient_json),
      dostawa_reczna_json: null,
    });
    expect(brakujacePolaAdresu(adres)).toEqual([]);
    expect(adres.ulica).toBe('Rynek 1');
  });
});
