import type { OpisKanalu, UmiejetnosciKanalu } from '../core/kontrakty.ts';
import { MODUL_ALLEGRO } from './modul-allegro.ts';
import { MODUL_WOO } from './modul-woo.ts';
import { MODUL_ERLI } from './modul-erli.ts';

/** Typy platform; rejestr połączeń przechowuje osobno konkretne konta. */
export const MODULY_KANALOW = Object.freeze({ woo: MODUL_WOO, allegro: MODUL_ALLEGRO, erli: MODUL_ERLI });
const TYPY_PREDYKATU: ReadonlySet<string> = new Set([MODUL_ALLEGRO.typ, MODUL_WOO.typ]);
export type TypKanaluZnany = keyof typeof MODULY_KANALOW;
export const TYPY_KANALOW: readonly TypKanaluZnany[] = Object.freeze(Object.keys(MODULY_KANALOW) as TypKanaluZnany[]);
export function czyTypKanalu(x: unknown): x is TypKanaluZnany {
  return typeof x === 'string' && Object.hasOwn(MODULY_KANALOW, x);
}
export function modulKanalu(typ: unknown): OpisKanalu {
  if (!czyTypKanalu(typ)) throw new Error('Nieznany typ kanału');
  return MODULY_KANALOW[typ];
}

let kanalyAllegroZKonfiguracji = new Set<string>();
/** Klucze kanałów Allegro z konfiguracji uruchomienia. */
export function ustawKanalyAllegro(klucze?: Iterable<string> | null) { kanalyAllegroZKonfiguracji = new Set(klucze ?? []); }
/** Kopia zbioru dla zapytań SQL dzielących zamówienia tak samo jak predykat. */
export const kanalyAllegro = () => [...kanalyAllegroZKonfiguracji];
type ZrodloZamowienia = { sklep?: unknown } | null | undefined;
export const czyKanalAllegro = (z: ZrodloZamowienia, klucze: ReadonlySet<string> = kanalyAllegroZKonfiguracji) => {
  const sklep = String(z?.sklep ?? '');
  return sklep.startsWith('allegro_') || klucze.has(sklep);
};

/** Kanały OMS-u (zamówienia ręczne, indywidualne) — bez połączenia w rejestrze, więc bez ostrzeżenia. Te same co WBUDOWANE w kanaly.js. */
export const KANALY_OMS: readonly string[] = Object.freeze(['reczne', 'indywidualne']);
/** Typ połączenia po kluczu (`OMS_KANALY` albo `kanaly_sprzedazy.typ`); null = klucza nie ma w rejestrze. */
export type TypPolaczeniaKanalu = (klucz: string) => string | null | undefined;
let typPolaczenia: TypPolaczeniaKanalu | null = null;
let modulyZamowien: Readonly<Record<string, OpisKanalu>> = MODULY_KANALOW;
const nieznaneKanaly = new Set<string>();
/** PRZ-157.00: kompozycja kanałów podaje raz przy starcie odczyt rejestru połączeń (domena nie otwiera bazy).
 * `moduly` — rejestr modułów; inny niż MODULY_KANALOW tylko w testach (wpis testowy nowego typu). */
export function ustawRejestrKanalow(typKanalu: TypPolaczeniaKanalu | null, moduly: Readonly<Record<string, OpisKanalu>> = MODULY_KANALOW) {
  typPolaczenia = typKanalu; modulyZamowien = moduly; nieznaneKanaly.clear();
}
/** Klucze z zamówień, których nie ma w rejestrze (albo ich typ nie ma modułu) — do diagnostyki kanałów. */
export const nieznaneKanalyZamowien = () => [...nieznaneKanaly];

/** D9: typ kanału z rejestru połączeń (poza Allegro i Woo); bez rejestru (testy domeny, skrypty) i dla nieznanego klucza — jak dotąd
 * (Allegro po predykacie, reszta do modułu sklepu). */
