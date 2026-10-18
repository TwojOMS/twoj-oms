import type { Srodowisko } from './kontrakty.ts';

// PRZ-093.08 — adres firmy: sprzedawca na proformie, specyfikacji i potwierdzeniu wywozu ORAZ nadawca paczek.
// Kolejność źródeł (jedna, dla wszystkich): plik konfiguracji `DPD_NADAWCA_*` → adres wpisany w Ustawieniach
// (tabela `konfiguracja_integracji`, wiersz „firma”, src/oms/db/adres-firmy.js) → brak adresu.
// Nazwy zmiennych zostają (produkcja ich używa); przedrostek DPD_ jest historyczny — to adres firmy, nie tylko DPD.
//
// To JEDYNE miejsce, które czyta DPD_NADAWCA_* dla dokumentów i nadawcy DPD z Ustawień. Kurierzy z pliku (DPD_URL,
// INPOST_TOKEN) nadal sprawdzają pełny adres w pliku przy starcie (moduly/wysylka/kurierzy.ts) — ich klient
// powstaje raz, przy uruchomieniu.

export type AdresFirmy = { nazwa: string; ulica: string; kod: string; miasto: string; kraj: string; phone: string; email: string };

/** Adres z pliku — dokładnie ten kształt, który moduł faktur składał przed PRZ-093 (puste pola = ''). */
export function adresFirmyZEnv(env: Srodowisko): AdresFirmy {
  return { nazwa: env.DPD_NADAWCA_NAZWA?.trim() ?? '', ulica: env.DPD_NADAWCA_ULICA?.trim() ?? '',
    kod: env.DPD_NADAWCA_KOD?.trim() ?? '', miasto: env.DPD_NADAWCA_MIASTO?.trim() ?? '',
    kraj: env.DPD_NADAWCA_KRAJ?.trim() || 'PL', phone: env.DPD_NADAWCA_TELEFON?.trim() ?? '',
    email: env.DPD_NADAWCA_EMAIL?.trim() ?? '' };
}

/**
 * Czy adres stoi w pliku. Liczy się którekolwiek z czterech pól adresu (nazwa, ulica, kod, miasto): wtedy plik
 * wygrywa W CAŁOŚCI — także niepełny, żeby dokument nie wyszedł ze zlepkiem pliku i ekranu. Sam kraj, telefon albo
 * e-mail w pliku adresu nie tworzą (szablon instalacji może mieć puste linie adresu).
 */
export function adresWPliku(a: AdresFirmy | null | undefined): boolean {
  return Boolean(a && (a.nazwa || a.ulica || a.kod || a.miasto));
}

/** Kompletny adres nadawcy paczki: nazwa, ulica, kod i miasto. */
export function adresKompletny(a: AdresFirmy | null | undefined): a is AdresFirmy {
  return Boolean(a?.nazwa && a.ulica && a.kod && a.miasto);
}
