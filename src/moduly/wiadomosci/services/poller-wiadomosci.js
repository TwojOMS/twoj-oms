// PIATY ZEGAR — odswiezanie lustra Centrum wiadomosci z OBU kont Allegro.
//
// ⚠️⚠️ NIE ZATRZYMUJE SIE NA PIERWSZYM ZNANYM WATKU. Dokumentacja Allegro nie gwarantuje
// kolejnosci przy GET /messaging/threads — podaje wylacznie `limit` i `offset`. Poller,
// ktory przerywa na pierwszym znanym, przy innej kolejnosci przestaje widziec nowe wiadomosci
// i wyglada to na cisze u kupujacych, nie na usterke. Chodzimy do konca stron albo do sufitu.
//
// ⚠️ Co jest „nowe", rozstrzyga POROWNANIE `lastMessageDateTime` z lustrem, a nie pozycja
// na liscie ani `read`. Flaga `read` mowi, czy CZLOWIEK to otworzyl w Allegro — nie, czy my
// juz to mamy.
//
// ⚠️ NIE WOLAMY `PUT /messaging/threads/{id}/read`. To zmiana stanu po stronie Allegro:
// skasowalaby znacznik „nowe" w aplikacji na telefonie wlasciciela. Przeczytanie zostaje
// czynnoscia czlowieka.
//
// ⚠️ Awaria jednego kanalu nie moze zabic drugiego — dwa konta to dwie niezalezne skrzynki.

import { MAKS_STRON_WATKOW, LIMIT_STRONY_WATKOW } from '../../../oms/allegro/client.js';
import { zapiszWatek, watek, zapiszWiadomosci } from '../../../oms/db/allegro-watki.js';
import { najnowszaWiadomosc } from '../../../domena/najnowsza-wiadomosc.js';

