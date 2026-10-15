// src/oms/domain/czyj-ruch-watku.js
//
// Stan watku LICZONY Z FAKTOW, nigdy ustawiany recznie — ta sama zasada, co przy statusie
// zamowienia w panelu. Zrodla sa dwa: „czy ostatnia wiadomosc jest od kupujacego" (lustro,
// czyli Allegro) i „czy nasza ostatnia odpowiedz byla formulka" (dowody, czyli my).
//
// ⚠️ ZALATWIONE, GDY OSTATNIA NIE JEST KUPUJACEGO — nawet bez naszego dowodu. Wlasciciel
// czesto odpisuje wprost w aplikacji Allegro; brak wpisu u nas nie znaczy, ze nikt nie
// odpowiedzial. Traktowanie tego jako „czeka" zapalaloby lampke na zawsze.

export function czyjRuch(watek, dowody = []) {
  if (watek?.ostatnia_od_kupujacego && !objeteZamknieciem(watek)) return 'czeka';
  // ⚠️ Liczy sie tylko dowod FAKTYCZNIE WYSLANY (`wyslany_at`). Wpis powstaje przed
  // strzalem do Allegro, wiec sam jego byt nie dowodzi, ze cokolwiek poszlo.
  const wyslane = dowody.filter((d) => d.wyslany_at);
  const ostatni = wyslane[wyslane.length - 1] ?? null;
  return ostatni?.rodzaj === 'formulka' ? 'formulka' : 'zalatwione';
}

/**
 * Czy RECZNE „Zalatwione" obejmuje BIEZACY stan watku.
 *
 * ⚠️⚠️ ZAMKNIECIE JEST FAKTEM Z DATA, NIE PRZELACZNIKIEM. `zamkniete_do` trzyma date
 * ostatniej wiadomosci z chwili klikniecia. Gdy kupujacy napisze POZNIEJ, watek wraca do
 * „czeka" SAM — bez tego jedno klikniecie uciszaloby go NA ZAWSZE, a nowe pytanie tego
 * samego czlowieka przepadloby po cichu. Cisza wyglada jak brak pytan, nie jak usterka.
 *
 * ⚠️ Powstalo 29.08.2026 na prosbe wlasciciela: sa watki, w ktorych kupujacy napisal na
 * koniec „Dziekuje" i nie ma na co odpisywac. Panel nie ma jak odroznic podziekowania od
 * pytania, wiec ta jedna rzecz musi powiedziec mu czlowiek.
 *
 * ⚠️ Data nie do odczytania po ktorejkolwiek stronie znaczy „nie obejmuje" — zostajemy przy
 * stanie wyliczonym z lustra. Zgadywanie tutaj gasiloby watek, ktory moze czekac.
 */
function objeteZamknieciem(watek) {
  const doKiedy = Date.parse(watek?.zamkniete_do ?? '');
  const ostatnia = Date.parse(watek?.last_message_date_time ?? '');
  if (Number.isNaN(doKiedy) || Number.isNaN(ostatnia)) return false;
  return ostatnia <= doKiedy;
}
