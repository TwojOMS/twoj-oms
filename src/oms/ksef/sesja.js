// Sesja tokenow KSeF (tabela `tokeny_ksef`, patrz db/schema.sql).
//
// ⚠️ TE WIERSZE SA POSWIADCZENIAMI. Nie wypisujemy ich do logu, nie wkladamy do komunikatu
// bledu i nie oddajemy na ekran (niezmiennik 4.10). `accessToken()` oddaje WYLACZNIE sam
// access token, nigdy caly wiersz.
//
// Regula wyboru drogi (trzy mozliwosci, sprawdzane w tej kolejnosci):
//   1. mamy zapisany access token, ktory jeszcze zyje -> uzywamy go, ZERO wywolan sieci.
//   2. access wygasl, ale refresh jeszcze zyje -> odswiezamy (jeden zapis, sam access).
//   3. refresh tez wygasl (albo nie ma zadnej pary) -> pelne logowanie tokenem KSeF
//      (jeden zapis, CALA para — patrz uzasadnienie w schema.sql).

// Zapas przed wygasnieciem. Bez niego token wazny „jeszcze przez sekunde" przechodzi walidacje
// i pada w polowie pobierania — a przebieg czuwacza trwa minuty, nie milisekundy.
const ZAPAS_MS = 5 * 60 * 1000;

export function createSesjaKsef({ db, klient, teraz = () => new Date() }) {
  const wczytaj = () => db.prepare('SELECT * FROM tokeny_ksef WHERE id = 1').get() ?? null;

  // ⚠️ OBA TOKENY JEDNYM ZAPISEM (patrz komentarz w schema.sql). Zapis samego access tokena
  // zostawilby refresh token z poprzedniej pary (albo pusty), a redeem dziala tylko raz.
  function zapiszPare({ accessToken, accessDo, refreshToken, refreshDo }) {
    db.prepare(`
      INSERT INTO tokeny_ksef (id, access_token, access_do, refresh_token, refresh_do, ostatni_blad, zaktualizowane_at)
      VALUES (1,?,?,?,?,NULL,?)
      ON CONFLICT(id) DO UPDATE SET
        access_token = excluded.access_token, access_do = excluded.access_do,
        refresh_token = excluded.refresh_token, refresh_do = excluded.refresh_do,
        ostatni_blad = NULL, zaktualizowane_at = excluded.zaktualizowane_at
    `).run(accessToken, accessDo, refreshToken, refreshDo, teraz().toISOString());
  }

  // Odswiezenie zmienia WYLACZNIE access token — refresh token zostaje ten sam (klient.odswiez
  // go nie oddaje), wiec zapis nie ma go czym nadpisac.
  function zapiszAccess({ accessToken, accessDo }) {
    db.prepare('UPDATE tokeny_ksef SET access_token = ?, access_do = ?, ostatni_blad = NULL, zaktualizowane_at = ? WHERE id = 1')
      .run(accessToken, accessDo, teraz().toISOString());
  }

  // Trwaly slad awarii logowania (kolumna byla dotad czyszczona tylko przy sukcesie).
  // UPDATE, nie INSERT — bez wczesniejszej udanej pary nie ma wiersza do opisania (access/refresh
  // sa NOT NULL w schema.sql), a to jest wtedy i tak scenariusz brzegowy bez trwalego stanu.
  // Zapisujemy WYLACZNIE komunikat bledu, nigdy zadnego tokena (niezmiennik 4.10).
  function zapiszBlad(e) {
    db.prepare('UPDATE tokeny_ksef SET ostatni_blad = ? WHERE id = 1')
      .run(String(e?.message ?? e));
  }

  const zywy = (doKiedy) => new Date(doKiedy).getTime() - teraz().getTime() > ZAPAS_MS;

  // W2: blokada logowania. Bez niej dwa rownolegle accessToken() na pustej bazie odczytalyby
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
        zapiszAccess(swiezy);
        return swiezy.accessToken;
      } catch {
        // W1: nieudane odswiezenie NIE moze zostawic sesji martwej do naturalnego uplywu
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
