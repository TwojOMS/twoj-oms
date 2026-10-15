// src/oms/services/czuwacz-formulki.js
//
// AUTORESPONDER — stala formulka w oknie godzin. Zastepuje autoresponder z Apilo, ktory
// wysylal jedna formulke do KAZDEJ wiadomosci, o kazdej porze.
//
// ⚠️⚠️ DOWOD POWSTAJE PRZED STRZALEM DO ALLEGRO. Gdy polaczenie padnie PO wyslaniu, wpis
// zostaje i drugi raz nie pojdzie. Swiadomie wybieramy „moze nie wyslac" zamiast „moze
// wyslac dwa razy" — kupujacy wybaczy cisze, nie wybaczy bota, ktory dubluje.
//
// ⚠️⚠️ FORMULKA NIGDY NIE IDZIE NA SPOR. Watek POST_PURCHASE_ISSUE jest wykluczony twardo:
// „dziekujemy, odpiszemy rano" w odpowiedzi na spor to nie neutralny komunikat, tylko dowod
// w sprawie.
//
// ⚠️ O OKNIE DECYDUJE CZAS NADEJSCIA WIADOMOSCI, nie czas przebiegu. Inaczej pytanie z 7:55
// dostaloby formulke „jestesmy poza godzinami" o 8:05, gdy ludzie juz siedza przy komputerze.

import { czyWOknie } from '../../../domena/okno-formulki.js';
import { ustawieniaFormulki } from '../../../domena/ustawienia-formulki.js';
import { czyjRuch } from '../../../domena/czyj-ruch-watku.js';
import { wczytajUstawienia } from '../../../oms/db/ustawienia.js';
import {
  listaWatkow, dowody, zapiszDowod, oznaczWyslane, oznaczBlad, licznikFormulek,
} from '../../../oms/db/allegro-watki.js';

// ⚠️ BEZPIECZNIK ILOSCIOWY. Wlasciciel mowi, ze wiadomosci jest „bardzo malo" — wiec nagly
// ruch nie znaczy dobrego dnia, tylko usterke (petla, zla detekcja autora, podwojony poller).
// Wtedy czuwacz ma STANAC, a nie zalac kupujacych formulkami.
export const MAKS_FORMULEK_NA_GODZINE = 5;

const GODZINA_MS = 60 * 60 * 1000;

// ⚠️⚠️ GORNA GRANICA WIEKU WIADOMOSCI — decyzja wlasciciela z 29.08.2026.
//
// Okno godzin sprawdza WYLACZNIE godzine i dzien tygodnia nadejscia, a karencja jest
// MINIMUM, nie maksimum — wiec bez tej granicy nic nie bronilo formulce polecec na
// wiadomosc sprzed miesiecy. Przy oknie „po godzinach" (18-8) stare watki nie lapia sie
// PRZYPADKIEM (przyszly w srodku dnia); przy oknie calodobowym zlapalyby sie od razu.
//
// Wyszlo to przy naprawie kolejnosci wiadomosci (domain/najnowsza-wiadomosc.js): poller
// bral zla wiadomosc jako ostatnia, przez co WSZYSTKIE 18 watkow sklepu A kwalifikowalo sie
// do formulki — w tym rozmowy z maja i lipca, dawno odpisane.
//
// ⚠️ TRESC FORMULKI SAMA WYZNACZA TE GRANICE. Zdanie „nie ma nas teraz przy komputerze,
// odpiszemy rano" jest FALSZYWE dla wiadomosci sprzed doby — a wyslane po miesiacach jest
// juz tylko kompromitujace.
const MAKS_WIEK_WIADOMOSCI_MS = 24 * GODZINA_MS;

