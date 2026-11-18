// PRZECIĄGANIE PLIKU w sekcji „Logo” (Ustawienia → Firma).
//
// Strefa (`[data-logo-strefa]`) obejmuje zwykłe pole `<input type="file" name="logo">`. Upuszczony plik trafia do
// TEGO SAMEGO pola (przez DataTransfer), więc formularz wysyła go dokładnie tak jak plik wybrany z dysku — zapis
// logo na serwerze się nie zmienia. Bez tego skryptu formularz działa jak dotąd (pole pliku, klawiatura, Zapisz).
//
// Serwer i tak sprawdza typ (sygnatura PNG) i rozmiar (src/core/web/logo-instalacji.js: MAKS_LOGO). Przeglądarka
// tylko mówi o błędzie OD RAZU: wskazanie złego pliku nie wymaga wysyłki i powrotu na ekran z odmową.
// Przeglądarka widzi typ z nazwy pliku, nie z jego bajtów — to kontrola dla wygody, nie dla bezpieczeństwa.
//
// Mechanika strefy jest wspólna (strefa-pliku.js, też dla zdjęć karty); tu zostają parametry logo.

// Wspólny moduł idzie z TĄ SAMĄ wersją (`?v=`) co ten skrypt (widok daje go przez zasob()). Statyczny import
// './strefa-pliku.js' szedłby bez wersji i pośrednik (Cloudflare, max-age=14400) po wydaniu dałby stary moduł.
export const adresStrefy = (adresSkryptu) =>
  new URL(`strefa-pliku.js${new URL(adresSkryptu).search}`, adresSkryptu).href;
const { podlaczStrefePliku, sprawdzPlik: sprawdzPlikStrefy } = await import(adresStrefy(import.meta.url));

export const MAKS_BAJTOW = 256 * 1024;

const OPCJE_LOGO = {
  typy: ['image/png'],
  rozszerzenia: /\.png$/i,
  maksBajtow: MAKS_BAJTOW,
  wiele: false,
  selStan: '[data-logo-stan]',
  selPodglad: '[data-logo-podglad]',
  klasaNad: 'logo-strefa--nad',
  komunikaty: {
    brak: 'Wybierz plik PNG.',
    zlyTyp: () => 'Plik musi być obrazem PNG. SVG i inne formaty nie są obsługiwane.',
    zaDuzy: (plik) => `Plik jest większy niż 256 KB (${Math.ceil(plik.size / 1024)} KB).`,
    kilka: 'Upuszczono kilka plików. Wybierz jeden plik PNG.',
    nieObraz: 'Ten plik nie wygląda na obraz PNG, którego przeglądarka może użyć. Wybierz inny.',
  },
};

/** Komunikat po polsku albo `null`, gdy plik wygląda na dobry. */
export const sprawdzPlik = (plik) => sprawdzPlikStrefy(plik, OPCJE_LOGO);

export const podlaczStrefe = (strefa, srodowisko) => podlaczStrefePliku(strefa, OPCJE_LOGO, srodowisko);

if (typeof document !== 'undefined') {
  for (const strefa of document.querySelectorAll('[data-logo-strefa]')) podlaczStrefe(strefa);
}