// ⚠️ `sprawy` (dyskusje i reklamacje) jedzie NA TYM SAMYM ZEGARZE, a nie na wlasnym — jeden
// zegar, dwa zrodla. Osobny znaczylby drugiego straznika „jeden przebieg naraz" i druga rzecz
// do pilnowania, a oba odczyty i tak pytaja te same dwa konta Allegro.
export function createPollerWiadomosci({
  db, klienci = {}, sprawy = null, brakiKanalu = () => [], teraz = () => new Date(),
}) {
  let trwa = false;

  async function kanal(nazwa, klient, pobranyAt, licznik) {
    // ⚠️ Postep liczymy WATKAMI, ktore faktycznie przyszly, a nie numerem strony razy limit.
    // Allegro potrafi oddac strone krotsza niz limit i JEDNOCZESNIE zapowiadac w `totalCount`,
    // ze jest wiecej — arytmetyka po numerze strony uznalaby to za koniec listy.
    let widziane = 0;

    for (let strona = 0; strona < MAKS_STRON_WATKOW; strona += 1) {
      const { watki, razem } = await klient.pobierzWatki({ offset: strona * LIMIT_STRONY_WATKOW });
      if (watki.length === 0) return;
      widziane += watki.length;

      for (const t of watki) {
        licznik.watkow += 1;
        const znany = watek(db, nazwa, t.id);
        const data = t.lastMessageDateTime ?? null;
        // Bez zmiany daty nie ma po co pytac o tresc — to najdrozsze wywolanie przebiegu.
        if (znany && znany.last_message_date_time === data) continue;

        const { wiadomosci } = await klient.pobierzWiadomosci(t.id, { offset: 0 });
        // ⚠️ CALA korespondencja do lustra, nie sama ostatnia linijka — karta watku ma ja
        // pokazac bez dzwonienia do Allegro. Te wiadomosci i tak juz mamy w rece.
        zapiszWiadomosci(db, nazwa, t.id, wiadomosci);
        // ⚠️⚠️ NAJNOWSZA PO DACIE, NIGDY PO POZYCJI W TABLICY. Do 29.08.2026 stalo tu
        // `wiadomosci[wiadomosci.length - 1]` z komentarzem „Allegro oddaje watek
        // chronologicznie" — ZALOZENIE, ktorego nikt nie zmierzyl. Pomiar na produkcji:
        // `GET /messaging/messages` oddaje OD NAJNOWSZEJ, wiec brany byl najstarszy wpis,
        // prawie zawsze pytanie kupujacego. Wszystkie 18 watkow sklepu A swiecilo sie jako
        // czekajace i nie zgaslo by nigdy, a czuwacz formulki wysyla DOKLADNIE do takich
        // watkow. Szczegoly i cena tej pomylki: domain/najnowsza-wiadomosc.js.
        const ostatnia = najnowszaWiadomosc(wiadomosci);

        zapiszWatek(db, {
          kanal: nazwa,
          threadId: t.id,
          interlocutorLogin: t.interlocutor?.login ?? null,
          lastMessageDateTime: data,
          typ: t.type ?? 'COMMON',
          przeczytany: t.read ? 1 : 0,
          // ⚠️ `author.isInterlocutor` to JEDYNE zrodlo „kto pisal". `role: 'BUYER'` jest
          // dopiero w beta.v1, a my chodzimy po public.v1.
          ostatniaOdKupujacego: ostatnia?.author?.isInterlocutor ? 1 : 0,
          ostatniaTresc: ostatnia?.text ?? znany?.ostatnia_tresc ?? null,
          pobranyAt,
        });
        licznik.odswiezonych += 1;
      }

      // Koniec listy: mamy juz tyle watkow, ile Allegro zapowiedzialo. `razem === null` znaczy
      // „Allegro nie podalo liczby" — wtedy jedynym warunkiem konca jest krotka strona.
      //
      // ⚠️ Krotka strona NIE konczy przebiegu, kiedy `razem` mowi, ze jest wiecej. Zawyzony
      // `totalCount` kosztuje tu najwyzej dojscie do sufitu (przebieg chodzi w tle, bez
      // czlowieka), a przerwanie za wczesnie kosztuje NIEWIDZIANE wiadomosci kupujacych —
      // i wyglada wtedy na cisze, nie na usterke.
      if (razem === null || razem === undefined) {
        if (watki.length < LIMIT_STRONY_WATKOW) return;
      } else if (widziane >= razem) {
        return;
      }
    }
  }

  async function przebieg() {
    if (trwa) return { pominiety: true };
    trwa = true;
    try {
      const pobranyAt = teraz().toISOString();
      const licznik = { watkow: 0, odswiezonych: 0 };
      const bledy = [];
      for (const [nazwa, klient] of Object.entries(klienci)) {
        // ⚠️⚠️ NIE WOLAMY ZASOBU, DO KTOREGO KANAL NIE MA UPRAWNIENIA. Bez tego panel wdrozony
        // PRZED przewiazaniem kanalow strzela 403 przy kazdym przebiegu — okolo 1150 nieudanych
        // wywolan na dobe prosto do raportu „Bledy techniczne" Allegro. Zakresy wchodza do tokenu
        // wylacznie przy autoryzacji, wiec ten stan trwa az do przewiazania, nie mija sam.
        // ⚠️ Pusta lista brakow znaczy „nie wiem" i przepuszcza — nie wnioskujemy z niewiedzy
        // (ta sama zasada, co w domain/uprawnienia-kanalu.js).
        if (brakiKanalu(nazwa).includes('allegro:api:messaging')) continue;
        try {
          await kanal(nazwa, klient, pobranyAt, licznik);
        } catch (e) {
          // ⚠️ Komunikat niesie kod i sciezke (klient juz o to zadbal) — nigdy tokenu.
          bledy.push(`${nazwa}: ${e.message}`);
        }
      }
      // ⚠️ SPRAWY W OSOBNYM `try` — przed przewiazaniem kanalow o `allegro:api:disputes`
      // `/sale/issues` odda 403 na obu kontach. Bez tej izolacji brak JEDNEGO uprawnienia
      // kasowalby wynik pobrania wiadomosci, ktore poszlo poprawnie.
      if (sprawy) {
        try {
          const wynikSpraw = await sprawy.przebieg();
          bledy.push(...(wynikSpraw?.bledy ?? []));
        } catch (e) {
          bledy.push(`sprawy: ${e.message}`);
        }
      }
      return { ...licznik, bledy };
    } finally {
      trwa = false;
    }
  }

  return { przebieg };
}
