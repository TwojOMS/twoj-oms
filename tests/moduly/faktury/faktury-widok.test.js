import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijFakture, zakonczFakture } from '../../../src/moduly/faktury/db/faktury.js';
import { zapiszProforme, uniewaznijPoprzednie } from '../../../src/moduly/faktury/db/proformy.js';
import { zapewnijOkres, zakonczFaktureOkresu } from '../../../src/oms/db/okresy.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';

function baza() {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 'w-1', numer: '3001', klient: { first_name: 'Jan' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 1, nip: null,
    kwota_brutto: '123.00', status_woo: 'processing',
    // Kolumny NOT NULL-owe wprost — sterownik SQLite nie zwiaze `undefined`.
    oplacone_at: null, anulowane: 0,
  }, {});
  const f = rozpocznijFakture(db, id);
  zakonczFakture(db, f.id, { uuid: 'u1', numer: '1/08/2026', ksefStatus: null });
  return { db, id };
}

const infaktZ = (faktury, korekty = [], nieoplacone = []) => ({
  listaFaktur: async () => faktury,
  listaKorekt: async () => korekty,
  listaNieoplaconych: async () => nieoplacone,
});

// Zamówienie za pobraniem z fakturą, do wyposażenia w paczkę (paczki) — bez ich stanu
// u kuriera dokument nie mówi nic o zwrocie, więc obie funkcje niżej domykają go same.
function zamowieniePobrania(db, nr, uuid) {
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: nr, numer: String(nr), klient: { email: 'k@k.pl' }, dostawa: {},
    metoda_wysylki: 'dpd', kwota_pobrania: '83.99', pobranie: 1, chce_fakture: 1, nip: null,
    kwota_brutto: '83.99', status_woo: 'processing', oplacone_at: null, anulowane: 0,
    utworzone_at: '2026-08-20T10:00:00Z', pozycje: [],
  }, {});
  db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, ?)')
    .run(id, uuid, `${nr}/08/2026`, '2026-08-20T08:00:00.000Z');
  return id;
}

