// PRZ-118.02 — kontrakt ProgramFakturowy: strażnik przy składaniu modułu (sprawdzProgramFakturowy)
// i podkładka zProgramu, dzięki której usługi przyjmują `{ program }` albo stary `{ infakt }`.
// Ten plik jest też wejściem tsc: wzorcowy program poniżej musi dać się zapisać typem ProgramFakturowy.
import { describe, it, expect, vi } from 'vitest';
import type { ProgramFakturowy, OpisProgramu, ZdolnoscProgramu } from '../../src/core/kontrakty.ts';
import { sprawdzProgramFakturowy, zProgramu } from '../../src/integracje/program-fakturowy.ts';
import { programInfakt } from '../../src/integracje/programy/infakt.ts';
import { PROG_ZAWIESZONEJ_FAKTURY_MS } from '../../src/domena/faktura-stan.js';
import { METODY_INFAKTU } from '../../src/oms/infakt/client.js';

const OPIS: OpisProgramu = {
  id: 'polcien-ksiegowa',
  nazwa: { mianownik: 'Księgowa Półcień', dopelniacz: 'Księgowej Półcień', miejscownik: 'Księgowej Półcień', narzednik: 'Księgową Półcień' },
  regulaVat: 'wierszami',
  zdolnosci: ['nieoplacone', 'oznaczZaplacona', 'wyslijDoKsef', 'numeracjaWlasna'],
  wystawienieWysylaDoKsef: false,
  limity: { zadanieMs: 30_000, najdluzszaListaMs: 300_000, stronaListy: 25, sufitStron: 20, rownolegleStron: 2 },
  adres: 'https://ksiegowa.polcien.invalid/api',
  ekran: '/ustawienia/integracje/polcien',
};

/** Pełny program w kontrakcie — każdy przypadek odmowy psuje w nim dokładnie jedną rzecz. */
function wzorcowy(): ProgramFakturowy {
  return {
    opis: OPIS,
    sprawdzPolaczenie: async () => ({ ok: true }),
    przygotujNabywce: async () => ({ client_id: 1 }),
    wystaw: async () => ({ uuid: 'd-1', numer: 'FV 1/10/2026' }),
    wystawKorekte: async () => ({ uuid: 'k-1' }),
    pobierzPdf: async () => Buffer.from('%PDF'),
    pobierzPdfKorekty: async () => Buffer.from('%PDF'),
    pobierzFakture: async () => ({ uuid: 'd-1', number: 'FV 1/10/2026' }),
    listaFaktur: async () => [],
    listaKorekt: async () => [],
    listaNieoplaconych: async () => [],
    oznaczZaplacona: async () => ({}),
    wyslijDokumentDoKsef: async () => ({}),
    iluMaNumer: async () => 0,
  };
}
const zOpisem = (zmiana: Record<string, unknown>) => ({ ...wzorcowy(), opis: { ...OPIS, ...zmiana } });
const bez = (p: Record<string, unknown>, ...klucze: string[]) => {
  const kopia = { ...p };
  for (const k of klucze) delete kopia[k];
  return kopia;
};

