import { wczytajKonfiguracjeIntegracji } from '../../oms/db/konfiguracja-integracji.js';

export const MAKS_LOGO = 256 * 1024;
const SYGNATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const czyPng = bajty => bajty.subarray(0, 8).equals(SYGNATURA_PNG);

// Plik czytany raz przy starcie jak dotąd; zapis z panelu czytany przy każdym użyciu.
// Cache bajtów pozwala przeliczać odcisk zasobów tylko po zmianie obrazu.
export function logoInstalacji(db, { bajty = null, alt = '', wPliku = false } = {}) {
  const maTabele = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='konfiguracja_integracji'").get());
  // Strona woła `zasob()` kilka razy, a zapis to do ~350 KB base64 w JSON-ie: najpierw sama chwila zmiany
  // (jedno małe zapytanie), pełny odczyt tylko wtedy, gdy się różni.
  const chwilaZmiany = maTabele ? db.prepare("SELECT zmieniono_at FROM konfiguracja_integracji WHERE integracja = 'logo'") : null;
  let ostatniaChwila;
  let ostatnie = { bajty: null, alt, zapis: null };
  return {
    wPliku,
    biezace() {
      if (wPliku) return { bajty, alt, zapis: null };
      const chwila = chwilaZmiany?.get()?.zmieniono_at ?? null;
      if (chwila === ostatniaChwila) return ostatnie;
      ostatniaChwila = chwila;
      const zapis = chwila ? wczytajKonfiguracjeIntegracji(db, 'logo') : null;
      const png = zapis?.ustawienia.png ?? null;
      ostatnie = { bajty: png ? Buffer.from(png, 'base64') : null, alt: zapis?.ustawienia.alt ?? alt,
        zapis: zapis ? { kontoLogin: zapis.kontoLogin, zmienionoAt: zapis.zmienionoAt } : null };
      return ostatnie;
    },
  };
}
