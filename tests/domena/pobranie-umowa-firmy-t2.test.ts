// PRZ-135.T2.01 — umowa firmy na pobranie w InPoście (ustawienie `wysylka.umowa_pobrania.inpost`)
// wchodzi do reguł PARAMETREM `umowyPobrania`. Rejestr kurierów i pamięć reguł zostają nietknięte,
// a bez parametru (albo z `[]`) wszystko działa bit w bit jak w złotych testach PRZ-135/PRZ-070.
import { describe, expect, it } from 'vitest';
import { kurierzyDoWyboru, metodaNadania } from '../../src/domena/kurier-nadania.js';
import { podzielDoNadania } from '../../src/domena/masowe.js';
import { MODULY_KURIEROW, pobranieNaDosylce, pobranieNaUmowie } from '../../src/domena/moduly-kurierow.ts';

const WZA = 'wza|Wysyłam z Allegro — umowa Allegro (domyślnie)';
const DPD = 'dpd|DPD — nasza umowa';
const PACZ = 'inpost_paczkomat|Paczkomat InPost — nasza umowa';
const UMOWA = { umowyPobrania: ['inpost'] };

const pary = (m: string, pobranie: number, paczka: number, ...opcje: any[]) =>
  (kurierzyDoWyboru as any)({ metoda_wysylki: m, pobranie }, paczka, ...opcje).map((k: any) => `${k.klucz}|${k.etykieta}`);

// Głęboka kopia z zachowaniem funkcji (rejestr ma `sledzenieAdres`, więc structuredClone odpada).
function kopia(w: any): any {
  if (Array.isArray(w)) return w.map(kopia);
  if (w && typeof w === 'object') return Object.fromEntries(Object.entries(w).map(([k, v]) => [k, kopia(v)]));
  return w;
}

describe('pobranieNaUmowie — awans „adapter” ustawieniem firmy', () => {
  it('paczkomat: bez umowy firmy nie, z umową InPostu tak', () => {
    expect(pobranieNaUmowie('inpost_paczkomat')).toBe(false);
    expect(pobranieNaUmowie('inpost_paczkomat', MODULY_KURIEROW, [])).toBe(false);
    expect(pobranieNaUmowie('inpost_paczkomat', MODULY_KURIEROW, ['dpd'])).toBe(false);
    expect(pobranieNaUmowie('inpost_paczkomat', MODULY_KURIEROW, ['inpost'])).toBe(true);
  });

  it('DPD i WzA mają „umowa” na stałe — ustawienie niczego im nie odbiera', () => {
    for (const m of ['dpd', 'allegro_dpd']) {
      expect(pobranieNaUmowie(m)).toBe(true);
      expect(pobranieNaUmowie(m, MODULY_KURIEROW, ['inpost'])).toBe(true);
    }
  });

  it('kurier z „brak” nigdy nie awansuje, nawet wpisany do umów firmy', () => {
    const rejestr: any = {
      ...MODULY_KURIEROW,
      zmyslony: {
        ...MODULY_KURIEROW.inpost, klucz: 'zmyslony',
        metody: [{ klucz: 'zmyslony_punkt', etykieta: 'Punkt Półcień', formularz: 'paczkomat', punktOdbioru: true }],
        umiejetnosci: { ...MODULY_KURIEROW.inpost.umiejetnosci, pobranie: 'brak' },
      },
    };
    expect(pobranieNaUmowie('zmyslony_punkt', rejestr, ['zmyslony'])).toBe(false);
  });

  it('metoda bez kuriera — false', () => {
    expect(pobranieNaUmowie('odbior_osobisty', MODULY_KURIEROW, ['inpost'])).toBe(false);
  });
});

