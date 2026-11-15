import { sprzedazWOkresieAsync } from '../../../domena/sprzedaz-okresu.js';
import { agreguj } from '../../../domena/agregacja-sprzedazy.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { zl } from '../../../domena/kwoty.js';
import { indeksListy } from '../../../oms/db/indeks-listy.js';

// PRZ-167 (właściciel 15.11): ANALITYKA — ekran wejściowy pozycji „Analityka” w menu bocznym. Podsumowanie DZISIEJSZEJ
// sprzedaży i odnośniki do podstron (Raporty, Statystyki, Reklamy, Finanse).
//
// ⚠️ TRASA NICZEGO NIE LICZY PO SWOJEMU — każda liczba ma już źródło gdzie indziej i musi się z nim zgadzać:
// - zamówienia i kwota dziś: `sprzedazWOkresie` + `agreguj`, czyli to samo co RAPORTY → „Dzisiaj”
//   (bez anulowanych i testowych);
// - w realizacji: licznik statusu „W realizacji” z indeksu listy zamówień (ta sama liczba co przy statusie w menu);
// - wysłane dziś: `wyslane_at` w dniu warszawskim — „Wysłane” jest statusem ustawianym przy wyjeździe paczki
//   (domena/status.js), nie przy wydruku etykiety.

const dzisiaj = () => dzienWarszawa(new Date().toISOString());

function wyslaneDzis(db, dzis) {
  // Okno SQL z zapasem dwóch dób (UTC kontra Warszawa), dzień rozstrzyga `dzienWarszawa`.
  const od = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  return db.prepare('SELECT wyslane_at FROM zamowienia WHERE wyslane_at >= ? AND anulowane = 0').all(od)
    .filter((w) => dzienWarszawa(w.wyslane_at) === dzis).length;
}

async function wRealizacji(db, req) {
  try {
    const teraz = Date.now();
    const indeks = indeksListy(db);
    await indeks.odswiez(teraz);
    return indeks.liczniki(teraz).statusy.w_realizacji ?? 0;
  } catch (e) {
    // Bez indeksu (baza bez migracji listy) kafel mówi „—”, a reszta ekranu się otwiera.
    req.log?.error?.(e, 'analityka: licznik „W realizacji” niepoliczony');
    return null;
  }
}

export function zarejestrujTrasyAnalityki(app, { db, config }) {
  app.get('/analityka', async (req, reply) => {
    const dzis = dzisiaj();
    let sprzedaz = null;
    let bladSprzedazy = null;
    try {
      const wiersze = await sprzedazWOkresieAsync(db, { od: dzis, do: dzis }, config.regulySprzedazy);
      const { kpi } = agreguj(wiersze);
      sprzedaz = { zamowien: kpi.zamowien, brutto: zl(kpi.bruttoGrosze) };
    } catch (e) {
      if (!e?.dlaOperatora) throw e;
      bladSprzedazy = e.message;
    }
    return reply.view('analityka.ejs', {
      title: 'Analityka',
      dzis,
      sprzedaz,
      bladSprzedazy,
      wyslane: wyslaneDzis(db, dzis),
      wRealizacji: await wRealizacji(db, req),
    });
  });
}
