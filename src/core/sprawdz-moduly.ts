import type { ModulOms } from './kontrakty.ts';

const NAZWA = /^[a-z][a-z0-9-]*$/;
const WERSJA = /^\d+\.\d+\.\d+$/;

export function sprawdzModuly(moduly: readonly ModulOms[]): void {
  const nazwy = new Set<string>();
  const klucze = new Map<string, string>();
  for (const m of moduly) {
    if (!NAZWA.test(m.nazwa)) throw new Error(`Moduł „${m.nazwa}": nazwa musi pasować do ${NAZWA}`);
    if (!WERSJA.test(m.wersja)) throw new Error(`Moduł „${m.nazwa}": wersja „${m.wersja}" nie jest w formacie X.Y.Z`);
    if (nazwy.has(m.nazwa)) throw new Error(`Moduł „${m.nazwa}" zarejestrowany dwa razy`);
    nazwy.add(m.nazwa);
    const numery = new Set<number>();
    for (const mig of m.migracje) {
      if (!Number.isInteger(mig.numer) || mig.numer < 1) throw new Error(`Moduł „${m.nazwa}": numer migracji ${mig.numer} musi być dodatnią liczbą całkowitą`);
      if (numery.has(mig.numer)) throw new Error(`Moduł „${m.nazwa}": numer migracji ${mig.numer} powtórzony`);
      numery.add(mig.numer);
    }
    for (const u of m.uprawnienia) {
      const wlasciciel = klucze.get(u.klucz);
      if (wlasciciel) throw new Error(`Uprawnienie „${u.klucz}" deklarują moduły „${wlasciciel}" i „${m.nazwa}"`);
      klucze.set(u.klucz, m.nazwa);
    }
  }
  for (const m of moduly) {
    for (const p of m.menu) {
      if (!klucze.has(p.uprawnienie)) throw new Error(`Moduł „${m.nazwa}": pozycja menu „${p.etykieta}" wskazuje nieznane uprawnienie „${p.uprawnienie}"`);
    }
    for (const w of m.wymaga) {
      if (!nazwy.has(w)) throw new Error(`Moduł „${m.nazwa}" wymaga modułu „${w}", którego nie ma na liście`);
    }
  }
}

export function kolejnoscBudowy(moduly: readonly ModulOms[]): ModulOms[] {
  const poNazwie = new Map(moduly.map((m) => [m.nazwa, m]));
  const stan = new Map<string, 'w-toku' | 'gotowy'>();
  const wynik: ModulOms[] = [];
  const odwiedz = (m: ModulOms, sciezka: readonly string[]): void => {
    const s = stan.get(m.nazwa);
    if (s === 'gotowy') return;
    if (s === 'w-toku') throw new Error(`Cykl zależności modułów: ${[...sciezka, m.nazwa].join(' → ')}`);
    stan.set(m.nazwa, 'w-toku');
    for (const w of m.wymaga) odwiedz(poNazwie.get(w)!, [...sciezka, m.nazwa]);
    stan.set(m.nazwa, 'gotowy');
    wynik.push(m);
  };
  for (const m of moduly) odwiedz(m, []);
  return wynik;
}