// Zamówienie za pobraniem z fakturą i JEDNĄ paczką w zadanym stanie u kuriera.
function pobranieZPaczka(db, { nr, uuid, opisKuriera }) {
  const id = zamowieniePobrania(db, nr, uuid);
  const p = rozpocznijPrzesylke(db, id, 'dpd');
  zakonczPrzesylke(db, p.id, { numerListu: `N${nr}`, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  zapiszStatusDpd(db, p.id, { opis: opisKuriera, at: '2026-08-25T14:00:00.000' });
  return id;
}

// ⚠️ WIELOPACZKOWY WARIANT (nauczka Zadania 5, K1 — komentarz przy `POBRANIA_PRZESYLKI`
// w services/faktury-widok.js): `rozpocznijPrzesylke` broni się przed drugą paczką pod tym
// samym numerem kolejnym, więc `kolejnosc` trzeba podać wprost (1, potem 2).
function pobranieZDwiemaPaczkami(db, { nr, uuid, paczki }) {
  const id = zamowieniePobrania(db, nr, uuid);
  for (const { opisKuriera, at, kolejnosc } of paczki) {
    const p = rozpocznijPrzesylke(db, id, 'dpd', kolejnosc);
    zakonczPrzesylke(db, p.id, {
      numerListu: `N${nr}-${kolejnosc}`, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>',
    });
    zapiszStatusDpd(db, p.id, { opis: opisKuriera, at });
  }
  return id;
}

const nieoplaconyDok = (uuid, number) => ({
  uuid, number, status: 'sent', left_to_pay: 8399, payment_method: 'delivery',
  gross_price: 8399, payment_date: '2026-08-27',
});

describe('widok faktur', () => {
  it('doczepia zamówienie po infakt_uuid', async () => {
    const { db, id } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 0, rodzaj: 'vat', invoice_date: '2026-08-03' },
    ]) });
    const wynik = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(wynik[0].zamowienie).toEqual({ id, numer: '3001' });
    expect(wynik[0].kwotaZl).toBe('123.00');
  });

  it('faktura wystawiona poza panelem nie ma zamówienia i to NIE jest błąd', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'obcy', number: '9/08/2026', gross_price: 100, left_to_pay: 0, rodzaj: 'vat', invoice_date: '2026-08-03' },
    ]) });
    expect((await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' }))[0].zamowienie).toBeNull();
  });

  it('liczy termin i pozostałą kwotę dla nieopłaconych', async () => {
    const { db, id } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([], [], [
      { uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 12300, payment_date: '2026-08-01', rodzaj: 'vat' },
    ]) });
    const wynik = await w.nieoplacone({ dzis: '2026-08-06' });
    expect(wynik[0].stanTerminu).toBe('po_terminie');
    expect(wynik[0].opisTerminu).toBe('po terminie o 5 dni');
    expect(wynik[0].pozostaloZl).toBe('123.00');
    expect(wynik[0].zamowienie).toEqual({ id, numer: '3001' });
  });

  // ⚠️⚠️ ZGŁOSZENIE WŁAŚCICIELA 10.08.2026: pas długów pokazywał 67 dokumentów, a zalegały DWA
  // (`64/07/2026`, `24/08/2026`). Pozostałe 65 miało `status: paid` i komplet `paid_date` —
  // oznaczenie zapłaty w inFakcie nie zeruje `left_to_pay`. Filtr `q[left_to_pay_gt]=0` zostaje
  // w zapytaniu jako tanie zawężenie, ale ROZSTRZYGA `czekaNaPrzelew` (domain/lista-faktur.js).
  it('odsiewa dokumenty oznaczone w inFakcie jako zapłacone', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([], [], [
      { uuid: 'a', number: '64/07/2026', status: 'sent', left_to_pay: 88842, payment_method: 'transfer', payment_date: '2026-08-14', gross_price: 88842, rodzaj: 'vat' },
      { uuid: 'b', number: '19/12/2025', status: 'paid', left_to_pay: 12300, payment_method: 'transfer', payment_date: '2025-12-24', gross_price: 12300, rodzaj: 'vat' },
      { uuid: 'c', number: '32/12/2025', status: 'paid', left_to_pay: 5000, payment_method: 'delivery', payment_date: '2025-12-28', gross_price: 5000, rodzaj: 'vat' },
    ]) });
    const wynik = await w.nieoplacone({ dzis: '2026-08-06' });
    expect(wynik.map((d) => d.number)).toEqual(['64/07/2026']);
  });

  // ⚠️ Faktura za pobraniem WYSTAWIONA DZIŚ: pieniądze przyjdą od kuriera, nie przelewem, więc
  // nie ma tu nikogo do upomnienia. Test stoi osobno od tego wyżej, bo tamten odsiewa ją już
  // po statusie — a ten pilnuje wiersza, którego status jeszcze nie zdążył się zmienić.
  it('nie dopisuje faktur za pobraniem, choćby były jeszcze nieopłacone', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([], [], [
      { uuid: 'p', number: '30/08/2026', status: 'sent', left_to_pay: 17180, payment_method: 'delivery', payment_date: '2026-08-06', gross_price: 17180, rodzaj: 'vat' },
    ]) });
    expect(await w.nieoplacone({ dzis: '2026-08-06' })).toEqual([]);
  });

  // ⚠️ REGRESJA DO PILNOWANIA (decyzja właściciela 06.08.2026, spec §4.1): panel NIE liczy
  // własnego zdania o tym, czy faktura jest zapłacona, choć dane po temu ma (wpłaty
  // zamówienia). Statusy porządkuje właściciel w inFakcie; druga prawda o pieniądzach
  // zostałaby w kodzie na zawsze, a przy pierwszym rozjeździe z innego powodu (zaliczka,
  // nadpłata, korekta) nikt nie wiedziałby, które zdanie jest wiążące.
  //
  // ⚠️ Test pilnuje CAŁEGO ZESTAWU KLUCZY, a nie jednej nazwy. Poprzednia wersja sprawdzała
  // tylko `not.toHaveProperty('oplaconeWPanelu')` — `zaplaconeWPanelu`, `saldoPanelu` czy
  // `czyOplacona` przeszłyby bokiem, czyli regresja, przed którą ten test stoi, wjechałaby
  // pod inną nazwą. Wolno tu dokładać WYŁĄCZNIE pola z listy niżej; każde nowe pole ma
  // najpierw trafić do tej listy, świadomie.
  it('NIE dokłada własnego zdania o opłaceniu — sędzią jest status z inFaktu (przez stanZaplaty)', async () => {
    const { db } = baza();
    const surowy = {
      uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 12300,
      payment_date: '2026-08-01', rodzaj: 'vat',
    };
    const w = createFakturyWidok({ db, infakt: infaktZ([], [], [surowy]) });
    const wynik = await w.nieoplacone({ dzis: '2026-08-06' });
    const oczekiwane = [
      ...Object.keys(surowy),
      // `ksefZleconaAt` dopisane ŚWIADOMIE 06.08.2026 (recenzja całości, Finding 1): to jest
      // FAKT z `wysylki_ksef` — „panel zlecił wysyłkę tego dokumentu do KSeF" — a nie zdanie
      // o pieniądzach. Bez niego lista mówiła „brak KSeF" przez ~70 sekund po wysyłce, którą
      // sama zleciła, i oddawała pole wyboru do drugiego, nieodwracalnego zgłoszenia.
      'zamowienie', 'okres', 'stanKsef', 'ksefZleconaAt', 'stanTerminu', 'opisTerminu',
      'kwotaZl', 'pozostaloZl',
      // `stanZaplaty` dopisane ŚWIADOMIE 28.08.2026 (Zadanie 2): to jest wynik wspólnej reguły
      // `stanZaplaty` z domain/lista-faktur.js (Zadanie 1), nie własne zdanie widoku o
      // opłaceniu — ta sama kategoria co `stanKsef` czy `stanTerminu` wyżej.
      'stanZaplaty',
    ].sort();
    expect(Object.keys(wynik[0]).sort()).toEqual(oczekiwane);
  });

  it('scala faktury z korektami w jedną listę', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ(
      [{ uuid: 'u1', number: '1/08/2026', invoice_date: '2026-08-01', gross_price: 100, left_to_pay: 0, rodzaj: 'vat' }],
      [{ uuid: 'k1', number: '1/KOR/08/2026', invoice_date: '2026-08-05', gross_price: -100, left_to_pay: 0, rodzaj: 'korekta' }],
    ) });
    const wynik = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(wynik.map((d) => d.number)).toEqual(['1/KOR/08/2026', '1/08/2026']);
  });

  it('śmieciowy miesiąc daje odmowę, a nie zapytanie o całe archiwum', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    await expect(w.dokumenty({ miesiac: 'kiedyś', pole: 'invoice_date' })).rejects.toThrow(/miesi[ąa]c/i);
  });

  // ⚠️ Wołanie bez argumentu ma dać ODMOWĘ PO POLSKU, a nie `TypeError` z destrukturyzacji.
  // Sam tekst błędu tego NIE rozstrzyga: „Cannot destructure property 'miesiac'…" też zawiera
  // słowo „miesiac". Rozstrzyga znacznik `dlaOperatora` — to on decyduje, czy komunikat wolno
  // pokazać na ekranie, czy leci wyłącznie do logu (domain/bledy.js).
  it('wołanie bez argumentów daje odmowę operatorowi, a nie TypeError', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    await expect(w.dokumenty()).rejects.toMatchObject({ dlaOperatora: true });
    await expect(w.dokumenty()).rejects.toThrow(/miesi[ąa]c/i);
  });

  // ⚠️ ZMIERZONE NA ŻYWYM API 06.08.2026 — literówka w nazwie pola daty nie wywala zapytania,
  // tylko je ROZSZERZA na całe archiwum (szczegóły w komentarzu przy `POLA_DATY` w serwisie).
  it('nieznane pole daty daje odmowę, a nie ciche zapytanie o całe archiwum', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    await expect(w.dokumenty({ miesiac: '2026-08', pole: 'nie_ma_takiego' })).rejects.toThrow(/pol[ea]/i);
    await expect(w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date_bzdura' })).rejects.toThrow(/pol[ea]/i);
  });

  it('przepuszcza oba prawdziwe pola daty', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    await expect(w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' })).resolves.toEqual([]);
    await expect(w.dokumenty({ miesiac: '2026-08', pole: 'sale_date' })).resolves.toEqual([]);
  });

  it('null wśród faktur z inFaktu też nie wywraca ekranu', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([
      null,
      { uuid: 'u1', number: '1/08/2026', invoice_date: '2026-08-01', gross_price: 100, left_to_pay: 0, rodzaj: 'vat' },
    ]) });
    const wynik = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(wynik).toHaveLength(2);
  });

  // ⚠️ REGRESJA DO PILNOWANIA: `?? []` NIE WYSTARCZY, bo zdegradowana odpowiedź potrafi być
  // PRAWDZIWYM, niepustym obiektem (`{ error: … }`), a nie tylko `null`/`undefined`. Ale dla
  // TEJ listy nie wolno cichcem zamienić błędu w PUSTĄ TABLICĘ — pusta lista długów na tym
  // ekranie to zdanie „nikt nie zalega", a nie „nie wiemy". Właściciel czyta tę zakładkę,
  // żeby wiedzieć, kto mu jest winien pieniądze; milczenie kosztuje tu więcej niż odmowa
  // (ta sama zasada, co przy `wszystkieStrony` w infakt/client.js).
  it('nie-tablica z listy nieopłaconych daje odmowę, a nie pustą tabelę długów', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: {
      listaFaktur: async () => [],
      listaKorekt: async () => [],
      listaNieoplaconych: async () => ({ error: 'coś poszło nie tak' }),
    } });
    await expect(w.nieoplacone({ dzis: '2026-08-06' })).rejects.toMatchObject({ dlaOperatora: true });
    await expect(w.nieoplacone({ dzis: '2026-08-06' })).rejects.toThrow(/nie rozumie|format/i);
  });

  // Tolerancja na poziomie ELEMENTU zostaje: jeden zepsuty wiersz w tablicy nie ma prawa
  // zwalić całej zakładki — to inny przypadek niż zły KONTENER wyżej.
  it('null wśród nieopłaconych renderuje się jako pusty wiersz, nie wywraca ekranu', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([], [], [
      null,
      { uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 12300, payment_date: '2026-08-01', rodzaj: 'vat' },
    ]) });
    const wynik = await w.nieoplacone({ dzis: '2026-08-06' });
    expect(wynik).toHaveLength(2);
    expect(wynik[0].zamowienie).toBeNull();
    expect(wynik[0].kwotaZl).toBe('0.00');
    expect(wynik[1].zamowienie).not.toBeNull();
  });

  // ⚠️⚠️ CAŁY SENS ZADANIA 6: paczka nieodebrana wraca zwrotem i pieniędzy nie ma — odsianie
  // „bo pobranie" ukrywałoby wtedy realny dług. Patrz `czekaNaPrzelew` w domain/lista-faktur.js.
  it('nieopłacone pobranie ze ZWRÓCONĄ paczką zostaje na pasie długów', async () => {
    const db = openOmsDb(':memory:');
    pobranieZPaczka(db, { nr: 33, uuid: 'u-zwrot', opisKuriera: 'Zwrot do nadawcy' });
    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-zwrot', '33/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista.map((d) => d.number)).toContain('33/08/2026');
  });

  it('nieopłacone pobranie w drodze jest dalej odsiane — kurier dopiero zainkasuje', async () => {
    const db = openOmsDb(':memory:');
    pobranieZPaczka(db, { nr: 28, uuid: 'u-droga', opisKuriera: 'Przyjęcie przesyłki w sortowni' });
    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-droga', '28/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista).toEqual([]);
  });

  // ⚠️⚠️ WIELOPACZKOWY PRZYPADEK (nauczka Zadania 5, K1): paczka 1 ZWRÓCONA (starsza), paczka 2
  // DORĘCZONA (nowsza) — gotówka realnie jest, więc dokument NIE MA prawa wisieć na pasie
  // długów. Bez zawężenia do jednej, najnowszej żywej paczki (patrz `POBRANIA_PRZESYLKI`)
  // sam fakt istnienia JAKIEJŚ zwróconej paczki na zamówieniu wystarczyłby, żeby dokument
  // trafił do zbioru „zwrócone" mimo doręczonej dosyłki.
  it('paczka 1 zwrócona, paczka 2 (nowsza) doręczona — dokument NIE wraca na pas długów', async () => {
    const db = openOmsDb(':memory:');
    pobranieZDwiemaPaczkami(db, {
      nr: 40,
      uuid: 'u-dwie-paczki',
      paczki: [
        { opisKuriera: 'Zwrot do nadawcy', at: '2026-08-24T10:00:00.000', kolejnosc: 1 },
        { opisKuriera: 'Przesyłka doręczona', at: '2026-08-26T10:00:00.000', kolejnosc: 2 },
      ],
    });
    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-dwie-paczki', '40/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista).toEqual([]);
  });

  // ⚠️⚠️ POPRAWKA PO RECENZJI (28.08.2026, KRYTYCZNE): zamówienie złożone w sklepie BEZ
  // pobrania (`z.pobranie = 0`), przełączone na pobranie RĘCZNIE z karty. Zapis idzie
  // WYŁĄCZNIE do `wysylka_reczna_json` — `zapiszNadpisanieWysylki` w db/zamowienia.js nigdy
  // nie rusza kolumny `pobranie`. Faktura dostaje w inFakcie `payment_method: 'delivery'`,
  // bo o sposobie płatności rozstrzyga wartość EFEKTYWNA, nie kolumna ze sklepu — ten sam
  // rachunek, po którym prefiltr SQL ma tu iść. Przed poprawką `z.pobranie = 1` odsiewał taki
  // dokument PRZED regułą `czekaNaPrzelew`, więc paczka wracająca zwrotem znikała z pasa
  // długów mimo że nikt nie zapłacił — dokładnie ten dług, który to zapytanie ma wykrywać.
  it('pobranie włączone RĘCZNIE z karty, paczka ZWRÓCONA — dokument zostaje na pasie długów', async () => {
    const db = openOmsDb(':memory:');
    const id = zapiszZamowienie(db, 'pro', {
      zrodlo_id: '50', numer: '50', klient: { email: 'k@k.pl' }, dostawa: {},
      metoda_wysylki: 'dpd', kwota_pobrania: null, pobranie: 0, chce_fakture: 1, nip: null,
      kwota_brutto: '83.99', status_woo: 'processing', oplacone_at: null, anulowane: 0,
      utworzone_at: '2026-08-20T10:00:00Z', pozycje: [],
    }, {});
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?')
      .run('{"metoda":"dpd","pobranie":1,"kwota_pobrania":"83.99"}', id);
    db.prepare('INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, ?)')
      .run(id, 'u-reczne', '50/08/2026', '2026-08-20T08:00:00.000Z');
    const p = rozpocznijPrzesylke(db, id, 'dpd');
    zakonczPrzesylke(db, p.id, { numerListu: 'N50', etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
    zapiszStatusDpd(db, p.id, { opis: 'Zwrot do nadawcy', at: '2026-08-25T14:00:00.000' });

    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-reczne', '50/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista.map((d) => d.number)).toContain('50/08/2026');
  });

  // ⚠️⚠️ DRUGI KIERUNEK TEGO SAMEGO NADPISANIA (recenzja poprawkowa 28.08.2026, W3) i jedyny,
  // który był CICHY. Zamówienie sklepowe Z pobraniem, przełączone RĘCZNIE na PRZEDPŁATĘ:
  // `z.pobranie = 1` przechodziło prefiltr SQL, a `czyPobranie` — wartość EFEKTYWNA — nie było
  // tu wołane ANI RAZU, więc jedynym testem „czy to pobranie" był ten prefiltr. Po zwrocie
  // paczki dokument lądował na pasie długów jako „zwrócone pobranie", którego już nie ma,
  // a czuwacz pobrań tego zamówienia nie widział wcale (`kandydatow: 0`). Trzy warstwy, trzy
  // różne zdania o jednym zamówieniu.
  it('pobranie WYŁĄCZONE ręcznie z karty, paczka zwrócona — to NIE jest zwrócone pobranie', async () => {
    const db = openOmsDb(':memory:');
    const id = pobranieZPaczka(db, { nr: 51, uuid: 'u-przedplata', opisKuriera: 'Zwrot do nadawcy' });
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?')
      .run('{"metoda":"dpd","pobranie":0}', id);

    // Dokument dalej niesie `payment_method: 'delivery'`, więc gdyby zbiór „bez gotówki" liczył
    // sam prefiltr SQL, wiersz zostałby na pasie długów jako zwrócone pobranie.
    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-przedplata', '51/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista).toEqual([]);
  });

  // ⚠️⚠️ BEZPIECZNIK NIEUDANEGO DORĘCZENIA PO OBU STRONACH (recenzja poprawkowa 28.08.2026, W4).
  // „Nie doręczono — adresat nieobecny" ma `etapPrzesylki === 'doreczona'`, więc czuwacz
  // przesyłek PRZESTAJE tę paczkę odpytywać (doręczone wypadają z puli) — a pas długów, dopóki
  // pytał wyłącznie o `'zwrot'`, jej NIE POKAZYWAŁ. Gotówki nie ma, faktura nieopłacona,
  // a dokument znikał z listy „kto nam zalega" NA STAŁE: w naszych danych ta paczka już się
  // nigdy nie ruszy. Rozstrzyga `czyPaczkaBezGotowki` — ta sama funkcja, co w ścieżce pieniędzy.
  it('nieudane doręczenie („adresat nieobecny") WRACA na pas długów', async () => {
    const db = openOmsDb(':memory:');
    pobranieZPaczka(db, { nr: 52, uuid: 'u-awizo', opisKuriera: 'Nie doręczono — adresat nieobecny' });
    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-awizo', '52/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista.map((d) => d.number)).toContain('52/08/2026');
  });

  // Druga połowa tej samej reguły: prawdziwe doręczenie dalej NIE wraca. Bez tego testu
  // „wszystko na pas długów" przechodziłoby jako poprawka.
  it('prawdziwe doręczenie dalej NIE wraca na pas długów', async () => {
    const db = openOmsDb(':memory:');
    pobranieZPaczka(db, { nr: 53, uuid: 'u-doreczona', opisKuriera: 'Przesyłka doręczona' });
    const infakt = { listaNieoplaconych: async () => ([nieoplaconyDok('u-doreczona', '53/08/2026')]) };
    const lista = await createFakturyWidok({ db, infakt }).nieoplacone({ dzis: '2026-08-28' });
    expect(lista).toEqual([]);
  });
});