describe('sprawdzProgramFakturowy — odmowa startu przy złym programie', () => {
  it('pełny program przechodzi i wraca ten sam obiekt', () => {
    const p = wzorcowy();
    const sprawdzony: ProgramFakturowy = sprawdzProgramFakturowy(p);
    expect(sprawdzony).toBe(p);
    expect(sprawdzony.opis.nazwa.miejscownik).toBe('Księgowej Półcień');
  });

  it('program bez żadnej zdolności (same metody obowiązkowe) przechodzi', () => {
    const p = { ...bez(wzorcowy(), 'listaNieoplaconych', 'oznaczZaplacona', 'wyslijDokumentDoKsef', 'iluMaNumer'), opis: { ...OPIS, zdolnosci: [] } };
    expect(sprawdzProgramFakturowy(p)).toBe(p);
  });

  it('(4) bez metody obowiązkowej → odmowa z nazwą metody (każda z dziewięciu)', () => {
    expect(() => sprawdzProgramFakturowy(bez(wzorcowy(), 'listaKorekt'))).toThrow(/listaKorekt/);
    for (const m of ['sprawdzPolaczenie', 'przygotujNabywce', 'wystaw', 'wystawKorekte', 'pobierzPdf', 'pobierzPdfKorekty',
      'pobierzFakture', 'listaFaktur', 'listaKorekt']) {
      expect(() => sprawdzProgramFakturowy(bez(wzorcowy(), m))).toThrow(new RegExp(`\\b${m}\\b`));
      expect(() => sprawdzProgramFakturowy({ ...wzorcowy(), [m]: 'nie funkcja' })).toThrow(new RegExp(`\\b${m}\\b`));
    }
  });

  it('(5) zdolność zadeklarowana bez metody → odmowa z nazwą zdolności i metody', () => {
    expect(() => sprawdzProgramFakturowy(bez(wzorcowy(), 'wyslijDokumentDoKsef'))).toThrow(/wyslijDoKsef.*wyslijDokumentDoKsef|wyslijDokumentDoKsef.*wyslijDoKsef/);
    const pary: [ZdolnoscProgramu, string][] = [
      ['nieoplacone', 'listaNieoplaconych'], ['oznaczZaplacona', 'oznaczZaplacona'],
      ['wyslijDoKsef', 'wyslijDokumentDoKsef'], ['numeracjaWlasna', 'iluMaNumer'],
    ];
    for (const [zdolnosc, metoda] of pary) {
      expect(() => sprawdzProgramFakturowy(bez(wzorcowy(), metoda))).toThrow(new RegExp(zdolnosc));
    }
  });

  it('(5) metoda opcjonalna bez zadeklarowanej zdolności → odmowa (zdolności = DOKŁADNIE zbiór obecnych metod)', () => {
    expect(() => sprawdzProgramFakturowy(zOpisem({ zdolnosci: ['nieoplacone', 'oznaczZaplacona', 'numeracjaWlasna'] }))).toThrow(/wyslijDoKsef/);
  });

  it('nieznana zdolność → odmowa', () => {
    expect(() => sprawdzProgramFakturowy(zOpisem({ zdolnosci: [...OPIS.zdolnosci, 'teleportacja'] }))).toThrow(/teleportacja/);
  });

  it('(6) regulaVat „odSumy” → odmowa (do PRZ-119); inna wartość też', () => {
    expect(() => sprawdzProgramFakturowy(zOpisem({ regulaVat: 'odSumy' }))).toThrow(/odSumy/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ regulaVat: undefined }))).toThrow(/regulaVat/);
  });

  it('(7) wystawienieWysylaDoKsef: true → odmowa; tylko literał false przechodzi', () => {
    expect(() => sprawdzProgramFakturowy(zOpisem({ wystawienieWysylaDoKsef: true }))).toThrow(/wystawienieWysylaDoKsef/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ wystawienieWysylaDoKsef: undefined }))).toThrow(/wystawienieWysylaDoKsef/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ wystawienieWysylaDoKsef: 0 }))).toThrow(/wystawienieWysylaDoKsef/);
  });

  it('(8) limity.zadanieMs = PROG_ZAWIESZONEJ_FAKTURY_MS → odmowa; o milisekundę mniej przechodzi', () => {
    const limity = (zadanieMs: number) => zOpisem({ limity: { ...OPIS.limity, zadanieMs } });
    expect(() => sprawdzProgramFakturowy(limity(PROG_ZAWIESZONEJ_FAKTURY_MS))).toThrow(/zadanieMs/);
    expect(() => sprawdzProgramFakturowy(limity(PROG_ZAWIESZONEJ_FAKTURY_MS + 1))).toThrow(/zadanieMs/);
    expect(sprawdzProgramFakturowy(limity(PROG_ZAWIESZONEJ_FAKTURY_MS - 1)).opis.limity.zadanieMs).toBe(PROG_ZAWIESZONEJ_FAKTURY_MS - 1);
  });

  it('limit brakujący albo nie-liczba → odmowa (porównanie z progiem nie może przejść przez undefined)', () => {
    expect(() => sprawdzProgramFakturowy(zOpisem({ limity: { ...OPIS.limity, zadanieMs: undefined } }))).toThrow(/zadanieMs/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ limity: { ...OPIS.limity, sufitStron: '20' } }))).toThrow(/sufitStron/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ limity: undefined }))).toThrow(/limity/);
  });

  it('bez opisu, bez id albo bez odmiany nazwy → odmowa', () => {
    expect(() => sprawdzProgramFakturowy(bez(wzorcowy(), 'opis'))).toThrow(/opis/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ id: '' }))).toThrow(/id/);
    expect(() => sprawdzProgramFakturowy(zOpisem({ nazwa: { mianownik: 'X' } }))).toThrow(/dopelniacz/);
    expect(() => sprawdzProgramFakturowy(null)).toThrow();
  });

  it('komunikat odmowy mówi, który program', () => {
    expect(() => sprawdzProgramFakturowy(bez(wzorcowy(), 'listaKorekt'))).toThrow(/Księgowa Półcień/);
  });
});

describe('(10) zProgramu — podkładka na czas PRZ-118', () => {
  const klient = () => Object.fromEntries(METODY_INFAKTU.map((m: string) => [m, vi.fn(async (..._a: unknown[]) => `wynik ${m}`)]));

  it('oba naraz → wyjątek', () => {
    expect(() => zProgramu({ program: wzorcowy(), infakt: klient() })).toThrow(/program.*infakt|infakt.*program/);
  });

  it('sam program → ten sam program', () => {
    const p = wzorcowy();
    expect(zProgramu({ program: p })).toBe(p);
    expect(zProgramu({ program: p, infakt: null })).toBe(p);
  });

  it('sam stary `infakt` → programInfakt(infakt): opis inFaktu, metody wołają klienta', async () => {
    const k = klient();
    const p = zProgramu({ infakt: k });
    expect(p).not.toBeNull();
    expect(p!.opis).toEqual(programInfakt(k).opis);
    expect(Object.keys(p!).sort()).toEqual(Object.keys(programInfakt(k)).sort());
    const ladunek = { client_id: 1, services: [] };
    expect(await p!.wystaw(ladunek)).toBe('wynik wystaw');
    expect(k.wystaw.mock.calls[0][0]).toBe(ladunek);
  });

  // PRZ-118.06 (odbiór): szew `fabryki.programFakturowy` modułu faktur podaje usługom program pod starą nazwą
  // `infakt` — podkładka nie może go owinąć adapterem inFaktu (zgubiłaby `opis.id` i `przygotujNabywce` programu).
  it('`infakt`, który już jest programem (ma opis i przygotujNabywce) → ten sam program, bez owinięcia', () => {
    const p = wzorcowy();
    expect(zProgramu({ infakt: p })).toBe(p);
    const k = klient();
    expect(zProgramu({ infakt: k })).not.toBe(k);
  });

  it('żaden → null (usługa bez programu fakturowego)', () => {
    expect(zProgramu({})).toBeNull();
    expect(zProgramu({ program: null, infakt: undefined })).toBeNull();
  });
});
