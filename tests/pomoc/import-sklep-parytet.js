import { createImportSklepu as produkcyjnaFabryka } from '../../src/moduly/kanaly/services/import-sklep.js';
import { regulyHistorii } from '../../src/moduly/kanaly/historia.ts';
import { wierszHistorii as wierszProdukcyjny, decyzja as decyzjaProdukcyjna } from '../../src/domena/historia-sklepu.js';
export * from '../../src/domena/historia-sklepu.js';
export const KONTA_SKLEPOW = new Map([['swietlik', 9]]);
export const regulyFixture = regulyHistorii({
  OMS_KLIENCI_WDT: 'peter.novak@alfatrend.sk,info@alfatrend.sk',
  OMS_HISTORIA_MAILE_TESTOWE: 'anna.wzorcowa@example.test,jan.wzorcowy@example.test',
  OMS_HISTORIA_DOMENY_TESTOWE: 'example.com',
  OMS_HISTORIA_PREFIKSY_TESTOWE: 'testpsm',
  OMS_HISTORIA_NAZWY_TESTOWE: 'test psm,pracownia półcień',
});
export const wierszHistorii = (sklep, z) => wierszProdukcyjny(sklep, z, { konta: KONTA_SKLEPOW });
export const decyzja = z => decyzjaProdukcyjna(z, regulyFixture);
// Jawna konfiguracja migawki fixture starego testu. Nie jest domyślną
// konfiguracją produktu; testy zachowują swoje wywołania i wszystkie asercje.
export function createImportSklepu(opcje) {
  return produkcyjnaFabryka({ ...opcje, konfiguracja: {
    konta: new Map([[opcje.sklep, 9]]),
    ...regulyFixture,
  } });
}
