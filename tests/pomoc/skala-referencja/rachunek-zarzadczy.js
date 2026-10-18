// Referencja PRZ-094.13 z 9ccdd75, przed optymalizacją.
import { sprzedazWOkresie, zwrotyWOkresie } from './sprzedaz-okresu.js';
import { miesiaceOkresu, nazwaOkresu } from '../../../src/domena/okresy-raportu.js';
import { podatekNarastajaco } from '../../../src/domena/podatek-skala.js';
import { wskazniki, prowizjaAllegroZaMiesiac } from '../../../src/domena/wskazniki-zarzadcze.js';
import { kategoriaWiersza } from '../../../src/domena/lista-kosztow.js';
import { daneOkresu } from '../../../src/oms/db/dane-miesieczne.js';
import { kosztyMiesiaca } from '../../../src/oms/db/koszty.js';
import { kategoriaDlaNip } from '../../../src/oms/db/kategorie-kosztow.js';
import { grosze } from '../../../src/domena/kwoty.js';

export const PODLOGA = null;

export const PODLOGA_ZWROTOW = null;

const PROG_POKRYCIA = 95;

const gr = (s) => (s ? grosze(s, 'kwota') : 0);

const sumaNetto = (wiersze) => wiersze.reduce((s, w) => s + w.nettoGrosze, 0);

function kosztyOkresu(db, miesiace) {
  let netto = 0;
  const wgKategorii = new Map();
  const poNipie = (nip) => kategoriaDlaNip(db, nip);
  for (const m of miesiace) {
    for (const k of kosztyMiesiaca(db, m)) {
      const n = gr(k.netto);
      netto += n;
      const przypisanie = kategoriaWiersza(k, poNipie);
      const nazwa = przypisanie?.kategoria ?? 'Nieprzypisane';
      const typ = przypisanie?.typ ?? 'drobne';
      const b = wgKategorii.get(nazwa) ?? { kategoria: nazwa, typ, nettoGrosze: 0, dokumentow: 0 };
      b.nettoGrosze += n;
      b.dokumentow += 1;
      wgKategorii.set(nazwa, b);
    }
  }
  return {
    nettoGrosze: netto,
    kategorie: [...wgKategorii.values()].sort((a, b) => b.nettoGrosze - a.nettoGrosze),
  };
}

const koniecMiesiaca = (miesiac) => new Date(
  Date.UTC(Number(miesiac.slice(0, 4)), Number(miesiac.slice(5, 7)), 0),
).toISOString().slice(0, 10);

function rachunekMiesiaca(db, miesiac, regulySprzedazy) {
  const od = `${miesiac}-01`;
  const doDnia = koniecMiesiaca(miesiac);
  const zwrotyNetto = sumaNetto(zwrotyWOkresie(db, { od, do: doDnia }, regulySprzedazy));
  const przychod = sumaNetto(sprzedazWOkresie(db, { od, do: doDnia }, regulySprzedazy)) - zwrotyNetto;
  const koszty = kosztyOkresu(db, [miesiac]).nettoGrosze;
  const { miesiace: [dane] = [] } = daneOkresu(db, [miesiac]);
  const zus = gr(dane?.zus_razem);
  const pit5 = gr(dane?.pit5_zaplacony);
  const wynik = przychod - koszty;
  return {
    miesiac,
    przychodNettoGrosze: przychod,
    kosztyNettoGrosze: koszty,
    wynikGrosze: wynik,
    zusGrosze: zus,
    pit5Grosze: pit5,
    zostajeGrosze: dane ? wynik - zus - pit5 : null,
    marza: przychod ? (wynik / przychod) * 100 : 0,
  };
}