// ⚠️ SPROSTOWANIE 28.08.2026: kolumna „Płatność" do dziś czytała `Number(pozostaloZl) > 0`,
// czyli `left_to_pay` — pole, którego oznaczenie zapłaty w inFakcie NIE ZERUJE (docblock
// `stanZaplaty` w domain/lista-faktur.js). Sześć dokumentów sierpnia świeciło przez to na
// czerwono mimo statusu `paid`. Ten opis pilnuje, że `wzbogac` przestaje liczyć kwotę i
// zamiast tego woła wspólną regułę.
describe('stan zapłaty na wzbogaconym dokumencie', () => {
  it('dokument opłacony w inFakcie dostaje stanZaplaty „zaplacona" mimo niezerowego left_to_pay', async () => {
    const { db } = baza();
    const infakt = {
      listaFaktur: async () => ([{
        uuid: 'u-51', number: '51/08/2026', rodzaj: 'vat', status: 'paid',
        left_to_pay: 99000, gross_price: 99000, invoice_date: '2026-08-26',
      }]),
      listaKorekt: async () => ([]),
    };
    const widok = createFakturyWidok({ db, infakt });
    const [d] = await widok.dokumenty({ miesiac: '2026-08', dzis: '2026-08-28' });
    expect(d.stanZaplaty).toBe('zaplacona');
    // Kwota ZOSTAJE na obiekcie — widok pokazuje ją tylko przy `do_zaplaty`.
    expect(d.pozostaloZl).toBe('990.00');
  });

  it('dokument realnie niezapłacony dostaje „do_zaplaty"', async () => {
    const { db } = baza();
    const infakt = {
      listaFaktur: async () => ([{
        uuid: 'u-44', number: '44/08/2026', rodzaj: 'vat', status: 'sent',
        left_to_pay: 5489, gross_price: 5489, invoice_date: '2026-08-20',
      }]),
      listaKorekt: async () => ([]),
    };
    const widok = createFakturyWidok({ db, infakt });
    const [d] = await widok.dokumenty({ miesiac: '2026-08', dzis: '2026-08-28' });
    expect(d.stanZaplaty).toBe('do_zaplaty');
  });
});

