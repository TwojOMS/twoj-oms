// PRZ-118 — inFakt za kontraktem ProgramFakturowy (core/kontrakty.ts). Adapter jest CIENKI i PRZEZROCZYSTY:
// owija każdy z czterech obiektów „inFakt” o 14 metodach (createInfaktClient, pośrednik z Ustawień
// moduly/faktury/infakt-ustawien.ts, atrapę piaskownicy, odmowę próby) i przekazuje te same argumenty, ten sam
// wynik (tożsamość — Buffer z PDF, tablica z listy) i ten sam obiekt błędu. Złoty zapis żądań
// (tests/moduly/faktury/zapis-zadan-infaktu-prz118.test.js) rozstrzyga, że do inFaktu idzie bajt w bajt to samo.
//
// Zdolność obecna ⇔ owijany obiekt ma metodę W CHWILI OWIJANIA (mock bez `oznaczZaplacona` = program bez tej
// zdolności, jak dziś moduly/wysylka/services/oznaczanie-pobran.js). Metoda brakująca u owijanego obiektu nie
// pojawia się w programie — także obowiązkowa: wtedy sprawdzProgramFakturowy odmówi z jej nazwą.
//
// Kartoteka nabywców (`znajdzKlientaPoNip`, `zalozKlienta`) to model inFaktu — schowana za `przygotujNabywce`.
//
// ⚠️ Import cykliczny z ../program-fakturowy.ts (zProgramu woła programInfakt): listy metod czytamy WYŁĄCZNIE
// wewnątrz programInfakt, nigdy przy wczytaniu modułu.
import type { NabywcaDokumentu, OdmianaNazwy, OpisProgramu, ProgramFakturowy, ZdolnoscProgramu } from '../../core/kontrakty.ts';
import { METODY_OBOWIAZKOWE, METODA_ZDOLNOSCI } from '../program-fakturowy.ts';
import {
  LIMIT_ZADANIA_MS, NAJDLUZSZA_LISTA_MS, STRONA_INFAKTU, SUFIT_STRON, ROWNOLEGLE_STRON,
} from '../../oms/infakt/client.js';
import { ADRES_INFAKT, EKRAN_INFAKTU, NAZWA_INFAKTU } from '../../domena/konfiguracja-infakt.js';
import { czyNipUe, rozbijNipUe } from '../../domena/wdt.js';

type KlientInfaktu = Readonly<Record<string, unknown>>;
type Metoda = (...a: unknown[]) => unknown;

/** Programy zbudowane tutaj — owinięcie programu oddaje go bez drugiej warstwy (alias `infakt` = program w 05–08). */
const zbudowane = new WeakSet<object>();

/**
 * Odmowa bez kontaktu z inFaktem niesie `bezInfaktu` (infakt-ustawien.ts — na obiekcie BŁĘDU, nie wyniku);
 * dokładamy nazwę ogólną `bezProgramu` na TYM SAMYM obiekcie — reszta (status, dlaOperatora, komunikat) bez zmian.
 */
function oznaczBezProgramu(e: unknown): void {
  if (e && typeof e === 'object' && (e as { bezInfaktu?: unknown }).bezInfaktu && !('bezProgramu' in e)) {
    try { (e as { bezProgramu?: boolean }).bezProgramu = true; } catch { /* zamrożony błąd zostaje jak był */ }
  }
}

function przekaz(klient: KlientInfaktu, nazwa: string): Metoda {
  // Wołamy metodę obiektu w chwili WYWOŁANIA (`this` = klient; szpieg dopięty po owinięciu też działa).
  return async (...a: unknown[]) => {
    try { return await (klient[nazwa] as Metoda)(...a); } catch (e) { oznaczBezProgramu(e); throw e; }
  };
}

