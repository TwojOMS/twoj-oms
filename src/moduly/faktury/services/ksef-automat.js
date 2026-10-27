// PRZ-102.12 — automat wysyłki faktur do KSeF o ustalonej godzinie (zlecenie właściciela 20.10.2026).
//
// ⚠️⚠️ AUTOMAT ZABIERA MOMENT NA ROZMYŚLENIE SIĘ — ekranu podglądu tu nie ma. Dlatego nie wolno mu wysłać
// NICZEGO, czego nie wysłałby przycisk po „zaznacz wszystkie” na ekranie Faktur:
//   • kandydaci = `doZaznaczeniaWszystkich` (ta sama reguła, co pola wyboru w faktury.ejs);
//   • każdy kandydat idzie OSOBNO przez `wysylkaKsef.wyslij` — usługa sama liczy zbiór od nowa z listy pobranej
//     na świeżo, przepuszcza przez `coWolnoWyslac`, rezerwuje w `wysylki_ksef` i pisze ślad w logu zamówienia
//     z operatorem „automat KSeF”. Żadnej drugiej drogi do `wyslijDokumentDoKsef`.
//
// ⚠️ JEDNA PRÓBA NA DZIEŃ: dzień zajmuje transakcja w bazie PRZED pierwszą wysyłką (db/ksef-automat.js).
// ⚠️ AWARIA = STOP: pierwszy `blad` (odmowa inFaktu albo „nie wiadomo”) albo wyjątek kończy przebieg. Reszta
// kandydatów nie leci tego dnia, a niczego się nie ponawia — dzień jest już zajęty. „Nie wiadomo” zostaje
// zarezerwowane (usługa go nie zwalnia), więc nie poleci też jutro, dopóki człowiek nie sprawdzi w inFakcie.
// Faktura ODRZUCONA (4xx) traci rezerwację — trafia na listę wstrzymanych (`ksef.automat.wstrzymane`) i automat
// ją pomija, dopóki człowiek nie wyśle jej ręcznie albo nie kliknie „Zwolnij” (poprawka po recenzji).
// Pojedyncze wysyłki zamiast jednej partii są właśnie po to: przy martwym inFakcie „nie wiadomo” jest jeden
// dokument, a nie wszystkie zaznaczone.
import { coWolnoWyslac, doZaznaczeniaWszystkich } from '../../../domena/wysylka-ksef.js';
import { czyWysylacKonsumenckie } from '../db/ksef-konsumenckie.js';
import {
  chwilaWarszawy, czyPoraPrzebiegu, miesiaceAutomatu, KTO_AUTOMAT, POLE_DATY_AUTOMATU,
} from '../../../domena/ksef-automat.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import {
  wczytajAutomatKsef, zajmijPrzebieg, zapiszWynikAutomatu, oznaczPrzerwanyPrzebieg, wstrzymajFakture, zwolnijWstrzymane,
} from '../db/ksef-automat.js';

/** Odstęp zegara: przebieg rusza najpóźniej minutę po ustawionej godzinie (i minutę po starcie panelu). */
export const ODSTEP_AUTOMATU_KSEF_MS = 60 * 1000;

