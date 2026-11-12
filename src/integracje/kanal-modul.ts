import type { OpisKanalu, UmiejetnosciKanalu, ZapisZwrotnyKanalu } from '../core/kontrakty.ts';
import { modulZamowienia, umiejetnosciZamowienia } from '../domena/moduly-kanalow.ts';
import { statusDlaErli } from '../domena/erli-status.js';
import { numerErli } from '../oms/erli/numer.js';

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
type KlientErli = { ustawStatusSprzedawcy: (id: string, status: string) => Promise<unknown> };
type ZapisZDecyzja = ZapisZwrotnyKanalu & {
  przygotujStatus?: (z: Parameters<typeof statusDlaErli>[0], ostatni: (akcja: string) => string | null) => {
    status: string; klient: KlientErli; gdzie: { nazwa: string; w: string; dokad: string }; akcja: string; sladZapisu: string;
  } | null;
};

export function zwrotneErli(klient: KlientErli): ZapisZDecyzja {
  const sladZapisu = 'sync-erli.przyjeto';
  return {
    ustawStatus: (id, status) => klient.ustawStatusSprzedawcy(id, status),
    przygotujStatus: (z, ostatni) => {
      const status = statusDlaErli(z, ostatni(sladZapisu));
      return status ? { status, klient, gdzie: { nazwa: 'ERLI', w: 'w ERLI', dokad: 'do ERLI' },
        akcja: 'sync-erli.status', sladZapisu } : null;
    },
  };
}

export function zwrotneAllegro(klient: KlientAllegro): ZapisZwrotnyKanalu {
  return { ustawStatus: (id, status) => klient.ustawStatusRealizacji(id, status) };
}
export function zwrotneSklepu(klient: KlientSklepu): ZapisZwrotnyKanalu {
  return { ustawStatus: (id, status) => klient.ustawStatus(id, status) };
}
export function zwrotneZamowienia(z: { sklep?: unknown } | null | undefined, klient: KlientAllegro | KlientSklepu | KlientErli): ZapisZDecyzja {
  if (modulZamowienia(z).typ === 'erli') return zwrotneErli(klient as KlientErli);
  return umiejetnosciZamowienia(z).statusZwrotny === 'mapa'
    ? zwrotneAllegro(klient as KlientAllegro)
    : zwrotneSklepu(klient as KlientSklepu);
}

/** Numer przesyłki jest osobną operacją od statusu sprzedawcy. */
export function numerZwrotnyZamowienia(z: { sklep?: unknown }, klient: unknown): ReturnType<typeof numerErli> | null {
  return modulZamowienia(z).typ === 'erli' ? numerErli(klient) : null;
}
