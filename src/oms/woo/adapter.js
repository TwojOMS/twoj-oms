import { mapujZamowienie } from '../../domena/mapowanie.js';

// Adapter kanalu dla WooCommerce. Powstal, gdy do panelu doszlo Allegro (Etap 4): reguly
// pollera — podloga po dacie zlozenia, jeden przebieg naraz, kursor za najpozniejsza
// PRZETWORZONA modyfikacja — musialy zostac JEDNE. Druga kopia tych regul rozjechalaby sie
// po cichu, a ich pierwsza wersja wciagnela kilka tysiecy zamowien i przebieg
// zwielokrotniajacy sam siebie.
//
// ⚠️ `date_modified_gmt`, NIE `date_modified`. Czas lokalny sklepu cofa sie o godzine przy
// przejsciu na czas zimowy, wiec kursor zapisany z wartosci lokalnej zostalby godzine
// „przed" i zamowienia zmienione po zmianie czasu NIE WROCILYBY w zadnym kolejnym oknie.
/** @param {import('../../integracje/opcje.ts').OpcjeAdapteraWoo} opcje */
export function createWooAdapter({ woo, mapowanie }) {
  return {
    // Poller podaje DWIE rozne rzeczy i adapter musi je rozrozniac:
    //   `kursor` — ZAPISANY kursor pollera (najpozniejsza przetworzona `date_modified_gmt`).
    //              Jest `null`, dopoki pollera dla tego sklepu jeszcze nie bylo.
    //   `od`     — trwala podloga po dacie ZLOZENIA, ta sama w kazdym przebiegu.
    // Poller ich NIE skleja, bo adapter, ktory wybiera miedzy nimi, musi widziec prawdziwy
    // brak kursora — inaczej na pustym stanie nie odroznilby „pierwszy przebieg" od „mam
    // kursor" i zapytal o cale archiwum (to jest awaria z 01.08.2026, tyle ze na Allegro).
    // Woo takiego wyboru nie robi: pyta zawsze po dacie modyfikacji, wiec sam robi `?? od`.
    // Kursor ma pierwszenstwo nad `od`: po pierwszym udanym przebiegu data startowa nie ma
    // juz nic do powiedzenia, bo cofnelaby okno do przeczytanych zamowien. Podloge po dacie
    // ZLOZENIA i tak egzekwuje poller (`zeStarego`), niezaleznie od tego zapytania.
    pobierzStrone: ({ kursor, od, strona }) => woo.pobierzZamowienia({ modifiedAfter: kursor ?? od, page: strona }),
    kursorZ: (surowe) => surowe.date_modified_gmt ?? null,
    zlozoneZ: (surowe) => surowe.date_created_gmt || surowe.date_created || null,
    mapuj: (surowe) => mapujZamowienie(surowe, mapowanie),
  };
}
