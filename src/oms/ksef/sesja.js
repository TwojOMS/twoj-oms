import { createHash } from 'node:crypto';
import { BladSekretow, doZapisu, zOdczytu } from '../../core/bezpieczenstwo/sejf-sekretow.js';

// Sesja tokenów KSeF (tabela `tokeny_ksef`).
//
// ⚠️ TE WIERSZE SĄ POŚWIADCZENIAMI. Nie wypisujemy ich do logu, nie wkładamy do komunikatu
// błędu i nie oddajemy na ekran (reguła: sekrety nie wychodzą). `accessToken()` oddaje WYLACZNIE sam
// access token, nigdy caly wiersz.
//
// Regula wyboru drogi (trzy mozliwosci, sprawdzane w tej kolejnosci):
//   1. mamy zapisany access token, ktory jeszcze zyje -> uzywamy go, ZERO wywolan sieci.
//   2. access wygasl, ale refresh jeszcze zyje -> odswiezamy (jeden zapis, sam access).
//   3. refresh tez wygasl (albo nie ma zadnej pary) -> pelne logowanie tokenem KSeF
//      (jeden zapis, CAŁA para — uzasadnienie przy `zapiszPare`).

// Zapas przed wygasnieciem. Bez niego token wazny „jeszcze przez sekunde" przechodzi walidacje
// i pada w polowie pobierania — a przebieg czuwacza trwa minuty, nie milisekundy.
const ZAPAS_MS = 5 * 60 * 1000;

// `odcisk` — skrót tokenu KSeF (i NIP-u), którym wydano parę. Para o INNYM odcisku albo bez
// odcisku to BRAK PARY: pełne logowanie bieżącym tokenem. Bez tego nowy token z Ustawień
// przejmowałby parę starego — np. gdy przebieg na starym tokenie zalogował się już PO zapisie nowego, albo po zdjęciu
// tokenu z pliku, gdy w bazie leżał zapis z ekranu — i „Sprawdź połączenie” mówiłoby „działa” dla złego tokenu.
// Odcisk leży w `ustawienia` (bez migracji). Wołający bez `odcisk` dostaje zapisaną parę bez sprawdzania odcisku.
export function odciskTokenuKsef({ token, nip }) {
  return createHash('sha256').update(`${nip ?? ''}|${token}`).digest('hex');
}
const KLUCZ_ODCISKU = 'ksef.sesja.odcisk';

// Oba tokeny leżą w bazie zaszyfrowane kluczem poświadczeń (src/core/bezpieczenstwo/sejf-sekretow.js).
const miejsce = (kolumna) => ({ tabela: 'tokeny_ksef', kolumna, id: '1' });
const odszyfrowany = (db, w) => w && { ...w,
  access_token: zOdczytu(db, miejsce('access_token'), w.access_token),
  refresh_token: zOdczytu(db, miejsce('refresh_token'), w.refresh_token) };

