import { etykietyStatusow } from './statusy.js';
// Indeks listy zamówień (PRZ-051).
//
// ⚠️ PO CO. Do PRZ-051 każde otwarcie listy czytało CAŁĄ tabelę zamówień z dziećmi i liczyło
// status, listę roboczą i termin w JS — pomiar na 15 000 zamówień: 17 s zamrożenia procesu,
// przy 32 767 błąd SQL (limit zmiennych). Status nie jest kolumną, tylko wynikiem reguł
// domeny, a te potrzebują faktur, paczek, wpłat i zwrotów — więc COUNT „po kolumnie" nie
// istniał.
//
// ⚠️ CO TO JEST. Tabela `lista_stan` (migracja zamowienia/1): jeden wiersz na zamówienie z tym,
// co o nim powiedziały reguły domeny (`klasyfikacjaListy`). Liczniki zakładek to COUNT,
// strona to LIMIT/OFFSET po indeksie, filtry i fraza to funkcje SQL wołające TĘ SAMĄ regułę
// JS (`pasujaKlucze`, `pasujePola`). Reguła istnieje raz; SQL przechowuje jej odpowiedzi.
//
// ⚠️ DLACZEGO TABELA TRWAŁA, A NIE `temp`. Pełne przeliczenie kosztuje ok. 260 µs na
// zamówienie (pomiar PRZ-051: odczyt z dziećmi + reguły) — przy 50 000 to ok. 13 s. W `temp`
// płaciłby to KAŻDY start procesu, a pierwszy widok listy po wydaniu czekałby na całość.
//
// ⚠️ ŚWIEŻOŚĆ — każda droga ma test w tests/prz051/indeks-listy.test.js:
//   1. zapis kodem panelu: wyzwalacze TEMP (oms/db/sledzenie-listy.js) wpisują zamówienie do
//      `lista_brudne` w tej samej transakcji; `odswiez` przelicza je PRZED odpowiedzią;
//   2. sam upływ czasu: wiersz trzyma CHWILE, od których reguły mówią „tak" (domena/
//      klasyfikacja-listy.js), więc zapytanie porównuje je z bieżącą chwilą; po horyzoncie
//      (`wazne_do`) wiersz liczy się od nowa;
//   3. wszystko inne — zmiana reguł w nowej wersji kodu, zapis gołym połączeniem (ręczny SQL,
//      skrypt bez `openOmsDb`): po starcie procesu indeks sprawdza CAŁĄ tabelę w tle, małymi
//      porcjami, a lista pokazuje postęp, zamiast udawać, że liczniki są już sprawdzone.
import { zamowieniaPoId, numeryZamowien } from './zamowienia.js';
import { idsDolaczonych } from '../../domena/scalanie.js';
import { sledzZmianyListy } from './sledzenie-listy.js';
import { klasyfikacjaListy } from '../../domena/klasyfikacja-listy.js';
import { pasujaKlucze } from '../../domena/filtry-listy.js';
import { dopasowanieFrazy, normalizuj } from '../../domena/szukanie.js';

// Porcja przeliczenia przed odpowiedzią: tyle zamówień czyta się i klasyfikuje bez oddania
// pętli zdarzeń. Między porcjami inne żądania dostają swoją kolej.
const PORCJA = 500;
// Sprawdzenie w tle: porcja mniejsza (ok. 25 ms na laptopie) i przerwa między porcjami,
// żeby żądanie, które trafi w trakcie, nie czekało dłużej niż jedną porcję.
const PORCJA_TLA = 100;
const PRZERWA_TLA_MS = 10;
// Klasyfikacja szuka przejść od chwili nieco WCZEŚNIEJSZEJ niż bieżąca: dwa żądania
// obsługiwane na przemian mogą przeliczać i pytać z chwilami różniącymi się o milisekundy,
// a wiersz „tak od teraz" zapisany z późniejszą chwilą odpowiadałby „nie" wcześniejszej.
const MARGINES_MS = 60000;

// Pola w postaci porównywalnej są znormalizowane (białe znaki zwinięte do spacji), więc
// znak nowej linii nie występuje w żadnym z nich — jest bezpiecznym separatorem.
const SEP = '\n';
const rozdziel = (s) => (s === '' ? [] : s.split(SEP));

