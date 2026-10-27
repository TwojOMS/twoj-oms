// PRZ-118 — kontrakt programu fakturowego: listy metod, strażnik przy składaniu modułu i podkładka dla usług.
// Typy: core/kontrakty.ts (ProgramFakturowy, OpisProgramu). Pierwszy wykonawca: integracje/programy/infakt.ts.
import type { ProgramFakturowy, ZdolnoscProgramu } from '../core/kontrakty.ts';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../domena/faktura-stan.js';
import { programInfakt } from './programy/infakt.ts';

type MetodaKontraktu = Exclude<keyof ProgramFakturowy, 'opis'>;
type MetodaOpcjonalna = { [K in MetodaKontraktu]-?: undefined extends ProgramFakturowy[K] ? K : never }[MetodaKontraktu];
type MetodaObowiazkowa = Exclude<MetodaKontraktu, MetodaOpcjonalna>;
/** `true` tylko, gdy lista wymienia KAŻDĄ metodę danego rodzaju — nowa metoda w typie bez wpisu tutaj = błąd tsc. */
type Komplet<Wszystkie, Wymienione> = [Exclude<Wszystkie, Wymienione>] extends [never] ? true : never;

/** Metody, bez których program nie wchodzi. `przygotujNabywce` — jedyna, której nie ma klient inFaktu. */
export const METODY_OBOWIAZKOWE = Object.freeze([
  'sprawdzPolaczenie', 'przygotujNabywce', 'wystaw', 'wystawKorekte', 'pobierzPdf', 'pobierzPdfKorekty',
  'pobierzFakture', 'listaFaktur', 'listaKorekt',
] as const satisfies readonly MetodaObowiazkowa[]);

/** Zdolność ↔ metoda, która ją daje. Zdolność jest obecna ⇔ program ma tę metodę. */
export const METODA_ZDOLNOSCI = Object.freeze({
  nieoplacone: 'listaNieoplaconych',
  oznaczZaplacona: 'oznaczZaplacona',
  wyslijDoKsef: 'wyslijDokumentDoKsef',
  numeracjaWlasna: 'iluMaNumer',
} as const satisfies Record<ZdolnoscProgramu, MetodaOpcjonalna>);

const pelneObowiazkowe: Komplet<MetodaObowiazkowa, (typeof METODY_OBOWIAZKOWE)[number]> = true;
const pelneOpcjonalne: Komplet<MetodaOpcjonalna, (typeof METODA_ZDOLNOSCI)[ZdolnoscProgramu]> = true;
void pelneObowiazkowe; void pelneOpcjonalne;

const FORMY_NAZWY = ['mianownik', 'dopelniacz', 'miejscownik', 'narzednik'] as const;
const LIMITY = ['zadanieMs', 'najdluzszaListaMs', 'stronaListy', 'sufitStron', 'rownolegleStron'] as const;

/**
 * Strażnik startu: wołany przy składaniu modułu (NIE w podkładce — mocki usług w testach bywają niepełne).
 * Oddaje ten sam obiekt albo rzuca — panel ze złym programem nie wstaje, zamiast paść przy pierwszej fakturze.
 */
