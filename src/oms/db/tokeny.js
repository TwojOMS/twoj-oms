// Para tokenow OAuth kanalu (tabela `tokeny_kanalu`, patrz db/schema.sql).
//
// ⚠️ TE WIERSZE SA POSWIADCZENIAMI. Nie wypisujemy ich do logu, nie wkladamy do komunikatu
// bledu i nie oddajemy na ekran (niezmiennik 4.10 w docs/oms/PRZEWODNIK.md). `wczytajTokeny`
// oddaje CALY wiersz, wiec kazdy jego czytelnik odpowiada za to sam — do widoku sluzy
// `stanDlaEkranu()` z allegro/tokeny.js.

export function wczytajTokeny(db, kanal) {
  return db.prepare('SELECT * FROM tokeny_kanalu WHERE kanal = ?').get(kanal) ?? null;
}

// ⚠️ CALA PARA ZAWSZE RAZEM, JEDNYM ZAPISEM. Refresh token Allegro jest JEDNORAZOWY: udane
// odswiezenie rotuje access ORAZ refresh, a stary refresh jest od tej chwili spalony po
// stronie Allegro. Zapis „tylko access token" zostawilby w bazie wartosc, ktora NA PEWNO
// nie zadziala przy nastepnym odswiezeniu — i kanal zamilkby az do reki czlowieka.
//
// `ostatni_blad` gasnie przy KAZDYM udanym zapisie i to jest wyjscie ze stanu wymagajacego
// uwagi (niezmiennik 4.9): kanal polaczony na nowo nie ma prawa dalej wygladac na zepsuty.
export function zapiszTokeny(db, kanal, { accessToken, refreshToken, wygasaAt, refreshWygasaAt }) {
  db.prepare(`
    INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, ostatni_blad, zaktualizowane_at)
    VALUES (?,?,?,?,?,NULL,?)
    ON CONFLICT(kanal) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      wygasa_at = excluded.wygasa_at,
      refresh_wygasa_at = excluded.refresh_wygasa_at,
      ostatni_blad = NULL,
      zaktualizowane_at = excluded.zaktualizowane_at
  `).run(kanal, accessToken, refreshToken, wygasaAt, refreshWygasaAt, new Date().toISOString());
}

// Slad po nieudanej probie — jedyna rzecz, ktora czlowiek zobaczy, zanim kanal zamilknie.
// ⚠️ NIE RUSZA TOKENOW: nieudane odswiezenie nie znaczy, ze para jest do wyrzucenia (Allegro
// mogl odpowiedziec 503), a skasowanie jej tutaj zamienialoby przejsciowa usterke sieci
// w konieczne przejscie czlowieka przez device flow.
//
// ⚠️ `opis` MUSI byc tekstem, ktory sami napisalismy dla czlowieka — nigdy surowa
// odpowiedzia serwera i nigdy z tokenem w srodku (niezmiennik 4.10).
//
// ⚠️ ZNACZNIK CZASU IDZIE RAZEM Z BLEDEM. Bez tego `zaktualizowane_at` zostawaloby z
// ostatniego SUKCESU: operator widzialby swiezy blad obok daty sprzed trzech dni i uznal go
// za stary slad, ktory ktos juz naprawil. To jest dokladnie ten rodzaj cichej awarii, przed
// ktorym ten slad ma chronic.
export function zapiszBladTokenu(db, kanal, opis) {
  db.prepare('UPDATE tokeny_kanalu SET ostatni_blad = ?, zaktualizowane_at = ? WHERE kanal = ?')
    .run(opis, new Date().toISOString(), kanal);
}
