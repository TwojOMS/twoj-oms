import type { OpisKanalu, UmiejetnosciKanalu } from '../core/kontrakty.ts';
import { MODUL_ALLEGRO } from './modul-allegro.ts';
import { MODUL_WOO } from './modul-woo.ts';

/** Typy platform; rejestr połączeń przechowuje osobno konkretne konta. */
export const MODULY_KANALOW = Object.freeze({ woo: MODUL_WOO, allegro: MODUL_ALLEGRO });
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

/** Zachowuje dotychczasowe if/else: każde zamówienie spoza Allegro trafia do Woo. */
export function modulZamowienia(z: ZrodloZamowienia): OpisKanalu {
  return czyKanalAllegro(z) ? MODUL_ALLEGRO : MODUL_WOO;
}
export function umiejetnosciZamowienia(z: ZrodloZamowienia): UmiejetnosciKanalu {
  return modulZamowienia(z).umiejetnosci;
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