export function createAutomatKsef({
  db, fakturyWidok, wysylkaKsef, teraz = () => new Date(), log = console.error, dostepny = () => true,
}) {
  // Proces właśnie wstał — wynik „trwa” w bazie to przebieg, który padł razem z poprzednim procesem.
  const doZaznaczenia = (d) => doZaznaczeniaWszystkich(d, czyWysylacKonsumenckie(db));
  oznaczPrzerwanyPrzebieg(db, teraz().toISOString());

  function dopiszWynik(wynik, w) {
    wynik.wyslane.push(...(w.wyslane ?? []).map(({ uuid, numer }) => ({ uuid, numer })));
    wynik.niepewne.push(...(w.niepewne ?? []).map(({ uuid, numer }) => ({ uuid, numer })));
    wynik.pominiete.push(...(w.pominiete ?? []).map(({ numer, powod }) => ({ numer, powod })));
  }

  async function przebieg() {
    // PRZ-118.07: nazwa i zdolność programu z usługi wysyłki — tej samej, którą automat wysyła (jedno źródło programu).
    if (!dostepny()) return { pominiety: true, powod: `${wysylkaKsef.nazwaProgramu?.mianownik ?? 'program fakturowy'} odłączony` };
    // Program bez zdolności `wyslijDoKsef`: automat nie ma czym wysłać — pominięty tym samym zdaniem co przycisk.
    if (wysylkaKsef.niedostepna) return { pominiety: true, powod: wysylkaKsef.niedostepna };
    const stan = wczytajAutomatKsef(db);
    const start = teraz();
    const chwila = chwilaWarszawy(start);
    if (!czyPoraPrzebiegu(stan, chwila)) return { pominiety: true, powod: 'nie ta pora' };

    const wynik = {
      dzien: chwila.dzien, startAt: start.toISOString(), koniecAt: null, stan: 'trwa',
      wyslane: [], niepewne: [], pominiete: [], poZasadzie: [], wstrzymane: [], wTrakcie: null, blad: null,
    };
    if (!zajmijPrzebieg(db, chwila.dzien, wynik, start.toISOString())) return { pominiety: true, powod: 'dziś już był przebieg' };

    try {
      petla: for (const miesiac of miesiaceAutomatu(chwila.dzien)) {
        const dokumenty = await fakturyWidok.dokumenty({ miesiac, pole: POLE_DATY_AUTOMATU });
        // Wstrzymane (odrzucone wcześniej przez inFakt): z numerem KSeF albo z rezerwacją — człowiek je wysłał,
        // wpis znika. Pozostałe pomijamy i pokazujemy w wyniku.
        const wstrzymane = new Set(wczytajAutomatKsef(db).wstrzymane.map((x) => x.uuid));
        const zalatwione = dokumenty.filter((d) => wstrzymane.has(d?.uuid) && d.stanKsef !== 'brak').map((d) => d.uuid);
        if (zalatwione.length) {
          zwolnijWstrzymane(db, zalatwione, teraz().toISOString());
          for (const u of zalatwione) wstrzymane.delete(u);
        }
        const kandydaci = dokumenty.filter((d) => doZaznaczenia(d) && !wstrzymane.has(d.uuid));
        wynik.wstrzymane.push(...dokumenty.filter((d) => doZaznaczenia(d) && wstrzymane.has(d.uuid))
          .map((d) => ({ uuid: d.uuid, numer: d.number })));
        // Bez numeru KSeF, a poza „zaznacz wszystkie” (korekty, konsumenckie) — do wyniku, z powodem z bariery.
        const zZasady = dokumenty.filter((d) => d?.stanKsef === 'brak' && !doZaznaczenia(d)).map((d) => d.uuid);
        wynik.poZasadzie.push(...coWolnoWyslac(zZasady, dokumenty, czyWysylacKonsumenckie(db), wysylkaKsef.nazwaProgramu).pominiete);
        for (const d of kandydaci) {
          // Wyłączenie w Ustawieniach działa od razu — także między dokumentami jednego przebiegu.
          if (!wczytajAutomatKsef(db).wlaczony) { wynik.stan = 'wylaczony'; break petla; }
          // Dokument „w locie” zapisany PRZED wysyłką: po restarcie w trakcie ekran i ostrzeżenie wskażą, który
          // sprawdzić w inFakcie.
          wynik.wTrakcie = { uuid: d.uuid, numer: d.number };
          zapiszWynikAutomatu(db, wynik, teraz().toISOString());
          const w = await wysylkaKsef.wyslij({ uuids: [d.uuid], miesiac, pole: POLE_DATY_AUTOMATU }, KTO_AUTOMAT);
          wynik.wTrakcie = null;
          dopiszWynik(wynik, w);
          if (w.blad) {
            wynik.blad = w.blad; wynik.stan = 'blad';
            // Jednoznaczna odmowa inFaktu: nic nie poszło i nic nie jest „nie wiadomo” — usługa zdjęła rezerwację,
            // więc bez wstrzymania ta faktura stawałaby jutro pierwsza i znowu zatrzymywała automat.
            if (!w.wyslane?.length && !w.niepewne?.length) {
              wstrzymajFakture(db, { uuid: d.uuid, numer: d.number, dzien: chwila.dzien, powod: w.blad }, teraz().toISOString());
            }
          }
          zapiszWynikAutomatu(db, wynik, teraz().toISOString());
          if (wynik.stan === 'blad') break petla;
        }
      }
    } catch (e) {
      // Wyjątek z `wyslij` pada PRZED wysyłką (lista, rezerwacja, ślad) — dokumentu w locie nie ma.
      wynik.wTrakcie = null;
      wynik.blad = komunikatDlaOperatora(e);
      wynik.stan = 'blad';
      log('automat KSeF: przebieg przerwany —', e instanceof Error ? e.message : String(e));
    }
    if (wynik.stan === 'trwa') wynik.stan = 'ok';
    wynik.koniecAt = teraz().toISOString();
    zapiszWynikAutomatu(db, wynik, wynik.koniecAt);
    log(`automat KSeF (${wynik.dzien}): wysłano ${wynik.wyslane.length}, nie wiadomo ${wynik.niepewne.length}, `
      + `pominięto ${wynik.pominiete.length}${wynik.blad ? `, zatrzymany: ${wynik.blad}` : ''}`);
    return wynik;
  }

  return { przebieg, stan: () => wczytajAutomatKsef(db) };
}
