import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zapewnijOkres } from '../../../src/oms/db/okresy.js';

// Endpoint jest ZA Basic Authem panelu (hook onRequest w server.js), więc każdy test musi
// podać nagłówek — tak samo jak pozostałe testy tras (okresy-trasy.test.js). CSRF nie
// dotyczy GET-a, więc `origin` nie jest tu potrzebny.
const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

let db;
let licznik = 202600000;

/**
 * Zamówienie w bazie. `utworzone` podajemy DOSŁOWNIE, bo cały sens połowy tych testów
 * siedzi w tym, że kolumna `utworzone_at` niesie DWA formaty naraz:
 *  - zamówienia ręczne: znacznik UTC z „Z" (`teraz()` w db/, kontener chodzi z TZ=UTC);
 *  - zamówienia ze sklepu: `date_created` z Woo, czyli czas Warszawy BEZ oznaczenia strefy
 *    (domain/mapowanie.js) — porównywanie tego napisu z instantem UTC jest z definicji złe.
 */
function dodaj({
  numer, kwota = '104.00', utworzone, okresId = null,
  anulowane = 0, anulowaneRecznie = null, sklep = 'reczne', indywidualne = 0,
}) {
  licznik += 1;
  db.prepare(
    'INSERT INTO zamowienia (sklep, zrodlo_id, numer, kwota_brutto, okres_rozliczeniowy_id,'
    + ' anulowane, anulowane_recznie, utworzone_at, indywidualne) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(
    sklep, licznik, numer, kwota, okresId, anulowane ? 1 : 0, anulowaneRecznie, utworzone,
    // Znacznik zamowienia z panelu ofert indywidualnych — w produkcji liczy go poller
    // z surowej odpowiedzi sklepu (domain/indywidualne.js), tu podajemy go wprost, bo
    // testowane jest zachowanie ENDPOINTU, a nie rozpoznawanie znacznika.
    indywidualne ? 1 : 0,
  );
}

const serwer = () => buildOmsServer({ db, config });

async function numery(url) {
  const odp = await serwer().inject({ method: 'GET', url, headers: naglowek });
  expect(odp.statusCode).toBe(200);
  return odp.json().zamowienia.map((z) => z.numer);
}

beforeEach(() => {
  db = openOmsDb();
});

