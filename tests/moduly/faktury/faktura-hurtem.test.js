import { describe, it, expect } from 'vitest';
import { createFakturaHurtem, BUDZET_HURTU_MS } from '../../../src/moduly/faktury/services/faktura-hurtem.js';

const zam = (id, numer, n = {}) => ({
  id, numer, kwota_brutto: '100.00', pozycje: [], platnosci: [{ kwota: '100.00' }],
  wyslane_at: null, ...n,
});

// Ile „trwa" jedna faktura w testach przerwania budzetem — LICZONE Z BUDZETU, nie wpisane
// liczba. Te testy mierza MECHANIZM („po przekroczeniu przestaje zaczynac nowe, reszta wraca
// jako nietknieta"), a nie konkretna wartosc stalej. Do 12.08.2026 stalo tu twarde 20_000,
// dobrane pod budzet 45 s — i przy podniesieniu budzetu do 150 s dwa testy upadly, nie
// dlatego, ze mechanizm przestal dzialac, tylko dlatego, ze arytmetyka fixture'u przestala
// pasowac. Test, ktory upada z powodu poprawnej zmiany, uczy ignorowania czerwieni.
//
// Polowa budzetu daje ZAWSZE ten sam ksztalt przebiegu: pierwsza i druga faktura mieszcza
// sie (po drugiej uplyw jest DOKLADNIE rowny budzetowi, czyli jeszcze nie przekroczony),
// trzecia tez rusza, a czwarta juz nie.
const KROK_MS = BUDZET_HURTU_MS / 2;

