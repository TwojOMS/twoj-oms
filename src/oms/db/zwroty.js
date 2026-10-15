import { bladOperatora } from '../../domena/bledy.js';
// ⚠️ TOZSAMOSC ZWROTU LICZY DOMENA, nie ten modul. Baza jej UZYWA (wewnatrz transakcji),
// ale nie rozstrzyga, co znaczy „ten sam zwrot" — druga definicja rozjechalaby sie przy
// pierwszej zmianie formularza. Ten sam uklad, co `stanFaktury` w db/faktury.js.
import { czyTenSamZwrot, powodOdmowyKorektyDlaFaktury } from '../../domena/zwrot.js';

const teraz = () => new Date().toISOString();

// Porzadek po DACIE ZWROTU, potem po `id` — tak samo jak przy platnosciach (db/platnosci.js).
// Kolejnosc WPISYWANIA pokazywalaby zwrot z 2 wrzesnia nad zwrotem z 14 sierpnia tylko
// dlatego, ze ktos dopisal go pozniej.
const PORZADEK = ' ORDER BY data, id';

function pozycjeZwrotu(db, zwrotId) {
  return db.prepare(
    'SELECT klucz_pozycji, nazwa, ilosc, kwota FROM zwroty_pozycje WHERE zwrot_id = ? ORDER BY id',
  ).all(zwrotId);
}

const zPozycjami = (db, w) => (w ? { ...w, pozycje: pozycjeZwrotu(db, w.id) } : null);

export function zwrotyZamowienia(db, zamowienieId) {
  return db.prepare(`SELECT * FROM zwroty WHERE zamowienie_id = ?${PORZADEK}`)
    .all(zamowienieId)
    .map((w) => zPozycjami(db, w));
}

// Szukamy po PARZE (id zwrotu, id zamowienia): w swiezej bazie liczniki AUTOINCREMENT roznych
// tabel zbiegaja sie (przewodnik OMS, 6.3), wiec sam `id` przepuscilby pomylke argumentu
// w trasie. Ta sama zasada, co w `usunWplateReczna`.
export function zwrot(db, zamowienieId, zwrotId) {
  return zPozycjami(db, db.prepare('SELECT * FROM zwroty WHERE id = ? AND zamowienie_id = ?')
    .get(zwrotId, zamowienieId));
}

/**
 * Zapis zwrotu. Naglowek i pozycje ida JEDNA transakcja: awaria miedzy dwoma zapisami
 * zostawilaby zwrot bez pozycji, czyli dokladnie taki, z ktorego nie da sie zlozyc korekty.
 *
 * ⚠️ Bariery (kwota, sztuki, data) NIE MIESZKAJA TUTAJ — liczy je `domain/zwrot.js` PRZED
 * wywolaniem. Ten modul zapisuje to, co dostal, i jest jedynym miejscem z SQL-em zwrotow.
 *
 * ⚠️⚠️ JEDEN WYJATEK OD ZDANIA WYZEJ I JEST NIM POWTORNE WYSLANIE (recenzja 2026-08-15).
 * Bariery `parsujZwrot` licza sie POZA transakcja, wiec sprawdzenie „czy taki zwrot juz jest"
 * musi stac TUTAJ, miedzy `BEGIN IMMEDIATE` a `INSERT`-em — sprawdzone u wolajacego przepuscilo
 * by dwa rownolegle zadania, ktore OBA zobaczylyby pusta liste. `BEGIN IMMEDIATE` bierze blokade
 * zapisu OD RAZU, wiec drugie zadanie czeka i widzi juz zapisany wiersz pierwszego.
 *
 * To ta sama obrona, co `zarezerwujKorekte` nizej i z tego samego powodu: back+resubmit, dwuklik
 * i dwie otwarte karty to znane drogi do drugiego dokumentu. Przy korekcie obrona byla, przy
 * rejestracji zwrotu nie bylo — a drugi identyczny zwrot podwaja sume zwrotow i ZDEJMUJE KWOTE
 * Z PRZYCHODU DWA RAZY (raport zarzadczy czyta zwroty pojedynczo).
 *
 * ⚠️ Odmowa jest WASKA: rozna data, kwota albo zestaw pozycji przechodza bez pytania. Dwa
 * PRAWDZIWE zwroty o tej samej dacie, kwocie i tych samych pozycjach sa nieodroznialne od
 * powtorki i komunikat mowi wprost, co zrobic (`bladOperatora` nizej).
 */