// ⚠️⚠️ DOKUMENT, KTÓREGO WYSYŁKĘ PANEL JUŻ ZLECIŁ (recenzja całości, Finding 1). inFakt nadaje
// numer KSeF dopiero po ~70 sekundach od przyjęcia zlecenia, więc przez ten czas `ksef_number`
// jest pusty — a lista pokazywała wtedy „brak", oddawała pole wyboru i liczyła taki dokument
// do wysyłki, która i tak odbiłaby się od rezerwacji w `wysylki_ksef`. Ekran, którego jedynym
// zadaniem jest złapać pomyłkę PRZED operacją nieodwracalną, mówił nieprawdę.
//
// Fakt bierzemy z TABELI (`wysylki_ksef`, klucz = uuid inFaktu), nie z treści wpisu w logu —
// dokładnie tak samo, jak robi to druga gałąź warunku czuwacza (domain/ksef-oczekiwanie.js).
describe('widok faktur — wysyłka do KSeF zlecona z panelu', () => {
  it('bez numeru KSeF, ale z rezerwacją — stanKsef „wyslana_czeka" i moment zlecenia', async () => {
    const { db } = baza();
    zajmijWysylkeKsef(db, 'u1', { numer: '1/08/2026', kiedy: '2026-08-06T14:00:00.000Z' });
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 0, rodzaj: 'vat', invoice_date: '2026-08-06' },
    ]) });
    const [d] = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(d.stanKsef).toBe('wyslana_czeka');
    expect(d.ksefZleconaAt).toBe('2026-08-06T14:00:00.000Z');
  });

  it('bez rezerwacji dalej jest „brak" — i to jest jedyny stan z polem wyboru', async () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 0, rodzaj: 'vat', invoice_date: '2026-08-06' },
    ]) });
    const [d] = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(d.stanKsef).toBe('brak');
    expect(d.ksefZleconaAt).toBeNull();
  });

  // ⚠️ NUMER ROZSTRZYGA NAD REZERWACJĄ: gdy inFakt numer już nadał, dokument JEST w KSeF,
  // a nie „czeka" — inaczej ekran zostawałby w stanie przejściowym na zawsze.
  it('gdy numer KSeF już przyszedł, rezerwacja niczego nie zmienia', async () => {
    const { db } = baza();
    zajmijWysylkeKsef(db, 'u1', { numer: '1/08/2026' });
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'u1', number: '1/08/2026', ksef_number: 'KS-1', gross_price: 12300, left_to_pay: 0, rodzaj: 'vat', invoice_date: '2026-08-06' },
    ]) });
    expect((await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' }))[0].stanKsef).toBe('jest');
  });

  // ⚠️ KLUCZEM JEST UUID inFAKTU, więc widać także dokument wystawiony POZA panelem — taki
  // nie ma wiersza ani w `faktury`, ani w `okresy_rozliczeniowe`, a wysłać go z panelu wolno.
  it('rezerwacja dokumentu wystawionego poza panelem też jest widoczna', async () => {
    const { db } = baza();
    zajmijWysylkeKsef(db, 'obcy', { numer: '9/08/2026', kiedy: '2026-08-06T14:00:00.000Z' });
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'obcy', number: '9/08/2026', gross_price: 100, left_to_pay: 0, rodzaj: 'vat', invoice_date: '2026-08-06' },
    ]) });
    const [d] = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(d.stanKsef).toBe('wyslana_czeka');
    expect(d.zamowienie).toBeNull();
  });

  // Pas nieopłaconych czyta te same dokumenty tą samą funkcją — rozjazd między pasami znaczyłby
  // „brak KSeF" w jednej tabeli i „czeka na numer" w drugiej, przy tym samym dokumencie.
  it('pas nieopłaconych zna ten sam stan', async () => {
    const { db } = baza();
    zajmijWysylkeKsef(db, 'u1', { numer: '1/08/2026', kiedy: '2026-08-06T14:00:00.000Z' });
    const w = createFakturyWidok({ db, infakt: infaktZ([], [], [
      { uuid: 'u1', number: '1/08/2026', gross_price: 12300, left_to_pay: 12300, payment_date: '2026-08-01', rodzaj: 'vat' },
    ]) });
    expect((await w.nieoplacone({ dzis: '2026-08-06' }))[0].stanKsef).toBe('wyslana_czeka');
  });
});