export function createCzuwaczFormulki({ db, klienci = {}, brakiKanalu = () => [], teraz = () => new Date() }) {
  let trwa = false;

  async function przebieg() {
    if (trwa) return { pominiety: true };
    trwa = true;
    try {
      const chwila = teraz();
      const u = ustawieniaFormulki(wczytajUstawienia(db));
      if (!u.wlaczona) return { wyslane: 0, pominiete: 0, bledy: [], wstrzymany: false };

      const odGodziny = new Date(chwila.getTime() - GODZINA_MS).toISOString();
      if (licznikFormulek(db, odGodziny) >= MAKS_FORMULEK_NA_GODZINE) {
        return { wyslane: 0, pominiete: 0, bledy: [], wstrzymany: true };
      }

      let wyslane = 0;
      let pominiete = 0;
      const bledy = [];

      for (const w of listaWatkow(db)) {
        // 2. Ruch musi byc po naszej stronie.
        // ⚠️⚠️ `czyjRuch`, A NIE SAMA FLAGA `ostatnia_od_kupujacego`. Watek zamkniety recznie
        // („Zalatwione") dalej ma te flage zapalona, bo kupujacy NAPRAWDE pisal ostatni —
        // napisal „Dziekuje". Patrzenie na sama flage wyslaloby formulke komus, kto wlasnie
        // podziekowal i komu czlowiek swiadomie zamknal temat. Warunek ma byc JEDEN
        // i wspolny z ekranem — dwie kopie rozjechalyby sie przy pierwszej nowej regule.
        if (czyjRuch(w) !== 'czeka') { pominiete += 1; continue; }
        // 5. Nigdy spor.
        if (w.typ === 'POST_PURCHASE_ISSUE') { pominiete += 1; continue; }
        if (!w.last_message_date_time) { pominiete += 1; continue; }

        const przyszla = new Date(w.last_message_date_time);
        // ⚠️ NAJPIERW WIEK, przed oknem i karencja: to granica TWARDA, nieustawialna,
        // i ma zadzialac niezaleznie od tego, jak szeroko ustawiono okno godzin.
        // `>=` — „z ostatniej doby" znaczy MLODSZA niz doba; rowno doba to juz za stara.
        if (chwila.getTime() - przyszla.getTime() >= MAKS_WIEK_WIADOMOSCI_MS) {
          pominiete += 1;
          continue;
        }
        // 3. Okno liczone dla CHWILI NADEJSCIA.
        if (!czyWOknie(przyszla, u)) { pominiete += 1; continue; }
        // 4. Karencja — daj czlowiekowi szanse odpisac pierwszemu.
        if (chwila.getTime() - przyszla.getTime() < u.karencjaMin * 60 * 1000) { pominiete += 1; continue; }
        // 6. Raz na watek. Liczy sie KAZDY dowod formulki, takze nieudany.
        if (dowody(db, w.kanal, w.thread_id).some((d) => d.rodzaj === 'formulka')) { pominiete += 1; continue; }

        const klient = klienci[w.kanal];
        if (!klient) { pominiete += 1; continue; }
        // ⚠️⚠️ NIE WYSYLAMY PRZEZ KANAL BEZ UPRAWNIENIA `messaging` — Allegro odbije 403,
        // a `oznaczBlad` zostawi dowod, ktory przy regule „raz na watek" zablokowalby
        // formulke NA ZAWSZE: po przewiazaniu nigdy by juz nie poszla. Pomijamy PRZED
        // zapisem dowodu, wiec watek czeka nietkniety.
        if (brakiKanalu(w.kanal).includes('allegro:api:messaging')) { pominiete += 1; continue; }

        // ⚠️ NAJPIERW DOWOD. Gdy zapis odmowi (wyscig z drugim przebiegiem — indeks
        // `allegro_formulka_raz`), NIE wysylamy: to znaczy, ze ktos byl szybszy.
        let dowod;
        try {
          dowod = zapiszDowod(
            db, { kanal: w.kanal, threadId: w.thread_id, rodzaj: 'formulka', tresc: u.tresc },
            chwila.toISOString(),
          );
        } catch { pominiete += 1; continue; }

        try {
          await klient.wyslijWiadomosc(w.thread_id, u.tresc);
          oznaczWyslane(db, dowod.id, teraz().toISOString());
          wyslane += 1;
        } catch (e) {
          // ⚠️ DOWOD ZOSTAJE. Skasowanie zwolniloby indeks i przy nastepnym przebiegu
          // formulka poszlaby drugi raz — a nie wiemy, czy pierwsza nie dotarla.
          oznaczBlad(db, dowod.id, e.message);
          bledy.push(`${w.kanal}/${w.thread_id}: ${e.message}`);
        }

        // Bezpiecznik sprawdzany takze W TRAKCIE — jeden przebieg nie moze przekroczyc progu.
        if (licznikFormulek(db, odGodziny) >= MAKS_FORMULEK_NA_GODZINE) {
          return { wyslane, pominiete, bledy, wstrzymany: true };
        }
      }

      return { wyslane, pominiete, bledy, wstrzymany: false };
    } finally {
      trwa = false;
    }
  }

  return { przebieg };
}
