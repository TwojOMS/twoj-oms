// PIATY ZEGAR — DANE KAMPANII ZE ZRODEL ZEWNETRZNYCH (Etapy 1-2, 2026-08-25).
//
// Raz na godzine dociaga do lustra w bazie: wydatki reklamowe z Meta (Etap 1) i ruch
// sklepu z GA4 (Etap 2), dzien po dniu, dla kampanii, ktore TRWAJA albo skonczyly sie
// niedawno. Ekran /kampania czyta WYLACZNIE lustro — dokladnie ta sama zasada, co przy
// kosztach z KSeF: panel nie ma prawa wisiec na dostepnosci Google ani Facebooka,
// a zamowienia i paczki nie moga zalezec od tego, czy dziala pomiar marketingu.
//
// ⚠️⚠️ KAZDE ZRODLO W OSOBNYM `try` I Z OSOBNYM STANEM. Wygasly klucz Google nie ma prawa
// zabrac ekranowi wydatkow z Mety (ani odwrotnie) — to dwa niezalezne pomiary jednej
// kampanii, a nie jeden potok. Blad jednego zrodla LADUJE W BAZIE (`kampania_zrodla`),
// zeby ekran umial odroznic „reklama nic nie wydala" od „od trzech dni nie dalo sie
// zapytac": w tabeli oba wygladaja jak zera.
//
// ⚠️ OKNO ODSWIEZANIA TO CALA KAMPANIA, NIE SAM DZISIAJ. Statystyki dnia dojrzewaja
// jeszcze przez dobe (Meta domyka wydatki, GA4 dolicza sesje), a przy 15-dniowej kampanii
// to i tak jedno zapytanie na zrodlo. Zapis idzie przez `ON CONFLICT DO UPDATE`, wiec
// dojrzale liczby nadpisuja wczesniejsze.

import { listaKampanii, zapiszMetaDzien, zapiszGa4Dzien, zapiszStanZrodla } from '../../../oms/db/kampanie.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';

// Ile dni PO koncu kampanii jeszcze ja odswiezamy. Dwa, bo tyle mniej wiecej dojrzewaja
// liczby obu zrodel; potem kampania jest zamknieta i jej wiersze sa juz historia.
export const DNI_DOJRZEWANIA = 2;

// Najgorszy przebieg: dwa zrodla, kilka zapytan kazde, przy zerwanej sieci wchodzi limit
// czasu `fetch`. Trzymamy to jawnie, bo bootstrap sprawdza, czy przebieg mieści się
// w odstepie zegara (ta sama bariera, co przy czuwaczu KSeF i kosztow).
export const NAJDLUZSZY_PRZEBIEG_KAMPANII_MS = 5 * 60 * 1000;

const dzienPo = (dzien, ile) => new Date(Date.parse(`${dzien}T00:00:00Z`) + ile * 86_400_000)
  .toISOString().slice(0, 10);

/**
 * Kampanie, ktore warto dzis odswiezac: juz sie zaczely i nie skonczyly dawniej niz
 * `DNI_DOJRZEWANIA` temu. Kampania sprzed miesiaca ma liczby zamkniete — pytanie o nia
 * co godzine to czysty ruch bez tresci.
 */
export function kampanieDoOdswiezenia(kampanie, dzis) {
  return kampanie.filter((k) => k.od_dnia <= dzis && dzis <= dzienPo(k.do_dnia, DNI_DOJRZEWANIA));
}

export function createCzuwaczKampanii({ db, meta = null, ga4 = null, teraz = () => new Date() }) {
  let trwa = false;

  async function zrodlo(nazwa, praca) {
    try {
      const dni = await praca();
      zapiszStanZrodla(db, nazwa, {});
      return { dni };
    } catch (e) {
      // ⚠️ Powod ZAPISANY, nie tylko zalogowany: log w kontenerze przewija sie po dobie,
      // a „skad te zera" pyta sie tydzien pozniej, przy podsumowaniu kampanii.
      zapiszStanZrodla(db, nazwa, { blad: e.message });
      return { blad: e.message };
    }
  }

  async function przebieg() {
    // Straznik „jeden przebieg naraz" — ta sama zasada, co w czuwaczach KSeF i kosztow:
    // przebieg dluzszy niz odstep zegara nie moze nawarstwiac rownoleglych petli.
    if (trwa) return { pominiety: true };
    trwa = true;
    try {
      const dzis = dzienWarszawa(teraz().toISOString());
      const kampanie = kampanieDoOdswiezenia(listaKampanii(db), dzis);
      const wynik = { kampanii: kampanie.length, meta: null, ga4: null };
      if (!kampanie.length) return wynik;

      for (const k of kampanie) {
        // Koniec okna to DZIS, gdy kampania trwa — pytanie o przyszlosc nie ma sensu
        // i Meta odmawia calego zapytania przy dacie „until" z przyszlosci.
        const doDnia = dzis < k.do_dnia ? dzis : k.do_dnia;

        if (meta) {
          // eslint-disable-next-line no-await-in-loop -- kampanie po kolei, jak poller po sklepach
          const w = await zrodlo('meta', async () => {
            const kampanieReklamowe = String(k.meta_kampanie ?? '').split(',').map((s) => s.trim()).filter(Boolean);
            const dni = await meta.dzienneStatystyki({ od: k.od_dnia, do: doDnia, kampanie: kampanieReklamowe });
            for (const d of dni) zapiszMetaDzien(db, k.kod, d);
            return dni.length;
          });
          wynik.meta = w;
        }

        // ⚠️ Brak wlasciwosci przy kampanii to NIE JEST awaria — to kampania, ktorej nikt
        // nie kazal mierzyc w GA4 (np. czysto allegrowa). Cisza, a nie wpis o bledzie:
        // czerwony pasek przy kazdym przebiegu nauczylby operatora go ignorowac.
        if (ga4 && k.ga4_wlasciwosc) {
          // eslint-disable-next-line no-await-in-loop -- jak wyzej
          const w = await zrodlo('ga4', async () => {
            const dni = await ga4.dzienneStatystyki({
              wlasciwosc: k.ga4_wlasciwosc, od: k.od_dnia, do: doDnia, sciezkaPromo: k.ga4_sciezka ?? null,
            });
            for (const d of dni) zapiszGa4Dzien(db, k.kod, d);
            return dni.length;
          });
          wynik.ga4 = w;
        }
      }
      return wynik;
    } finally {
      trwa = false;
    }
  }

  return { przebieg };
}