export function modulZamowienia(z: ZrodloZamowienia): OpisKanalu {
  const dawny = czyKanalAllegro(z) ? MODUL_ALLEGRO : MODUL_WOO;
  const sklep = String(z?.sklep ?? '');
  if (typPolaczenia && sklep && !KANALY_OMS.includes(sklep)) {
    const typ = typPolaczenia(sklep);
    // Typy wbudowane (MODULY_KANALOW) zostają przy predykacie — tym samym, którym dzieli je SQL KSeF
    // (ksef-oczekiwanie.js); rejestr decyduje tylko o pozostałych typach (recenzja PRZ-157.00).
    if (typeof typ === 'string' && TYPY_PREDYKATU.has(typ)) return dawny;
    if (typeof typ === 'string' && Object.hasOwn(modulyZamowien, typ)) return modulyZamowien[typ];
    nieznaneKanaly.add(sklep);
  }
  return dawny;
}
export function umiejetnosciZamowienia(z: ZrodloZamowienia): UmiejetnosciKanalu {
  return modulZamowienia(z).umiejetnosci;
}
/** PRZ-157.12b: klient z mapy `klienciKanalow` obsługuje wiadomości Allegro? Odrzuca tylko typy z rejestru, których
 * moduł ich nie ma (ERLI). Klucz poza rejestrem albo typu wbudowanego przechodzi — predykat nazw zamieniłby
 * nieznany klucz Allegro w Woo i odciął mu wiadomości. */
export function kanalZWiadomosciami(klucz: string): boolean {
  return kanalKlientaUmie(klucz, u => u.wiadomosci);
}
/** Ta sama reguła dla każdej umiejętności klienta z `klienciKanalow` (magazyn ofert, pliki faktur): typ wbudowany
 * i klucz spoza rejestru przechodzą, odpada tylko typ z rejestru bez tej umiejętności. */
export function kanalKlientaUmie(klucz: string, umie: (u: UmiejetnosciKanalu) => boolean): boolean {
  const modul = modulZamowienia({ sklep: klucz });
  return TYPY_PREDYKATU.has(modul.typ) || umie(modul.umiejetnosci);
}

/** Strażnik składania modułów, bez skutków ubocznych przy imporcie. */
export function sprawdzOpisyKanalow(moduly: Readonly<Record<string, OpisKanalu>> = MODULY_KANALOW): void {
  const bledy: string[] = [];
  const litery = new Set<string>();
  const katalogi = new Set<string>();
  for (const [klucz, opis] of Object.entries(moduly)) {
    if (opis.typ !== klucz) bledy.push(`${klucz}: typ musi być równy kluczowi rejestru`);
    if (litery.has(opis.litera)) bledy.push(`${klucz}: powtórzona litera ${opis.litera}`);
    litery.add(opis.litera);
    if (katalogi.has(opis.idKatalogu)) bledy.push(`${klucz}: powtórzone idKatalogu ${opis.idKatalogu}`);
    katalogi.add(opis.idKatalogu);
  }
  for (const [klucz, opis] of Object.entries(moduly)) {
    for (const sufiks of [...opis.kluczeEnv.sekrety, ...opis.kluczeEnv.wymagane]) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(sufiks)) bledy.push(`${klucz}: niepoprawny sufiks ${sufiks}`);
    }
    for (const sekret of opis.kluczeEnv.sekrety) {
      if (!opis.kluczeEnv.wymagane.includes(sekret)) bledy.push(`${klucz}: sekret ${sekret} spoza wymagane`);
    }
    const idKrokow = new Set<string>();
    let poprzedniNumer: number | undefined;
    for (const krok of opis.konfigurator.kroki) {
      const miejsce = `${klucz}: krok ${krok.id}`;
      if (idKrokow.has(krok.id)) bledy.push(`${miejsce}: powtórzone id kroku`);
      idKrokow.add(krok.id);
      if (poprzedniNumer !== undefined && krok.numer !== poprzedniNumer + 1) bledy.push(`${miejsce}: numer musi rosnąć o 1`);
      poprzedniNumer = krok.numer;
      if ((krok.formularz !== undefined) === (krok.widok !== undefined)) bledy.push(`${miejsce}: wymagane dokładnie jedno z formularz/widok`);
      const idPol = new Set<string>();
      for (const pole of krok.formularz?.pola ?? []) {
        if (idPol.has(pole.id)) bledy.push(`${miejsce}: powtórzone id pola ${pole.id}`);
        idPol.add(pole.id);
        if (pole.opcje !== undefined && pole.rodzaj !== 'wybor') bledy.push(`${miejsce}: opcje tylko dla wyboru (${pole.id})`);
      }
    }
  }
  if (bledy.length) throw new Error(`Błędne opisy kanałów:\n${bledy.join('\n')}`);
}