/** @param {{ db: any, klient: any, teraz?: () => Date, odcisk?: string }} opcje */
export function createSesjaKsef({ db, klient, teraz = () => new Date(), odcisk = undefined }) {
  const odciskPary = () => db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ODCISKU)?.wartosc ?? null;
  const wczytaj = () => {
    const w = db.prepare('SELECT * FROM tokeny_ksef WHERE id = 1').get() ?? null;
    return w && (odcisk === undefined || odciskPary() === odcisk) ? odszyfrowany(db, w) : null;
  };

  // ⚠️ OBA TOKENY JEDNYM ZAPISEM. Zapis samego access tokena
  // zostawiłby refresh token z poprzedniej pary (albo pusty), a redeem działa tylko raz.
  function zapiszPare({ accessToken, accessDo, refreshToken, refreshDo }) {
    db.prepare(`
      INSERT INTO tokeny_ksef (id, access_token, access_do, refresh_token, refresh_do, ostatni_blad, zaktualizowane_at)
      VALUES (1,?,?,?,?,NULL,?)
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token, access_do = excluded.access_do,
        refresh_token = excluded.refresh_token, refresh_do = excluded.refresh_do,
        ostatni_blad = NULL, zaktualizowane_at = excluded.zaktualizowane_at
    `).run(doZapisu(db, miejsce('access_token'), accessToken), accessDo, doZapisu(db, miejsce('refresh_token'), refreshToken), refreshDo,
      teraz().toISOString());
    // Odcisk PO parze: przerwa między zapisami zostawia nową parę ze starym odciskiem = brak pary (ponowne logowanie),
    // nigdy starą parę z nowym odciskiem.
    if (odcisk !== undefined) {
      db.prepare(`INSERT INTO ustawienia (klucz, wartosc, zmienione_at) VALUES (?, ?, ?)
        ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, zmienione_at = excluded.zmienione_at`)
        .run(KLUCZ_ODCISKU, odcisk, teraz().toISOString());
    }
  }

  // Odswiezenie zmienia WYLACZNIE access token — refresh token zostaje ten sam (klient.odswiez
  // go nie oddaje), wiec zapis nie ma go czym nadpisac.
  // Tylko do TEJ pary, którą odświeżaliśmy — w trakcie `odswiez` inny zestaw (nowy token) mógł zapisać
  // własną parę, a access token starego tokenu wpisany do niej zostałby przejęty przez nowy.
  // Szyfrogram jest za każdym zapisem inny, więc „ta sama para” to porównanie ODSZYFROWANEGO tokenu odświeżającego —
  // krótka transakcja już PO odpowiedzi HTTP (blokady zapisu nie trzymamy w trakcie żądania sieciowego).
  function zapiszAccess({ accessToken, accessDo }, refreshToken) {
    const wlasna = !db.isTransaction;
    if (wlasna) db.exec('BEGIN IMMEDIATE');
    try {
      const w = db.prepare('SELECT refresh_token FROM tokeny_ksef WHERE id = 1').get();
      if (w && zOdczytu(db, miejsce('refresh_token'), w.refresh_token) === refreshToken) {
        db.prepare('UPDATE tokeny_ksef SET access_token = ?, access_do = ?, ostatni_blad = NULL, zaktualizowane_at = ? WHERE id = 1')
          .run(doZapisu(db, miejsce('access_token'), accessToken), accessDo, teraz().toISOString());
      }
      if (wlasna) db.exec('COMMIT');
    } catch (e) {
      if (wlasna && db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }

  // Trwały ślad awarii logowania; udany zapis pary albo access tokena go czyści.
  // UPDATE, nie INSERT — bez wcześniejszej udanej pary nie ma wiersza do opisania (access/refresh
  // są NOT NULL w tabeli `tokeny_ksef`), a to jest wtedy i tak scenariusz brzegowy bez trwałego stanu.
  // Zapisujemy WYŁĄCZNIE komunikat błędu, nigdy żadnego tokena (reguła: sekrety nie wychodzą).
  function zapiszBlad(e) {
    db.prepare('UPDATE tokeny_ksef SET ostatni_blad = ? WHERE id = 1')
      .run(String(e?.message ?? e));
  }

  const zywy = (doKiedy) => new Date(doKiedy).getTime() - teraz().getTime() > ZAPAS_MS;

  // Blokada logowania. Bez niej dwa rownolegle accessToken() na pustej bazie odczytalyby
  // pusty stan przed pierwszym await i OBA wpadlyby w klient.zaloguj() — a /auth/token/redeem
  // dziala tylko raz, wiec drugie wywolanie spalilo by jednorazowy zasob na nic. Zamiast tego
  // pierwszy wolajacy zaklada blokade (zapamietana obietnica), kolejni dolaczaja do tej samej
  // obietnicy i dostaja ten sam token. Blokada spada w `finally`, wiec po zakonczeniu (sukces
  // lub porazka) kolejne wywolanie moze zalogowac sie ponownie, gdy zajdzie taka potrzeba.
  let logowanieWToku = null;
  function zalogujZBlokada() {
    if (!logowanieWToku) {
      logowanieWToku = (async () => {
        try {
          const para = await klient.zaloguj();
          zapiszPare(para);
          return para.accessToken;
        } catch (e) {
          zapiszBlad(e);
          throw e;
        }
      })().finally(() => { logowanieWToku = null; });
    }
    return logowanieWToku;
  }

  async function accessToken() {
    const w = wczytaj();
    if (w && zywy(w.access_do)) return w.access_token;
    if (w && zywy(w.refresh_do)) {
      try {
        const swiezy = await klient.odswiez(w.refresh_token);
        zapiszAccess(swiezy, w.refresh_token);
        return swiezy.accessToken;
      } catch (e) {
        // Nieczytelny wiersz (klucz, uszkodzenie) to nie awaria sieci: pełne logowanie zapisałoby nową parę
        // na miejsce poświadczeń, których nie umiemy odczytać — błąd sejfu wychodzi na wierzch.
        if (e instanceof BladSekretow) throw e;
        // Nieudane odswiezenie NIE moze zostawic sesji martwej do naturalnego uplywu
        // refresh_do (to potrafi byc kwestia dni). Zamiast czekac, probujemy RAZ pelnego
        // logowania. Celowo tylko raz — pelne logowanie zuzywa jednorazowy
        // `/auth/token/redeem`, wiec ponawianie w petle spalaloby kolejne zasoby bez sensu;
        // gdy i ta proba padnie, blad leci dalej do wolajacego (zadnej trzeciej proby).
        return await zalogujZBlokada();
      }
    }
    return await zalogujZBlokada();
  }

  return { accessToken };
}

// Zmiana albo usunięcie tokenu KSeF w Ustawieniach kasuje parę tokenów sesji. Bez tego nowy token
// jechałby na access/refresh tokenie wydanym STAREMU (np. odwołanemu) — a „Sprawdź połączenie” po wklejeniu złego
// tokenu mówiłoby „działa”, bo nie logowałoby się nim wcale. Ten sam token zapisany ponownie sesji nie rusza.
export function usunSesjeKsef(db) {
  db.prepare('DELETE FROM tokeny_ksef WHERE id = 1').run();
  db.prepare('DELETE FROM ustawienia WHERE klucz = ?').run(KLUCZ_ODCISKU);
}