export function dodajZwrot(db, zamowienieId, { data, kwota, kwotaDostawy = null, powod = null, pozycje = [] }) {
  let nowyId = null;
  const kandydat = { data, kwota, kwotaDostawy, pozycje };
  const zapisz = db.prepare(
    'INSERT INTO zwroty (zamowienie_id, data, kwota, kwota_dostawy, powod, utworzony_at)'
    + ' VALUES (?,?,?,?,?,?)',
  );
  const zapiszPozycje = db.prepare(
    'INSERT INTO zwroty_pozycje (zwrot_id, klucz_pozycji, nazwa, ilosc, kwota) VALUES (?,?,?,?,?)',
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    const blizniak = zwrotyZamowienia(db, zamowienieId).find((w) => czyTenSamZwrot(kandydat, w));
    if (blizniak) {
      // ⚠️ RADA MUSI BYC PRAWDZIWA (recenzja kontrolna 2026-08-15). Stalo tu „zmień datę albo
      // kwotę" — czyli namowa na ZAPISANIE NIEPRAWDY: data zwrotu RZADZI MIESIACEM PODATKOWYM
      // (art. 14 ust. 1m PIT, art. 29a ust. 13 VAT), a kwota idzie wprost do korekty i do
      // raportu. Dwa prawdziwe zwroty tego samego dnia, za te sama kwote i te same pozycje sa
      // nieodroznialne od powtorki, wiec jedyna uczciwa rada to POLACZYC je w jeden wpis.
      throw bladOperatora(
        `Taki sam zwrot jest już zapisany przy tym zamówieniu (${blizniak.data}, ${blizniak.kwota} zł) `
        + '— panel niczego nie dopisał. Jeśli klient naprawdę dostał te pieniądze dwa razy tego '
        + 'samego dnia, wpisz to jako jeden zwrot na łączną kwotę: data i kwota zwrotu rządzą '
        + 'miesiącem podatkowym i muszą zostać prawdziwe.',
      );
    }
    nowyId = Number(zapisz.run(
      zamowienieId, data, String(kwota), kwotaDostawy == null ? null : String(kwotaDostawy),
      powod, teraz(),
    ).lastInsertRowid);
    for (const p of pozycje) {
      zapiszPozycje.run(nowyId, p.klucz_pozycji, p.nazwa, Number(p.ilosc), String(p.kwota));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return zwrot(db, zamowienieId, nowyId);
}

/**
 * WYJSCIE ze stanu, w ktory panel sam pozwala wejsc (przewodnik OMS, 4.9) — omylkowo wpisany
 * zwrot przewraca sprzedaz w raporcie i przykleja zamowieniu status, ktory zostaje na zawsze.
 *
 * ⚠️ TRESC odmowy (ktory fakt i dlaczego) stoi w `domain/zwrot.js`
 * (`powodOdmowyUsunieciaZwrotu`) i to ona rozmawia z czlowiekiem.
 *
 * ⚠️⚠️ ALE WARUNEK JEST TAKZE W SQL-u (recenzja kontrolna 2026-08-15). Regula liczy sie w trasie,
 * POZA transakcja: przy dwoch otwartych kartach „pieniądze oddane" kliknięte MIEDZY sprawdzeniem
 * a `DELETE`-em kasowalo zwrot z JUZ WYPLACONA kwota — a razem z nim (kaskada na
 * `zwroty_pozycje`) jedyny zapis o tym, ile i kiedy wyszlo do kupujacego. Ta sama zasada, co przy
 * rezerwacji korekty nizej: granica FAKTU nalezy do bazy, bo tylko tam nie da sie jej wyprzedzic.
 */
export function usunZwrot(db, zamowienieId, zwrotId) {
  const w = zwrot(db, zamowienieId, zwrotId);
  if (!w) throw bladOperatora('Nie ma takiego zwrotu przy tym zamówieniu.');
  const wynik = db.prepare(
    'DELETE FROM zwroty WHERE id = ? AND zamowienie_id = ? AND pieniadze_oddane_at IS NULL'
    + ' AND korekta_zlecona_at IS NULL AND korekta_numer IS NULL',
  ).run(zwrotId, zamowienieId);
  if (!wynik.changes) {
    throw bladOperatora(
      'Ten zwrot ma już oddane pieniądze albo korektę — panel go nie skasował. Odśwież ekran: '
      + 'ktoś (albo Ty w drugiej karcie) zdążył to zrobić między sprawdzeniem a skasowaniem.',
    );
  }
  return w;
}

export function oznaczPieniadzeOddane(db, zamowienieId, zwrotId, kiedy = teraz()) {
  const wynik = db.prepare(
    'UPDATE zwroty SET pieniadze_oddane_at = ? WHERE id = ? AND zamowienie_id = ?',
  ).run(kiedy, zwrotId, zamowienieId);
  if (!wynik.changes) throw bladOperatora('Nie ma takiego zwrotu przy tym zamówieniu.');
}

/**
 * REZERWACJA korekty — sprawdzenie i zapis w JEDNEJ transakcji, PRZED wywolaniem inFaktu.
 * `false` znaczy „ktos byl pierwszy przy TYM zwrocie". To ta sama bariera, co przy `faktury`
 * i `wysylki_ksef`: dwuklik, back+resubmit i dwie otwarte karty to znane drogi do drugiego
 * dokumentu, a duplikat korekty rozwiazuje sie wylacznie TRZECIM dokumentem — widocznym
 * u organu podatkowego i u nabywcy.
 *
 * ⚠️⚠️ DWA WARUNKI W SQL-u, NIE JEDEN (K1, recenzja kontrolna 2026-08-15). `korekta_numer IS NULL`
 * dolozony obok `korekta_zlecona_at IS NULL`, bo „Korektę wystawiłem ręcznie" zapisuje NUMER BEZ
 * REZERWACJI: zwrot z numerem `9/KOR/08/2026` i pusta rezerwacja przechodzil dotad rezerwacje
 * bez oporu, a `zapiszKorekte` (COALESCE) nadpisywalo numer reczny numerem nowego dokumentu —
 * pierwszy znikal z bazy bez sladu. Warunek jest W SQL-u, a nie nad nim, bo tylko tam nie da sie
 * go wyprzedzic wyscigiem.
 *
 * ⚠️⚠️ REGULA „JEDNA KOREKTA NA FAKTURE" LICZY SIE TUTAJ, WEWNATRZ `BEGIN IMMEDIATE` (W4). Do
 * 2026-08-15 sprawdzala ja wylacznie usluga, POZA transakcja — dwa rownolegle zgloszenia na DWA
 * zwroty tego samego zamowienia oba czytaly „nikt inny nie ma korekty" i oba rezerwowaly wlasny
 * wiersz. Rezerwacja bronila POJEDYNCZEGO ZWROTU, a chroniona rzecza jest FAKTURA. Wzorem
 * `dodajZwrot` wyzej: `BEGIN IMMEDIATE` bierze blokade zapisu OD RAZU, wiec drugie zadanie czeka
 * i widzi juz zapisana rezerwacje pierwszego.
 *
 * ⚠️ Tresc odmowy pisze DOMENA (`powodOdmowyKorektyDlaFaktury`) — ta sama, ktora usluga pokazuje
 * czlowiekowi zanim w ogole dotknie inFaktu. Dwie kopie tego zdania rozjechalyby sie przy
 * pierwszej zmianie reguly.
 */
export function zarezerwujKorekte(db, zamowienieId, zwrotId, kiedy = teraz()) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const wszystkie = zwrotyZamowienia(db, zamowienieId);
    const powod = powodOdmowyKorektyDlaFaktury({ id: zwrotId }, wszystkie);
    if (powod) throw bladOperatora(powod);
    const wynik = db.prepare(
      'UPDATE zwroty SET korekta_zlecona_at = ?, korekta_blad = NULL'
      + ' WHERE id = ? AND zamowienie_id = ? AND korekta_zlecona_at IS NULL AND korekta_numer IS NULL',
    ).run(kiedy, zwrotId, zamowienieId);
    db.exec('COMMIT');
    return wynik.changes === 1;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// `COALESCE` broni czesciowej odpowiedzi inFaktu (referencja od razu, uuid/numer dopiero
// po przetworzeniu zlecenia — zasob jest ASYNCHRONICZNY): zapis pozniejszy nie ma prawa
// wyzerowac tego, co juz wiadomo.
export function zapiszKorekte(db, zamowienieId, zwrotId, { referencja = null, uuid = null, numer = null }) {
  db.prepare(
    'UPDATE zwroty SET korekta_referencja = COALESCE(?, korekta_referencja),'
    + ' korekta_uuid = COALESCE(?, korekta_uuid), korekta_numer = COALESCE(?, korekta_numer)'
    + ' WHERE id = ? AND zamowienie_id = ?',
  ).run(referencja, uuid, numer, zwrotId, zamowienieId);
}

/**
 * ⚠️ ZWALNIA REZERWACJE. Wolno ja zwolnic WYLACZNIE po ODMOWIE inFaktu (4xx) — wtedy wiadomo,
 * ze dokument nie powstal. Zerwane polaczenie znaczy „NIE WIADOMO" i rezerwacja ZOSTAJE
 * (ta sama regula, co przy `wysylki_ksef`). Bez tej sciezki jedno 422 zamykaloby droge do
 * korekty NA ZAWSZE, a jedynym wyjsciem bylby reczny UPDATE na produkcji.
 */
export function zapiszBladKorekty(db, zamowienieId, zwrotId, opis) {
  db.prepare(
    'UPDATE zwroty SET korekta_zlecona_at = NULL, korekta_blad = ? WHERE id = ? AND zamowienie_id = ?',
  ).run(String(opis).slice(0, 500), zwrotId, zamowienieId);
}

/**
 * ⚠️⚠️ JEDYNE WYJSCIE Z REZERWACJI, KTORA PRZEPADLA — kasuje SAMA rezerwacje i NIC POZA TYM.
 * Panel nie dotyka inFaktu: rozstrzyga czlowiek, ktory tam sprawdzil. Odpowiednik
 * `odblokujFakture` (db/faktury.js) i `odblokujPrzesylke` (db/przesylki.js), tą samą konwencją.
 *
 * Powstalo, bo `201` z inFaktu NIE DOWODZI, ze tresc korekty byla poprawna (zmierzone pustym
 * cialem 2026-08-14): zlecenie odrzucone w przetwarzaniu w tle zostawialo `korekta_zlecona_at`
 * ustawione NA ZAWSZE, a razem z nim zwrot NIEROZLICZONY i zamowienie na liscie roboczej.
 * Jedynym wyjsciem byl `UPDATE` na produkcyjnej bazie — czyli to, przed czym panel ma chronic
 * (przewodnik OMS, 4.9).
 *
 * ⚠️ PROG (15 minut) SPRAWDZA REGULA W `domain/zwrot.js` (`powodOdmowyOdblokowaniaKorekty`),
 * nie ten modul — baza nie liczy regul. TUTAJ stoi wylacznie granica FAKTU, ktorej zadna
 * decyzja czlowieka nie przekroczy: rezerwacji Z NUMEREM nie wolno ruszyc, bo dokument
 * w inFakcie NA PEWNO istnieje. Warunek jest W SQL-u, a nie nad nim, zeby dwa rownolegle
 * zadania nie zdazyly obu przeczytac wiersza bez numeru.
 *
 * Zwraca stan SPRZED zmiany — wolajacy zapisuje go do logu zamowienia. Bez tego sladu po
 * miesiacu nie da sie odtworzyc, co dokladnie zostalo skasowane.
 */
export function odblokujKorekte(db, zamowienieId, zwrotId) {
  const w = zwrot(db, zamowienieId, zwrotId);
  if (!w) throw bladOperatora('Nie ma takiego zwrotu przy tym zamówieniu.');
  const wynik = db.prepare(
    'UPDATE zwroty SET korekta_zlecona_at = NULL, korekta_referencja = NULL, korekta_blad = NULL'
    + ' WHERE id = ? AND zamowienie_id = ? AND korekta_numer IS NULL',
  ).run(zwrotId, zamowienieId);
  if (!wynik.changes) {
    throw bladOperatora(
      `Korekta ${w.korekta_numer} do tego zwrotu istnieje — panel nie zwolni rezerwacji dokumentu, `
      + 'który na pewno powstał. Odblokowanie otworzyłoby drogę do drugiej korekty do tej samej faktury.',
    );
  }
  return w;
}

/**
 * DRUGIE wyjscie: numer korekty WYSTAWIONEJ RECZNIE w inFakcie. Panel niczego tam nie wystawia
 * ani nie sprawdza — to jest odnotowanie faktu, ktory czlowiek stwierdzil sam, poza panelem
 * (dokladnie jak `fakturaSkasowanaWInfakcie` w db/faktury.js).
 *
 * ⚠️ `korekta_numer IS NULL` W SQL-u, a nie nad nim: dwuklik przy dwoch otwartych kartach
 * inaczej nadpisalby numer pierwszego dokumentu numerem drugiego, a panel rozliczylby zwrot
 * jednym z nich, milczac o istnieniu obu. Regule „co wpisac" trzyma
 * `parsujNumerKorekty` (domain/zwrot.js); tutaj jest sam zapis i jego bariera wyscigu.
 *
 * ⚠️⚠️ TEN SAM NUMER NA DWOCH ZWROTACH JEDNEGO ZAMOWIENIA TO DUPLIKAT ROZLICZENIA (W3, recenzja
 * kontrolna 2026-08-15): oba zwroty melduja sie wtedy jako rozliczone (`zwrotRozliczony` pyta
 * o `korekta_numer`) i zamowienie schodzi z listy roboczej, choc drugiej korekty NIE MA.
 * Sprawdzenie idzie razem z zapisem w `BEGIN IMMEDIATE`, a ostatnia instancja stoi w schemacie
 * (`UNIQUE zwroty_korekta_numer_zamowienia`) — droga reczna omija KAZDE sito w kodzie, wiec
 * bariera musi byc takze w bazie.
 *
 * ⚠️ Bariera jest PER ZAMOWIENIE. Ten sam napis przy dwoch roznych zamowieniach to pomylka
 * czlowieka przy przepisywaniu, a nie duplikat dokumentu — baza nie ma prawa tego rozstrzygac.
 */
export function zapiszRecznyNumerKorekty(db, zamowienieId, zwrotId, numer) {
  const nowy = String(numer);
  db.exec('BEGIN IMMEDIATE');
  try {
    const zajety = zwrotyZamowienia(db, zamowienieId)
      .find((x) => x.id !== zwrotId && x.korekta_numer === nowy);
    if (zajety) {
      throw bladOperatora(
        `Korekta ${nowy} jest już zapisana przy zwrocie z ${zajety.data} — jeden dokument nie `
        + 'rozlicza dwóch zwrotów. Sprawdź w inFakcie, który numer należy do tego zwrotu.',
      );
    }
    const wynik = db.prepare(
      'UPDATE zwroty SET korekta_numer = ? WHERE id = ? AND zamowienie_id = ? AND korekta_numer IS NULL',
    ).run(nowy, zwrotId, zamowienieId);
    if (!wynik.changes) {
      throw bladOperatora(
        'Nie udało się zapisać numeru korekty — albo nie ma takiego zwrotu przy tym zamówieniu, '
        + 'albo numer został już zapisany.',
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Identyfikatory zamowien, ktore maja CHOC JEDEN zwrot — JEDNYM zapytaniem.
 *
 * ⚠️ Lista zamowien liczy status dla kilkuset wierszy naraz (routes/zamowienia.js:
 * `wczytajListe`). Pytanie per wiersz dalo by N+1 na ekranie, na ktory operator patrzy
 * najczesciej.
 */
export function zamowieniaZeZwrotem(db) {
  return new Set(db.prepare('SELECT DISTINCT zamowienie_id AS id FROM zwroty').all().map((w) => w.id));
}

/**
 * Naglowki zwrotow (BEZ pozycji) dla calej LISTY zamowien — JEDNYM zapytaniem, batched
 * po IN (...). Ten sam wzorzec, co `pozycjeDlaZamowien` w db/zamowienia.js.
 *
 * ⚠️ ISTNIEJE DLA `doZrobienia` (domain/status.js), NIE TYLKO DLA `ma_zwrot`. Sam fakt
 * istnienia zwrotu (`ma_zwrot`, `zamowieniaZeZwrotem` wyzej) NIE WYSTARCZA liscie roboczej:
 * `doZrobienia` musi sprawdzic, czy KAZDY zwrot jest ROZLICZONY (zwrotRozliczony z
 * domain/zwrot.js), a do tego potrzebuje `pieniadze_oddane_at` i `korekta_numer` z
 * kazdego naglowka — nie samego faktu „ma zwrot". Bez tej funkcji lista pokazywalaby
 * status „Zwrot" poprawnie, ale ZDEJMOWALABY zamowienie z listy roboczej natychmiast,
 * zanim ktokolwiek oddal pieniadze (zmierzone: `doZrobienia` na wierszu z samym `ma_zwrot`,
 * bez `zwroty`, zawsze wraca `false` dla nierozliczonego zwrotu).
 *
 * ⚠️ BEZ pozycji CELOWO: lista ich nie pokazuje (szczegoly sa na karcie —
 * `zwrotyZamowienia` wyzej), a rozliczenie ich nie potrzebuje. Dowiazanie pozycji per
 * zwrot dalyby N+1 dokladnie tam, gdzie ta funkcja ma go unikac.
 */
export function zwrotyDlaZamowien(db, zamowienieIds) {
  const mapa = new Map();
  if (zamowienieIds.length === 0) return mapa;
  const placeholdery = zamowienieIds.map(() => '?').join(',');
  const wiersze = db.prepare(
    `SELECT * FROM zwroty WHERE zamowienie_id IN (${placeholdery})${PORZADEK}`,
  ).all(...zamowienieIds);
  for (const w of wiersze) {
    if (!mapa.has(w.zamowienie_id)) mapa.set(w.zamowienie_id, []);
    mapa.get(w.zamowienie_id).push(w);
  }
  return mapa;
}
