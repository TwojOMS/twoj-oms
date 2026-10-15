import { kosztyMiesiaca } from '../oms/db/koszty.js';
import { grosze } from './kwoty.js';

// Wskazniki, ktore oglada sie co miesiac (spec §8.4). Modul jest CZYSTY poza jedna funkcja,
// ktora musi siegnac do bazy po dokumenty prowizyjne — z powodu opisanego nizej.

const NIP_ALLEGRO = '5252674798';
const OBSLUGA = ['Prowizje sprzedażowe', 'Kurierzy', 'Opakowania'];

export function wskazniki({ kategorie, przychodNettoGrosze, zamowien }) {
  const suma = (typ) => (kategorie ?? [])
    .filter((k) => k.typ === typ)
    .reduce((s, k) => s + k.nettoGrosze, 0);

  // ⚠️ „drobne" to TRZECI typ i celowo nie wchodzi ani do stalych, ani do zmiennych —
  // to koszty, ktorych nie umiemy przypisac. Doliczenie ich do stalych podnioslby prog
  // rentownosci o kwote, ktora moze byc czymkolwiek.
  const kosztyStaleGrosze = suma('staly');
  const kosztyZmienneGrosze = suma('zmienny');

  if (!przychodNettoGrosze) {
    return {
      kosztyStaleGrosze,
      kosztyZmienneGrosze,
      marzaPoZmiennych: null,
      progRentownosciGrosze: null,
      kosztObslugiGrosze: null,
    };
  }

  const marzaPoZmiennych = ((przychodNettoGrosze - kosztyZmienneGrosze) / przychodNettoGrosze) * 100;
  const obsluga = (kategorie ?? [])
    .filter((k) => OBSLUGA.includes(k.kategoria))
    .reduce((s, k) => s + k.nettoGrosze, 0);

  return {
    kosztyStaleGrosze,
    kosztyZmienneGrosze,
    marzaPoZmiennych,
    // Prog rentownosci: ile trzeba sprzedac, zeby pokryc koszty stale.
    // ⚠️ Marza po zmiennych <= 0 znaczy, ze kazda sprzedaz doklada do interesu — progu
    // wtedy NIE MA i `null` jest jedyna uczciwa odpowiedzia (dzielenie daloby liczbe ujemna,
    // ktora wygladalaby jak bardzo dobry wynik).
    progRentownosciGrosze: marzaPoZmiennych > 0
      ? Math.round(kosztyStaleGrosze / (marzaPoZmiennych / 100))
      : null,
    kosztObslugiGrosze: zamowien ? Math.round(obsluga / zamowien) : null,
  };
}

/**
 * Prowizje Allegro ZA WSKAZANY MIESIAC.
 *
 * ⚠️⚠️ FAKTURA PROWIZYJNA DOTYCZY MIESIACA POPRZEDNIEGO: dokument wystawiony 01.06.2026 ma
 * w numerze `/2026/05`. Liczenie po dacie wystawienia dawaloby wskaznik „prowizja / sprzedaz",
 * w ktorym licznik i mianownik pochodza z DWOCH ROZNYCH MIESIECY — i wychodzilby wiarygodnie.
 *
 * Dlatego okres rozstrzyga NUMER dokumentu, a dokumentow szukamy w miesiacu docelowym
 * ORAZ w nastepnym. Numer bez rozpoznawalnego okresu liczy sie do miesiaca wystawienia —
 * lepiej przypisac go zachowawczo niz zgubic.
 */
export function prowizjaAllegroZaMiesiac(db, miesiac) {
  const [rok, mm] = miesiac.split('-');
  const nastepny = new Date(Date.UTC(Number(rok), Number(mm), 1)).toISOString().slice(0, 7);
  const wzorzecOkresu = new RegExp(`/${rok}/${mm}(?!\\d)`);
  const wzorzecJakiegokolwiek = /\/(\d{4})\/(\d{2})(?!\d)/;

  const kandydaci = [...kosztyMiesiaca(db, miesiac), ...kosztyMiesiaca(db, nastepny)]
    .filter((k) => String(k.sprzedawca_nip ?? '').replace(/\D/g, '') === NIP_ALLEGRO);

  const wybrane = kandydaci.filter((k) => {
    const numer = String(k.numer_dokumentu ?? '');
    if (wzorzecOkresu.test(numer)) return true;
    // Bez rozpoznawalnego okresu — zostaje przy swoim miesiacu wystawienia.
    return !wzorzecJakiegokolwiek.test(numer)
      && String(k.data_wystawienia ?? '').slice(0, 7) === miesiac;
  });

  return {
    nettoGrosze: wybrane.reduce((s, k) => s + grosze(k.netto, 'prowizja'), 0),
    dokumentow: wybrane.length,
  };
}
