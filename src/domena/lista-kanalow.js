// Listę dostarcza konfiguracja instancji; pusty zakres jest świadomą konfiguracją.
export function wymagajListyKanalow(lista) {
  if (!Array.isArray(lista)) throw new TypeError('Wymagana lista kanałów jako tablica');
}