// Faktura zbiorcza okresu to faktura WYSTAWIONA Z PANELU — tyle że jej `infakt_uuid` leży
// w `okresy_rozliczeniowe`, nie w `faktury`. Bez drugiego mapowania cały pieniądz B2B
// wyglądałby na ekranie jak dokumenty wklepane wprost w inFakcie.
describe('widok faktur — faktury okresów rozliczeniowych', () => {
  it('faktura okresu ma `okres`, a zwykła faktura ma `zamowienie`', async () => {
    const { db, id } = baza();
    const okres = zapewnijOkres(db, { klientKlucz: 'hurt-abc', rok: 2026, miesiac: 8 });
    zakonczFaktureOkresu(db, okres.id, { uuid: 'okres-1', numer: '5/08/2026', ksefStatus: null });

    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'okres-1', number: '5/08/2026', invoice_date: '2026-08-31', gross_price: 88842, left_to_pay: 0, rodzaj: 'vat' },
      { uuid: 'u1', number: '1/08/2026', invoice_date: '2026-08-03', gross_price: 12300, left_to_pay: 0, rodzaj: 'vat' },
    ]) });
    const [zbiorcza, zwykla] = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });

    expect(zbiorcza.okres).toEqual({ id: okres.id, klient: 'hurt-abc', rok: 2026, miesiac: 8 });
    expect(zbiorcza.zamowienie).toBeNull();
    expect(zbiorcza.kwotaZl).toBe('888.42');

    expect(zwykla.zamowienie).toEqual({ id, numer: '3001' });
    expect(zwykla.okres).toBeNull();
  });

  it('faktura wystawiona poza panelem nie ma ani okresu, ani zamówienia', async () => {
    const { db } = baza();
    const okres = zapewnijOkres(db, { klientKlucz: 'hurt-abc', rok: 2026, miesiac: 8 });
    zakonczFaktureOkresu(db, okres.id, { uuid: 'okres-1', numer: '5/08/2026', ksefStatus: null });
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'obcy', number: '9/08/2026', invoice_date: '2026-08-03', gross_price: 100, left_to_pay: 0, rodzaj: 'vat' },
    ]) });
    const [d] = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(d.okres).toBeNull();
    expect(d.zamowienie).toBeNull();
  });

  // ⚠️ NIEZMIENNIK ISTNIEJE TYLKO W KOMENTARZU PRZY `wzbogac` ("`zamowienie` i `okres`
  // wykluczają się nawzajemnie") — nic w kodzie go nie egzekwuje. `wzbogac` dokłada oba pola
  // NIEZALEŻNIE, po tym samym `uuid`, z dwóch osobnych map. W praktyce kolizja nie może się
  // zdarzyć: wiersz w `faktury` i wiersz w `okresy_rozliczeniowe` to ZAWSZE dwa RÓŻNE dokumenty
  // w inFakcie (każdy ma swoje własne wywołanie `wystaw`), więc żaden prawdziwy `infakt_uuid`
  // nie trafi do obu tabel naraz. Ten test wymusza kolizję sztucznie, żeby PRZYPIĄĆ dzisiejsze
  // zachowanie — gdyby ktoś kiedyś dodał deduplikację, ten test ma to złapać jako świadomą
  // zmianę, nie przez przypadek.
  it('gdy ten sam infakt_uuid trafi do obu tabel (sztucznie), dokument dostaje OBA pola — kolizja niemożliwa w praktyce', async () => {
    const { db, id } = baza();
    const okres = zapewnijOkres(db, { klientKlucz: 'hurt-abc', rok: 2026, miesiac: 8 });
    // Ten sam uuid co faktura zwykła z `baza()` ('u1') — kolizja, która w produkcji nie
    // powstaje, bo oba wiersze zawsze wskazują różne dokumenty inFaktu.
    zakonczFaktureOkresu(db, okres.id, { uuid: 'u1', numer: '5/08/2026', ksefStatus: null });
    const w = createFakturyWidok({ db, infakt: infaktZ([
      { uuid: 'u1', number: '1/08/2026', invoice_date: '2026-08-03', gross_price: 12300, left_to_pay: 0, rodzaj: 'vat' },
    ]) });
    const [d] = await w.dokumenty({ miesiac: '2026-08', pole: 'invoice_date' });
    expect(d.zamowienie).toEqual({ id, numer: '3001' });
    expect(d.okres).toEqual({ id: okres.id, klient: 'hurt-abc', rok: 2026, miesiac: 8 });
  });
});

