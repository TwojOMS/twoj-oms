import { formatujNumer, kolejnyZNumeru, zrodloIdReczne } from '../../domena/numeracja.js';
import { sumaPozycjiZWysylkaGrosze } from '../../domena/suma-pozycji.js';
import { pobranieZeSklepu, nadpisanieWysylki } from '../../domena/wysylka.js';
import { pobierzZamowienie, zapiszNadpisanieWysylki } from './zamowienia.js';

const teraz = () => new Date().toISOString();
const zl = (gr) => (gr / 100).toFixed(2);

/**
 * Kolejny wolny numer serii recznej w danym roku.
 *
 * UWAGA: Wynik jest wazny WYLACZNIE w transakcji, ktora od razu wstawia zamowienie z tym
 * numerem. Dwa rownoczesne klikniecia policza to samo; rozstrzyga dopiero indeks unikalny
 * `zamowienia_numer_reczny` (schema.sql) — dokladnie tak, jak numer kolejnej paczki.
 */
export function nastepnyNumerReczny(db, rok) {
  const wiersze = db.prepare(
    "SELECT numer FROM zamowienia WHERE sklep = 'reczne' AND numer LIKE ?",
  ).all(`R/${rok}/%`);
  const najwyzszy = wiersze.reduce((max, w) => Math.max(max, kolejnyZNumeru(w.numer) ?? 0), 0);
  return formatujNumer(rok, najwyzszy + 1);
}

/**
 * Nowe zamowienie spoza sklepu (telefoniczne, sprzedaz na miejscu, dosylka/poprawka).
 *
 * `zrodlo_id` (kolumna NOT NULL) dostaje wartosc z `zrodloIdReczne(rok, kolejny)`, NIE sama
 * pozycje w roku — dzieki temu NIE RUSZAMY schematu (unikalnosc `(sklep, zrodlo_id)` dalej
 * dziala, kolizja z numerem sklepu jest niemozliwa, bo `sklep` jest inny: 'reczne' vs 'pro'),
 * a JEDNOCZESNIE zrodlo_id nie zderza sie miedzy latami (patrz komentarz przy
 * zrodloIdReczne w domain/numeracja.js — recenzja calej galezi, C2). Sama pozycja (1, 2, 3...)
 * zerowalaby sie razem z licznikiem serii i pierwsze zamowienie nowego roku zderzyloby sie
 * z pierwszym zamowieniem roku poprzedniego.
 *
 * Numer i wstawienie w JEDNEJ transakcji, tak samo jak numer kolejnej paczki (przesylki.js):
 * dwa rownoczesne klikniecia „Nowe zamowienie" licza ten sam numer, ale indeks unikalny
 * `zamowienia_numer_reczny` przepusci tylko pierwszy INSERT.
 *
 * `okresRozliczeniowyId` przychodzi Z ZEWNATRZ (services/okres.js), a nie jest tu liczony:
 * rozstrzygniecie „czy ten NIP jest rozliczany zbiorczo" wymaga konfiguracji, a warstwa bazy
 * jej nie zna i ma nie znac. Domyslne `null` to normalny stan tysiecy zamowien spoza
 * rozliczenia zbiorczego.
 */
