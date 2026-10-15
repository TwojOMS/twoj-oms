import { grosze, zl } from '../../../domena/suma-pozycji.js';
import { formatNumeru } from '../../../domena/proforma-stan.js';

const teraz = () => new Date().toISOString();

/**
 * Kolejny wolny licznik proformy w danym miesiacu — `{ rok, miesiac, kolejny, numer }`.
 *
 * ⚠️ WYNIK JEST WAZNY WYLACZNIE W TRANSAKCJI, KTORA OD RAZU WSTAWIA WIERSZ Z TYM NUMEREM.
 * Dwa rownoczesne klikniecia „Wystaw proformę" policza to samo — dlatego `zapiszProforme`
 * nizej wola te funkcje JUZ POD BLOKADA ZAPISU (BEGIN IMMEDIATE), a indeks unikalny
 * `proformy_kolejny` (schema.sql) jest DRUGA siatka, nie pierwsza. Ta sama zasada, co przy
 * numerze serii recznej (db/zamowienia-reczne.js) i numerze kolejnej paczki (db/przesylki.js).
 *
 * ⚠️ LICZYMY MAX, A NIE COUNT. Numer raz nadany jest SPALONY, takze gdy dokument
 * uniewazniono: klient dostal PDF na maila i moze go miec przed soba, wiec drugi dokument
 * o tym samym numerze znaczylby dwie rozne kwoty pod jednym tytulem przelewu. `COUNT(*)`
 * zaczalby po pierwszym uniewaznieniu wydawac numery, ktore juz sa u ludzi.
 *
 * Licznik zeruje sie co miesiac (warunek na pare `rok`+`miesiac`) — dokladnie jak w serii
 * Apilo, ktora ten dokument nasladuje.
 *
 * Numer skladamy JEDNA funkcja z domeny (`formatNumeru`), a nie tutaj drugi raz — dwie
 * kopie formatu rozjechalyby sie przy pierwszej zmianie, a numer jest tym, co klient
 * wpisuje w tytul przelewu.
 */
export function nastepnyNumer(db, rok, miesiac) {
  const { m } = db.prepare(
    'SELECT MAX(kolejny) m FROM proformy WHERE rok = ? AND miesiac = ?',
  ).get(rok, miesiac);
  const kolejny = Number(m ?? 0) + 1;
  return { rok, miesiac, kolejny, numer: formatNumeru({ kolejny, miesiac, rok }) };
}

/**
 * Nowa proforma do zamowienia: nadanie numeru i zapis wiersza, w JEDNEJ transakcji.
 *
 * ⚠️ NUMER LICZYMY POD BLOKADA ZAPISU I TO JEST SEDNO TEJ FUNKCJI. `BEGIN IMMEDIATE` bierze
 * blokade OD RAZU, wiec odczyt licznika i INSERT sa nierozdzielne — zwykle `BEGIN` bralo by
 * ja dopiero przy INSERT-cie, czyli PO odczytaniu licznika, i zostawialo dokladnie to okno,
 * w ktorym dwa klikniecia licza ten sam „nastepny" numer.
 *
 * ⚠️ KWOTA PRZECHODZI PRZEZ `grosze()`/`zl()`, a do bazy idzie wartosc POLICZONA, nie surowy
 * input. To ta sama lekcja, co przy wplatach okresu (db/platnosci.js): `String(kwota)` na
 * `undefined` zapisywalo w bazie napis „undefined", ktorego zaden pozniejszy odczyt juz nie
 * parsuje — a tutaj taki wiersz zostawalby z ZUZYTYM numerem z serii. Odmowa (bladOperatora
 * z `grosze`) leci PRZED otwarciem transakcji, wiec nieudana proba nie zuzywa numeru.
 *
 * `rok`/`miesiac` mozna podac wprost (testy, wystawienie „za poprzedni miesiac"); domyslnie
 * wychodza Z TEGO SAMEGO znacznika czasu, co `utworzona_at`. Dwa niezalezne odczyty zegara
 * daly by na przelomie miesiaca numer z jednego miesiaca przy liczniku drugiego — ta sama
 * pulapka, co przy `utworzone_at` zamowienia recznego (db/zamowienia-reczne.js).
 *
 * ⚠️ Uniewaznienia poprzednich proform TU NIE MA — robi je `uniewaznijPoprzednie`, wolane
 * przez serwis (services/proforma.js) zaraz po zapisie. Kolejnosc faz nalezy do serwisu, bo
 * to on wie, czy PDF w ogole powstal: uniewaznienie poprzedniej PRZED nadaniem numeru
 * zostawialoby zamowienie bez ani jednej waznej proformy, gdyby zapis sie nie udal.
 */