export function rachunekOkresu(db, { od, do: doDnia }, { regulySprzedazy = {}, podlogaKosztow = null } = {}) {
  if (!podlogaKosztow) { const e = new Error(BRAK_PODLOGI_KOSZTOW); e.dlaOperatora = true; throw e; }
  if (od.slice(0, 7) < podlogaKosztow) {
    const e = new Error(
      `Rachunek zarządczy zaczyna się od ${podlogaKosztow}: kosztów sprzed KSeF panel nie zna,`
      + ' więc wcześniejszy wynik byłby zyskiem zawyżonym o niewidoczne wydatki.',
    );
    e.dlaOperatora = true;
    throw e;
  }

  const miesiace = miesiaceOkresu({ od, do: doDnia });
  const pelnyMiesiac = /^\d{4}-\d{2}$/.test(nazwaOkresu({ od, do: doDnia })) ? miesiace[0] : null;
  const pelneMiesiace = od.endsWith('-01') && doDnia === koniecMiesiaca(miesiace.at(-1));
  const wiersze = sprzedazWOkresie(db, { od, do: doDnia }, regulySprzedazy);
  const zwroty = zwrotyWOkresie(db, { od, do: doDnia }, regulySprzedazy);
  const zwrotyNettoGrosze = sumaNetto(zwroty);
  const przychodNettoGrosze = sumaNetto(wiersze) - zwrotyNettoGrosze;
  const koszty = kosztyOkresu(db, miesiace);
  const dane = daneOkresu(db, miesiace);

  const wynikGrosze = przychodNettoGrosze - koszty.nettoGrosze;
  const zostajeGrosze = dane.brakujace.length
    ? null
    : wynikGrosze - dane.suma.zusRazemGrosze - dane.suma.pit5Grosze;

  const kpirKoszty = dane.suma.kpirKosztyGrosze;
  const pokrycieKosztow = kpirKoszty
    ? (koszty.nettoGrosze / kpirKoszty) * 100
    : null;
  const kosztyZnane = pokrycieKosztow === null ? true : pokrycieKosztow >= PROG_POKRYCIA;

  const kpirPrzychod = dane.suma.kpirPrzychodGrosze;
  const roznicaPrzychodu = kpirPrzychod ? {
    kpirGrosze: kpirPrzychod,
    roznicaGrosze: przychodNettoGrosze - kpirPrzychod,
    procent: ((przychodNettoGrosze - kpirPrzychod) / kpirPrzychod) * 100,
  } : null;

  const rok = doDnia.slice(0, 4);
  const odStycznia = miesiaceOkresu({ od: `${rok}-01-01`, do: doDnia });
  const daneRoku = daneOkresu(db, odStycznia);
  const zwrotyRokuNettoGrosze = sumaNetto(zwrotyWOkresie(db, { od: `${rok}-01-01`, do: doDnia }, regulySprzedazy));
  const dochodRoku = sumaNetto(sprzedazWOkresie(db, { od: `${rok}-01-01`, do: doDnia }, regulySprzedazy))
    - zwrotyRokuNettoGrosze - kosztyOkresu(db, odStycznia).nettoGrosze;
  const podatek = podatekNarastajaco({
    dochodGrosze: dochodRoku,
    spoleczneGrosze: daneRoku.suma.zusSpoleczneGrosze,
  });

  const prowizjaAllegro = pelnyMiesiac ? prowizjaAllegroZaMiesiac(db, pelnyMiesiac) : null;
  const sprzedazAllegroGrosze = wiersze
    .filter((w) => w.kanal.startsWith('ALLEGRO_'))
    .reduce((s, w) => s + w.nettoGrosze, 0);

  return {
    od,
    do: doDnia,
    pelneMiesiace,
    przychodNettoGrosze,
    zwrotyNettoGrosze,
    kosztyNettoGrosze: koszty.nettoGrosze,
    wynikGrosze,
    marza: przychodNettoGrosze ? (wynikGrosze / przychodNettoGrosze) * 100 : 0,
    zusGrosze: dane.suma.zusRazemGrosze,
    pit5Grosze: dane.suma.pit5Grosze,
    zostajeGrosze,
    vatGrosze: dane.suma.vat7Grosze,
    zwrotyGrosze: dane.suma.zwrotyGrosze,
    brakujaceDane: dane.brakujace,
    pokrycieKosztow,
    kosztyZnane,
    kategorie: kosztyZnane ? koszty.kategorie : null,
    roznicaPrzychodu,
    podatek,
    miesiacami: miesiace.length >= 2 ? miesiace.map((m) => rachunekMiesiaca(db, m, regulySprzedazy)) : null,
    wskazniki: kosztyZnane
      ? wskazniki({
        kategorie: koszty.kategorie,
        przychodNettoGrosze,
        zamowien: wiersze.length,
      })
      : null,
    prowizjaAllegro,
    sprzedazAllegroGrosze,
    udzialProwizjiAllegro: prowizjaAllegro && sprzedazAllegroGrosze
      ? (prowizjaAllegro.nettoGrosze / sprzedazAllegroGrosze) * 100
      : null,
  };
}

const BRAK_PODLOGI_KOSZTOW = 'Nie ustawiono podłogi danych kosztów rachunku zarządczego.'
  + ' Wpisz w pliku konfiguracji OMS (oms.env) linię OMS_RAPORTY_PODLOGA_KOSZTOW=RRRR-MM, np. 2026-05:'
  + ' pierwszy miesiąc, od którego koszty firmy w OMS-ie (faktury kosztowe z KSeF i koszty dopisane ręcznie)'
  + ' są kompletne — i uruchom OMS ponownie. Rachunek pokaże wynik od tego miesiąca; wcześniejszych nie policzy,'
  + ' bo bez części kosztów zysk wyszedłby zawyżony.';