// ⚠️ PROFORMY FILTRUJEMY PO SERII (rok, miesiac), A NIE PO ZNACZNIKU CZASU. To jest jedyne
// ręcznie pisane SQL w tym module i najłatwiejsze do cichego zepsucia miejsce.
describe('widok faktur — proformy miesiąca', () => {
  it('oddaje proformę pytanego miesiąca razem z numerem zamówienia z joina', () => {
    const { db, id } = baza();
    zapiszProforme(db, id, { kwotaBrutto: '123.00', rok: 2026, miesiac: 8, utworzonaAt: '2026-08-10T09:00:00.000Z' });
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    const wynik = w.proformy({ miesiac: '2026-08' });
    expect(wynik).toHaveLength(1);
    expect(wynik[0].numer).toBe('PF/1/08/2026');
    expect(wynik[0].zamowienie_numer).toBe('3001');
    expect(wynik[0].zamowienie_id).toBe(id);
  });

  it('proforma sąsiedniego miesiąca nie wpada do listy', () => {
    const { db, id } = baza();
    zapiszProforme(db, id, { kwotaBrutto: '123.00', rok: 2026, miesiac: 7, utworzonaAt: '2026-07-15T09:00:00.000Z' });
    zapiszProforme(db, id, { kwotaBrutto: '123.00', rok: 2026, miesiac: 8, utworzonaAt: '2026-08-10T09:00:00.000Z' });
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    expect(w.proformy({ miesiac: '2026-08' }).map((p) => p.numer)).toEqual(['PF/1/08/2026']);
    expect(w.proformy({ miesiac: '2026-07' }).map((p) => p.numer)).toEqual(['PF/1/07/2026']);
  });

  // ⚠️ TA GRANICA BYŁA ZEPSUTA: `utworzona_at` to UTC (`new Date().toISOString()`), a filtr
  // porównywał ją z warszawskim miesiącem kalendarzowym. Proforma wystawiona 1 września
  // 00:30 czasu warszawskiego leży w bazie jako '2026-08-31T22:30Z' i wpadała do SIERPNIA —
  // czyli znikała z września, mimo że na PDF-ie u klienta stoi numer `PF/…/09/2026`.
  it('proforma z września po UTC-owym sierpniu jest we WRZEŚNIU, nie w sierpniu', () => {
    const { db, id } = baza();
    zapiszProforme(db, id, {
      kwotaBrutto: '123.00', rok: 2026, miesiac: 9, utworzonaAt: '2026-08-31T23:30:00.000Z',
    });
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    expect(w.proformy({ miesiac: '2026-09' }).map((p) => p.numer)).toEqual(['PF/1/09/2026']);
    expect(w.proformy({ miesiac: '2026-08' })).toEqual([]);
  });

  // Dokument wystawiony „za poprzedni miesiąc": stempel z sierpnia, seria lipcowa. Rozstrzyga
  // numer wydrukowany na PDF-ie, bo to on stoi w tytule przelewu klienta.
  it('proforma wystawiona za poprzedni miesiąc idzie za swoim numerem, nie za stemplem', () => {
    const { db, id } = baza();
    zapiszProforme(db, id, {
      kwotaBrutto: '123.00', rok: 2026, miesiac: 7, utworzonaAt: '2026-08-04T10:00:00.000Z',
    });
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    expect(w.proformy({ miesiac: '2026-07' }).map((p) => p.numer)).toEqual(['PF/1/07/2026']);
    expect(w.proformy({ miesiac: '2026-08' })).toEqual([]);
  });

  // ⚠️ Unieważniona proforma MA się pokazać — klient dostał ją mailem i ma ją przed sobą,
  // więc ekran musi umieć powiedzieć „ten dokument już nie obowiązuje". Ukrycie jej znaczyłoby,
  // że operator nie widzi dokumentu, o który dzwoni klient.
  it('unieważniona proforma zostaje na liście, ze swoim znacznikiem', () => {
    const { db, id } = baza();
    const p = zapiszProforme(db, id, { kwotaBrutto: '123.00', rok: 2026, miesiac: 8, utworzonaAt: '2026-08-10T09:00:00.000Z' });
    uniewaznijPoprzednie(db, id, null, { teraz: '2026-08-11T09:00:00.000Z' });
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    const wynik = w.proformy({ miesiac: '2026-08' });
    expect(wynik.map((x) => x.id)).toEqual([p.id]);
    expect(wynik[0].uniewazniona_at).toBe('2026-08-11T09:00:00.000Z');
  });

  it('śmieciowy miesiąc daje odmowę, a nie listę wszystkich proform', () => {
    const { db } = baza();
    const w = createFakturyWidok({ db, infakt: infaktZ([]) });
    expect(() => w.proformy({ miesiac: 'kiedyś' })).toThrow(/miesi[ąa]c/i);
    expect(() => w.proformy({ miesiac: '2026-13' })).toThrow(/miesi[ąa]c/i);
    expect(() => w.proformy({})).toThrow(/miesi[ąa]c/i);
  });
});
