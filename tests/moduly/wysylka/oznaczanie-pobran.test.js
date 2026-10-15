import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, zapiszStatusDpd } from '../../../src/moduly/wysylka/db/przesylki.js';
import { oznaczDoreczonePobrania } from '../../../src/moduly/wysylka/services/oznaczanie-pobran.js';
import { oznaczenieZaplaty } from '../../../src/moduly/wysylka/db/oznaczenia-zaplaty.js';

const zmapowane = (nr, nadpisz = {}) => ({
  zrodlo_id: nr, numer: String(nr), klient: { email: 'k@k.pl' }, dostawa: {},
  metoda_wysylki: 'dpd', kwota_pobrania: '123.00', pobranie: 1, chce_fakture: 1, nip: null,
  kwota_brutto: '123.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-08-20T10:00:00Z', pozycje: [], ...nadpisz,
});

// Faktura powiązana z zamówieniem — tak, jak zapisuje ją panel po wystawieniu.
// ⚠️ Tabela `faktury` NIE MA daty wystawienia; ta przychodzi z inFaktu (patrz `dokumenty` niżej).
function zFaktura(db, zamowienieId, uuid, { numer = 'F/1' } = {}) {
  db.prepare(
    'INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, ?, ?, ?)',
  ).run(zamowienieId, uuid, numer, '2026-08-20T08:00:00.000Z');
}

// Klient inFaktu: co oddaje na odczyt dokumentu i co przyjmuje na oznaczenie zapłaty.
function klientInfaktu(dokumenty, { oznacz } = {}) {
  const zlecenia = [];
  // Każdy odczyt dokumentu — po to, żeby dało się zmierzyć, że skan pyta inFakt o daną
  // fakturę DOKŁADNIE RAZ na przebieg (zamówienie z dwiema paczkami dawało dwa `GET`-y).
  const odczyty = [];
  return {
    zlecenia,
    odczyty,
    pobierzFakture: async (uuid) => {
      odczyty.push(uuid);
      return dokumenty[uuid] ?? { uuid, number: null, invoice_date: null, status: null, left_to_pay: null };
    },
    oznaczZaplacona: async (uuid, opcje) => {
      if (oznacz) await oznacz(uuid);
      zlecenia.push({ uuid, ...opcje });
    },
  };
}

const dokWystawiony = (invoiceDate = '2026-08-20') => ({ status: 'sent', left_to_pay: 12300, invoice_date: invoiceDate, number: 'F/1' });

function paczka(db, zamowienieId, { opis, at = '2026-08-25T14:00:00.000', kolejnosc = 1 } = {}) {
  const p = rozpocznijPrzesylke(db, zamowienieId, 'dpd', kolejnosc);
  zakonczPrzesylke(db, p.id, { numerListu: `N${kolejnosc}`, etykietaSciezka: '/tmp/e.pdf', surowa: '<x/>' });
  if (opis) zapiszStatusDpd(db, p.id, { opis, at });
  return p.id;
}

const logZamowienia = (db, zamowienieId) => db
  .prepare('SELECT * FROM log WHERE zamowienie_id = ? ORDER BY id')
  .all(zamowienieId);

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

