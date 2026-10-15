// PRZ-060: historyczna mapa wysyłki sklepów właściciela, przeniesiona bajt w bajt z
// src/domena/mapowanie-wysylki.js (linie 25–69 w 80e84f6). Produkcja jej nie czytała — mapę
// instancji daje `<PREFIKS>_MAPOWANIE`. Jawne dane zamrożonych testów; produkcja nie importuje tego pliku.
export * from '../../src/domena/mapowanie-wysylki.js';

// ⚠️⚠️ INSTANCJA 9 NA SZKICOWNIA.PL TO PULAPKA, KTORA KOSZTUJE TOWAR — i potwierdzila sie
// na zywym sklepie 2026-08-01. Nazywa sie „Kurier DPD pobranie", ale jej `method_id` to
// `local_pickup`, czyli w WooCommerce „odbior osobisty". Panel czytajacy RODZAJ metody
// zamiast `instance_id` wyslalby te paczke BEZ pobrania: kurier nie zainkasowalby ani
// zlotowki, a nikt by sie o tym nie dowiedzial.
//
// Instancja 12 („InPost Paczkomat", `easypack_parcel_machines`) doszla 2026-08-01 razem
// z paczkomatami. ⚠️ BEZ POBRANIA: sklep dzis nie sprzedaje paczkomatu za pobraniem
// (a rozpoznanie ShipX nie potwierdza nawet, czy umowa je obejmuje — wszystkie 44 przesylki
// na koncie maja `cod` puste). Wlaczenie tego w WooCommerce bedzie pozniej dopisaniem
// `pobranie: true` w tym jednym wierszu, a nie zmiana w kodzie.
// Instancje 6, 10 i 11 sa w sklepie WYLACZONE.
export const MAPOWANIE_SKLEPOW = {
  pro: {
    // Instancje 1 i 3 to ten sam fizyczny kurier (platny wprost i darmowa dostawa nad
    // progiem 199 zl). Instancja 2 to TEN SAM kurier, tyle ze za pobraniem — stad flaga
    // obok metody, a nie osobna nazwa metody (2026-08-01).
    instancje: { 1: { metoda: 'dpd' }, 2: { metoda: 'dpd', pobranie: true }, 3: { metoda: 'dpd' } },
    // ⚠️ TA REGULA MUSIALA TU DOJSC 21.08.2026 i jest to koszt PRZEPROWADZKI WTYCZKI OFERT
    // na pro.szkicownia.pl (19.08). Do tego dnia stala WYLACZNIE pod `szkicownia` — bo tam stala
    // wtyczka — wiec pierwsze zamowienie z oferty zlozone na PRO (nr 1294) wyladowalo jako
    // „Nieznana metoda": sklep nie daje przy nim ani jednej linii wysylki, a warstwa zapasowa
    // dla PRO byla pusta. Objawilo sie to dopiero na karcie, dwa dni pozniej.
    //
    // Dopasowanie po SKU, nie po nazwie — identycznie jak na szkicownia.pl (patrz nizej). PRO
    // nie sprzedaje dzis paczkomatu, wiec jedynym transportem, ktory moze stac za oferta,
    // jest kurier; gdyby to sie zmienilo, ta tablica jest jedynym miejscem do poprawienia.
    poPozycji: [
      { sku: 'psm-zam-placeholder', metoda: 'dpd' },
    ],
  },
  szkicownia: {
    instancje: {
      3: { metoda: 'dpd' },
      9: { metoda: 'dpd', pobranie: true },
      12: { metoda: 'inpost_paczkomat' },
    },
    poPozycji: [
      // Zamowienie zlozone z OFERTY (panel indywidualny): wysylka jest pozycja, nie metoda.
      // Rozpoznajemy po SKU, nie po nazwie — SKU jest identyfikatorem produktu-zaslepki
      // i nie zmienia sie przy poprawianiu tekstu widocznego dla klienta.
      { sku: 'psm-zam-placeholder', metoda: 'dpd' },
    ],
  },
};
