import type {
  KatalogKanalu,
  OpisKanalu,
  UmiejetnosciKanalu,
  WynikKataloguKanalu,
  ZapisZwrotnyKanalu,
} from '../core/kontrakty.ts';
import { MODULY_KANALOW, modulZamowienia, umiejetnosciZamowienia } from '../domena/moduly-kanalow.ts';
import { statusDlaErli } from '../domena/erli-status.js';
import { numerErli } from '../oms/erli/numer.js';

const METODA_ZAPISU_ZWROTNEGO = {
  statusZwrotny: 'ustawStatus',
} as const satisfies Partial<Record<keyof UmiejetnosciKanalu, keyof ZapisZwrotnyKanalu>>;
export const METODA_UMIEJETNOSCI = Object.freeze({
  ...METODA_ZAPISU_ZWROTNEGO,
  odczytOfert: 'odczytOfert',
  wystawOferte: 'wystawOferte',
  zmienOferte: 'zmienOferte',
  zmienIloscCene: 'zmienIloscCene',
  stanOferty: 'stanOferty',
} as const satisfies Partial<Record<keyof UmiejetnosciKanalu, keyof ZapisZwrotnyKanalu | keyof KatalogKanalu>>);
type Komplet<Wszystkie, Wymienione> = [Exclude<Wszystkie, Wymienione>] extends [never] ? true : never;
const komplet: Komplet<
  keyof ZapisZwrotnyKanalu | keyof KatalogKanalu,
  (typeof METODA_UMIEJETNOSCI)[keyof typeof METODA_UMIEJETNOSCI]
> = true;
void komplet;

/** Jedyna droga wywołania katalogu: także atrapa nie omija deklaracji umiejętności. */
export function katalogKanalu(opis: OpisKanalu, metody: Partial<KatalogKanalu>): KatalogKanalu {
  function chroniona<M extends keyof KatalogKanalu>(umiejetnosc: M): KatalogKanalu[M] {
    const metoda = METODA_UMIEJETNOSCI[umiejetnosc];
    return (async (...args: Parameters<KatalogKanalu[M]>) => {
      if (opis.umiejetnosci[umiejetnosc] !== true)
        return { ok: false, powod: `kanał ${opis.typ} nie umie ${umiejetnosc}` };
      const wykonaj = metody[metoda];
      if (typeof wykonaj !== 'function')
        return { ok: false, powod: `kanał ${opis.typ}: ${umiejetnosc} niezaimplementowane` };
      return (wykonaj as (...args: Parameters<KatalogKanalu[M]>) => Promise<WynikKataloguKanalu>).apply(metody, args);
    }) as KatalogKanalu[M];
  }
  return {
    odczytOfert: chroniona('odczytOfert'),
    wystawOferte: chroniona('wystawOferte'),
    zmienOferte: chroniona('zmienOferte'),
    zmienIloscCene: chroniona('zmienIloscCene'),
    stanOferty: chroniona('stanOferty'),
  };
}

/** Metody klienta HTTP Erli (`src/oms/erli/client.js`); brak metody nigdy nie udaje przyjęcia żądania. */
export type KlientKataloguErli = {
  szukajProduktow?: (filtry: Parameters<KatalogKanalu['odczytOfert']>[0]) => Promise<unknown>;
  utworzProdukt?: (...args: Parameters<KatalogKanalu['wystawOferte']>) => Promise<unknown>;
  zmienProdukt?: (...args: Parameters<KatalogKanalu['zmienOferte']>) => Promise<unknown>;
  zmienProdukty?: (...args: Parameters<KatalogKanalu['zmienIloscCene']>) => Promise<unknown>;
  pobierzProdukt?: (...args: Parameters<KatalogKanalu['stanOferty']>) => Promise<unknown>;
};

