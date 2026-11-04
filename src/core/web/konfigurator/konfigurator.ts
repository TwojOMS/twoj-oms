import type { KrokKonfiguratora } from '../../kontrakty.ts';

/** PRZ-135.07b: wspólne dla kanałów (OpisKonfiguratora) i kurierów (OpisKuriera['konfigurator'] z krokami). */
type KrokiKonfiguratora = Readonly<{ kroki: readonly KrokKonfiguratora[] }>;
type SciezkaKonfiguratora = Readonly<{ sciezka: string }>;

/** Bieżący i wykonane kroki wskazujemy przez id z opisu modułu. */
export function stanKrokow(konfigurator: KrokiKonfiguratora, stan: { biezacy: string; zrobione: readonly string[] }) {
  return konfigurator.kroki.map(({ numer, tytul, id }) => ({
    numer, tytul,
    stan: id === stan.biezacy ? 'biezacy' as const : stan.zrobione.includes(id) ? 'zrobione' as const : 'przed' as const,
  }));
}

/** Wyłącznie wybór pól i przycięcie tekstu; poprawność sprawdza usługa modułu. */
export function polaZFormularza(krok: KrokKonfiguratora, body: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries((krok.formularz?.pola ?? []).map(({ id }) => [
    id, Object.hasOwn(body, id) && typeof body[id] === 'string' ? body[id].trim() : '',
  ]));
}

export function adresAkcji(konfigurator: SciezkaKonfiguratora, krok: KrokKonfiguratora, klucz: string): string {
  if (!krok.formularz) throw new Error('Krok nie ma formularza');
  return `${konfigurator.sciezka}/${krok.formularz.akcja.replaceAll(':kanal', encodeURIComponent(klucz))}`;
}