describe('kurierzyDoWyboru z umowyPobrania: [inpost] — metoda × pobranie × numer paczki', () => {
  // [metoda, pobranie, paczka, oczekiwane] — od złotej tabeli różni się WYŁĄCZNIE [m,1,1].
  const TABELA: [string, number, number, string[]][] = [];
  for (const m of ['dpd', 'inpost_paczkomat', 'allegro_paczkomat']) {
    TABELA.push([m, 0, 1, [DPD, PACZ]], [m, 0, 2, [DPD, PACZ]], [m, 1, 1, [DPD, PACZ]], [m, 1, 2, [DPD, PACZ]]);
  }
  for (const m of ['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne']) {
    TABELA.push([m, 0, 1, [WZA, DPD, PACZ]], [m, 0, 2, [WZA, DPD, PACZ]], [m, 1, 1, [WZA, DPD, PACZ]], [m, 1, 2, [WZA, DPD, PACZ]]);
  }
  it('tabela ma 7 metod × 4 kombinacje', () => { expect(TABELA).toHaveLength(28); });
  it.each(TABELA)('%s pobranie=%i paczka=%i', (m, pobranie, paczka, oczekiwane) => {
    expect(pary(m, pobranie, paczka, UMOWA)).toEqual(oczekiwane);
  });

  it('pusta lista umów i brak parametru — tak jak dziś: [m,1,1] bez paczkomatu', () => {
    expect(pary('inpost_paczkomat', 1, 1)).toEqual([DPD]);
    for (const opcje of [undefined, {}, { umowyPobrania: [] }, { umowyPobrania: ['dpd', 'allegro'] }]) {
      expect(pary('inpost_paczkomat', 1, 1, opcje)).toEqual([DPD]);
      expect(pary('allegro_dpd', 1, 1, opcje)).toEqual([WZA, DPD]);
    }
  });

  // PRZ-137.03 (D2): adapter InPostu wysyła cod także na zamienniku, więc z umową paczkomat zostaje;
  // WzA odpada nawet dla zamówienia allegro_dpd — Allegro nie przyjmie pobrania na kolejnej paczce.
  it('zamiennik (paczka 2, pobranie na tej paczce) z umową: DPD i paczkomat, nigdy WzA', () => {
    for (const m of ['inpost_paczkomat', 'allegro_paczkomat', 'dpd']) {
      expect(kurierzyDoWyboru({ metoda_wysylki: m, pobranie: 1 } as any, 2, { pobranieNaTejPaczce: true, ...UMOWA } as any)
        .map((k: any) => k.klucz)).toEqual(['dpd', 'inpost_paczkomat']);
    }
    expect(kurierzyDoWyboru({ metoda_wysylki: 'allegro_dpd', pobranie: 1 } as any, 3, { pobranieNaTejPaczce: true, ...UMOWA } as any)
      .map((k: any) => k.klucz)).toEqual(['dpd', 'inpost_paczkomat']);
  });

  it('rejestr: pobranie na kolejnej paczce przyjmują DPD i InPost, nie WzA ani Allegro', () => {
    expect(pobranieNaDosylce('dpd')).toBe(true);
    expect(pobranieNaDosylce('inpost_paczkomat')).toBe(true);
    expect(pobranieNaDosylce('allegro_dpd')).toBe(false);
    expect(pobranieNaDosylce('allegro_punkt')).toBe(false);
    expect(pobranieNaDosylce('metoda_nieznana')).toBe(false);
  });

  it('rejestr i pamięć reguł nietknięte: głęboko równe przed i po, wynik bez parametru jak dawniej', () => {
    const przed = kopia(MODULY_KURIEROW);
    pary('inpost_paczkomat', 1, 1, UMOWA);
    pary('allegro_punkt', 1, 1, UMOWA);
    metodaNadania({ metoda_wysylki: 'allegro_dpd', pobranie: 1 }, 'inpost_paczkomat', UMOWA);
    podzielDoNadania([{ id: 1, numer: 'P1', sklep: 'pro', metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'POL01A',
      pobranie: 1, kwota_pobrania: '12.30', anulowane: 0, przesylki: [] }], UMOWA);
    expect(MODULY_KURIEROW).toEqual(przed);
    expect(MODULY_KURIEROW.inpost.umiejetnosci.pobranie).toBe('adapter');
    expect(pary('inpost_paczkomat', 1, 1)).toEqual([DPD]);
  });
});

describe('metodaNadania z umowyPobrania', () => {
  const z = { metoda_wysylki: 'allegro_dpd', sklep: 'allegro_polcien', pobranie: 1 };

  it('z umową InPostu przyjmuje paczkomat wskazany przy pobraniu na paczce 1', () => {
    expect(metodaNadania(z, 'inpost_paczkomat', UMOWA))
      .toEqual({ metoda: 'inpost_paczkomat', wskazanyRecznie: true, metodaZamowienia: 'allegro_dpd' });
    expect(metodaNadania(z, 'inpost_paczkomat', { kolejnosc: 1, ...UMOWA }).metoda).toBe('inpost_paczkomat');
  });

  it('bez parametru (i z pustą listą) odmawia jak dziś', () => {
    for (const opcje of [undefined, { kolejnosc: 1 }, { kolejnosc: 1, umowyPobrania: [] }]) {
      const w: any = metodaNadania(z, 'inpost_paczkomat', opcje);
      expect(w.metoda).toBeUndefined();
      expect(w.blad).toBe('Nie umiem nadać tej paczki jako „inpost_paczkomat" — do wyboru jest '
        + 'Wysyłam z Allegro — umowa Allegro (domyślnie) albo DPD — nasza umowa. Panel niczego nie nadał.');
    }
  });

  it('droga domyślna i DPD się nie zmieniają', () => {
    expect(metodaNadania(z, '', UMOWA)).toEqual({ metoda: 'allegro_dpd' });
    expect(metodaNadania(z, 'dpd', UMOWA)).toEqual({ metoda: 'dpd', wskazanyRecznie: true, metodaZamowienia: 'allegro_dpd' });
  });
});