export function katalogErli(klient: KlientKataloguErli): KatalogKanalu {
  function przypnij<M extends keyof KatalogKanalu>(metoda: M, nazwa: keyof KlientKataloguErli): KatalogKanalu[M] {
    return (async (...args: Parameters<KatalogKanalu[M]>) => {
      const wykonaj = klient[nazwa];
      if (typeof wykonaj !== 'function') return { ok: false, powod: `kanał erli: ${metoda} niezaimplementowane` };
      const dane = await (wykonaj as (...args: Parameters<KatalogKanalu[M]>) => Promise<unknown>).apply(klient, args);
      return { ok: true, dane };
    }) as KatalogKanalu[M];
  }
  return katalogKanalu(MODULY_KANALOW.erli, {
    odczytOfert: przypnij('odczytOfert', 'szukajProduktow'),
    wystawOferte: przypnij('wystawOferte', 'utworzProdukt'),
    zmienOferte: przypnij('zmienOferte', 'zmienProdukt'),
    zmienIloscCene: przypnij('zmienIloscCene', 'zmienProdukty'),
    stanOferty: przypnij('stanOferty', 'pobierzProdukt'),
  });
}

/** Operacje Allegro spoza `KatalogKanalu` — wąski obiekt metod klienta jednego konta. */
export type WezlyAllegro = Readonly<{
  wgrajZdjecie: (bajty: Uint8Array, typ: string, opcje?: Readonly<{ ai?: boolean | number }>) => Promise<unknown>;
  stanOperacji: (adres: string) => Promise<unknown>;
  szukajProduktow: (ean: string) => Promise<unknown>;
  ofertyPoSygnaturze: (sygnatura: string) => Promise<unknown>;
  komendaIlosci: (
    commandId: string,
    pozycje: readonly Readonly<{ ofertaId: string; ilosc: number }>[],
  ) => Promise<unknown>;
  komendaCeny: (
    commandId: string,
    pozycje: readonly Readonly<{ ofertaId: string; cena: string }>[],
  ) => Promise<unknown>;
  wynikKomendy: (rodzaj: 'ilosc' | 'cena', commandId: string) => Promise<unknown>;
  oplatyOferty: (ofertaId: string) => Promise<unknown>;
  /** Prognoza opłat przed wznowieniem wyprzedanej oferty (`POST /pricing/offer-fee-preview`, bez skutku po stronie
   *  Allegro). `oplatyOferty` (`GET /pricing/offer-quotes`) oddaje 403 przy zakresach panelu — pomiar
   *  w tests/fixtures/allegro/e3-pomiar-p18-oplaty.json. */
  podgladOplat: (oferta: Readonly<Record<string, unknown>>) => Promise<unknown>;
}>;

/** Metody klienta HTTP Allegro (`src/oms/allegro/client.js`); brak metody nigdy nie udaje przyjęcia żądania. */
export type KlientKataloguAllegro = Partial<WezlyAllegro> & {
  ofertyKonta?: (filtry: Parameters<KatalogKanalu['odczytOfert']>[0]) => Promise<unknown>;
  utworzOferte?: (cialo: Parameters<KatalogKanalu['wystawOferte']>[1]) => Promise<unknown>;
  edytujOferte?: (...args: Parameters<KatalogKanalu['zmienOferte']>) => Promise<unknown>;
  pobierzOferte?: (...args: Parameters<KatalogKanalu['stanOferty']>) => Promise<unknown>;
};

/** Pozycja `zmienIloscCene` dla Allegro: `externalId` = id oferty, `price` w groszach, klucze idempotencji z pętli. */
type PozycjaKomendAllegro = Parameters<KatalogKanalu['zmienIloscCene']>[0][number] &
  Readonly<{
    commandIdIlosci?: unknown;
    commandIdCeny?: unknown;
  }>;
type KomendaAllegro =
  | { rodzaj: 'ilosc'; commandId: string; pozycje: { ofertaId: string; ilosc: number }[] }
  | { rodzaj: 'cena'; commandId: string; pozycje: { ofertaId: string; cena: string }[] };

const groszeNaZlGr = (grosze: number) => `${Math.trunc(grosze / 100)}.${String(grosze % 100).padStart(2, '0')}`;
const idKomendy = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Komendy ilości i ceny z pozycji kontraktu. `commandId` przychodzi z pozycji (wołający ma go zapisać
 * PRZED wywołaniem); łącznik nigdy go nie losuje, bo ponowienie z nowym identyfikatorem byłoby drugą komendą. Jedna komenda = jeden `commandId` (wartość pilnuje klient).
 */
