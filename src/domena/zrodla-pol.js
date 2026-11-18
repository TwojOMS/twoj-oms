// Źródła pól karty i reguła ochrony przed importem treści z kanału.
//
// Tabela `karty_zrodla_pol` (migracja rdzen/0012) mówi, skąd przyszła wartość pola karty.
// Import treści (z Allegro i ze sklepu) pyta tę funkcję przed KAŻDYM polem.
//
// ⚠️ REGUŁA: wiersz źródła z `reczne = 1` chroni pole zawsze, także puste (ktoś je celowo
// wyczyścił). Poza tym import zapisuje pole tylko wtedy, gdy kolumna jest PUSTA albo pole ma wiersz
// źródła z `reczne = 0` (wartość wcześniej przyniesiona przez import). Niepusta kolumna BEZ
// wiersza źródła jest chroniona tak samo jak `zastane`: piszą ją dziś edycja hurtem
// (`zastosujHurtem`), nadanie SKU i starsze wydania — żadne z nich nie zostawia
// wiersza źródła, a każde to decyzja człowieka.

// Wymiary i waga: 0 i mniej to brak (rozmiar.js oddaje dla nich null). Cena 0 zł to wartość.
export const POLA_DODATNIE = ['szerokosc_mm', 'wysokosc_mm', 'glebokosc_mm', 'waga_g'];

// Pola treści, które migracja 0012 oznaczyła jako `zastane` (gdy niepuste). Bez `paczkomat`
// (decyzja OMS-u, nie treść kanału) i `wycofana` (stan karty).
export const POLA_ZASTANE = [
  'nazwa',
  'sku',
  'opis',
  'kategoria_glowna',
  'stawka_vat',
  'ean',
  'cena_gr',
  ...POLA_DODATNIE,
];

// Te same znaki co `trim(x, ' '||char(9,10,13))` w SQL migracji — celowo NIE String#trim(),
// który zdejmuje też twardą spację, \v i \f; wtedy JS i SQL różniłyby się co do pustości.
const BIALE = /^[ \t\n\r]*$/;

export function polePuste(pole, wartosc) {
  if (wartosc === null || wartosc === undefined) return true;
  if (POLA_DODATNIE.includes(pole)) {
    if (typeof wartosc === 'string' && BIALE.test(wartosc)) return true;
    return !(Number(wartosc) > 0);
  }
  if (typeof wartosc === 'string') return BIALE.test(wartosc);
  if (Array.isArray(wartosc)) return wartosc.length === 0;
  return false;
}

/**
 * Czy import treści z kanału może zapisać to pole karty.
 * @param {string} pole nazwa kolumny karty (np. 'opis', 'waga_g') albo 'opis_sekcje_json', 'zdjecia'
 * @param {unknown} wartoscKolumny obecna wartość na karcie
 * @param {{ zrodlo: string, reczne: number } | null | undefined} wierszZrodla wiersz `karty_zrodla_pol` albo brak
 * @param {string} zrodloImportu klucz importującego połączenia (`allegro:<konto>`, `woo:<sklep>`)
 *
 * @param {string[]} kolejnosc pełna kolejność połączeń; źródło spoza listy nie przejmuje pola
 * Niepuste pole aktualizuje własne źródło albo połączenie wyżej na liście.
 */
export function importMozeZapisac(pole, wartoscKolumny, wierszZrodla, zrodloImportu, kolejnosc = []) {
  // reczne = 1 chroni zawsze — także pole puste, bo celowe wyczyszczenie to też ręczna decyzja.
  if (wierszZrodla && Number(wierszZrodla.reczne) === 1) return false;
  if (polePuste(pole, wartoscKolumny)) return true;
  if (!wierszZrodla) return false;
  if (Number(wierszZrodla.reczne) !== 0) return false;
  if (wierszZrodla.zrodlo === zrodloImportu) return true;
  const nowy = kolejnosc.indexOf(zrodloImportu);
  const obecny = kolejnosc.indexOf(wierszZrodla.zrodlo);
  return nowy >= 0 && (obecny < 0 || nowy < obecny);
}