export function utworzZamowienieReczne(db, dane = {}, okresRozliczeniowyId = null) {
  // ⚠️ ZNACZNIK CZASU PRZYCHODZI Z ZEWNATRZ, jesli wolajacy go poda — i to nie jest zaczep
  // testowy, tylko poprawka o pieniadze (recenzja koncowa galezi, D4). Trasa zakladania
  // zamowienia (web/routes/zamowienia.js) liczy okres rozliczeniowy z WLASNEGO odczytu
  // zegara, a ta funkcja wpisywala `utworzone_at` z WLASNEGO `teraz()`. Dwa niezalezne
  // odczyty na przelomie miesiaca daja zamowienie w LIPCOWYM okresie z SIERPNIOWA data
  // zlozenia — czyli pozycje na fakturze nie tego miesiaca, ktorego data widnieje
  // na zamowieniu. Znacznik ma byc policzony RAZ i przekazany dalej.
  //
  // `teraz()` zostaje jako domysl: wolania spoza trasy (i testy) maja dzialac jak dotad.
  const stworzone = dane.utworzone_at ?? teraz();
  // `dane.rok` to WYLACZNIE zaczep testowy — pozwala testom sprawdzic PRAWDZIWA trase
  // zakladania zamowienia na przelomie lat bez czekania na Sylwestra. Bez niego rok bierze
  // sie Z TEGO SAMEGO znacznika, co `utworzone_at`: osobny odczyt zegara postawilby
  // pierwsze zamowienie nowego roku w serii roku poprzedniego.
  const rok = dane.rok ?? new Date(stworzone).getFullYear();
  db.exec('BEGIN IMMEDIATE');
  try {
    const numer = nastepnyNumerReczny(db, rok);
    const kolejny = kolejnyZNumeru(numer);
    const info = db.prepare(`
      INSERT INTO zamowienia (sklep, zrodlo_id, numer, klient_json, dostawa_json, metoda_wysylki,
        pobranie, kwota_pobrania, punkt_odbioru, chce_fakture, nip, kwota_brutto,
        koszt_dostawy_brutto, status_woo,
        metoda_platnosci, oplacone_at, anulowane, uwagi, surowe_json, zamowienie_zrodlowe_id,
        utworzone_at, zmienione_at, okres_rozliczeniowy_id, do_siedziby_klienta,
        karta_id, indywidualne, b2b, termin_platnosci, rabat_procent)
      VALUES ('reczne',?,?,?,?,?,?,?,?,?,?,'0.00',?,NULL,?,NULL,0,?,NULL,?,?,?,?,?,?,?,?,?,?)
    `).run(
      zrodloIdReczne(rok, kolejny), numer,
      JSON.stringify(dane.klient ?? null), JSON.stringify(dane.dostawa ?? null),
      // ⚠️ Pobranie jedzie WLASNA kolumna (2026-08-01) — bez tego zamowienie telefoniczne
      // przyjete „za pobraniem" wpadaloby do bazy jako przedplacone i kurier nie mialby
      // czego zainkasowac. Kwote przeliczy zaraz przeliczKwoteRecznego (pozycji jeszcze nie ma).
      dane.metoda_wysylki ?? 'dpd', dane.pobranie ? 1 : 0, dane.kwota_pobrania ?? null,
      // ⚠️ KOD PACZKOMATU idzie do KOLUMNY, nie do nadpisania (07.08.2026). Przy zamówieniu
      // ręcznym nie ma sklepu, który mógłby ją przepisać — to MY jesteśmy tu źródłem — więc
      // kolumna jest właściwym miejscem, dokładnie jak `metoda_wysylki` obok. Ręczna korekta
      // kodu z karty i tak wygra przy odczycie (domain/wysylka.js: punktOdbioru).
      dane.punkt_odbioru ?? null,
      dane.chce_fakture ? 1 : 0, dane.nip ?? null,
      dane.koszt_dostawy_brutto ?? '0.00', dane.metoda_platnosci ?? null,
      dane.uwagi ?? null, dane.zamowienie_zrodlowe_id ?? null,
      // `utworzone_at` i `zmienione_at` z JEDNEJ wartosci, nie z dwoch odczytow zegara —
      // swiezo zalozone zamowienie ma byc „zmienione" dokladnie wtedy, kiedy powstalo.
      stworzone, stworzone,
      // `?? null` mimo domyslnej wartosci parametru: domyslna lapie tylko BRAK argumentu,
      // a wolajacy potrafi podac jawne `undefined` (np. z pola obiektu, ktorego nie ma) —
      // node:sqlite odmowilby wtedy wiazania i cale zalozenie zamowienia by padlo.
      okresRozliczeniowyId ?? null,
      // ⚠️ FLAGA MUSI ZOSTAWIC SLAD W BAZIE, nie tylko przelecec przez `przypiszDoOkresu`.
      // Zamowienie do siedziby klienta ma `okres_rozliczeniowy_id = NULL` — dokladnie tak
      // samo, jak zamowienie, ktore z okresu wypadlo przez pomylke. Bez tej kolumny jedno
      // od drugiego nie da sie odroznic, a to sa pieniadze: do siedziby fakturujemy OD RAZU,
      // z terminem platnosci (spec §3), i nic w panelu nie mialoby o tym pojecia.
      //
      // Idzie z `dane`, a nie osobnym argumentem jak `okresRozliczeniowyId`: to zwykle pole
      // formularza (jak `pobranie` czy `chce_fakture`), do ktorego odczytania nie trzeba
      // konfiguracji — a warstwa `db/` konfiguracji nie zna i ma nie znac.
      dane.hurt ? 1 : 0,
      // ⚠️ ZNACZNIK MUSI ISC TUTAJ, nie byc dopisany pozniej. `uzupelnijIndywidualne`
      // (db.js) przy KAZDYM otwarciu bazy robi
      // `UPDATE ... SET indywidualne = 0 WHERE indywidualne IS NULL AND surowe_json IS NULL`,
      // a zamowienie reczne surowe_json nie ma — wiec znacznik dopisany „za chwile"
      // wyzerowalby sie przy najblizszym restarcie kontenera. Cicho, bez bledu.
      //
      // Domyslnie 0: zwykle zamowienie telefoniczne indywidualnym nie jest.
      dane.karta_id ?? null, dane.indywidualne ? 1 : 0,
      // ⚠️ KANAL RAPORTOWY ZAPISUJE SIE RAZEM Z ZAMOWIENIEM, a nie „za chwile" — to jest
      // migawka decyzji podjetej w chwili zakladania (patrz `kanalOms` i schema.sql).
      // Dopisany pozniej osobnym UPDATE-em zostawialby okno, w ktorym zamowienie hurtowe
      // liczy sie jako reczne, a raport odswiezony w tym oknie mowilby nieprawde.
      dane.b2b ? 1 : 0,
      // Brak ustalen to NULL, a nie '' — patrz `terminFaktury`: pusty napis i NULL czytaja
      // sie tam tak samo, ale w bazie tylko jedna z tych postaci jest zdaniem „nie wiadomo".
      dane.termin_platnosci ?? null,
      // Rabat jest juz WLICZONY w ceny pozycji; ta kolumna niesie wylacznie wiedze, ile go
      // bylo — do pokazania na karcie i do przeliczenia po zmianie (domain/rabat.js).
      Number(dane.rabat_procent) || 0,
    );
    db.exec('COMMIT');
    return Number(info.lastInsertRowid);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Kwota zamowienia recznego IDZIE ZA POZYCJAMI — nie ma sklepu, ktory by ja narzucil.
 * Wolac po KAZDEJ zmianie pozycji albo kosztu dostawy, inaczej bariera arytmetyczna
 * (przewodnik 4.5) zablokuje fakture.
 *
 * ⚠️ KWOTA POBRANIA IDZIE ZA NIA — I TO SA PIENIADZE, KTORE INKASUJE KURIER. Ekran
 * zakladania nie ma osobnego pola na kwote pobrania (decyzja wlasciciela 2026-08-01:
 * „wyjdzie sama po dodaniu produktow"), wiec liczy ja panel — dokladnie tak, jak robi to
 * sklep (domain/mapowanie.js: `kwota_pobrania = total`). Przeliczana TUTAJ, razem z kwota
 * zamowienia, a nie raz przy zakladaniu: wpisana raz zestarzalaby sie przy pierwszej
 * dopisanej pozycji i kurier zainkasowalby za malo.
 *
 * ⚠️ DWA MIEJSCA, NIE JEDNO — i pomylenie ich gubi pobranie po cichu (recenzja 2026-08-01):
 *
 *  1. KOLUMNA `kwota_pobrania` nalezy do KOLUMNY `pobranie`, wiec pytamy o nia
 *     `pobranieZeSklepu` (wartosc SUROWA), a NIE o pobranie efektywne. Pierwsza wersja
 *     zerowala kolumne, gdy pobranie efektywne bylo wylaczone — a wtedy wystarczylo
 *     przelaczyc na karcie na zwykle „dpd bez pobrania", ruszyc pozycje i cofnac
 *     przelaczenie („Przywroc metode ze sklepu"), zeby wrocic do pobrania z PUSTA kwota.
 *     DPD przy pustej kwocie po prostu nie wstawia <cod> — paczka jedzie jak przedplacona,
 *     kurier nie inkasuje nic i nigdzie nie ma bledu.
 *  2. NADPISANIE `wysylka_reczna_json` niesie WLASNA kwote i to ona wygrywa przy odczycie
 *     (domain/wysylka.js: kwotaPobrania). Przy zamowieniu RECZNYM odswiezamy takze ja —
 *     bo regula wlasciciela brzmi „kwota pobrania wychodzi z sumy" i nie ma wyjatku dla
 *     pobrania wlaczonego z karty. Bez tego kwota wpisana przy zmianie metody zostawala
 *     przy starej sumie i kurier inkasowal tyle, ile zamowienie bylo warte PRZED dopisaniem
 *     pozycji.
 *
 * Bez pobrania jedno i drugie wraca do NULL — niezerowa kwota przy zwyklej wysylce znaczy
 * dla DPD „zainkasuj" (kurierzy/dpd.js: <cod>), a klient juz zaplacil przelewem. Zero tez
 * zapisujemy jako NULL: „pobranie na 0,00" to nie pobranie, tylko stan, ktory DPD po cichu
 * pomija (wymaga kwoty > 0), a karta pokazywalaby „za pobraniem" bez ani zlotowki.
 */
export function przeliczKwoteRecznego(db, id) {
  const z = pobierzZamowienie(db, id);
  if (!z || z.sklep !== 'reczne') return;
  const grosze = sumaPozycjiZWysylkaGrosze(z);
  const kwota = zl(grosze);
  const doPobrania = grosze > 0 ? kwota : null;

  db.prepare('UPDATE zamowienia SET kwota_brutto = ?, kwota_pobrania = ?, zmienione_at = ? WHERE id = ?')
    .run(kwota, pobranieZeSklepu(z) ? doPobrania : null, teraz(), id);

  const nadpisanie = nadpisanieWysylki(z);
  if (nadpisanie?.pobranie && nadpisanie.kwota_pobrania !== doPobrania) {
    zapiszNadpisanieWysylki(db, id, { ...nadpisanie, kwota_pobrania: doPobrania });
  }
}