function komendyAllegro(zmiany: readonly PozycjaKomendAllegro[]): KomendaAllegro[] | string {
  if (!Array.isArray(zmiany) || zmiany.length === 0) return 'brak pozycji do zmiany ilości i ceny';
  const komendy = new Map<string, KomendaAllegro>();
  for (const p of zmiany) {
    if (p.stock === undefined && p.price === undefined) return `pozycja ${p.externalId} nie ma ani ilości, ani ceny`;
    if (p.stock !== undefined) {
      if (!Number.isSafeInteger(p.stock) || p.stock < 0)
        return `pozycja ${p.externalId}: ilość musi być liczbą całkowitą ≥ 0`;
      const commandId = idKomendy(p.commandIdIlosci);
      if (commandId === null) return `pozycja ${p.externalId} bez commandIdIlosci — komendy ilości nie wysyłam`;
      const k = komendy.get(`ilosc:${commandId}`) ?? { rodzaj: 'ilosc', commandId, pozycje: [] };
      (k as Extract<KomendaAllegro, { rodzaj: 'ilosc' }>).pozycje.push({ ofertaId: p.externalId, ilosc: p.stock });
      komendy.set(`ilosc:${commandId}`, k);
    }
    if (p.price !== undefined) {
      if (!Number.isSafeInteger(p.price) || p.price <= 0)
        return `pozycja ${p.externalId}: cena musi być w groszach (liczba całkowita > 0)`;
      const commandId = idKomendy(p.commandIdCeny);
      if (commandId === null) return `pozycja ${p.externalId} bez commandIdCeny — komendy ceny nie wysyłam`;
      const k = komendy.get(`cena:${commandId}`) ?? { rodzaj: 'cena', commandId, pozycje: [] };
      (k as Extract<KomendaAllegro, { rodzaj: 'cena' }>).pozycje.push({
        ofertaId: p.externalId,
        cena: groszeNaZlGr(p.price),
      });
      komendy.set(`cena:${commandId}`, k);
    }
  }
  return [...komendy.values()].sort((a, b) => (a.rodzaj === b.rodzaj ? 0 : a.rodzaj === 'ilosc' ? -1 : 1));
}

export function katalogAllegro(klient: KlientKataloguAllegro): KatalogKanalu {
  const brak = (metoda: keyof KatalogKanalu) => ({
    ok: false as const,
    powod: `kanał allegro: ${metoda} niezaimplementowane`,
  });
  function przypnij<M extends Exclude<keyof KatalogKanalu, 'zmienIloscCene'>>(
    metoda: M,
    nazwa: keyof KlientKataloguAllegro,
    argumenty: (...args: Parameters<KatalogKanalu[M]>) => unknown[],
  ): KatalogKanalu[M] {
    return (async (...args: Parameters<KatalogKanalu[M]>) => {
      const wykonaj = klient[nazwa];
      if (typeof wykonaj !== 'function') return brak(metoda);
      const dane = await (wykonaj as (...a: unknown[]) => Promise<unknown>).apply(klient, argumenty(...args));
      return { ok: true, dane };
    }) as KatalogKanalu[M];
  }
  const zmienIloscCene: KatalogKanalu['zmienIloscCene'] = async (zmiany) => {
    const komendy = komendyAllegro(zmiany as readonly PozycjaKomendAllegro[]);
    if (typeof komendy === 'string') return { ok: false, powod: `kanał allegro: ${komendy}` };
    const { komendaIlosci, komendaCeny } = klient;
    if (komendy.some((k) => typeof (k.rodzaj === 'ilosc' ? komendaIlosci : komendaCeny) !== 'function'))
      return brak('zmienIloscCene');
    const dane = [];
    for (const k of komendy) {
      const wynik =
        k.rodzaj === 'ilosc'
          ? await komendaIlosci!.call(klient, k.commandId, k.pozycje)
          : await komendaCeny!.call(klient, k.commandId, k.pozycje);
      dane.push({ rodzaj: k.rodzaj, commandId: k.commandId, wynik });
    }
    return { ok: true, dane };
  };
  return katalogKanalu(MODULY_KANALOW.allegro, {
    odczytOfert: przypnij('odczytOfert', 'ofertyKonta', (filtry) => [filtry]),
    wystawOferte: przypnij('wystawOferte', 'utworzOferte', (_id, dane) => [dane]),
    zmienOferte: przypnij('zmienOferte', 'edytujOferte', (id, zmiany) => [id, zmiany]),
    zmienIloscCene,
    stanOferty: przypnij('stanOferty', 'pobierzOferte', (id) => [id]),
  });
}

