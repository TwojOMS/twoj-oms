// PRZ-118 — program fakturowy TESTOWY („Testownik”): drugi wykonawca kontraktu ProgramFakturowy obok inFaktu.
// Służy testom usług, które mają działać na KAŻDYM programie, nie tylko na inFakcie (opis.id ≠ 'infakt',
// nazwa w czterech przypadkach różna od inFaktu — komunikat z zaszytym „inFakt” od razu wychodzi na wierzch).
//
// API:
//   programTestowy({ id, nazwa, pomin, metody }) → program (przechodzi sprawdzProgramFakturowy)
//     id      — opis.id, domyślnie 'testowy'
//     nazwa   — odmiana nazwy, domyślnie NAZWA_TESTOWNIKA
//     pomin   — nazwy metod OPCJONALNYCH do pominięcia (np. ['oznaczZaplacona']); zdolność znika razem z metodą
//     metody  — podmiana dowolnej metody (np. { wystaw: vi.fn().mockRejectedValue(…) })
//   program.wywolania — kolejność wywołań metod kontraktu: [['przygotujNabywce', arg0, arg1], ['wystaw', ładunek], …]
//   program.ile(nazwa) — liczba wywołań metody
//   Każda metoda to vi.fn — `program.wystaw.mock.calls` działa jak przy mockach inFaktu.
import { vi } from 'vitest';
import { METODY_OBOWIAZKOWE, METODA_ZDOLNOSCI, sprawdzProgramFakturowy } from '../../src/integracje/program-fakturowy.ts';

export const NAZWA_TESTOWNIKA = Object.freeze({
  mianownik: 'Testownik', dopelniacz: 'Testownika', miejscownik: 'Testowniku', narzednik: 'Testownikiem',
});

const domyslne = () => ({
  sprawdzPolaczenie: async () => ({ ok: true }),
  przygotujNabywce: async () => ({ client_id: 'nabywca-t1' }),
  wystaw: async () => ({ uuid: 'dok-t1', numer: 'TST 1/10/2026', ksefStatus: null }),
  wystawKorekte: async () => ({ uuid: 'kor-t1', numer: 'TST K 1/10/2026' }),
  pobierzPdf: async () => Buffer.from('%PDF-testownik'),
  pobierzPdfKorekty: async () => Buffer.from('%PDF-testownik-korekta'),
  pobierzFakture: async (uuid) => ({ uuid, number: 'TST 1/10/2026', ksef_number: null }),
  listaFaktur: async () => [],
  listaKorekt: async () => [],
  listaNieoplaconych: async () => [],
  oznaczZaplacona: async () => ({ referencja: 'zap-t1' }),
  wyslijDokumentDoKsef: async () => ({}),
  iluMaNumer: async () => 0,
});

export function programTestowy({ id = 'testowy', nazwa = NAZWA_TESTOWNIKA, pomin = [], metody = {} } = {}) {
  const opcjonalne = Object.values(METODA_ZDOLNOSCI);
  for (const m of pomin) {
    if (!opcjonalne.includes(m)) throw new Error(`programTestowy: „${m}” nie jest metodą opcjonalną — obowiązkowej nie da się pominąć.`);
  }
  const wywolania = [];
  const zrodla = { ...domyslne(), ...metody };
  const program = {
    opis: Object.freeze({
      id,
      nazwa: Object.freeze({ ...nazwa }),
      regulaVat: 'wierszami',
      zdolnosci: Object.freeze(Object.entries(METODA_ZDOLNOSCI).filter(([, m]) => !pomin.includes(m)).map(([z]) => z)),
      wystawienieWysylaDoKsef: false,
      limity: Object.freeze({ zadanieMs: 30_000, najdluzszaListaMs: 300_000, stronaListy: 25, sufitStron: 20, rownolegleStron: 2 }),
      adres: 'https://testownik.invalid/api',
      ekran: '/ustawienia/integracje/testownik',
    }),
    wywolania,
    ile: (m) => wywolania.filter(([nazwaMetody]) => nazwaMetody === m).length,
  };
  for (const m of [...METODY_OBOWIAZKOWE, ...opcjonalne]) {
    if (pomin.includes(m)) continue;
    const zrodlo = zrodla[m];
    // Metoda = vi.fn, który zapisuje kolejność i woła źródło; vi.fn podany w `metody` liczy swoje wywołania dalej.
    program[m] = vi.fn((...a) => { wywolania.push([m, ...a]); return zrodlo(...a); });
  }
  return sprawdzProgramFakturowy(program);
}