describe('wystawianie faktur hurtem', () => {
  it('wystawia po kolei, w podanej kolejnosci, i oddaje numery', async () => {
    const wolania = [];
    const faktura = { wystaw: async (id) => { wolania.push(id); return { numer: `F-${id}` }; } };
    const h = createFakturaHurtem({ faktura });
    const wynik = await h.wystawWiele([zam(1, 'A'), zam(2, 'B'), zam(3, 'C')]);
    expect(wolania).toEqual([1, 2, 3]);
    expect(wynik.wystawione).toEqual([
      { id: 1, numer: 'A', numerFaktury: 'F-1' },
      { id: 2, numer: 'B', numerFaktury: 'F-2' },
      { id: 3, numer: 'C', numerFaktury: 'F-3' },
    ]);
    expect(wynik.bledy).toEqual([]);
    expect(wynik.nietkniete).toEqual([]);
  });

  // ⚠️ SEKWENCYJNOSC, a nie sama kolejnosc wywolan. Test wyzej przechodzi TAKZE na wersji
  // z `Promise.all`, bo atrapa zapisuje `id` synchronicznie, zanim odda sterowanie — czyli
  // nie odroznia petli od rownoleglosci. Tutaj atrapa naprawde oddaje sterowanie w srodku,
  // wiec przeplot „wejscie-1, wejscie-2, ..." wyszedlby na jaw. Numery faktur sa kolejne
  // i przekladaja sie na chronologie zamowien, a numeracji ksiegowej nie da sie przestawic
  // po fakcie — to wymaganie nie moze byc chronione komentarzem.
  it('wystawia sekwencyjnie — nie zaczyna nastepnej przed koncem poprzedniej', async () => {
    const slad = [];
    const faktura = {
      wystaw: async (id) => {
        slad.push(`wejscie-${id}`);
        await new Promise((r) => { setTimeout(r, 0); });
        slad.push(`wyjscie-${id}`);
        return { numer: `F-${id}` };
      },
    };
    await createFakturaHurtem({ faktura }).wystawWiele([zam(1, 'A'), zam(2, 'B'), zam(3, 'C')]);
    expect(slad).toEqual([
      'wejscie-1', 'wyjscie-1',
      'wejscie-2', 'wyjscie-2',
      'wejscie-3', 'wyjscie-3',
    ]);
  });

  // ⚠️ Zasada wspolna wszystkim akcjom masowym modulu: jedno zamowienie, ktorego nie da sie
  // ruszyc, NIE BLOKUJE reszty. Odmowa calosci znaczylaby, ze operator szuka winowajcy wsrod
  // dwudziestu zaznaczen i klika jeszcze raz.
  it('awaria jednej faktury nie przerywa partii', async () => {
    const faktura = {
      wystaw: async (id) => {
        if (id === 2) throw new Error('inFakt odmowil');
        return { numer: `F-${id}` };
      },
    };
    const wynik = await createFakturaHurtem({ faktura }).wystawWiele([zam(1, 'A'), zam(2, 'B'), zam(3, 'C')]);
    expect(wynik.wystawione.map((w) => w.numer)).toEqual(['A', 'C']);
    expect(wynik.bledy).toEqual([{ id: 2, numer: 'B', powod: 'inFakt odmowil' }]);
  });

  // ⚠️⚠️ SEDNO ZADANIA. Partia ciagnaca sie bez konca zostawia czlowieka przy krecacym sie
  // kolku, bez wiedzy o tym, co juz powstalo w inFakcie. Petla przestaje ZACZYNAC nowe, gdy
  // budzet sie konczy, i oddaje ekran wyniku.
  //
  // ⚠️ SPROSTOWANIE 12.08.2026: stalo tu „Limit pojedynczego zadania HTTP to 60 s" i to bylo
  // NIEPRAWDA — panel ustawia `requestTimeout: 0` jawnie, a 60 s to limit WYCHODZACY do
  // inFaktu (`LIMIT_ZADANIA_MS`). Budzet chroni OPERATORA, nie serwer; pelne wyjasnienie
  // stoi przy `BUDZET_HURTU_MS` w services/faktura-hurtem.js.
  //
  // ⚠️ PIEC zamowien, nie cztery: do przerwania musza zostac CO NAJMNIEJ DWA. Przy jednym
  // „reszta listy" i „biezace zamowienie" to ta sama tablica, wiec okrojenie `nietkniete`
  // do samego biezacego wpisu przechodzilo niezauwazone. Sufit partii to 25 zamowien, wiec
  // prawdziwe przerwanie wypadnie w SRODKU listy: partia urwana na dziesiatej oddalaby
  // wtedy jedno `nietkniete` zamiast pietnastu, a czternascie zamowien znikaloby z ekranu
  // wyniku bez sladu. To ten sam tryb awarii, dla ktorego cały budzet powstal — czlowiek,
  // ktory nie wie, co ma w inFakcie — tylko przesuniety o jeden ekran dalej.
  //
  // Asercja na pelna tablice (a nie na dlugosc czy `toContain`) domyka przy okazji
  // KOLEJNOSC wpisow: operator ma zobaczyc pominiete w kolejnosci listy, ktora zatwierdzil.
  it('po wyczerpaniu budzetu czasu przestaje zaczynac nowe i oddaje CALA reszte jako nietkniete', async () => {
    let zegar = 0;
    const faktura = { wystaw: async (id) => { zegar += KROK_MS; return { numer: `F-${id}` }; } };
    const h = createFakturaHurtem({ faktura, teraz: () => zegar });
    const wynik = await h.wystawWiele([
      zam(1, 'A'), zam(2, 'B'), zam(3, 'C'), zam(4, 'D'), zam(5, 'E'),
    ]);
    expect(wynik.wystawione.map((w) => w.numer)).toEqual(['A', 'B', 'C']);
    expect(wynik.nietkniete).toEqual([{ id: 4, numer: 'D' }, { id: 5, numer: 'E' }]);
  });

  // Pierwsza faktura idzie ZAWSZE — inaczej wolny dzien inFaktu dawalby partie, ktora
  // nie zrobila nic i nie umie powiedziec dlaczego.
  //
  // Budzet JEST tu przekroczony juz przy wejsciu w petle: `start` to moment przyjscia
  // zadania HTTP, cofniety o wiecej niz caly budzet (tyle zjadlo wczytanie listy i podzial),
  // a zegar stoi. Tak wyglada wolny dzien inFaktu widziany przez trase.
  it('pierwsza probe podejmuje nawet po przekroczeniu budzetu', async () => {
    const zegar = 1_700_000_000_000;
    const faktura = { wystaw: async (id) => ({ numer: `F-${id}` }) };
    const h = createFakturaHurtem({ faktura, teraz: () => zegar });
    const wynik = await h.wystawWiele([zam(1, 'A'), zam(2, 'B')], {
      start: zegar - BUDZET_HURTU_MS - 1,
    });
    expect(wynik.wystawione.map((w) => w.numer)).toEqual(['A']);
    expect(wynik.nietkniete.map((w) => w.numer)).toEqual(['B']);
  });

  // ⚠️⚠️ ART. 19a UST. 8. Na karcie date sprzedazy podaje formularz; przy hurcie nie ma
  // formularza, a pominiecie pola daje `sale_date = invoice_date`. Hurt dotyczy WYLACZNIE
  // zamowien oplaconych, wiec bez tego bledna bylaby KAZDA faktura z tej drogi.
  //
  // ⚠️ Data wplaty idzie polem `data` — TAK, JAK CZYTA JA `domain/platnosci.js`
  // (`p.data ?? p.utworzona_at`). Wczesniej fixture podawal `at`, o ktorym domena nie wie:
  // wplata byla BEZDATNA, galaz art. 19a ust. 8 nie odpalala sie wcale, a test przechodzil
  // na ostatnim fallbacku, czyli na DZISIAJ — dokladnie na dacie rownej dacie wystawienia,
  // ktora to zadanie ma wykluczyc. Dlatego asercja jest na KONKRETNA date, a nie na ksztalt
  // napisu: „wyglada jak data" przechodzi rowniez dla wartosci zakazanej.
  it('podaje termin ZAPLACONE i date sprzedazy z dnia zaplaty', async () => {
    const przekazane = [];
    const faktura = { wystaw: async (id, t) => { przekazane.push(t); return { numer: `F-${id}` }; } };
    const oplacone = zam(1, 'A', { platnosci: [{ kwota: '100.00', data: '2026-08-03T09:00:00.000Z' }] });
    await createFakturaHurtem({ faktura }).wystawWiele([oplacone]);
    expect(przekazane[0].termin).toBe('zaplacone');
    expect(przekazane[0].dataSprzedazy).toBe('2026-08-03');
  });

  // Granica budzetu rozstrzygnieta SWIADOMIE: dokladnie `BUDZET_HURTU_MS` to jeszcze
  // NIE przekroczenie (`>`, nie `>=`). Przy rownej granicy obie odpowiedzi sa obronne,
  // wiec test istnieje po to, zeby zmiana operatora porownania nie przeszla niezauwazona.
  it('dokladnie na granicy budzetu jeszcze wystawia', async () => {
    const zegar = 1_700_000_000_000;
    const faktura = { wystaw: async (id) => ({ numer: `F-${id}` }) };
    const h = createFakturaHurtem({ faktura, teraz: () => zegar });
    const wynik = await h.wystawWiele([zam(1, 'A'), zam(2, 'B')], {
      start: zegar - BUDZET_HURTU_MS,
    });
    expect(wynik.wystawione.map((w) => w.numer)).toEqual(['A', 'B']);
    expect(wynik.nietkniete).toEqual([]);
  });

  // ⚠️ POMYLKA TRASY MA BYC TANIA. Wartosc domyslna parametru broni wylacznie przed
  // `undefined`, a trasa moze rownie dobrze podac `null` (kolumna z bazy) albo napis
  // (znacznik z formularza). Bez `Number.isFinite`: `null` dawalby uplyw rowny calej
  // epoce uniksowej, czyli JEDNA fakture z dwudziestu po cichu, a napis dawalby `NaN`,
  // przy ktorym warunek budzetu jest zawsze falszywy — zabezpieczenie znikaloby bez sladu.
  // `start: null` — kolumna z bazy, ktora przyszla pusta. Zegar STOI, wiec przy poprawnym
  // spadku do „teraz" nic nie jest przekroczone i wychodzi komplet.
  it('`start: null` nie obcina partii', async () => {
    const zegar = 1_700_000_000_000;
    const faktura = { wystaw: async (id) => ({ numer: `F-${id}` }) };
    const h = createFakturaHurtem({ faktura, teraz: () => zegar });
    const wynik = await h.wystawWiele([zam(1, 'A'), zam(2, 'B'), zam(3, 'C')], { start: null });
    expect(wynik.wystawione.map((w) => w.numer)).toEqual(['A', 'B', 'C']);
    expect(wynik.nietkniete).toEqual([]);
  });

  // `start` jako napis — znacznik z formularza albo z bazy, w trasie bardzo prawdopodobny.
  // Tryb awarii jest tu ODWROTNY niz przy `null`: `teraz() - '...'` to `NaN`, a `NaN > BUDZET`
  // jest zawsze falszywe, wiec budzet nie zadzialalby NIGDY i partia leciałaby bez konca.
  // Dlatego zegar tu IDZIE — test sprawdza, ze zabezpieczenie nadal tnie.
  it('`start` jako napis nie wylacza budzetu', async () => {
    let zegar = 1_700_000_000_000;
    const faktura = { wystaw: async (id) => { zegar += KROK_MS; return { numer: `F-${id}` }; } };
    const h = createFakturaHurtem({ faktura, teraz: () => zegar });
    const wynik = await h.wystawWiele(
      [zam(1, 'A'), zam(2, 'B'), zam(3, 'C'), zam(4, 'D')],
      { start: '2026-08-11T10:00:00Z' },
    );
    expect(wynik.wystawione.map((w) => w.numer)).toEqual(['A', 'B', 'C']);
    expect(wynik.nietkniete).toEqual([{ id: 4, numer: 'D' }]);
  });
});
