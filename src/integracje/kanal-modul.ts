import type { OpisKanalu, UmiejetnosciKanalu, ZapisZwrotnyKanalu } from '../core/kontrakty.ts';
import { umiejetnosciZamowienia } from '../domena/moduly-kanalow.ts';

export const METODA_UMIEJETNOSCI = Object.freeze({
  statusZwrotny: 'ustawStatus',
} as const satisfies Partial<Record<keyof UmiejetnosciKanalu, keyof ZapisZwrotnyKanalu>>);
type Komplet<Wszystkie, Wymienione> = [Exclude<Wszystkie, Wymienione>] extends [never] ? true : never;
const komplet: Komplet<keyof ZapisZwrotnyKanalu, (typeof METODA_UMIEJETNOSCI)[keyof typeof METODA_UMIEJETNOSCI]> = true;
void komplet;

export function sprawdzZapisZwrotny(opis: OpisKanalu, zwrotne: ZapisZwrotnyKanalu): void {
  for (const [umiejetnosc, metoda] of Object.entries(METODA_UMIEJETNOSCI)) {
    const wymagana = opis.umiejetnosci[umiejetnosc as keyof typeof METODA_UMIEJETNOSCI] !== 'brak';
    if (wymagana !== (typeof zwrotne[metoda] === 'function')) {
      throw new Error(`Kanał „${opis.typ}”: ${umiejetnosc}=${opis.umiejetnosci[umiejetnosc as keyof typeof METODA_UMIEJETNOSCI]} wymaga ${wymagana ? 'obecności' : 'braku'} metody ${metoda}`);
    }
  }
}

type KlientAllegro = { ustawStatusRealizacji: (id: string, status: string) => Promise<unknown> };
type KlientSklepu = { ustawStatus: (id: string, status: string) => Promise<unknown> };

export function zwrotneAllegro(klient: KlientAllegro): ZapisZwrotnyKanalu {
  return { ustawStatus: (id, status) => klient.ustawStatusRealizacji(id, status) };
}
export function zwrotneSklepu(klient: KlientSklepu): ZapisZwrotnyKanalu {
  return { ustawStatus: (id, status) => klient.ustawStatus(id, status) };
}
export function zwrotneZamowienia(z: { sklep?: unknown } | null | undefined, klient: KlientAllegro | KlientSklepu): ZapisZwrotnyKanalu {
  return umiejetnosciZamowienia(z).statusZwrotny === 'mapa'
    ? zwrotneAllegro(klient as KlientAllegro)
    : zwrotneSklepu(klient as KlientSklepu);
}