describe('GET /api/sprzedaz', () => {
  it('zamowienie w okresie to DROPSHIPPING, poza okresem to B2B', async () => {
    const o = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
    dodaj({ numer: 'R/2026/001', kwota: '104.00', utworzone: '2026-07-10T10:00:00.000Z', okresId: o.id });
    dodaj({ numer: 'R/2026/002', kwota: '900.00', utworzone: '2026-07-11T10:00:00.000Z' });

    const odp = await serwer().inject({
      method: 'GET', url: '/api/sprzedaz?od=2026-07-01&do=2026-07-31', headers: naglowek,
    });
    expect(odp.statusCode).toBe(200);
    const { zamowienia } = odp.json();
    expect(zamowienia).toHaveLength(2);
    const zbiorcze = zamowienia.find((z) => z.numer === 'R/2026/001');
    expect(zbiorcze.kanal).toBe('DROPSHIPPING');
    // Kwota idzie z kolumny `kwota_brutto` — dla zamówień ręcznych jest utrzymywana przy
    // zapisie pozycji i ma już doklejoną opłatę za obsługę (domain/suma-pozycji.js).
    expect(zbiorcze.kwotaBrutto).toBe('104.00');
    expect(zbiorcze.dataZlozenia).toBe('2026-07-10T10:00:00.000Z');
    expect(zamowienia.find((z) => z.numer === 'R/2026/002').kanal).toBe('B2B');
  });

  it('zakres dat odcina zamowienia spoza okna', async () => {
    dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
    expect(await numery('/api/sprzedaz?od=2026-08-01&do=2026-08-31')).toEqual([]);
  });

  // ── Usterka 1: anulowanie RĘCZNE ──────────────────────────────────────────────────────
  // Zamówienia zbiorcze są ręczne, więc żaden sklep ich nie anuluje — anuluje je operator,
  // a to osobna kolumna. Warunek o samym `anulowane` wliczał anulowane zamówienie do
  // sprzedaży, czyli raport pokazywałby pieniądze, których nikt nie zapłacił.
  describe('anulowanie', () => {
    it('zamowienie anulowane RECZNIE nie liczy sie do sprzedazy', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      dodaj({ numer: 'R/2026/002', utworzone: '2026-07-11T10:00:00.000Z', anulowaneRecznie: 1 });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual(['R/2026/001']);
    });

    it('zamowienie anulowane W SKLEPIE nie liczy sie do sprzedazy', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      dodaj({ numer: 'R/2026/002', utworzone: '2026-07-11T10:00:00.000Z', anulowane: 1 });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual(['R/2026/001']);
    });

    it('anulowane_recznie = 0 NIE odanulowuje zamowienia anulowanego w sklepie', async () => {
      dodaj({
        numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z',
        anulowane: 1, anulowaneRecznie: 0,
      });
      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual([]);
    });
  });

  // ── Usterki 2 i 3: okno liczone w Europe/Warsaw, obie granice domknięte ────────────────
  describe('okno dat w czasie warszawskim', () => {
    it('zamowienie zlozone 1 lipca o 01:30 czasu polskiego jest w LIPCU', async () => {
      // 2026-07-01 01:30 w Warszawie = 2026-06-30T23:30Z. Okno liczone w UTC wyrzucało je
      // z lipca (i z tygodnia, o który pytał raport) do czerwca.
      dodaj({ numer: 'R/2026/001', utworzone: '2026-06-30T23:30:00.000Z' });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual(['R/2026/001']);
      expect(await numery('/api/sprzedaz?od=2026-06-01&do=2026-06-30')).toEqual([]);
    });

    it('zamowienie zlozone 1 sierpnia o 01:30 czasu polskiego NIE jest w lipcu', async () => {
      // Druga strona tej samej pomyłki: 2026-07-31T23:30Z to już 1 sierpnia w Polsce.
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-31T23:30:00.000Z' });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual([]);
      expect(await numery('/api/sprzedaz?od=2026-08-01&do=2026-08-31')).toEqual(['R/2026/001']);
    });

    it('obie granice okna sa DOMKNIETE — polnoc dnia `od` i ostatnia milisekunda dnia `do`', async () => {
      // Północ dnia `od` w formacie SKLEPOWYM (czas Warszawy bez „Z") — porównanie napisów
      // z instantem UTC gubiło ją, bo '2026-07-01T00:00:00' < '2026-07-01T00:00:00.000Z'.
      dodaj({ numer: 'W/1', utworzone: '2026-07-01T00:00:00', sklep: 'szkicownia' });
      // Ostatnia milisekunda dnia `do` w czasie warszawskim (23:59:59.999 = 21:59:59.999Z).
      dodaj({ numer: 'R/2026/002', utworzone: '2026-07-31T21:59:59.999Z' });
      // Ostatnia milisekunda dnia PRZED oknem — po drugiej stronie domknięcia.
      dodaj({ numer: 'W/0', utworzone: '2026-06-30T23:59:59', sklep: 'szkicownia' });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual(['W/1', 'R/2026/002']);
    });

    it('zamowienie ZE SKLEPU liczy sie w czasie sklepu, bez przeliczania drugi raz', async () => {
      // `date_created` z Woo jest JUŻ w czasie Warszawy — doklejenie mu strefy przesunęłoby
      // je o dwie godziny (latem) i zamówienie z 1 lipca 01:30 wypadłoby z lipca.
      dodaj({ numer: 'W/2', utworzone: '2026-07-01T01:30:00', sklep: 'szkicownia' });
      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-01')).toEqual(['W/2']);
    });
  });

  // ── Usterka 4: zły format daty ma być błędem, a nie pustym tygodniem ───────────────────
  describe('walidacja parametrow', () => {
    const zle = async (url) => (await serwer().inject({ method: 'GET', url, headers: naglowek })).statusCode;

    it('brak parametrow to 400, a nie caly zbior', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      expect(await zle('/api/sprzedaz')).toBe(400);
      expect(await zle('/api/sprzedaz?od=2026-07-01')).toBe(400);
      expect(await zle('/api/sprzedaz?do=2026-07-31')).toBe(400);
    });

    it('niepoprawny format daty to 400, a nie pusty tydzien', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      expect(await zle('/api/sprzedaz?od=abc&do=2026-07-31')).toBe(400);
      expect(await zle('/api/sprzedaz?od=2026-07-01&do=01.07.2026')).toBe(400);
      expect(await zle('/api/sprzedaz?od=2026-7-1&do=2026-07-31')).toBe(400);
    });

    it('data kalendarzowo nieistniejaca to 400 — V8 przewija ja po cichu na kolejny dzien', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      // new Date('2026-02-30') to 2 marca, a nie Invalid Date — samo parsowanie niczego
      // nie wyłapie (ta sama pułapka co w domain/okres-rozliczeniowy.js).
      expect(await zle('/api/sprzedaz?od=2026-02-30&do=2026-03-31')).toBe(400);
      expect(await zle('/api/sprzedaz?od=2026-01-01&do=2026-13-01')).toBe(400);
    });

    it('komunikat bledu mowi, czego brakuje', async () => {
      const odp = await serwer().inject({ method: 'GET', url: '/api/sprzedaz', headers: naglowek });
      expect(odp.json().blad).toMatch(/od.*do|do.*od/i);
    });

    // ── W1: odwrócone granice okna ──────────────────────────────────────────────────────
    // `od` późniejsze niż `do` dawało 200 i pustą listę, czyli RAPORT Z ZEROWĄ SPRZEDAŻĄ,
    // który wygląda wiarygodnie — dokładnie ta sama klasa awarii, przed którą broni
    // odrzucanie złego formatu daty. Odwrócone argumenty albo literówka w dacie tygodnia
    // po stronie konsumenta nie mają prawa przejść po cichu.
    it('od pozniejsze niz do to 400, a nie pusty tydzien', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      expect(await zle('/api/sprzedaz?od=2026-07-31&do=2026-07-01')).toBe(400);
    });

    it('od rowne do jest POPRAWNE — jednodniowe okno to legalne pytanie', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      expect(await numery('/api/sprzedaz?od=2026-07-10&do=2026-07-10')).toEqual(['R/2026/001']);
    });

    it('komunikat o odwroconym zakresie mowi, ktore granice sa zle', async () => {
      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-07-31&do=2026-07-01', headers: naglowek,
      });
      expect(odp.json().blad).toMatch(/od.*do|do.*od/i);
    });

    // ── D2, mutant 1: brak `WZORZEC_DNIA` ───────────────────────────────────────────────
    // Bez wzorca `kluczOkresu` przepuszcza pełny znacznik czasu, więc `?od=2026-07-01T05:00`
    // wchodzi do porównania jako napis — a '2026-07-01' >= '2026-07-01T05:00' jest FAŁSZEM,
    // czyli okno cicho gubi CAŁY pierwszy dzień. Sam dzień kalendarzowy albo 400.
    it('znacznik czasu w parametrze to 400 — inaczej okno gubi caly pierwszy dzien', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-01T10:00:00.000Z' });
      expect(await zle('/api/sprzedaz?od=2026-07-01T05:00&do=2026-07-31')).toBe(400);
      expect(await zle('/api/sprzedaz?od=2026-07-01&do=2026-07-31T23:59')).toBe(400);
      expect(await zle('/api/sprzedaz?od=2026-07-01T00:00:00.000Z&do=2026-07-31')).toBe(400);
    });
  });

  // ── W2: dzień handlowy liczony po stronie, która wie jak ───────────────────────────────
  // `dataZlozenia` niesie surową kolumnę w DWÓCH skalach czasu, więc konsument kubełkujący
  // tygodnie przez `slice(0,10)` albo `getUTCDay()` odtworzyłby błąd, który ten endpoint
  // właśnie naprawia. `dzien` to ta sama wartość, po której endpoint filtruje okno.
  describe('pole `dzien` — dzien handlowy w Europe/Warsaw', () => {
    it('zamowienie RECZNE z nocy dostaje polski dzien, a nie dzien z UTC', async () => {
      // 2026-07-05T22:30Z to niedziela 6 lipca 00:30 czasu polskiego. `slice(0,10)` po
      // stronie konsumenta wsadziłoby je do 5 lipca, czyli do POPRZEDNIEGO tygodnia.
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-05T22:30:00.000Z' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-07-01&do=2026-07-31', headers: naglowek,
      });
      const [z] = odp.json().zamowienia;
      expect(z.dzien).toBe('2026-07-06');
      // `dataZlozenia` zostaje BEZ ZMIAN — to nadal surowa kolumna, kontrakt się nie zmienia.
      expect(z.dataZlozenia).toBe('2026-07-05T22:30:00.000Z');
    });

    it('zamowienie ZE SKLEPU dostaje swoj dzien bez przeliczania drugi raz', async () => {
      dodaj({ numer: 'W/1', utworzone: '2026-07-06T00:30:00', sklep: 'szkicownia' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-07-01&do=2026-07-31', headers: naglowek,
      });
      expect(odp.json().zamowienia[0].dzien).toBe('2026-07-06');
    });

    it('`dzien` zgadza sie z oknem, ktore to zamowienie przepuscilo', async () => {
      // Granica: 2026-07-31T23:30Z to już 1 sierpnia w Polsce — i pole `dzien` musi mówić
      // to samo, co filtr okna, bo inaczej konsument policzyłby je w innym tygodniu.
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-31T23:30:00.000Z' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      expect(odp.json().zamowienia[0].dzien).toBe('2026-08-01');
    });
  });

  // ── W3: kanał wynika ze ŹRÓDŁA zamówienia ─────────────────────────────────────────────
  // Zamówienie ze sklepu bez okresu wychodziło jako 'B2B', a konsument (raporty/src/
  // klasyfikacja.mjs) ma osobne kanały SKLEP_WOO (konto Apilo 9) i B2B (konto 12) i bierze
  // je z Apilo. Suma Apilo + ten endpoint liczyłaby detal ze szkicownia.pl DWA RAZY.
  describe('kanal', () => {
    it('zamowienie SKLEPOWE nie dostaje ani B2B, ani DROPSHIPPING', async () => {
      dodaj({ numer: 'W/1', utworzone: '2026-07-10T10:00:00', sklep: 'szkicownia' });
      dodaj({ numer: 'W/2', utworzone: '2026-07-11T10:00:00', sklep: 'pro' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-07-01&do=2026-07-31', headers: naglowek,
      });
      const kanaly = odp.json().zamowienia.map((z) => z.kanal);
      expect(kanaly).not.toContain('B2B');
      expect(kanaly).not.toContain('DROPSHIPPING');
      expect(kanaly).toEqual(['SKLEP', 'SKLEP']);
    });

    it('zamowienie sklepowe PRZYPISANE do okresu tez jest SKLEP, nie DROPSHIPPING', async () => {
      // Źródło rozstrzyga PRZED okresem: gdyby ktoś kiedyś doczepił zamówienie sklepowe do
      // okresu rozliczeniowego, nie ma ono prawa wejść do raportu jako dropshipping.
      const o = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
      dodaj({ numer: 'W/1', utworzone: '2026-07-10T10:00:00', sklep: 'szkicownia', okresId: o.id });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-07-01&do=2026-07-31', headers: naglowek,
      });
      expect(odp.json().zamowienia[0].kanal).toBe('SKLEP');
    });

    it('zamowienie sklepowe ZOSTAJE w odpowiedzi — konsument ma je jawnie odrzucic', async () => {
      dodaj({ numer: 'W/1', utworzone: '2026-07-10T10:00:00', sklep: 'szkicownia' });
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-11T10:00:00.000Z' });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31'))
        .toEqual(['W/1', 'R/2026/001']);
    });

    // ── I-2 (recenzja calej galezi): KANAL ALLEGRO ──────────────────────────────────────
    // ⚠️ Galaz dodala kanal sprzedazy i tego pliku nie tknela, wiec regula „wszystko, co nie
    // jest `reczne`, to SKLEP" wchlaniala zamowienia z Allegro: sprzedaz z Allegro wychodzila
    // stad OZNACZONA JAKO DETAL ZE SKLEPU — kanal, ktory konsument odrzuca jako liczony
    // z Apilo. Zamowienia znikaly z raportu, a wbudowany mechanizm ostrzegawczy (nieznana
    // nazwa PRZERYWA raport) byl przez to obejsciem wylaczony: konsument nie widzial nowej
    // nazwy, wiec nie mial na czym rzucic.
    it('zamowienie z Allegro wychodzi jako ALLEGRO, a NIE jako SKLEP', async () => {
      dodaj({ numer: 'ALG-1', utworzone: '2026-08-10T10:00:00', sklep: 'allegro_szkicownia' });
      dodaj({ numer: 'ALG-2', utworzone: '2026-08-10T11:00:00', sklep: 'allegro_amarka' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      const kanaly = odp.json().zamowienia.map((z) => z.kanal);
      expect(kanaly).toEqual(['ALLEGRO', 'ALLEGRO']);
      expect(kanaly).not.toContain('SKLEP');
    });

    // ⚠️ NAZWA JEST TU CALA TRESCIA TESTU. Konsument (C:\Users\uzytkownik\raporty\src\klasyfikacja.mjs)
    // MA JUZ kanaly 'ALLEGRO_SZKICOWNIA' i 'ALLEGRO_AMARKA', liczone Z APILO (konta 3 i 27).
    // Oddanie stad ktorejkolwiek z tych nazw daloby raport sumujacy oba zrodla, ktory policzylby
    // te zamowienia DWA RAZY — zawyzona sprzedaz, nie blad, wiec nikt by tego nie zauwazyl.
    // Ta sama zasada, dla ktorej kanal sklepowy nazywa sie 'SKLEP', a nie 'SKLEP_WOO'.
    it('nazwa kanalu NIE JEST nazwa kanalu apilowego (ALLEGRO_SZKICOWNIA / ALLEGRO_AMARKA)', async () => {
      dodaj({ numer: 'ALG-1', utworzone: '2026-08-10T10:00:00', sklep: 'allegro_szkicownia' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      const kanaly = odp.json().zamowienia.map((z) => z.kanal);
      // Po TABLICY, nie po tresci odpowiedzi: 'ALLEGRO_SZKICOWNIA' zawiera w sobie 'ALLEGRO',
      // wiec `not.toContain` na `odp.body` bylby falszywie czerwony zawsze (ta sama pulapka,
      // co przy SKLEP_INDYWIDUALNE nizej).
      expect(Array.isArray(kanaly)).toBe(true);
      expect(kanaly).not.toContain('ALLEGRO_SZKICOWNIA');
      expect(kanaly).not.toContain('ALLEGRO_AMARKA');
    });

    // Zamowienia z Allegro NIE USUWAMY z odpowiedzi — konsument ma je zobaczyc i SWIADOMIE
    // zdecydowac, co z nimi zrobic. Cichy filtr po stronie serwera znaczylby, ze nikt po
    // drugiej stronie nie wie, ze cokolwiek odpadlo.
    it('zamowienie z Allegro ZOSTAJE w odpowiedzi, a nie znika', async () => {
      dodaj({ numer: 'ALG-1', utworzone: '2026-08-10T10:00:00', sklep: 'allegro_szkicownia' });
      dodaj({ numer: 'R/2026/001', utworzone: '2026-08-11T10:00:00.000Z' });

      expect(await numery('/api/sprzedaz?od=2026-08-01&do=2026-08-31'))
        .toEqual(['ALG-1', 'R/2026/001']);
    });

    // Sklep o kluczu podobnym do kanalu NIE JEST kanalem Allegro — ten sam prefiks
    // z podkreslnikiem, co w domain/wysylka.js. Bez podkreslnika „allegrowy" wpadlby do
    // kanalu Allegro i zniknal z raportu sklepowego.
    it('sklep „allegrowy" (bez podkreslnika) dalej jest SKLEPEM', async () => {
      dodaj({ numer: 'W/1', utworzone: '2026-08-10T10:00:00', sklep: 'allegrowy' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      expect(odp.json().zamowienia[0].kanal).toBe('SKLEP');
    });

    // ── Zadanie 7: zamowienia z panelu ofert indywidualnych ─────────────────────────────
    // ⚠️ NAZWA JEST TU CALA TRESCIA TESTU, nie szczegolem. Konsument (repo raporty,
    // C:\Users\uzytkownik\raporty\src\klasyfikacja.mjs) ma juz WLASNY kanal 'INDYWIDUALNE',
    // liczony Z APILO (konto 21 oraz originalCode z przedrostkiem '28040|' dla konta Woo).
    // Oddanie stad tej samej nazwy daloby te zamowienia policzone DWA RAZY — zawyzona
    // sprzedaz, nie blad, wiec nikt by tego nie zauwazyl. To ta sama pulapka, przed ktora
    // chroni etykieta 'SKLEP' (a nie 'SKLEP_WOO').
    it('zamowienie indywidualne wychodzi jako SKLEP_INDYWIDUALNE, NIE jako INDYWIDUALNE', async () => {
      dodaj({ numer: 'W/I1', utworzone: '2026-08-10T10:00:00', sklep: 'szkicownia', indywidualne: 1 });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      const kanaly = odp.json().zamowienia.map((z) => z.kanal);
      // ⚠️ ASERCJE MUSZA ISC PO TABLICY WARTOSCI KANALOW, nie po napisie calej odpowiedzi:
      // 'SKLEP_INDYWIDUALNE' ZAWIERA w sobie napis 'INDYWIDUALNE', wiec `not.toContain`
      // uzyte na `odp.body` byloby FALSZYWIE CZERWONE zawsze i niczego nie pilnowalo.
      // Na tablicy `toContain` porownuje ELEMENTY (===), wiec dziala poprawnie. Ten warunek
      // stoi tu jako straznik: gdyby ktos podmienil `kanaly` na napis, test padnie tutaj.
      expect(Array.isArray(kanaly)).toBe(true);
      expect(kanaly).toContain('SKLEP_INDYWIDUALNE');
      expect(kanaly).not.toContain('INDYWIDUALNE');
    });

    it('zwykle zamowienie z TEGO SAMEGO sklepu dalej wychodzi jako SKLEP', async () => {
      // Regula indywidualna nie ma prawa przemalowac calego sklepu `szkicownia` — inaczej
      // caly detal ze szkicownia.pl wyszedlby w zlym kanale.
      dodaj({ numer: 'W/1', utworzone: '2026-08-10T10:00:00', sklep: 'szkicownia', indywidualne: 0 });
      dodaj({ numer: 'W/I1', utworzone: '2026-08-11T10:00:00', sklep: 'szkicownia', indywidualne: 1 });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      const kanal = (n) => odp.json().zamowienia.find((z) => z.numer === n).kanal;
      expect(kanal('W/1')).toBe('SKLEP');
      expect(kanal('W/I1')).toBe('SKLEP_INDYWIDUALNE');
    });

    // Zamowienia indywidualnego NIE USUWAMY z odpowiedzi — konsument ma je zobaczyc
    // i jawnie odrzucic. Zamowienie znikniete z okna jest tak samo zle, jak policzone
    // dwa razy, tylko myli w druga strone.
    it('zamowienie indywidualne ZOSTAJE w odpowiedzi, a nie znika', async () => {
      dodaj({ numer: 'W/I1', utworzone: '2026-08-10T10:00:00', sklep: 'szkicownia', indywidualne: 1 });
      dodaj({ numer: 'R/2026/001', utworzone: '2026-08-11T10:00:00.000Z' });

      expect(await numery('/api/sprzedaz?od=2026-08-01&do=2026-08-31'))
        .toEqual(['W/I1', 'R/2026/001']);
    });

    it('reczne dalej rozdziela sie na DROPSHIPPING i B2B mimo nowej reguly', async () => {
      // Nowy warunek stoi PRZED regula sklepowa, wiec musi byc widac, ze nie zjadl
      // podzialu recznych: cztery kanaly obok siebie w jednym oknie.
      const o = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 8 });
      dodaj({ numer: 'R/2026/001', utworzone: '2026-08-10T10:00:00.000Z', okresId: o.id });
      dodaj({ numer: 'R/2026/002', utworzone: '2026-08-11T10:00:00.000Z' });
      dodaj({ numer: 'W/1', utworzone: '2026-08-12T10:00:00', sklep: 'szkicownia' });
      dodaj({ numer: 'W/I1', utworzone: '2026-08-13T10:00:00', sklep: 'szkicownia', indywidualne: 1 });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-08-01&do=2026-08-31', headers: naglowek,
      });
      const kanal = (n) => odp.json().zamowienia.find((z) => z.numer === n).kanal;
      expect(kanal('R/2026/001')).toBe('DROPSHIPPING');
      expect(kanal('R/2026/002')).toBe('B2B');
      expect(kanal('W/1')).toBe('SKLEP');
      expect(kanal('W/I1')).toBe('SKLEP_INDYWIDUALNE');
    });

    it('podzial recznych na DROPSHIPPING i B2B zostaje bez zmian', async () => {
      const o = zapewnijOkres(db, { klientKlucz: 'przykladowa', rok: 2026, miesiac: 7 });
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z', okresId: o.id });
      dodaj({ numer: 'R/2026/002', utworzone: '2026-07-11T10:00:00.000Z' });

      const odp = await serwer().inject({
        method: 'GET', url: '/api/sprzedaz?od=2026-07-01&do=2026-07-31', headers: naglowek,
      });
      const kanal = (n) => odp.json().zamowienia.find((z) => z.numer === n).kanal;
      expect(kanal('R/2026/001')).toBe('DROPSHIPPING');
      expect(kanal('R/2026/002')).toBe('B2B');
    });
  });

  // ── D2, mutanty 2 i 3: kolejność i strażnik nieczytelnej daty ─────────────────────────
  describe('kolejnosc i dane nieczytelne', () => {
    it('sortowanie idzie po czasie WARSZAWSKIM, nie po surowym napisie', async () => {
      // Ręczne '2026-07-09T23:00:00.000Z' to 10 lipca 01:00 w Polsce, a sklepowe
      // '2026-07-10T00:30:00' to 10 lipca 00:30 — sklepowe jest WCZEŚNIEJSZE. Wstawiamy je
      // do bazy w odwrotnej kolejności, więc `return 0` w komparatorze (albo sortowanie po
      // surowej kolumnie) zostawiłoby kolejność wstawienia i test padnie.
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-09T23:00:00.000Z' });
      dodaj({ numer: 'W/1', utworzone: '2026-07-10T00:30:00', sklep: 'szkicownia' });

      expect(await numery('/api/sprzedaz?od=2026-07-09&do=2026-07-10'))
        .toEqual(['W/1', 'R/2026/001']);
    });

    it('zamowienia z tej samej chwili ida po id — kolejnosc jest deterministyczna', async () => {
      dodaj({ numer: 'R/2026/002', utworzone: '2026-07-10T10:00:00.000Z' });
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });

      expect(await numery('/api/sprzedaz?od=2026-07-10&do=2026-07-10'))
        .toEqual(['R/2026/002', 'R/2026/001']);
    });

    it('zamowienie z data NIE DO ODCZYTANIA nie wchodzi do zadnego okna', async () => {
      dodaj({ numer: 'R/2026/001', utworzone: '2026-07-10T10:00:00.000Z' });
      dodaj({ numer: 'X/1', utworzone: 'brak-daty' });
      dodaj({ numer: 'X/2', utworzone: '' });

      expect(await numery('/api/sprzedaz?od=2026-07-01&do=2026-07-31')).toEqual(['R/2026/001']);
      // ...i nie udaje, że mieści się w oknie liczonym od początku czasu.
      expect(await numery('/api/sprzedaz?od=1970-01-01&do=2099-12-31')).toEqual(['R/2026/001']);
    });
  });
});