describe('oznaczanie doręczonych pobrań', () => {
  it('doręczone pobranie z fakturą leci do inFaktu z datą doręczenia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(1), {});
    zFaktura(db, id, 'u-1');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });

    const infakt = klientInfaktu({ 'u-1': dokWystawiony('2026-08-20') });
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(infakt.zlecenia).toEqual([{ uuid: 'u-1', paidDate: '2026-08-25' }]);
    expect(wynik).toMatchObject({ zlecone: 1, bledy: 0 });
  });

  // ⚠️ inFakt odrzuca `paid_date` wcześniejszą niż wystawienie. Faktura wystawiona PO
  // doręczeniu (klient poprosił o dokument później) musi dostać datę wystawienia.
  it('data zapłaty nigdy nie schodzi poniżej daty wystawienia z inFaktu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(10), {});
    zFaktura(db, id, 'u-10');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });

    const infakt = klientInfaktu({ 'u-10': dokWystawiony('2026-08-27') });
    await oznaczDoreczonePobrania({ db, infakt });
    expect(infakt.zlecenia).toEqual([{ uuid: 'u-10', paidDate: '2026-08-27' }]);
  });

  // ⚠️ POMIAR 28.08.2026: `18/08/2026` jest `delivery` I `paid` — właściciel oznacza część
  // pobrań ręcznie. Taki dokument ma wypaść, a nie dostać drugie zlecenie.
  it('faktura już opłacona w inFakcie nie dostaje drugiego zlecenia', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(11), {});
    zFaktura(db, id, 'u-11');
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const infakt = klientInfaktu({ 'u-11': { status: 'paid', left_to_pay: 22089, invoice_date: '2026-08-10', number: '18/08/2026' } });
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(infakt.zlecenia).toEqual([]);
    expect(wynik).toMatchObject({ zlecone: 0, pominiete: 1, bledy: 0 });
    // ⚠️ REZERWACJA 'juz_zaplacona' TO CAŁY POWÓD ISTNIENIA TEGO WIERSZA W BAZIE: bez niej
    // skan pytałby inFakt o ten sam dokument co godzinę do końca świata. Sama cisza
    // w `zlecenia` niczego o niej nie mówi — dlatego asercja idzie do bazy.
    expect(oznaczenieZaplaty(db, 'u-11')).toMatchObject({ powod: 'juz_zaplacona', data_zaplaty: null });
  });

  // ⚠️ CAŁY SENS REGUŁY — patrz domain/pobranie-zaplacone.js.
  it('zwrócona paczka NIE jedzie do inFaktu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(2), {});
    zFaktura(db, id, 'u-2');
    paczka(db, id, { opis: 'Zwrot do nadawcy' });

    const infakt = klientInfaktu({ 'u-2': dokWystawiony() });
    await oznaczDoreczonePobrania({ db, infakt });
    expect(infakt.zlecenia).toEqual([]);
  });

  // ⚠️⚠️ DWIE PACZKI NA JEDNYM ZAMÓWIENIU — TU BYŁY PIENIĄDZE (recenzja 28.08.2026, K1).
  // `LEFT JOIN przesylki` bez zawężenia dawał DWA wiersze na tę samą fakturę, a reguła chodzi
  // po WIERSZU: wystarczyła jedna doręczona paczka, żeby dokument poszedł do inFaktu jako
  // opłacony. Rozstrzyga PACZKA Z NAJNOWSZYM ZDARZENIEM U KURIERA — jedyna reguła, która
  // trafia oba kierunki tej historii.
  describe('zamówienie z dwiema paczkami — rozstrzyga OSTATNIE zdarzenie', () => {
    // Paczka z pobraniem wróciła zwrotem (gotówki NIE MA), a wcześniejsze doręczenie było
    // czymś innym. Zamówienie NIE JEST rozliczone i faktura ma zostać nieopłacona.
    it('doręczona 25.08, potem zwrot 26.08 → żadnego zlecenia', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(30), {});
      zFaktura(db, id, 'u-30');
      paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000', kolejnosc: 1 });
      paczka(db, id, { opis: 'Zwrot do nadawcy', at: '2026-08-26T09:00:00.000', kolejnosc: 2 });

      const infakt = klientInfaktu({ 'u-30': dokWystawiony('2026-08-20') });
      const wynik = await oznaczDoreczonePobrania({ db, infakt });

      expect(infakt.zlecenia).toEqual([]);
      expect(wynik).toMatchObject({ zlecone: 0, bledy: 0 });
    });

    // Odwrotny kierunek tej samej historii: pierwsza paczka wróciła, dosyłka doszła.
    // Pieniądze SĄ, a datą zapłaty jest dzień DOSYŁKI, nie zwrotu.
    it('zwrot 25.08, potem doręczona 26.08 → zlecenie z datą doręczenia', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(31), {});
      zFaktura(db, id, 'u-31');
      paczka(db, id, { opis: 'Zwrot do nadawcy', at: '2026-08-25T14:00:00.000', kolejnosc: 1 });
      paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-26T11:00:00.000', kolejnosc: 2 });

      const infakt = klientInfaktu({ 'u-31': dokWystawiony('2026-08-20') });
      await oznaczDoreczonePobrania({ db, infakt });

      expect(infakt.zlecenia).toEqual([{ uuid: 'u-31', paidDate: '2026-08-26' }]);
    });

    // Dwie doręczone paczki tego samego zamówienia to nadal JEDNA faktura: jedno zlecenie,
    // jeden kandydat i JEDEN `GET` na dokument (podwójny wiersz dawał wszystko po dwa,
    // razem z podwójną, identyczną linią w logu zamówienia).
    it('dwie doręczone → jedno zlecenie z późniejszą datą i jeden odczyt dokumentu', async () => {
      const id = zapiszZamowienie(db, 'pro', zmapowane(32), {});
      zFaktura(db, id, 'u-32');
      paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000', kolejnosc: 1 });
      paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-27T08:00:00.000', kolejnosc: 2 });

      const infakt = klientInfaktu({ 'u-32': dokWystawiony('2026-08-20') });
      const wynik = await oznaczDoreczonePobrania({ db, infakt });

      expect(infakt.zlecenia).toEqual([{ uuid: 'u-32', paidDate: '2026-08-27' }]);
      expect(wynik).toMatchObject({ kandydatow: 1, zlecone: 1 });
      expect(infakt.odczyty).toEqual(['u-32']);
      expect(logZamowienia(db, id)).toHaveLength(1);
    });
  });

  it('drugi przebieg nie zleca po raz drugi', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(3), {});
    zFaktura(db, id, 'u-3');
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const infakt = klientInfaktu({ 'u-3': dokWystawiony() });
    await oznaczDoreczonePobrania({ db, infakt });
    await oznaczDoreczonePobrania({ db, infakt });
    expect(infakt.zlecenia.map((z) => z.uuid)).toEqual(['u-3']);
  });

  // ⚠️ REZERWACJA POWSTAJE PRZED WYWOŁANIEM. `201` nie dowodzi niczego, więc po awarii
  // NIEJEDNOZNACZNEJ nie wolno próbować ponownie — dokument mógł już zostać oznaczony.
  it('rezerwacja zostaje także wtedy, gdy inFakt odmówił', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(4), {});
    zFaktura(db, id, 'u-4');
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const infakt = klientInfaktu({ 'u-4': dokWystawiony() }, { oznacz: () => { throw new Error('HTTP 500'); } });
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(wynik).toMatchObject({ zlecone: 0, bledy: 1 });
    expect(oznaczenieZaplaty(db, 'u-4')).toBeDefined();
  });

  // ⚠️ AWARIA JEDNEGO DOKUMENTU NIE MOŻE ZATRZYMAĆ POZOSTAŁYCH — ten skan chodzi w czuwaczu,
  // który pilnuje WSZYSTKICH paczek.
  it('awaria jednego dokumentu nie zatrzymuje reszty', async () => {
    const a = zapiszZamowienie(db, 'pro', zmapowane(5), {});
    zFaktura(db, a, 'u-zly'); paczka(db, a, { opis: 'Przesyłka doręczona' });
    const b = zapiszZamowienie(db, 'pro', zmapowane(6), {});
    zFaktura(db, b, 'u-dobry'); paczka(db, b, { opis: 'Przesyłka doręczona' });

    const infakt = klientInfaktu(
      { 'u-zly': dokWystawiony(), 'u-dobry': dokWystawiony() },
      { oznacz: (uuid) => { if (uuid === 'u-zly') throw new TypeError('cokolwiek z naszego kodu'); } },
    );
    const wynik = await oznaczDoreczonePobrania({ db, infakt });
    expect(infakt.zlecenia.map((z) => z.uuid)).toEqual(['u-dobry']);
    expect(wynik).toMatchObject({ zlecone: 1, bledy: 1 });
  });

  // ⚠️⚠️⚠️ USTERKA BLOKUJĄCA WDROŻENIE (recenzja całości 28.08.2026, K1). `zapytaj`
  // (infakt/client.js) oddaje `dane = null` dla KAŻDEJ odpowiedzi 2xx, której ciała nie da się
  // sparsować — `pobierzFakture` składa wtedy dokument z samych `null`-i, a `stanZaplaty` mówi
  // na niego `nieznany`. Dopóki skan sprawdzał wyłącznie `=== 'zaplacona'`, JECHAŁ DALEJ:
  // zmierzone uruchomieniowo na prawdziwym kliencie z atrapą `fetch` oddającą 200
  // z niesparsowalnym ciałem — `{"kandydatow":1,"zlecone":1,"bledy":0}`, ruch `["GET","POST"]`,
  // rezerwacja `pobranie_doreczone` założona NA STAŁE (funkcji zwalniającej nie ma).
  //
  // Trzy szkody naraz: ten `GET` istnieje DOKŁADNIE po to, żeby dokument oznaczony ręcznie
  // wypadł z kandydatów — i przy jednej złej odpowiedzi tego nie robił; `bledy: 0, zlecone: 1`
  // było nie do odróżnienia od czystego sukcesu; a dokument nie wracał już nigdy.
  it('zdegradowana odpowiedź inFaktu (same null-e) NIE wysyła POST i NIE rezerwuje', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(19), {});
    zFaktura(db, id, 'u-19');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });

    const zlecenia = [];
    const infakt = {
      // DOKŁADNIE to, co składa `pobierzFakture` po odpowiedzi 2xx bez parsowalnego ciała.
      pobierzFakture: async (uuid) => ({
        uuid, number: null, invoice_date: null, status: null, left_to_pay: null,
      }),
      oznaczZaplacona: async (uuid, opcje) => { zlecenia.push({ uuid, ...opcje }); },
    };
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(zlecenia).toEqual([]);
    expect(wynik).toMatchObject({ kandydatow: 1, zlecone: 0, bledy: 1 });
    // Brak rezerwacji JEST treścią: stan jest przejściowy, więc dokument ma wrócić za godzinę.
    expect(oznaczenieZaplaty(db, 'u-19')).toBeUndefined();
  });

  it('po zdegradowanej odpowiedzi drugi przebieg pyta ponownie', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(21), {});
    zFaktura(db, id, 'u-21');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });

    // Pierwszy odczyt zdegradowany, drugi normalny — dokładnie tak wygląda minięcie awarii.
    const odczyty = [];
    const zlecenia = [];
    const infakt = {
      pobierzFakture: async (uuid) => {
        odczyty.push(uuid);
        return odczyty.length === 1
          ? { uuid, number: null, invoice_date: null, status: null, left_to_pay: null }
          : dokWystawiony('2026-08-20');
      },
      oznaczZaplacona: async (uuid, opcje) => { zlecenia.push({ uuid, ...opcje }); },
    };
    await oznaczDoreczonePobrania({ db, infakt });
    await oznaczDoreczonePobrania({ db, infakt });

    expect(odczyty).toEqual(['u-21', 'u-21']);
    expect(zlecenia).toEqual([{ uuid: 'u-21', paidDate: '2026-08-25' }]);
  });

  // ⚠️ Odmowa ODCZYTU też nie może zatrzymać przebiegu — i NIE zostawia rezerwacji,
  // bo do zlecenia w ogóle nie doszło. Następny przebieg spróbuje jeszcze raz.
  it('awaria odczytu dokumentu nie zostawia rezerwacji', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(12), {});
    zFaktura(db, id, 'u-12');
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const infakt = {
      pobierzFakture: async () => { throw new Error('HTTP 503'); },
      oznaczZaplacona: async () => { throw new Error('nie powinno się zdarzyć'); },
    };
    const wynik = await oznaczDoreczonePobrania({ db, infakt });
    expect(wynik).toMatchObject({ zlecone: 0, bledy: 1 });
    expect(oznaczenieZaplaty(db, 'u-12')).toBeUndefined();
  });

  // ⚠️⚠️ KONTRAKT `dataZaplatyPobrania` OD POPRAWKI 1 (28.08.2026): funkcja MOŻE ODDAĆ `null`
  // — dokładnie wtedy, gdy nie ma ani stempla kuriera, ani poprawnej `invoice_date` z inFaktu.
  // Zmyślona albo pusta data w dokumencie księgowym jest gorsza niż brak oznaczenia, więc
  // wysyłki NIE MA. Rezerwacja jednak ZOSTAJE (powód 'brak_daty'): bez niej skan wracałby tu
  // co godzinę i co godzinę dopisywał tę samą linię do logu zamówienia. Panel NIE PONOWI
  // tego sam — rozstrzyga człowiek w inFakcie, a skan liczy to jako OSOBNĄ liczbę, bo to
  // ani zlecenie, ani błąd.
  it('bez daty zapłaty nie wysyła nic, ale zostawia rezerwację i ślad w logu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(13), {});
    zFaktura(db, id, 'u-13');
    // Kurier nie oddał czasu zdarzenia — `status_kuriera_at` zostaje puste.
    paczka(db, id, { opis: 'Przesyłka doręczona', at: null });

    const infakt = klientInfaktu({ 'u-13': { status: 'sent', left_to_pay: 12300, invoice_date: null, number: 'F/1' } });
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(infakt.zlecenia).toEqual([]);
    expect(wynik).toMatchObject({ zlecone: 0, bledy: 0, pominiete: 0, bezDaty: 1 });
    expect(oznaczenieZaplaty(db, 'u-13')).toMatchObject({ powod: 'brak_daty', data_zaplaty: null });
    const wpisy = logZamowienia(db, id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].wynik).toMatch(/nie ponowi/i);
  });

  it('bez daty zapłaty drugi przebieg nie dopisuje drugiej linii do logu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(14), {});
    zFaktura(db, id, 'u-14');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: null });

    const infakt = klientInfaktu({ 'u-14': { status: 'sent', left_to_pay: 12300, invoice_date: null, number: 'F/1' } });
    await oznaczDoreczonePobrania({ db, infakt });
    await oznaczDoreczonePobrania({ db, infakt });

    expect(infakt.zlecenia).toEqual([]);
    expect(logZamowienia(db, id)).toHaveLength(1);
  });

  it('zamówienie bez pobrania nie jest kandydatem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(7, { pobranie: 0, kwota_pobrania: null }), {});
    zFaktura(db, id, 'u-7');
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const infakt = klientInfaktu({ 'u-7': dokWystawiony() });
    await oznaczDoreczonePobrania({ db, infakt });
    expect(infakt.zlecenia).toEqual([]);
  });

  it('pobranie bez faktury nie jest kandydatem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(8), {});
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const infakt = klientInfaktu({});
    await oznaczDoreczonePobrania({ db, infakt });
    expect(infakt.zlecenia).toEqual([]);
  });

  // ⚠️ ZAMÓWIENIE PRZEŁĄCZONE NA POBRANIE Z KARTY ma `pobranie = 0` w kolumnie ze sklepu,
  // a decyzję w `wysylka_reczna_json` — i to nadpisanie wygrywa (`czyPobranie`, domain/wysylka.js).
  // Prefiltr SQL czytający samą kolumnę odsiewał je PRZED regułą, więc taki dokument nie
  // trafiał do żadnego kubełka: ani zlecony, ani pominięty, ani policzony jako bez daty.
  it('pobranie włączone RĘCZNIE z karty też jest kandydatem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(15, { pobranie: 0, kwota_pobrania: null }), {});
    db.prepare('UPDATE zamowienia SET wysylka_reczna_json = ? WHERE id = ?')
      .run('{"metoda":"dpd","pobranie":1,"kwota_pobrania":"123.00"}', id);
    zFaktura(db, id, 'u-15');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });

    const infakt = klientInfaktu({ 'u-15': dokWystawiony('2026-08-20') });
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(infakt.zlecenia).toEqual([{ uuid: 'u-15', paidDate: '2026-08-25' }]);
    expect(wynik).toMatchObject({ kandydatow: 1, zlecone: 1 });
  });

  // ⚠️⚠️ ODMOWA JEDNOZNACZNA (4xx) ZAMYKA DOKUMENT (recenzja poprawkowa 28.08.2026, W5).
  // Faktura SKASOWANA w inFakcie — przepływ wprost wspierany — oddaje 404 na zawsze. Bez
  // rezerwacji był jeden `GET` na godzinę, jedna linia w logu ZAMÓWIENIA na godzinę i stała
  // lampka w logu procesu: fałszywy alarm, który uczy ignorować tę linię.
  it('jednoznaczna odmowa odczytu (404) rezerwuje dokument i przestaje o niego pytać', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(22), {});
    zFaktura(db, id, 'u-22', { numer: 'F/22' });
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const odczyty = [];
    const infakt = {
      pobierzFakture: async (uuid) => {
        odczyty.push(uuid);
        throw Object.assign(new Error('inFakt odrzucił odczyt faktury (404): nie znaleziono'), { status: 404 });
      },
      oznaczZaplacona: async () => { throw new Error('nie powinno się zdarzyć'); },
    };

    const wynik = await oznaczDoreczonePobrania({ db, infakt });
    expect(wynik).toMatchObject({ zlecone: 0, bledy: 1 });
    expect(oznaczenieZaplaty(db, 'u-22')).toMatchObject({ powod: 'nieznana_w_infakcie', data_zaplaty: null });
    const wpisy = logZamowienia(db, id);
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].wynik).toMatch(/NIE BĘDZIE PONAWIAŁ/);

    // DRUGI PRZEBIEG: dokument nie jest już kandydatem, więc nie ma ani jednego `GET`
    // i ani jednej nowej linii w logu zamówienia.
    const drugi = await oznaczDoreczonePobrania({ db, infakt });
    expect(drugi).toMatchObject({ kandydatow: 0 });
    expect(odczyty).toEqual(['u-22']);
    expect(logZamowienia(db, id)).toHaveLength(1);
  });

  // ⚠️ ODMOWA NIEJEDNOZNACZNA (5xx, timeout, zerwane połączenie) ZOSTAJE OTWARTA. Dokument,
  // którego nie umieliśmy odczytać raz, jutro się odczyta — zamknięcie go rezerwacją byłoby
  // zgadywaniem w drugą stronę.
  it('niejednoznaczna odmowa odczytu (503) NIE rezerwuje i wraca w następnym przebiegu', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(23), {});
    zFaktura(db, id, 'u-23', { numer: 'F/23' });
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const odczyty = [];
    const infakt = {
      pobierzFakture: async (uuid) => {
        odczyty.push(uuid);
        throw Object.assign(new Error('inFakt odrzucił odczyt faktury (503): serwis niedostępny'), { status: 503 });
      },
      oznaczZaplacona: async () => { throw new Error('nie powinno się zdarzyć'); },
    };

    await oznaczDoreczonePobrania({ db, infakt });
    expect(oznaczenieZaplaty(db, 'u-23')).toBeUndefined();

    const drugi = await oznaczDoreczonePobrania({ db, infakt });
    expect(drugi).toMatchObject({ kandydatow: 1, bledy: 1 });
    expect(odczyty).toEqual(['u-23', 'u-23']);
  });

  // ⚠️⚠️ SUFIT PRZEBIEGU (recenzja poprawkowa 28.08.2026, W6). Skan chodzi w czuwaczu
  // przesyłek, który tyka co godzinę i ma strażnik „jeden przebieg naraz": przebieg dłuższy
  // niż odstęp NIE ZGŁASZA BŁĘDU, tylko po cichu zjada kolejne tyknięcia. Obcięcie ma być
  // SŁYCHAĆ — `kandydatow` mówi prawdę o całości, `ponadSufit` o tym, ile czeka.
  it('sufit przebiegu obcina liczbę dokumentów, ale mówi to głośno', async () => {
    for (const nr of [24, 25, 26]) {
      const id = zapiszZamowienie(db, 'pro', zmapowane(nr), {});
      zFaktura(db, id, `u-${nr}`, { numer: `F/${nr}` });
      paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });
    }

    const infakt = klientInfaktu({
      'u-24': dokWystawiony('2026-08-20'),
      'u-25': dokWystawiony('2026-08-20'),
      'u-26': dokWystawiony('2026-08-20'),
    });
    const wynik = await oznaczDoreczonePobrania({ db, infakt, limit: 2 });

    expect(wynik).toMatchObject({
      kandydatow: 3, obsluzone: 2, ponadSufit: 1, zlecone: 2,
    });
    expect(infakt.odczyty).toHaveLength(2);

    // Reszta czeka na następne tyknięcie i wtedy przechodzi — skan jest idempotentny.
    const drugi = await oznaczDoreczonePobrania({ db, infakt, limit: 2 });
    expect(drugi).toMatchObject({ kandydatow: 1, obsluzone: 1, ponadSufit: 0, zlecone: 1 });
    expect(infakt.zlecenia).toHaveLength(3);
  });

  it('bez obcięcia ponadSufit jest zerem', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(27), {});
    zFaktura(db, id, 'u-27');
    paczka(db, id, { opis: 'Przesyłka doręczona', at: '2026-08-25T14:00:00.000' });

    const infakt = klientInfaktu({ 'u-27': dokWystawiony('2026-08-20') });
    expect(await oznaczDoreczonePobrania({ db, infakt }))
      .toMatchObject({ kandydatow: 1, obsluzone: 1, ponadSufit: 0 });
  });

  // ⚠️⚠️ AWARIA SPOZA DWÓCH ZNANYCH DRÓG (recenzja 28.08.2026, W1): nie odczyt, nie zlecenie,
  // tylko `TypeError` z naszego kodu POMIĘDZY nimi. Zewnętrzny `try` wokół całego ciała pętli
  // jest jedyną rzeczą, która trzyma tu obietnicę „żaden dokument nie przerwie przebiegu" —
  // przed nim taki wyjątek WYCHODZIŁ Z FUNKCJI i następny kandydat nie był nawet odpytany.
  //
  // ⚠️ Dawniej mierzył to `pobierzFakture` oddające `null` — ale od poprawki K1 taki dokument
  // ma własną, JAWNĄ bramkę (`stanZaplaty === 'nieznany'`) i do zewnętrznego `try` już nie
  // dochodzi. Dlatego wyjątek jest tu wywołany wprost: gdyby ten test dalej opierał się na
  // pustej odpowiedzi, świeciłby na zielono także po usunięciu zewnętrznego `try`.
  it('awaria spoza znanych dróg nie przerywa przebiegu — następny kandydat jedzie dalej', async () => {
    const a = zapiszZamowienie(db, 'pro', zmapowane(16), {});
    zFaktura(db, a, 'u-zepsuty', { numer: 'F/16' }); paczka(db, a, { opis: 'Przesyłka doręczona' });
    const b = zapiszZamowienie(db, 'pro', zmapowane(17), {});
    zFaktura(db, b, 'u-dobry-17', { numer: 'F/17' }); paczka(db, b, { opis: 'Przesyłka doręczona' });

    const zlecenia = [];
    const infakt = {
      pobierzFakture: async (uuid) => (uuid === 'u-zepsuty'
        // Dokument POPRAWNY dla `stanZaplaty` (`sent`), ale czytanie daty wystawienia rzuca —
        // czyli awaria dokładnie tam, gdzie nie sięga żaden z węższych bloków `try`.
        ? { status: 'sent', left_to_pay: 12300, get invoice_date() { throw new TypeError('cokolwiek z naszego kodu'); } }
        : dokWystawiony('2026-08-20')),
      oznaczZaplacona: async (uuid, opcje) => { zlecenia.push({ uuid, ...opcje }); },
    };

    // Samo dojście do następnej linii jest częścią asercji: rzucenie stąd wywala test.
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(zlecenia).toEqual([{ uuid: 'u-dobry-17', paidDate: '2026-08-25' }]);
    expect(wynik).toMatchObject({ kandydatow: 2, zlecone: 1, bledy: 1 });
    // Ślad dla człowieka przy tym, który padł — awaria nie ma prawa zniknąć w ciszy.
    expect(logZamowienia(db, a)[0].wynik).toMatch(/awaria panelu/);
  });

  // ⚠️ PUSTA ODPOWIEDŹ inFAKTU (2xx bez parsowalnego ciała — `zapytaj` oddaje wtedy `null`,
  // NIE rzuca) idzie od poprawki K1 przez bramkę „stan zapłaty nieznany": bez POST-a, bez
  // rezerwacji, z błędem i śladem w logu. Przebieg leci dalej.
  it('pusta odpowiedź inFaktu nie przerywa przebiegu — następny kandydat jedzie dalej', async () => {
    const a = zapiszZamowienie(db, 'pro', zmapowane(16), {});
    zFaktura(db, a, 'u-pusty', { numer: 'F/16' }); paczka(db, a, { opis: 'Przesyłka doręczona' });
    const b = zapiszZamowienie(db, 'pro', zmapowane(17), {});
    zFaktura(db, b, 'u-dobry-17', { numer: 'F/17' }); paczka(db, b, { opis: 'Przesyłka doręczona' });

    const zlecenia = [];
    const infakt = {
      pobierzFakture: async (uuid) => (uuid === 'u-pusty' ? null : dokWystawiony('2026-08-20')),
      oznaczZaplacona: async (uuid, opcje) => { zlecenia.push({ uuid, ...opcje }); },
    };

    // Samo dojście do następnej linii jest częścią asercji: rzucenie stąd wywala test.
    const wynik = await oznaczDoreczonePobrania({ db, infakt });

    expect(zlecenia).toEqual([{ uuid: 'u-dobry-17', paidDate: '2026-08-25' }]);
    expect(wynik).toMatchObject({ kandydatow: 2, zlecone: 1, bledy: 1 });
    // Ślad dla człowieka przy tym, który padł — awaria nie ma prawa zniknąć w ciszy.
    expect(logZamowienia(db, a)[0].wynik).toMatch(/NIEOPŁACONA/);
  });

  // ⚠️ FAŁSZYWA ZIELEŃ (recenzja 28.08.2026, D1): ten test miał PUSTĄ bazę, więc przechodził
  // także po usunięciu strażnika — nie było czego zlecić niezależnie od tego, czy strażnik
  // istnieje. Kandydat w bazie jest tu CAŁĄ treścią testu.
  it('bez klienta inFaktu nie robi nic i nie wywala się', async () => {
    const id = zapiszZamowienie(db, 'pro', zmapowane(18), {});
    zFaktura(db, id, 'u-18');
    paczka(db, id, { opis: 'Przesyłka doręczona' });

    const wynik = await oznaczDoreczonePobrania({ db, infakt: null });

    expect(wynik).toMatchObject({ kandydatow: 0, zlecone: 0, bledy: 0 });
    // Panel bez klucza inFaktu ma NIE ZOSTAWIAĆ śladu po dokumencie, którego nie dotknął:
    // rezerwacja zamknęłaby go na zawsze, także po podpięciu klucza.
    expect(oznaczenieZaplaty(db, 'u-18')).toBeUndefined();
    expect(logZamowienia(db, id)).toHaveLength(0);
  });
});