export function zapiszProforme(db, zamowienieId, {
  kwotaBrutto, plikSciezka = null, rok = null, miesiac = null, utworzonaAt = null,
} = {}) {
  const kwotaGr = grosze(kwotaBrutto, 'kwota proformy');
  const stempel = utworzonaAt ?? teraz();
  const data = new Date(stempel);
  const rokDokumentu = rok ?? data.getFullYear();
  // getMonth() liczy od zera — miesiac trzymamy po ludzku (1–12), bo tak wchodzi do numeru.
  const miesiacDokumentu = miesiac ?? data.getMonth() + 1;

  db.exec('BEGIN IMMEDIATE');
  try {
    const n = nastepnyNumer(db, rokDokumentu, miesiacDokumentu);
    const info = db.prepare(
      'INSERT INTO proformy (zamowienie_id, numer, rok, miesiac, kolejny, kwota_brutto,'
      + ' plik_sciezka, uniewazniona_at, utworzona_at) VALUES (?,?,?,?,?,?,?,NULL,?)',
    ).run(zamowienieId, n.numer, n.rok, n.miesiac, n.kolejny, zl(kwotaGr), plikSciezka, stempel);
    db.exec('COMMIT');
    // Oddajemy ZAPISANY wiersz, odczytany z bazy: wolajacy dostaje `id` (bez niego nie ma
    // czego uniewaznic ani do czego podpiac pliku) i numer, ktory ma wydrukowac na PDF-ie.
    return pobierzProforme(db, Number(info.lastInsertRowid));
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Wszystkie proformy jednego zamowienia — NAJSTARSZE PIERWSZE.
 *
 * Lista, a nie pojedynczy wiersz, i to jest zasadnicza roznica wobec faktury VAT: proforma
 * jest odwracalna, wiec zamowienie ma HISTORIE dokumentow z oznaczeniem aktualnej (patrz
 * `aktualnaProforma` w domain/proforma-stan.js). Porzadek chronologiczny jest tym, co widzi
 * operator na karcie — numery maja rosnac z gory na dol.
 *
 * Pusta lista, a nie `null`, zeby kod czytajacy nie musial rozrozniac „brak proform" od
 * „nie wiem" — ta sama zasada, co przy przesylkach zamowienia.
 */
export function proformyZamowienia(db, zamowienieId) {
  return db.prepare('SELECT * FROM proformy WHERE zamowienie_id = ? ORDER BY utworzona_at, id')
    .all(zamowienieId);
}

/** Jedna proforma po `id` — do pobrania PDF-a i do odczytu po zapisie. `null`, gdy nie ma. */
export function pobierzProforme(db, id) {
  return db.prepare('SELECT * FROM proformy WHERE id = ?').get(id) ?? null;
}

/**
 * Podpiecie wygenerowanego PDF-a pod juz zapisany wiersz.
 *
 * Osobny UPDATE, a nie pole w `zapiszProforme`, bo NAZWA PLIKU ZAWIERA NUMER DOKUMENTU,
 * a numer powstaje dopiero w transakcji tamtej funkcji. Kolejnosc jest wiec wymuszona:
 * najpierw numer, potem plik, na koncu sciezka. Wiersz ze sciezka do pliku, ktorego jeszcze
 * nie ma, mowilby karcie „dokument gotowy do pobrania" w chwili, gdy dokumentu nie ma.
 */
export function zapiszSciezkePliku(db, id, sciezka) {
  db.prepare('UPDATE proformy SET plik_sciezka = ? WHERE id = ?').run(sciezka, id);
}

/**
 * Skasowanie wiersza proformy, ktorej DOKUMENT NIGDY NIE POWSTAL.
 *
 * ⚠️ JEDYNE dozwolone uzycie: sprzatanie po awarii zapisu pliku w services/proforma.js.
 * Proformy WYSLANEJ klientowi nie kasuje sie nigdy — od tego jest `uniewaznijPoprzednie`,
 * bo klient ma dokument przed soba i panel musi umiec powiedziec „ten juz nie obowiazuje".
 * Tu chodzi o cos innego: wiersz, ktoremu odpowiada zero bajtow na dysku i zero maili.
 *
 * ⚠️ SKASOWANIE ODDAJE NUMER DO PULI TYLKO WTEDY, GDY BYL TO NUMER NAJWYZSZY — i tylko
 * tyle wolno tu obiecywac. `nastepnyNumer` liczy MAX z ISTNIEJACYCH wierszy, wiec zniknięcie
 * najwyzszego cofa licznik o jeden i kolejna proba uzyje tego samego numeru (nikt go nie
 * widzial, wiec nikogo to nie wprowadzi w blad). Przy DWOCH zamowieniach naraz jest inaczej:
 * A dostaje 1, B dostaje 2, zapis pliku dla A pada — numer 1 zostaje DZIURA w serii, bo
 * licznik stoi juz na 2. Dziura jest cena, ktora placimy swiadomie: alternatywa to wiersz
 * bez dokumentu, czyli karta pokazujaca proforme, ktorej klient nigdy nie dostal.
 *
 * Zasada „numer raz nadany jest spalony" dotyczy proformy UNIEWAZNIONEJ — tamten wiersz
 * zostaje w tabeli i MAX go widzi, bo klient ma tamten PDF przed soba. Dlatego te dwie
 * sytuacje maja dwie rozne funkcje.
 */
export function usunProforme(db, id) {
  db.prepare('DELETE FROM proformy WHERE id = ?').run(id);
}

/**
 * Stempluje jako uniewaznione wszystkie WAZNE proformy zamowienia poza wskazana.
 *
 * ⚠️ DWIE WAZNE PROFORMY NARAZ TO KLIENT PLACACY WEDLUG STAREJ KWOTY — dlatego
 * uniewaznienie jest AUTOMATYCZNE przy wystawieniu kolejnej, a nie osobnym przyciskiem,
 * o ktorym operator ma pamietac. Dokumentu nie kasujemy: klient dostal go mailem i moze
 * miec przed soba, wiec panel musi umiec powiedziec „ten juz nie obowiazuje", a nie udawac,
 * ze nigdy nie istnial.
 *
 * `pozaId = null` uniewaznia WSZYSTKIE — potrzebne przy recznym wycofaniu omylkowej
 * proformy, gdy zadna nastepna nie powstaje.
 *
 * ⚠️ Warunek `uniewazniona_at IS NULL` nie jest optymalizacja: bez niego powtorne wywolanie
 * przestemplowaloby dokument uniewazniony tydzien temu dzisiejsza data i slad po chwili
 * decyzji przepadlby.
 *
 * Zawezenie do `zamowienie_id` jest granica wlasnosci: proforma innego zamowienia to inny
 * klient i inne pieniadze.
 */
export function uniewaznijPoprzednie(db, zamowienieId, pozaId = null, { teraz: kiedy = teraz() } = {}) {
  const info = db.prepare(
    'UPDATE proformy SET uniewazniona_at = ?'
    + ' WHERE zamowienie_id = ? AND uniewazniona_at IS NULL AND (? IS NULL OR id <> ?)',
  ).run(kiedy, zamowienieId, pozaId, pozaId);
  return Number(info.changes);
}

export function createZapytania(db) {
  return {
    nastepnyNumer: (...args) => nastepnyNumer(db, ...args),
    zapiszProforme: (...args) => zapiszProforme(db, ...args),
    proformyZamowienia: (...args) => proformyZamowienia(db, ...args),
    pobierzProforme: (...args) => pobierzProforme(db, ...args),
    zapiszSciezkePliku: (...args) => zapiszSciezkePliku(db, ...args),
    usunProforme: (...args) => usunProforme(db, ...args),
    uniewaznijPoprzednie: (...args) => uniewaznijPoprzednie(db, ...args),
  };
}
