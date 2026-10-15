// DYSKUSJE I REKLAMACJE — odczyt `GET /sale/issues` do lustra.
//
// ⚠️⚠️ RUSZTOWANIE NA DWA MIESIACE, budowane ze swiadomoscia, ze zniknie. Od 28.10.2026 Allegro
// wprowadza Problemy z zakupem do Centrum wiadomosci jako typ watku POST_PURCHASE_ISSUE,
// obslugiwany WYLACZNIE przez `/messaging`. Wtedy ten plik, `pobierzSprawy` w kliencie i tabela
// `allegro_sprawy` maja zostac SKASOWANE, a nie zostac „na wszelki wypadek". Alternatywa dla
// tego rusztowania byly dwa miesiace slepoty na sprawy, ktore MAJA TERMINY — a milczenie
// w sporze rozstrzyga go na nasza niekorzysc.
//
// ⚠️ TYLKO ODCZYT. Odpisywanie w sporze zostaje w Allegro, gdzie jest komplet narzedzi
// i dowodow. Panel pokazuje, ze sprawa istnieje, i odsyla.
//
// Historia zasobu: `/sale/disputes` Allegro USUNELO 07.01.2026, zastapione przez `/sale/issues`
// (od 24.06.2025). Pole `type` rozroznia `DISPUTE` od `CLAIM`.

export const STATUSY_OTWARTE = ['DISPUTE_ONGOING', 'DISPUTE_UNRESOLVED', 'CLAIM_SUBMITTED'];

export function createOdswiezanieSpraw({ db, klienci = {}, brakiKanalu = () => [], teraz = () => new Date() }) {
  // ⚠️ KLUCZ TO PARA (kanal, issue_id), nie samo `issue_id`. Mamy dwa konta Allegro i nic nie
  // gwarantuje rozlacznosci identyfikatorow miedzy nimi — sklejenie pokazaloby jeden spor
  // zamiast dwoch.
  const wpis = db.prepare(`
    INSERT INTO allegro_sprawy
      (kanal, issue_id, typ, status, buyer_login, zamowienie_id, opened_date, pobrany_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(kanal, issue_id) DO UPDATE SET
      typ = excluded.typ, status = excluded.status, buyer_login = excluded.buyer_login,
      zamowienie_id = excluded.zamowienie_id, opened_date = excluded.opened_date,
      pobrany_at = excluded.pobrany_at
  `);

  async function przebieg() {
    const pobranyAt = teraz().toISOString();
    const bledy = [];
    let zapisane = 0;
    for (const [nazwa, klient] of Object.entries(klienci)) {
  // ⚠️⚠️ NIE WOLAMY ZASOBU, DO KTOREGO KANAL NIE MA UPRAWNIENIA. Bez tego panel wdrozony
  // PRZED przewiazaniem kanalow strzela 403 przy kazdym przebiegu — okolo 1150 nieudanych
  // wywolan na dobe prosto do raportu „Bledy techniczne" Allegro. Zakresy wchodza do tokenu
  // wylacznie przy autoryzacji, wiec ten stan trwa az do przewiazania, nie mija sam.
  // ⚠️ Pusta lista brakow znaczy „nie wiem" i przepuszcza — nie wnioskujemy z niewiedzy
  // (ta sama zasada, co w domain/uprawnienia-kanalu.js).
      if (brakiKanalu(nazwa).includes('allegro:api:disputes')) continue;
      // ⚠️ IZOLACJA NA KANAL. Przed przewiazaniem kanalow o `allegro:api:disputes` ten zasob
      // odda 403 na obu kontach — przebieg ma to zniesc i oddac bledy, a nie odrzucic
      // obietnicy i zabrac ze soba odswiezanie wiadomosci, z ktorym dzieli zegar.
      try {
        const { sprawy } = await klient.pobierzSprawy({ offset: 0 });
        for (const s of sprawy) {
          wpis.run(
            nazwa, s.id, s.type ?? null, s.status ?? null,
            s.buyer?.login ?? null, s.checkoutForm?.id ?? null, s.openedDate ?? null, pobranyAt,
          );
          zapisane += 1;
        }
      } catch (e) {
        // ⚠️ Komunikat niesie kod i sciezke (zadbal o to klient) — nigdy tokenu.
        bledy.push(`${nazwa}: ${e.message}`);
      }
    }
    return { zapisane, bledy };
  }

  return { przebieg };
}

/** Sprawy wymagajace uwagi — na znacznik przy zakladce i na liste wiadomosci. */
export function sprawyOtwarte(db) {
  const pytajniki = STATUSY_OTWARTE.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM allegro_sprawy WHERE status IN (${pytajniki}) ORDER BY opened_date DESC`,
  ).all(...STATUSY_OTWARTE);
}