export function sprawdzProgramFakturowy(p: unknown): ProgramFakturowy {
  if (!p || typeof p !== 'object') throw new Error('Program fakturowy: oczekiwany obiekt programu.');
  const program = p as Record<string, unknown>;
  const opis = program.opis as Record<string, unknown> | undefined;
  if (!opis || typeof opis !== 'object') throw new Error('Program fakturowy: brak opisu programu (`opis`).');
  const nazwa = opis.nazwa as Record<string, unknown> | undefined;
  const kto = `Program fakturowy „${typeof nazwa?.mianownik === 'string' ? nazwa.mianownik : String(opis.id)}”`;
  const odmowa = (powod: string): never => { throw new Error(`${kto}: ${powod} — panel nie wstanie z tym programem.`); };

  if (typeof opis.id !== 'string' || !opis.id) odmowa('opis bez identyfikatora (`opis.id`)');
  for (const forma of FORMY_NAZWY) {
    if (typeof nazwa?.[forma] !== 'string' || !nazwa[forma]) odmowa(`opis bez odmiany nazwy (\`opis.nazwa.${forma}\`)`);
  }

  for (const m of METODY_OBOWIAZKOWE) {
    if (typeof program[m] !== 'function') odmowa(`brak metody obowiązkowej ${m}`);
  }

  if (!Array.isArray(opis.zdolnosci)) odmowa('opis bez listy zdolności (`opis.zdolnosci`)');
  const zadeklarowane = new Set(opis.zdolnosci as unknown[]);
  for (const z of zadeklarowane) {
    if (!Object.hasOwn(METODA_ZDOLNOSCI, z as string)) odmowa(`nieznana zdolność ${String(z)}`);
  }
  for (const [zdolnosc, metoda] of Object.entries(METODA_ZDOLNOSCI)) {
    const ma = typeof program[metoda] === 'function';
    if (zadeklarowane.has(zdolnosc) && !ma) odmowa(`zdolność ${zdolnosc} zadeklarowana, a metody ${metoda} brak`);
    if (!zadeklarowane.has(zdolnosc) && ma) odmowa(`metoda ${metoda} jest, a zdolności ${zdolnosc} nie zadeklarowano`);
  }

  // Do PRZ-119 jedyna zaimplementowana reguła to 'wierszami' (domena/podsumowanie-wierszami.js).
  if (opis.regulaVat !== 'wierszami') {
    odmowa(`regulaVat „${String(opis.regulaVat)}” nieobsługiwana — panel liczy VAT tylko wierszami`);
  }
  // Niezmiennik „wystawienie ≠ wysyłka do KSeF”: tylko literał false.
  if (opis.wystawienieWysylaDoKsef !== false) {
    odmowa('wystawienieWysylaDoKsef musi być false — wysyłka do KSeF to osobna, świadoma decyzja człowieka');
  }

  const limity = opis.limity as Record<string, unknown> | undefined;
  if (!limity || typeof limity !== 'object') odmowa('opis bez limitów (`opis.limity`)');
  for (const l of LIMITY) {
    const v = limity![l];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) odmowa(`limity.${l} musi być dodatnią liczbą`);
  }
  // Ten sam strażnik co src/oms/infakt/client.js przy wczytaniu: rezerwacja starsza od progu MUSI znaczyć „nic nie leci”.
  if ((limity!.zadanieMs as number) >= PROG_ZAWIESZONEJ_FAKTURY_MS) {
    odmowa(`limity.zadanieMs (${String(limity!.zadanieMs)} ms) musi być krótszy niż próg zawieszonej faktury (${PROG_ZAWIESZONEJ_FAKTURY_MS} ms)`);
  }
  return p as ProgramFakturowy;
}

/**
 * Podkładka na czas PRZ-118: usługa przyjmuje `{ program }` albo stary `{ infakt }` (52 pliki testów wstrzykują
 * `infakt`). Oba naraz = błąd programisty. Żaden = `null` (usługa bez programu fakturowego, jak dziś bez `infakt`).
 * Bez sprawdzProgramFakturowy — mock w teście usługi bywa niepełny i ma działać tak jak dziś.
 */
function jestProgramem(o: unknown): o is ProgramFakturowy {
  if (!o || typeof o !== 'object') return false;
  const p = o as { opis?: { id?: unknown }; przygotujNabywce?: unknown };
  return typeof p.opis?.id === 'string' && typeof p.przygotujNabywce === 'function';
}

export function zProgramu({ program, infakt }: { program?: ProgramFakturowy | null; infakt?: unknown }): ProgramFakturowy | null {
  if (program != null && infakt != null) {
    throw new Error('Usługa dostała naraz `program` i `infakt` — podaj jedno (`infakt` to stara nazwa na czas PRZ-118).');
  }
  if (program != null) return program;
  // Szew `fabryki.programFakturowy` (moduly/faktury/modul.ts) podaje program pod starą nazwą `infakt` — już jest
  // programem (opis + przygotujNabywce), więc bez owinięcia adapterem inFaktu.
  if (jestProgramem(infakt)) return infakt;
  if (infakt != null) return programInfakt(infakt as Parameters<typeof programInfakt>[0]);
  return null;
}