export function programInfakt(
  klient: KlientInfaktu,
  { nazwa = NAZWA_INFAKTU, adres = ADRES_INFAKT, ekran = EKRAN_INFAKTU }: { nazwa?: OdmianaNazwy; adres?: string; ekran?: string } = {},
): ProgramFakturowy {
  if (zbudowane.has(klient)) return klient as unknown as ProgramFakturowy;
  const ma = (m: string) => typeof klient[m] === 'function';

  const zdolnosci = (Object.entries(METODA_ZDOLNOSCI) as [ZdolnoscProgramu, string][])
    .filter(([, metoda]) => ma(metoda)).map(([zdolnosc]) => zdolnosc);
  const opis: OpisProgramu = Object.freeze({
    id: 'infakt',
    nazwa: Object.freeze({ ...nazwa }),
    regulaVat: 'wierszami',
    zdolnosci: Object.freeze(zdolnosci),
    wystawienieWysylaDoKsef: false,
    // Limity z eksportów klienta — jedno źródło z transportem i strażnikiem client.js:59.
    limity: Object.freeze({
      zadanieMs: LIMIT_ZADANIA_MS, najdluzszaListaMs: NAJDLUZSZA_LISTA_MS, stronaListy: STRONA_INFAKTU,
      sufitStron: SUFIT_STRON, rownolegleStron: ROWNOLEGLE_STRON,
    }),
    adres,
    ekran,
  });

  /**
   * Nabywca w kartotece inFaktu — logika przeniesiona DOSŁOWNIE z moduly/faktury/services/faktura.js (faza
   * przygotowania) i faktura-okresu.js (samo wyszukanie). Bez NIP-u nie szukamy (dopasowanie po nazwie podpięłoby
   * fakturę pod cudzy wpis). `null` = nie ma i nie założono — komunikat odmowy zostaje w usłudze.
   */
  async function przygotujNabywce(
    nabywca: NabywcaDokumentu, { zalozGdyBrak = false }: Readonly<{ zalozGdyBrak?: boolean }> = {},
  ): Promise<{ client_id: unknown } | null> {
    try {
      const d = nabywca;
      let clientId = d.nip ? await (klient.znajdzKlientaPoNip as Metoda)(d.nip) : null;
      if (!clientId && zalozGdyBrak) {
        // Rozpoznanie WDT po TYM SAMYM numerze, który idzie do kartoteki (jak `czyNipUe(d.nip)` w faktura.js).
        const wdt = czyNipUe(d.nip);
        clientId = await (klient.zalozKlienta as Metoda)({
          // company_name jest WYMAGANE także dla osoby prywatnej (422 "Proszę podać nazwę firmy").
          company_name: d.firma || 'Nabywca',
          // NIP musi trafić do kartoteki, inaczej `q[nip_eq]` nigdy tego wpisu nie znajdzie.
          nip: d.nip || null,
          street: d.ulica,
          postal_code: d.kod,
          city: d.miasto,
          // Przy WDT kraj wpisu Z PREFIKSU numeru, nie z `d.kraj` (zamówienie ręczne oddaje domyślne 'PL').
          country: wdt ? rozbijNipUe(d.nip)!.kraj : d.kraj,
          email: d.email,
        });
      }
      return clientId ? { client_id: clientId } : null;
    } catch (e) {
      oznaczBezProgramu(e);
      throw e;
    }
  }

  const metody: Record<string, Metoda> = {};
  for (const m of [...METODY_OBOWIAZKOWE, ...Object.values(METODA_ZDOLNOSCI)]) {
    if (m !== 'przygotujNabywce' && ma(m)) metody[m] = przekaz(klient, m);
  }
  // Obiekt składany dynamicznie (obecność metod zależy od owijanego obiektu), więc `satisfies` na literale nie
  // wchodzi w grę; komplet nazw pilnują typy METODY_OBOWIAZKOWE / METODA_ZDOLNOSCI, a resztę sprawdzProgramFakturowy.
  const program = { opis, przygotujNabywce, ...metody } as unknown as ProgramFakturowy;
  zbudowane.add(program);
  return program;
}
