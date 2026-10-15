import { wierszHistorii, decyzja } from '../../../domena/historia-sklepu.js';
import {
  zapiszHistorie, sufitZApilo, kursorSklepu, zapiszKursorSklepu,
} from '../../../oms/db/historia-sprzedazy.js';

// Jednorazowy import historii sprzedazy ze sklepu WooCommerce.
//
// ⚠️ TO NIE JEST CZUWACZ I NIE MA NIM ZOSTAC. Historia jest niezmienna, a poller ma wlasna
// podloge (`<PREFIKS>_OD`) postawiona dokladnie po to, zeby panel NIE czytal archiwum:
// pierwszy przebieg bez niej wciagnal 01.08.2026 osiem tysiecy zamowien i nie zdazyl sie
// skonczyc miedzy dwoma tyknieniami zegara.

/** Dzien +/- n dni, na napisach `RRRR-MM-DD`. */
function przesunDzien(dzien, n) {
  const d = new Date(`${dzien}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function createImportSklepu({ db, sklep, klient, konfiguracja, log = () => {} }) {
  if (!konfiguracja?.konta?.has(sklep)) throw new Error(`Brak jawnej konfiguracji historii sklepu "${sklep}".`);
  async function przebieg({ od, doDnia, sonda = false }) {
    const licznik = {
      pobranych: 0, pominietych: 0, testowych: 0, stron: 0, razem: 0,
      zatrzymany: false, powod: null, statusy: {}, lata: {}, waluty: {},
    };

    // ⚠️ SUFIT SPRAWDZAMY PRZED PIERWSZYM ZAPYTANIEM DO SKLEPU, nie przy zapisie: przebieg,
    // ktory czyta 86 stron i dopiero potem odmawia, kosztuje kwadrans i nic nie tlumaczy.
    const sufit = sufitZApilo(db, konfiguracja.konta.get(sklep));
    if (!sonda) {
      if (!sufit) {
        throw new Error(
          'Era Apilo jest pusta (brak wierszy skonfigurowanego konta w `sprzedaz_historyczna`), wiec nie ma'
          + ' czym zmierzyc sufitu importu. Zaimportuj najpierw historie z Apilo.',
        );
      }
      if (doDnia >= sufit) {
        throw new Error(
          `Sufit importu to ${przesunDzien(sufit, -1)} — od ${sufit} sprzedaz sklepowa jest`
          + ' juz w historii z Apilo i wciagnieta drugi raz policzylaby sie PODWOJNIE.',
        );
      }
    }

    // ⚠️ OKNO JEST CZESCIA KURSORA (patrz schema.sql). Kursor z innego okna nie mowi nic
    // o tym przebiegu — numer strony ma sens wylacznie w zbiorze, w ktorym go policzono.
    const k = kursorSklepu(db, sklep);
    let strona = (k && k.odDnia === od && k.doDnia === doDnia ? k.ostatniaStrona : 0) + 1;

    // Granice z zapasem doby: filtr Woo jedzie w GMT i jest OSTRY po obu stronach, a my
    // kubelkujemy po dobie WARSZAWSKIEJ. Wlasciwe odciecie robi `dzien` nizej.
    const after = `${przesunDzien(od, -1)}T00:00:00`;
    const before = `${przesunDzien(doDnia, 2)}T00:00:00`;

    let stron = 1;
    do {
      // eslint-disable-next-line no-await-in-loop
      const { zamowienia, stron: ile, razem } = await klient.pobierzZamowieniaZakresu({ after, before, page: strona });
      stron = ile;
      licznik.razem = razem;

      for (const z of zamowienia) {
        licznik.statusy[z.status] = (licznik.statusy[z.status] ?? 0) + 1;
        licznik.waluty[z.currency] = (licznik.waluty[z.currency] ?? 0) + 1;

        const w = wierszHistorii(sklep, z, konfiguracja);
        licznik.lata[w.dzien.slice(0, 4)] = (licznik.lata[w.dzien.slice(0, 4)] ?? 0) + 1;

        if (w.dzien < od || w.dzien > doDnia) { licznik.pominietych += 1; continue; }

        const d = decyzja(z, konfiguracja);
        if (d.akcja === 'stop') {
          // ⚠️ ZATRZYMANIE, NIE WYJATEK: to, co juz zapisane, ma zostac zapisane, a operator
          // ma zobaczyc POWOD i numer zamowienia, a nie stos wywolan.
          licznik.zatrzymany = true;
          licznik.powod = d.powod;
          break;
        }
        if (d.akcja === 'pomin') {
          if (d.powod === 'testowe') licznik.testowych += 1;
          else licznik.pominietych += 1;
          continue;
        }
        if (sonda) { licznik.pobranych += 1; continue; }
        zapiszHistorie(db, w);
        licznik.pobranych += 1;
      }

      licznik.stron = strona;
      // ⚠️ Kursor zapisuje sie PO KAZDEJ STRONIE, a nie na koncu przebiegu: import 86 stron
      // przerwany na 60. ma wznowic sie od 61., a nie od pierwszej.
      if (!sonda) zapiszKursorSklepu(db, { sklep, odDnia: od, doDnia, ostatniaStrona: strona });
      if (licznik.zatrzymany) break;
      log(`strona ${strona}/${stron}: zapisanych ${licznik.pobranych}`);
      strona += 1;
    } while (strona <= stron);

    if (!sonda && !licznik.zatrzymany) {
      zapiszKursorSklepu(db, {
        sklep, odDnia: od, doDnia, ostatniaStrona: licznik.stron,
        zakonczonyAt: new Date().toISOString(),
      });
    }
    if (!sonda && licznik.zatrzymany) {
      // ⚠️ COFAMY KURSOR O STRONE. Zatrzymanie nastapilo W SRODKU strony, wiec zapisanie jej
      // jako „przerobionej" kazaloby wznowieniu przeskoczyc zamowienia stojace za tym, ktore
      // przebieg zatrzymalo. Powtorzenie strony jest darmowe (zapis jest idempotentny),
      // przeskoczenie jej kosztuje ciche braki w sprzedazy.
      zapiszKursorSklepu(db, {
        sklep, odDnia: od, doDnia, ostatniaStrona: Math.max(0, licznik.stron - 1), blad: licznik.powod,
      });
    }
    return licznik;
  }

  return { przebieg };
}
