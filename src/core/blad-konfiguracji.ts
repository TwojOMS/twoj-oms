export class BladKonfiguracji extends Error {
  readonly zmienna: string;
  readonly wskazowka: string;
  opisStartu: string;

  constructor(zmienna: string, opis: string, wskazowka = 'poprawną wartość w środowisku uruchomienia OMS.') {
    super(opis);
    this.name = 'BladKonfiguracji';
    this.zmienna = zmienna;
    this.wskazowka = wskazowka;
    this.opisStartu = opis;
  }
}

/** Wywoływany wyłącznie przez walidatory, nigdy do rozpoznawania obcych wyjątków. */
export function bladKonfiguracji(opis: string): BladKonfiguracji {
  return new BladKonfiguracji(opis.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)?.[0] ?? 'konfigurację modułu', opis);
}

/** Starsze konfiguratory zgłaszają walidację zwykłym Error z nazwą zmiennej.
 * Adapter działa tylko na granicy konfiguratora i tylko dla istniejących form komunikatu.
 * TypeError, błędy systemowe i wyjątki bez wskazania zmiennej zachowują pełny stos. */
export function bladWalidatora(e: unknown): BladKonfiguracji | undefined {
  if (e instanceof BladKonfiguracji) return e;
  if (!(e instanceof Error) || e.name !== 'Error' || 'code' in e) return;
  const nazwany = /^(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+(?=[: /])|Brak (?:wymaganej zmiennej: |wymaganej konfiguracji poczty: |poprawnego |)|Ustawione |Konflikt |Sekcja KSeF wymaga )/;
  if (!nazwany.test(e.message) || !/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/.test(e.message)) return;
  return bladKonfiguracji(e.message);
}

export function komunikatKonfiguracji(blad: BladKonfiguracji): string {
  const opis = blad.opisStartu.split('\n')[0].trim();
  return `Błąd konfiguracji: ${opis}\nUstaw ${blad.zmienna} ${blad.wskazowka}\nOpis: docs/konfiguracja.md`;
}
