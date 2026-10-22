// PRZ-108.09 (zmiana C2 planu automatyzacji, sekcja 2): zdarzenie „Kurier odebrał paczkę”.
//
// Fakt: `przesylki.odebrana_at` — chwila, w której OMS PIERWSZY RAZ zobaczył dowód odbioru z białej listy
// (domena/dowod-odbioru.js; zapis wyłącznie w `odswiezStatusKuriera`: czuwacz co godzinę i karta zamówienia; migracja
// automatyzacje/0003). NIE `etapPrzesylki` (nieznany stan InPostu = „w drodze”) i nie `status_kuriera_at` (czas u kuriera,
// przesuwa się z każdym skanem i bywa godzinę starszy niż chwila zapisu — kursor by go zgubił).
//
// Granica w detektorze: id paczki większe niż migawka `granica.przesylki` z chwili włączenia — paczka nadana przed
// włączeniem nie trafia nawet do dziennika, choćby kurier odebrał ją po włączeniu (plan C2: „paczka sprzed granicy → 0”;
// ten sam warunek co „Paczka nadana”). „Mail do historii” — zamówienie z INNĄ paczką z numerem sprzed granicy albo złożone
// ponad ZAMOWIENIE_STARSZE_NIZ_DNI przed granicą — odsiewa WSPÓLNY warunek wykonania każdej reguły (`historiaPrzedGranica`,
// domena/warunki-automatyzacji.js, kod `przed_granica`; PRZ-108.08 po recenzji 08): pominięte z powodem w dzienniku.
// Okna czasu detektor nie potrzebuje — czyta zakres indeksu `przesylki_odebrana_at` od kursora. `od` = kursor
// − 5 min, nigdy sprzed granicy. Kontrakt kandydatów (zdarzenia/index.js): rosnąco po (odebrana_at, id paczki), przy `po`
// ŚCIŚLE po (at, id), najwyżej `limit`. Jedno wykonanie na ZAMÓWIENIE (przedmiot domyślny `zamowienie:<id>`): druga paczka
// tego zamówienia trafia w UNIQUE silnika, a pominięte wykonanie otwiera tylko paczka odebrana PÓŹNIEJ (`odebrana_at`
// jest stałe, więc kolejne skany tej samej paczki go nie otwierają).
//
// Paczka bez śledzenia (numer wpisany ręcznie u przewoźnika, którego OMS nie pyta; Allegro bez numeru przewoźnika) nigdy
// nie dostaje `odebrana_at` — reguła po prostu jej nie widzi, bez wpisu w dzienniku.
import { dowodOdbioru } from '../../../domena/dowod-odbioru.js';

const znaki = (n) => Array.from({ length: n }, () => '?').join(',');

export const zdarzeniePaczkaOdebrana = Object.freeze({
  klucz: 'paczka_odebrana',
  etykieta: 'Kurier odebrał paczkę',
  grupa: 'przesylka',
  opis: 'Działa dla paczek, których status OMS sprawdza u przewoźnika: DPD i InPost podłączone w Ustawieniach oraz paczki '
    + 'Allegro ze śledzeniem. OMS pyta przewoźnika co godzinę, więc zdarzenie przychodzi do około godziny po odbiorze.',
  pomoc: 'Paczka bez śledzenia — numer wpisany ręcznie u przewoźnika, którego OMS nie pyta — nigdy nie wywoła tej reguły. '
    + 'Kupujących z Allegro powiadamia o wysyłce samo Allegro, dlatego kanały Allegro zwykle zostawia się odznaczone.',

  kandydaci(db, { granica, od, po = null, limit, kanaly = null }) {
    const odKiedy = od && granica?.at && od > granica.at ? od : granica?.at ?? od ?? '';
    const filtrKanalu = Array.isArray(kanaly) ? ` AND z.sklep IN (${znaki(kanaly.length)})` : '';
    const filtrPo = po ? ' AND (p.odebrana_at > ? OR (p.odebrana_at = ? AND p.id > ?))' : '';
    // Plan: indeks `przesylki_odebrana_at` (zakres od kursora), potem PK zamówienia — koszt rośnie z liczbą odbiorów
    // od kursora, nie z wiekiem reguły (pomiar w raporcie PRZ-108.09).
    return db.prepare(`SELECT p.id, p.zamowienie_id, z.sklep, p.id AS przesylka_id, p.odebrana_at AS zdarzenie_at
      FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
      WHERE p.odebrana_at >= ? AND p.id > ? AND p.status = 'nadana'${filtrKanalu}${filtrPo}
      ORDER BY p.odebrana_at, p.id LIMIT ?`)
      .all(odKiedy, Number(granica?.przesylki ?? 0),
        ...(Array.isArray(kanaly) ? kanaly : []), ...(po ? [po.at, po.at, po.id] : []), limit ?? 1000);
  },

  /**
   * Podgląd „30 dni”: przybliżenie z BIEŻĄCEGO stanu paczek nadanych od `od` (historii statusów nie trzymamy, a paczki
   * sprzed migracji nie mają `odebrana_at`) — ta sama biała lista co zapis. Jedna (najnowsza) paczka na zamówienie,
   * najnowsze pierwsze. Zero zapisów.
   */
  symulacja(db, od) {
    const wiersze = db.prepare(`SELECT p.id, p.zamowienie_id, z.sklep, p.status_kuriera, p.status_kuriera_kod, p.przejeta_at,
        p.odebrana_at, COALESCE(p.odebrana_at, p.utworzona_at) AS zdarzenie_at
      FROM przesylki p JOIN zamowienia z ON z.id = p.zamowienie_id
      WHERE p.utworzona_at >= ? AND p.status = 'nadana' AND (p.odebrana_at IS NOT NULL OR p.przejeta_at IS NOT NULL
        OR p.status_kuriera IS NOT NULL OR p.status_kuriera_kod IS NOT NULL)
      ORDER BY zdarzenie_at DESC, p.id DESC`).all(od);
    const naZamowienie = new Map();
    for (const w of wiersze) {
      // `odebrana_at` = dowód już zapisany (także z historii odpowiedzi, której stan bieżący nie pokazuje).
      if (naZamowienie.has(w.zamowienie_id) || !(w.odebrana_at || dowodOdbioru(w))) continue;
      naZamowienie.set(w.zamowienie_id, { zamowienie_id: w.zamowienie_id, sklep: w.sklep, przesylka_id: w.id, zdarzenie_at: w.zdarzenie_at });
    }
    return [...naZamowienie.values()];
  },
});
