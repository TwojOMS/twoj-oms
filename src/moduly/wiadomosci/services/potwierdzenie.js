import { pobierzZamowienie, oznaczPotwierdzenieWyslane, dopiszLog } from '../../../oms/db/zamowienia.js';
import { zapiszWiadomosc } from '../../../oms/db/wiadomosci.js';
import { wczytajSzablonyWiadomosci } from '../../../oms/db/szablony-wiadomosci.js';
import { mailPotwierdzenia } from '../szablony.js';
import { tekstZeStopka } from '../oprawa.js';
import { oprawaTeraz } from '../podpis-maili.js';
import { zdaniaPlatnosciTeraz } from '../zdania-platnosci.js';

// WYSYLKA POTWIERDZENIA PRZYJECIA ZAMOWIENIA (21.08.2026).
//
// ⚠️ USLUGA NIE DECYDUJE, CZY WYSLAC — decyduje czlowiek, klikajac na ekranie PODGLADU.
// Tresc sklada domena (domain/potwierdzenie-zamowienia.js) i to ona odmawia przy zamowieniu
// anulowanym, bez adresu albo bez pozycji. Tutaj zostaje samo „wyslij i odnotuj".
//
// ⚠️ MAILA NIE DA SIE COFNAC. Dlatego: nigdy z jednego klikniecia (karta pokazuje podglad
// pod `?wiadomosc=potwierdzenie`, wysyla dopiero POST /zamowienia/:id/wiadomosc/potwierdzenie),
// a slad zostaje w TRZECH miejscach — w logu karty, w rejestrze `wiadomosci` i w kolumnie
// `potwierdzenie_wyslane_at`, z ktorej ekran mowi „wyslano 21.08 o 12:40" zamiast pozwalac
// wysylac w kolko bez sladu.
// PRZ-102.10: `podpisPanelu()` — marka i stopka z Ustawień → Poczta (pola niezablokowane plikiem), czytane przy KAŻDEJ
// wysyłce. Oprawa liczona raz przy starcie dawała stary podpis aż do restartu panelu.
export function createPotwierdzenie({ db, mailer, sprzedawca = {}, oprawaPoczty = {}, podpisPanelu = null, teraz = () => new Date().toISOString() }) {
  const oprawaMailaTeraz = oprawaTeraz(oprawaPoczty, podpisPanelu);
  async function wyslij(id, { ktoKlikal = 'operator' } = {}) {
    const z = pobierzZamowienie(db, id);
    if (!z) throw new Error(`Nie ma zamówienia ${id}`);
    const oprawa = oprawaMailaTeraz();

    // RZUCA przy odmowie domeny — trasa zamienia to na komunikat po polsku, tak samo jak
    // przy fakturze i proformie.
    // PRZ-101.03: szablon z Ustawień → Szablony wiadomości, czytany przy każdej wysyłce (zmiana bez restartu).
    // Bez zapisu — dzisiejsza treść co do znaku (szablony.js: droga `szablon: null`).
    // PRZ-102.19: etykiety i stałe teksty (nagłówki, kolumny, „Pozdrawiamy,") z tej samej sekcji, czytane przy każdej wysyłce.
    const mail = mailPotwierdzenia(z, {
      oprawa, szablon: wczytajSzablonyWiadomosci(db).wbudowane.potwierdzenie ?? null, zdania: zdaniaPlatnosciTeraz(db),
    });

    try {
      await mailer.sendMail({
        to: mail.do,
        subject: mail.temat,
        // ⚠️ TEKST ZOSTAJE JAKO CZESC ALTERNATYWNA — klient pocztowy bez HTML-a dostaje
        // te sama tresc, tylko bez tabeli. Obie postacie wychodza z JEDNEGO modelu
        // (domain/potwierdzenie-zamowienia.js), wiec nie moga pokazac roznych kwot.
        text: tekstZeStopka(mail.tekst, oprawa.footer),
        // ⚠️ WLASNY RENDERER, a nie `renderMailHtml` (przebudowa 21.08.2026). Tamten rozpoznaje
        // wzorce linii napisane pod maile z WYCENA (`3x Nazwa - 74,90zl brutto/szt`);
        // potwierdzenie ich nie spelnia, wiec wychodzilo z niego jako ciag akapitow — bez
        // tabeli, ktora mialo miec. Wspolna zostaje KOPERTA (wordmark, karta, stopka), czyli
        // to, co naprawde ma wygladac tak samo w calej korespondencji.
        html: mail.html,
      });
    } catch (e) {
      // ⚠️ NIEUDANA WYSYLKA NIE MA PRAWA ZOSTAWIC SLADU „wyslano". Odwrotna kolejnosc
      // (oznacz, potem wyslij) dawalaby karte twierdzaca, ze klient dostal maila, ktorego
      // nigdy nie bylo — i nikt by tego nie sprawdzil.
      dopiszLog(db, id, {
        akcja: 'potwierdzenie.blad',
        wynik: `BŁĄD wysyłki potwierdzenia do ${mail.do} (${ktoKlikal}): ${e.message}`,
      });
      throw e;
    }

    const kiedy = teraz();
    oznaczPotwierdzenieWyslane(db, id, kiedy);
    // Zapis do rejestru STĄD, bezwarunkowo: to jedyna usługa, która faktycznie wysyła
    // potwierdzenie, więc ślad zostaje JEDEN i zostaje zawsze — kto by jej nie zawołał.
    // ⚠️⚠️ `services/wiadomosci.js` NIE MA PRAWA dopisać drugiego wpisu po delegacji do tej
    // usługi: dwa wiersze na jednego maila znaczą kartę twierdzącą, że klient dostał
    // potwierdzenie dwa razy (pilnuje tego test „potwierdzenie idzie starą usługą…").
    zapiszWiadomosc(db, {
      zamowienieId: id, temat_id: 'potwierdzenie', adresat: mail.do, temat: mail.temat,
      zalacznik: null, kto: ktoKlikal, at: kiedy,
    });
    dopiszLog(db, id, {
      akcja: 'potwierdzenie.wyslane',
      // Adresat i temat TAK, tresc NIE — ta sama zasada, co przy komentarzu wewnetrznym:
      // log karty czyta sie na glos przy reklamacji.
      wynik: `Ręcznie (${ktoKlikal}): potwierdzenie przyjęcia zamówienia wysłane na ${mail.do}.`,
    });
    return { do: mail.do, temat: mail.temat, kiedy };
  }

  return { wyslij };
}