const NAZWY_WEZLOW_ALLEGRO = [
  'wgrajZdjecie',
  'stanOperacji',
  'szukajProduktow',
  'ofertyPoSygnaturze',
  'komendaIlosci',
  'komendaCeny',
  'wynikKomendy',
  'oplatyOferty',
  'podgladOplat',
] as const satisfies readonly (keyof WezlyAllegro)[];

/** 9 metod klienta konta wprost (bariera i odświeżanie tokenu są w kliencie z `klienciKanalow`). */
export function wezlyAllegro(klient: Partial<WezlyAllegro>): WezlyAllegro {
  return Object.freeze(
    Object.fromEntries(
      NAZWY_WEZLOW_ALLEGRO.map((nazwa) => [
        nazwa,
        async (...args: unknown[]) => {
          const wykonaj = klient[nazwa];
          if (typeof wykonaj !== 'function') throw new Error(`kanał allegro: ${nazwa} niezaimplementowane`);
          return (wykonaj as (...a: unknown[]) => Promise<unknown>).apply(klient, args);
        },
      ]),
    ) as WezlyAllegro,
  );
}

export function sprawdzZapisZwrotny(opis: OpisKanalu, zwrotne: ZapisZwrotnyKanalu): void {
  for (const [umiejetnosc, metoda] of Object.entries(METODA_ZAPISU_ZWROTNEGO)) {
    const wymagana = opis.umiejetnosci[umiejetnosc as keyof typeof METODA_UMIEJETNOSCI] !== 'brak';
    if (wymagana !== (typeof zwrotne[metoda] === 'function')) {
      throw new Error(
        `Kanał „${opis.typ}”: ${umiejetnosc}=${opis.umiejetnosci[umiejetnosc as keyof typeof METODA_UMIEJETNOSCI]} wymaga ${wymagana ? 'obecności' : 'braku'} metody ${metoda}`,
      );
    }
  }
}

type KlientAllegro = { ustawStatusRealizacji: (id: string, status: string) => Promise<unknown> };
type KlientSklepu = { ustawStatus: (id: string, status: string) => Promise<unknown> };
type KlientErli = { ustawStatusSprzedawcy: (id: string, status: string) => Promise<unknown> };
type ZapisZDecyzja = ZapisZwrotnyKanalu & {
  przygotujStatus?: (
    z: Parameters<typeof statusDlaErli>[0],
    ostatni: (akcja: string) => string | null,
  ) => {
    status: string;
    klient: KlientErli;
    gdzie: { nazwa: string; w: string; dokad: string };
    akcja: string;
    sladZapisu: string;
  } | null;
};

export function zwrotneErli(klient: KlientErli): ZapisZDecyzja {
  const sladZapisu = 'sync-erli.przyjeto';
  return {
    ustawStatus: (id, status) => klient.ustawStatusSprzedawcy(id, status),
    przygotujStatus: (z, ostatni) => {
      const status = statusDlaErli(z, ostatni(sladZapisu));
      return status
        ? {
            status,
            klient,
            gdzie: { nazwa: 'ERLI', w: 'w ERLI', dokad: 'do ERLI' },
            akcja: 'sync-erli.status',
            sladZapisu,
          }
        : null;
    },
  };
}

export function zwrotneAllegro(klient: KlientAllegro): ZapisZwrotnyKanalu {
  return { ustawStatus: (id, status) => klient.ustawStatusRealizacji(id, status) };
}
export function zwrotneSklepu(klient: KlientSklepu): ZapisZwrotnyKanalu {
  return { ustawStatus: (id, status) => klient.ustawStatus(id, status) };
}
export function zwrotneZamowienia(
  z: { sklep?: unknown } | null | undefined,
  klient: KlientAllegro | KlientSklepu | KlientErli,
): ZapisZDecyzja {
  if (modulZamowienia(z).typ === 'erli') return zwrotneErli(klient as KlientErli);
  return umiejetnosciZamowienia(z).statusZwrotny === 'mapa'
    ? zwrotneAllegro(klient as KlientAllegro)
    : zwrotneSklepu(klient as KlientSklepu);
}

/** Numer przesyłki jest osobną operacją od statusu sprzedawcy. */
export function numerZwrotnyZamowienia(z: { sklep?: unknown }, klient: unknown): ReturnType<typeof numerErli> | null {
  return modulZamowienia(z).typ === 'erli' ? numerErli(klient) : null;
}