function zarejestrujFunkcje(db) {
  let ostatnie = null; let sparsowane = null;
  db.function('lista_filtr', { deterministic: true },
    (dzien, wysylka, indywidualne, sklep, platnosc, filtryJson) => {
      if (filtryJson !== ostatnie) { ostatnie = filtryJson; sparsowane = JSON.parse(filtryJson); }
      return pasujaKlucze({ dzien, wysylka, indywidualne: Boolean(indywidualne), sklep, platnosc }, sparsowane) ? 1 : 0;
    });
  // Fraza rozkładana raz na zapytanie, nie raz na wiersz (recenzja PRZ-051).
  let ostatniaFraza = null; let dopasuj = null;
  db.function('lista_szukaj', { deterministic: true }, (tekst, cyfry, fraza) => {
    if (fraza !== ostatniaFraza) { ostatniaFraza = fraza; dopasuj = dopasowanieFrazy(fraza); }
    return dopasuj({ tekst: rozdziel(tekst), cyfry: rozdziel(cyfry) }) ? 1 : 0;
  });
}

// ⚠️ ROZRZUT `wazne_do` (recenzja PRZ-051). Cała pierwsza budowa liczy się z jedną chwilą, więc
// bez rozrzutu po 90 dniach bez restartu wygasałaby CAŁA tabela naraz i pierwsze żądanie
// liczyłoby wszystko od nowa (50 000 zamówień ≈ 12 s). Wcześniejsze wygaśnięcie jest zawsze
// bezpieczne — chwile przejścia były szukane do końca pełnego horyzontu.
const DOBA_MS = 24 * 3600 * 1000;
const rozrzut = (id) => (id % 30) * DOBA_MS;
// Zamówienie, którego nie da się odczytać, wraca do sprawdzenia po dobie — albo od razu po
// zapisie, który może je naprawić (wyzwalacze).
const PONOW_USZKODZONE_MS = DOBA_MS;
const STATUS_USZKODZONE = 'blad';

/**
 * Przyczyna do pokazania na liście i zapisu w `lista_stan.blad` — BEZ danych zamówienia. V8 przy
 * części błędów `JSON.parse` wkleja w komunikat wycinek wejścia (czyli np. imię i adres klienta),
 * a ta tabela trafia do kopii bazy i na ekran (recenzja PRZ-051).
 */
export function przyczynaUszkodzenia(e) {
  if (e instanceof SyntaxError) return 'uszkodzony JSON w danych zamówienia';
  return `${e?.name ?? 'Error'}: ${String(e?.message ?? e).replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'")}`.slice(0, 160);
}

export const PRZYCZYNA_POMINIETEGO = 'nie daje się odczytać — indeks jeszcze o tym nie wie (zmiana spoza panelu?)';

const indeksy = new WeakMap();

/** Indeks listy dla połączenia — jeden na `db`, tworzony przy pierwszym użyciu listy. */
export function indeksListy(db) {
  let i = indeksy.get(db);
  if (!i) { i = utworz(db); indeksy.set(db, i); }
  return i;
}