describe('nadanie hurtem (podzielDoNadania) z umową na pobranie w InPoście', () => {
  const zam = (nad = {}) => ({
    id: 7, numer: 'PC-7', sklep: 'pro', metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'POL01A', anulowane: 0,
    oplacone_at: null, przesylki: [], pobranie: 1, kwota_pobrania: '87.40', ...nad,
  });
  // PRZ-137.01: odmowa dotyczy tylko pobrania OMS-owego (zamówienie ręczne); sklepowe jedzie bez umowy.
  const ODMOWA = 'pobranie przez InPost wymaga umowy — włącz ją w Ustawieniach → Integracje albo zmień kuriera na karcie zamówienia';

  it('włączone: paczkomat za pobraniem z dobrą kwotą przechodzi, z uwagą o inkasie', () => {
    const { doNadania, pominiete, uwagi } = podzielDoNadania([zam()], UMOWA);
    expect(pominiete).toEqual([]);
    expect(doNadania.map((z: any) => [z.metodaUzyta, z.rodzajFormularza])).toEqual([['inpost_paczkomat', 'paczkomat']]);
    expect(uwagi).toEqual([{ id: 7, numer: 'PC-7', tresc: 'za pobraniem — kurier zainkasuje 87.40 zł' }]);
  });

  it('włączone: paczkomat Allegro za pobraniem idzie naszym InPostem z kwotą z zamówienia', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ sklep: 'allegro_polcien', metoda_wysylki: 'allegro_paczkomat' })], UMOWA);
    expect(pominiete).toEqual([]);
    expect(doNadania[0].metodaUzyta).toBe('inpost_paczkomat');
  });

  it('włączone: paczkomat bez kwoty odpada — InPost nie może dostać paczki bez cod', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ kwota_pobrania: null })], UMOWA);
    expect(doNadania).toEqual([]);
    expect(pominiete).toEqual([{ id: 7, numer: 'PC-7', powod: 'pobranie bez kwoty — uzupełnij kwotę pobrania na karcie zamówienia' }]);
  });

  it.each(['0.00', '', '87.', '1e2'])('włączone: paczkomat z niepoprawną kwotą „%s” odpada', (kwota) => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ kwota_pobrania: kwota })], UMOWA);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toBe(`kwota pobrania jest niepoprawna — popraw ją na karcie zamówienia („${kwota}”)`);
  });

  it('wyłączone (brak parametru, [] albo inny kurier): ręczne odpada z odmową, także bez kwoty', () => {
    for (const opcje of [undefined, {}, { umowyPobrania: [] }, { umowyPobrania: ['dpd'] }]) {
      for (const kwota of ['87.40', null, '0.00']) {
        const { doNadania, pominiete } = podzielDoNadania([zam({ sklep: 'reczne', kwota_pobrania: kwota })], opcje as any);
        expect(doNadania).toEqual([]);
        expect(pominiete).toEqual([{ id: 7, numer: 'PC-7', powod: ODMOWA }]);
      }
    }
  });

  it('włączone: DPD i WzA za pobraniem bez zmian', () => {
    const dpd = podzielDoNadania([zam({ metoda_wysylki: 'dpd', kwota_pobrania: null })], UMOWA);
    expect(dpd.pominiete[0].powod).toBe('pobranie bez kwoty — uzupełnij kwotę pobrania na karcie zamówienia');
    const wza = podzielDoNadania([zam({ sklep: 'allegro_polcien', metoda_wysylki: 'allegro_dpd', kwota_pobrania: null })], UMOWA);
    expect(wza.pominiete).toEqual([]);
    expect(wza.doNadania[0].rodzajFormularza).toBe('wza');
  });
});