function utworz(db) {
  if (!sledzZmianyListy(db)) throw new Error('Brak tabel indeksu listy — migracja modułu zamówień nie została wykonana');
  // Baza ze schematem indeksu sprzed poprawek recenzji (kopia robocza z 9f614fa) — czytelna odmowa
  // zamiast surowego błędu SQL przy pierwszym zapisie.
  if (!db.prepare('PRAGMA table_info(lista_stan)').all().some((k) => k.name === 'blad')) {
    throw new Error('Tabela lista_stan bez kolumny blad — baza z niezatwierdzonej wersji PRZ-051; odtwórz ją z kopii sprzed migracji');
  }
  zarejestrujFunkcje(db);
  const maScalenia = db.prepare('PRAGMA table_info(zamowienia)').all().some((k) => k.name === 'scalone_do');
  const wstaw = db.prepare(`INSERT OR REPLACE INTO lista_stan (zamowienie_id, utworzone_at, status, robocze_od,
    po_terminie_od, wazne_do, dzien, wysylka, indywidualne, sklep, platnosc, szukaj_tekst, szukaj_cyfry, blad)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  // ⚠️ ZAMÓWIENIE NIE DO ODCZYTANIA (recenzja PRZ-051, P1). Jeden wiersz z uszkodzonym JSON-em
  // (ręczny SQL, awaria zapisu) wywracał całą porcję, a znacznik zostawał w `lista_brudne`
  // i trafiał w każdą następną porcję — indeks stawał dla WSZYSTKICH zamówień, a przy pierwszej
  // budowie każde żądanie liczyło całą tabelę od nowa. Teraz takie zamówienie trafia do indeksu
  // jako „do zrobienia" (widoczne, nie zgubione), z przyczyną, a reszta liczy się normalnie.
  // Status `blad` nie jest żadną zakładką — zamówienie liczy się do „Wszystkie" i „Do zrobienia".
  const wstawUszkodzone = (w, e, teraz) => wstaw.run(w.id, w.utworzone_at, STATUS_USZKODZONE, teraz - MARGINES_MS, null,
    teraz + PONOW_USZKODZONE_MS, null, null, 0, w.sklep ?? null, null, normalizuj(w.numer ?? ''), '', przyczynaUszkodzenia(e));
  let kolejka = Promise.resolve();
  let sprawdzenieRuszylo = false;
  let sprawdzenie = null; // { kursor, sprawdzone, wszystkie } w trakcie sprawdzania w tle
  // Najwcześniejsza chwila odświeżenia w tym procesie. Sprawdzenie w tle klasyfikuje OD NIEJ,
  // nie od zegara: chwila wcześniejsza jest zawsze bezpieczna (reguły są monotoniczne, wynik
  // dla każdej późniejszej chwili ten sam), a późniejsza niż ta, o którą zapyta lista,
  // odpowiadałaby „nie" za wcześnie.
  let ostatnieTeraz = null;

  // Jedna porcja — w całości synchronicznie: znaczniki zdejmowane PRZED odczytem, więc zapis,
  // który przyjdzie po tej porcji, oznaczy zamówienie od nowa, zamiast przepaść razem
  // z obsłużonym znacznikiem.
  function klasyfikuj(idsWejscie, teraz) {
    // PRZ-101.04 (recenzja, W3): zmiana DOŁĄCZONEGO (anulowanie w sklepie, przesyłka, faktura) brudzi
    // tylko jego wiersz — a ten nie ma wiersza w indeksie. Wynik GŁÓWNEGO zależy od dołączonych
    // (`uwagaDolaczonychAnulowanych`), więc główne liczy się w tej samej porcji, co dołączone.
    // Baza bez migracji scaleń (testy indeksu na samej migracji 0001) kolumny nie ma — wtedy nie ma też grup.
    const glowne = maScalenia ? db.prepare(`SELECT DISTINCT scalone_do AS id FROM zamowienia WHERE id IN (${idsWejscie.map(() => '?').join(',')})
      AND scalone_do IS NOT NULL`).all(...idsWejscie).map((w) => w.id) : [];
    const ids = [...new Set([...idsWejscie, ...glowne])];
    const znaki = ids.map(() => '?').join(',');
    db.exec('SAVEPOINT lista_porcja');
    try {
      db.prepare(`DELETE FROM lista_brudne WHERE zamowienie_id IN (${znaki})`).run(...ids);
      db.prepare(`DELETE FROM lista_stan WHERE zamowienie_id IN (${znaki})`).run(...ids);
      const zamowienia = zamowieniaPoId(db, ids, { bezSurowych: true, naBlad: (w, e) => wstawUszkodzone(w, e, teraz) });
      for (const z of zamowienia) {
        // PRZ-101.04: zamówienie DOŁĄCZONE (scalone do głównego) nie ma wiersza w indeksie — znika
        // z każdej zakładki i każdego licznika (decyzja właściciela 18.10: „jest jedno zamówienie”).
        // Wiersz skasowany wyżej, więc rozdzielenie (UPDATE → wyzwalacz) przywraca je samo.
        if (z.scalone_do) continue;
        let k;
        try { k = klasyfikacjaListy(z, teraz - MARGINES_MS); } catch (e) { wstawUszkodzone(z, e, teraz); continue; }
        // …a jego numer szuka się na GŁÓWNYM: fraza z numerem dołączonego prowadzi do głównego.
        const dolaczone = idsDolaczonych(z);
        if (dolaczone.length) {
          for (const { numer } of numeryZamowien(db, dolaczone)) {
            k.szukaj.tekst.push(normalizuj(numer ?? ''));
            const cyfry = String(numer ?? '').replace(/\D+/g, '');
            if (cyfry) k.szukaj.cyfry.push(cyfry);
          }
        }
        wstaw.run(z.id, z.utworzone_at, k.status, k.robocze_od, k.po_terminie_od, k.wazne_do - rozrzut(z.id),
          k.filtr.dzien, k.filtr.wysylka, k.filtr.indywidualne ? 1 : 0, k.filtr.sklep, k.filtr.platnosc,
          k.szukaj.tekst.join(SEP), k.szukaj.cyfry.join(SEP), null);
      }
      db.exec('RELEASE lista_porcja');
    } catch (e) {
      db.exec('ROLLBACK TO lista_porcja'); db.exec('RELEASE lista_porcja');
      throw e;
    }
  }

  async function przeliczBrudne(teraz) {
    for (;;) {
      const ids = db.prepare('SELECT zamowienie_id FROM lista_brudne LIMIT ?').all(PORCJA).map((w) => w.zamowienie_id);
      if (!ids.length) return;
      klasyfikuj(ids, teraz);
      if (ids.length < PORCJA) return;
      await new Promise((r) => setImmediate(r));
    }
  }

  // Sprawdzenie całości w tle po starcie procesu (droga 3 w nagłówku). Zamówienia o
  // identyfikatorze większym niż kursor, rosnąco — nowe zamówienia dochodzą na koniec
  // i i tak są już śledzone wyzwalaczami.
  function krokSprawdzenia() {
    if (!sprawdzenie || !db.isOpen) { sprawdzenie = null; return; }
    try {
      const ids = db.prepare('SELECT id FROM zamowienia WHERE id > ? ORDER BY id LIMIT ?')
        .all(sprawdzenie.kursor, PORCJA_TLA).map((w) => w.id);
      if (!ids.length) { sprawdzenie = null; return; }
      klasyfikuj(ids, ostatnieTeraz);
      sprawdzenie.kursor = ids[ids.length - 1];
      sprawdzenie.sprawdzone += ids.length;
    } catch {
      // Zamknięta baza albo awaria odczytu: sprawdzenie odpuszcza, a lista zostaje przy
      // ostatnim stanie — następny start procesu sprawdzi całość od nowa.
      sprawdzenie = null; return;
    }
    setTimeout(krokSprawdzenia, PRZERWA_TLA_MS).unref?.();
  }

  function ruszSprawdzenie(teraz, poBudowie) {
    sprawdzenieRuszylo = true;
    // Zbudowany od zera w tym procesie = już sprawdzony.
    if (poBudowie) return;
    db.exec('DELETE FROM lista_stan WHERE zamowienie_id NOT IN (SELECT id FROM zamowienia)');
    const wszystkie = db.prepare('SELECT COUNT(*) AS n FROM zamowienia').get().n;
    if (wszystkie <= PORCJA) {
      const ids = db.prepare('SELECT id FROM zamowienia').all().map((w) => w.id);
      if (ids.length) klasyfikuj(ids, teraz);
      return;
    }
    sprawdzenie = { kursor: 0, sprawdzone: 0, wszystkie };
    setTimeout(krokSprawdzenia, 0).unref?.();
  }

  async function przelicz(teraz) {
    ostatnieTeraz = ostatnieTeraz === null ? teraz : Math.min(ostatnieTeraz, teraz);
    // Każde wołanie, nie raz: baza mogła zostać otwarta bez `openOmsDb` (wyzwalacze są
    // w połączeniu), a `IF NOT EXISTS` kosztuje tyle, co odczyt schematu.
    sledzZmianyListy(db);
    // Najpierw odczyt, zapis tylko gdy jest co oznaczyć: lista bez pracy do zrobienia nie
    // otwiera transakcji zapisu (recenzja PRZ-051) — gdy inny proces trzyma blokadę zapisu,
    // pusty INSERT czekałby na nią synchronicznie i zatrzymał cały proces.
    if (db.prepare('SELECT 1 FROM lista_stan WHERE wazne_do <= ? LIMIT 1').get(teraz)) {
      db.prepare('INSERT OR IGNORE INTO lista_brudne SELECT zamowienie_id FROM lista_stan WHERE wazne_do <= ?').run(teraz);
    }
    const zbudowany = db.prepare("SELECT 1 FROM lista_meta WHERE klucz = 'zbudowany_at'").get();
    if (!zbudowany) {
      // Pierwsza budowa (świeża migracja na bazie z historią): bez niej lista byłaby pusta,
      // więc odpowiedź czeka na całość — jednorazowo w życiu bazy, porcjami.
      db.exec('INSERT OR IGNORE INTO lista_brudne SELECT id FROM zamowienia');
      db.exec('DELETE FROM lista_stan WHERE zamowienie_id NOT IN (SELECT id FROM zamowienia)');
    }
    await przeliczBrudne(teraz);
    if (!zbudowany) {
      db.prepare("INSERT OR REPLACE INTO lista_meta (klucz, wartosc) VALUES ('zbudowany_at', ?)").run(new Date(teraz).toISOString());
    }
    if (!sprawdzenieRuszylo) ruszSprawdzenie(teraz, !zbudowany);
  }

  return {
    /** Doprowadza indeks do stanu bazy w chwili `teraz` (ms). Wywołania idą po kolei. */
    odswiez(teraz = Date.now()) {
      const p = kolejka.then(() => przelicz(teraz));
      kolejka = p.catch(() => {});
      return p;
    },

    /** `null` albo postęp sprawdzania w tle po starcie: `{ sprawdzone, wszystkie }`. */
    sprawdzanie() {
      return sprawdzenie ? { sprawdzone: sprawdzenie.sprawdzone, wszystkie: sprawdzenie.wszystkie } : null;
    },

    /** Liczniki panelu bocznego w chwili `teraz` — po `odswiez`. */
    liczniki(teraz) {
      // Każda zakładka statusu ma licznik, także pusta — zero to odpowiedź, nie brak danych.
      const statusy = Object.fromEntries(Object.keys(etykietyStatusow(db)).map((k) => [k, 0]));
      let wszystkie = 0;
      for (const w of db.prepare('SELECT status, COUNT(*) AS n FROM lista_stan GROUP BY status').all()) {
        statusy[w.status] = w.n; wszystkie += w.n;
      }
      const ile = (kol) => db.prepare(`SELECT COUNT(*) AS n FROM lista_stan WHERE ${kol} <= ?`).get(teraz).n;
      return { wszystkie, do_zrobienia: ile('robocze_od'), po_terminie: ile('po_terminie_od'), statusy };
    },

    /**
     * Identyfikatory jednej strony i liczba wszystkich pasujących.
     * `zakladka`: null (fraza zdejmuje zakładkę), {rodzaj:'wszystkie'|'robocze'|'po_terminie'}
     * albo {rodzaj:'status', status}. `filtry` jak z `parsujFiltry`, `szukaj` — fraza.
     */
    strona({ zakladka, filtry, szukaj, offset, limit, teraz }) {
      const warunki = []; const arg = [];
      if (zakladka?.rodzaj === 'status') { warunki.push('status = ?'); arg.push(zakladka.status); }
      else if (zakladka?.rodzaj === 'robocze') { warunki.push('robocze_od <= ?'); arg.push(teraz); }
      else if (zakladka?.rodzaj === 'po_terminie') { warunki.push('po_terminie_od <= ?'); arg.push(teraz); }
      if (filtry && Object.values(filtry).some(Boolean)) {
        warunki.push('lista_filtr(dzien, wysylka, indywidualne, sklep, platnosc, ?) = 1');
        arg.push(JSON.stringify(filtry));
      }
      if (szukaj) { warunki.push('lista_szukaj(szukaj_tekst, szukaj_cyfry, ?) = 1'); arg.push(szukaj); }
      const gdzie = warunki.length ? `WHERE ${warunki.join(' AND ')}` : '';
      const ileWszystkich = () => db.prepare(`SELECT COUNT(*) AS n FROM lista_stan ${gdzie}`).get(...arg).n;
      // Filtr albo fraza i tak przechodzą przez KAŻDY wiersz (funkcja JS na wiersz), więc liczbę
      // wszystkich bierzemy z tego samego przejścia (`COUNT(*) OVER ()`) zamiast drugiego skanu
      // (recenzja PRZ-051). Sama zakładka idzie indeksem: strona kończy się po LIMIT, a COUNT
      // po indeksie kolumny jest tani — okno wymusiłoby tam pełne przejście i sortowanie.
      if (filtry && Object.values(filtry).some(Boolean) || szukaj) {
        const wiersze = db.prepare(`SELECT zamowienie_id, COUNT(*) OVER () AS lacznie FROM lista_stan ${gdzie}
          ORDER BY utworzone_at DESC, zamowienie_id DESC LIMIT ? OFFSET ?`).all(...arg, limit, offset);
        return { ids: wiersze.map((w) => w.zamowienie_id), lacznie: wiersze.length ? wiersze[0].lacznie : ileWszystkich() };
      }
      const ids = db.prepare(`SELECT zamowienie_id FROM lista_stan ${gdzie}
        ORDER BY utworzone_at DESC, zamowienie_id DESC LIMIT ? OFFSET ?`).all(...arg, limit, offset).map((w) => w.zamowienie_id);
      return { ids, lacznie: ileWszystkich() };
    },

    /** Zamówienia, których nie da się odczytać: `[{ id, numer, blad }]` (najwyżej 20). */
    uszkodzone() {
      return db.prepare(`SELECT s.zamowienie_id AS id, z.numer, s.blad FROM lista_stan s
        LEFT JOIN zamowienia z ON z.id = s.zamowienie_id WHERE s.status = ? ORDER BY s.zamowienie_id LIMIT 20`)
        .all(STATUS_USZKODZONE).map((w) => ({ id: w.id, numer: w.numer, blad: w.blad }));
    },
  };
}
