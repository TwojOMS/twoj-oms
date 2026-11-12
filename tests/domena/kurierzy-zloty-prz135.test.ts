// PRZ-135.01 — ZŁOTE TESTY dzisiejszego zachowania kurierów. Wartości oczekiwane są wpisane na sztywno
// (zmierzone 03.11 w fb84a210), nie liczone z kodu. Zmiana którejkolwiek = zmiana zachowania panelu
// (nadanie paczki, pieniądze przy pobraniu, linki śledzenia) i wymaga świadomej decyzji w opisie commitu.
import { describe, expect, it } from 'vitest';
import { wybierzKuriera, kurierWpisuRecznego } from '../../src/oms/kurierzy/index.js';
import { METODY_WYSYLKI, ETYKIETY_WYSYLKI } from '../../src/domena/wysylka.js';
import { kurierzyDoWyboru, metodaNadania, METODY_Z_ZPL, nadanieDaZpl } from '../../src/domena/kurier-nadania.js';
import { rodzajFormularzaNadania } from '../../src/domena/masowe.js';
import { PRZEWOZNICY, przewoznikPrzesylki, adresSledzenia } from '../../src/domena/przewoznik-przesylki.js';
import { linkDoSledzenia } from '../../src/domena/tracking.js';
import { sledzeniePrzesylki } from '../../src/domena/sledzenie-przesylki.js';

const PELNA: any = { dpd: {}, inpost: {}, allegro_wza: {} };
const BRAK_METODY = (m: string) => `Metoda „${m}” nie jest obsługiwana w tym panelu.`;
const BRAK_KLIENTA = (k: string) => `Kurier ${k} nie jest skonfigurowany.`;

describe('wybierzKuriera — dzisiejsza mapa metod na integracje', () => {
  // [metoda, kurier z pełną mapą albo tekst odmowy, tekst odmowy przy pustej mapie]
  const TABELA: [string, string, string][] = [
    ['dpd', 'dpd', BRAK_KLIENTA('dpd')],
    ['inpost_paczkomat', 'inpost', BRAK_KLIENTA('inpost')],
    ['odbior_osobisty', BRAK_METODY('odbior_osobisty'), BRAK_METODY('odbior_osobisty')],
    ['allegro_dpd', 'allegro_wza', BRAK_KLIENTA('allegro_wza')],
    ['allegro_paczkomat', BRAK_METODY('allegro_paczkomat'), BRAK_METODY('allegro_paczkomat')],
    ['allegro_punkt', 'allegro_wza', BRAK_KLIENTA('allegro_wza')],
    ['allegro_kurier', 'allegro_wza', BRAK_KLIENTA('allegro_wza')],
    ['allegro_inne', 'allegro_wza', BRAK_KLIENTA('allegro_wza')],
    ['nieznana', BRAK_METODY('nieznana'), BRAK_METODY('nieznana')],
    ['', BRAK_METODY(''), BRAK_METODY('')],
  ];
  it.each(TABELA)('%s z pełną mapą', (metoda, oczekiwane) => {
    if (oczekiwane.endsWith('w tym panelu.')) {
      expect(() => wybierzKuriera(metoda, PELNA)).toThrow(oczekiwane);
    } else {
      const w = wybierzKuriera(metoda, PELNA);
      expect(w.nazwa).toBe(oczekiwane);
      expect(w.klient).toBe(PELNA[oczekiwane]);
    }
  });
  it.each(TABELA)('%s z pustą mapą', (metoda, _pelna, odmowaPustej) => {
    expect(() => wybierzKuriera(metoda, {} as any)).toThrow(odmowaPustej);
  });
  it('teksty odmów dosłownie', () => {
    expect(() => wybierzKuriera('odbior_osobisty', PELNA)).toThrow('Metoda „odbior_osobisty” nie jest obsługiwana w tym panelu.');
    expect(() => wybierzKuriera('dpd', {} as any)).toThrow('Kurier dpd nie jest skonfigurowany.');
  });
});

describe('kurierWpisuRecznego', () => {
  it.each([
    ['dpd', 'dpd'],
    ['inpost_paczkomat', 'inpost'],
    ['odbior_osobisty', 'dpd'], // zapasowe 'dpd' dla metody nieznanej (dziwność: odbiór osobisty też)
    ['allegro_dpd', 'allegro'],
    ['allegro_paczkomat', 'allegro'],
    ['allegro_punkt', 'allegro'],
    ['allegro_kurier', 'allegro'],
    ['allegro_inne', 'allegro'],
    [null, 'dpd'],
  ])('%s → %s', (metoda, oczekiwany) => {
    expect(kurierWpisuRecznego(metoda)).toBe(oczekiwany);
  });
});

describe('METODY_WYSYLKI i ETYKIETY_WYSYLKI', () => {
  it('kolejność metod', () => {
    expect([...METODY_WYSYLKI]).toEqual([
      'dpd', 'inpost_paczkomat', 'odbior_osobisty',
      'allegro_dpd', 'allegro_paczkomat', 'allegro_punkt', 'allegro_kurier', 'allegro_inne',
    ]);
  });
  it('etykiety — całość', () => {
    expect(ETYKIETY_WYSYLKI).toEqual({
      dpd: 'Kurier DPD',
      inpost_paczkomat: 'InPost Paczkomat',
      odbior_osobisty: 'Odbiór osobisty',
      allegro_dpd: 'Allegro Kurier DPD',
      allegro_paczkomat: 'Allegro Paczkomat InPost',
      allegro_punkt: 'Allegro punkt / automat',
      allegro_kurier: 'Allegro One Kurier',
      allegro_inne: 'Allegro — inna metoda',
      // PRZ-157.07e: metoda kuriera Przesyłki Erli — nazwa z rejestru, choć nie ma jej w METODY_WYSYLKI.
      erli_przesylki: 'Przesyłki Erli',
      nieznana: 'Nieznana metoda',
    });
  });
});

describe('kurierzyDoWyboru — metoda × pobranie × numer paczki', () => {
  const WZA = 'wza|Wysyłam z Allegro — umowa Allegro (domyślnie)';
  const DPD = 'dpd|DPD — nasza umowa';
  const PACZ = 'inpost_paczkomat|Paczkomat InPost — nasza umowa';
  const pary = (m: string, pobranie: number, paczka: number) =>
    kurierzyDoWyboru({ metoda_wysylki: m, pobranie } as any, paczka).map((k: any) => `${k.klucz}|${k.etykieta}`);
  // [metoda, pobranie, paczka, oczekiwane]
  const TABELA: [string, number, number, string[]][] = [];
  for (const m of ['dpd', 'inpost_paczkomat', 'allegro_paczkomat']) {
    TABELA.push([m, 0, 1, [DPD, PACZ]], [m, 0, 2, [DPD, PACZ]], [m, 1, 1, [DPD]], [m, 1, 2, [DPD, PACZ]]);
  }
  for (const m of ['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne']) {
    TABELA.push([m, 0, 1, [WZA, DPD, PACZ]], [m, 0, 2, [WZA, DPD, PACZ]], [m, 1, 1, [WZA, DPD]], [m, 1, 2, [WZA, DPD, PACZ]]);
  }
  it('tabela ma 7 metod × 4 kombinacje', () => { expect(TABELA).toHaveLength(28); });
  it.each(TABELA)('%s pobranie=%i paczka=%i', (m, pobranie, paczka, oczekiwane) => {
    expect(pary(m, pobranie, paczka)).toEqual(oczekiwane);
  });
  it('pobranie na paczce nr 2 jedzie tylko gdy wskazano wprost (zamiennik) — wtedy znów sam DPD', () => {
    const z: any = { metoda_wysylki: 'inpost_paczkomat', pobranie: 1 };
    expect(kurierzyDoWyboru(z, 2, { pobranieNaTejPaczce: true } as any).map((k: any) => k.klucz)).toEqual(['dpd']);
    expect(kurierzyDoWyboru(z, 1, { pobranieNaTejPaczce: false } as any).map((k: any) => k.klucz)).toEqual(['dpd', 'inpost_paczkomat']);
  });
});

describe('metodaNadania', () => {
  it('zamówienie Allegro (allegro_dpd) z wyborem inpost_paczkomat → nadajemy sami, ręcznie', () => {
    expect(metodaNadania({ sklep: 'allegro_a', metoda_wysylki: 'allegro_dpd' } as any, 'inpost_paczkomat'))
      .toEqual({ metoda: 'inpost_paczkomat', wskazanyRecznie: true, metodaZamowienia: 'allegro_dpd' });
  });
  it('allegro_punkt z wyborem inpost_paczkomat', () => {
    expect(metodaNadania({ sklep: 'allegro_a', metoda_wysylki: 'allegro_punkt' } as any, 'inpost_paczkomat'))
      .toEqual({ metoda: 'inpost_paczkomat', wskazanyRecznie: true, metodaZamowienia: 'allegro_punkt' });
  });
  it('allegro_inne bez wyboru → metoda domyślna WzA', () => {
    expect(metodaNadania({ sklep: 'allegro_a', metoda_wysylki: 'allegro_inne' } as any, '')).toEqual({ metoda: 'allegro_inne' });
  });
  it('allegro_paczkomat → zawsze nasz InPost, wybór ignorowany', () => {
    expect(metodaNadania({ sklep: 'allegro_a', metoda_wysylki: 'allegro_paczkomat' } as any, 'dpd')).toEqual({ metoda: 'inpost_paczkomat' });
  });
  it('zamówienie sklepowe z wyborem inpost_paczkomat → wybór IGNOROWANY (pieniądze przy pobraniu)', () => {
    expect(metodaNadania({ sklep: 'woo', metoda_wysylki: 'dpd', pobranie: 1 } as any, 'inpost_paczkomat')).toEqual({ metoda: 'dpd' });
  });
  it('Allegro z wyborem spoza listy → odmowa dosłownie', () => {
    expect(metodaNadania({ sklep: 'allegro_a', metoda_wysylki: 'allegro_dpd', pobranie: 1 } as any, 'inpost_paczkomat')).toEqual({
      blad: 'Nie umiem nadać tej paczki jako „inpost_paczkomat" — do wyboru jest '
        + 'Wysyłam z Allegro — umowa Allegro (domyślnie) albo DPD — nasza umowa. Panel niczego nie nadał.',
    });
  });
});

describe('ZPL i rodzaj formularza nadania', () => {
  it('METODY_Z_ZPL', () => {
    expect([...METODY_Z_ZPL]).toEqual(['dpd', 'inpost_paczkomat', 'allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne']);
  });
  // [metoda, nadanieDaZpl, rodzajFormularzaNadania]
  it.each<[string, boolean, string | null]>([
    ['dpd', true, 'dpd'],
    ['inpost_paczkomat', true, 'paczkomat'],
    ['odbior_osobisty', false, null],
    ['allegro_dpd', true, 'wza'],
    ['allegro_paczkomat', false, null],
    ['allegro_punkt', true, 'wza'],
    ['allegro_kurier', true, 'wza'],
    ['allegro_inne', true, 'wza'],
  ])('%s → ZPL=%s, formularz=%s', (metoda, zpl, rodzaj) => {
    expect(nadanieDaZpl(metoda)).toBe(zpl);
    expect(rodzajFormularzaNadania(metoda)).toBe(rodzaj);
  });
  it('null → bez ZPL, bez formularza', () => {
    expect(nadanieDaZpl(null)).toBe(false);
    expect(rodzajFormularzaNadania(null)).toBeNull();
  });
});

describe('przewoźnik przesyłki i linki śledzenia', () => {
  it('PRZEWOZNICY — klucze w kolejności', () => {
    expect(Object.keys(PRZEWOZNICY)).toEqual(['dpd', 'inpost', 'dhl', 'orlen', 'allegro-one', 'packeta']);
  });
  // [wejście, klucz przewoźnika] — po jednym wierszu na każdą regułę
  it.each<[Record<string, string>, string | null]>([
    [{ kurier: 'dpd' }, 'dpd'],
    [{ kurier: 'inpost', metoda: 'dpd' }, 'inpost'], // kod nadania ważniejszy niż metoda
    [{ carrierAllegro: 'inpost' }, 'inpost'],
    [{ carrierAllegro: 'PACKETA' }, 'packeta'],
    [{ nazwaUslugi: 'Allegro Automaty Paczkowe Packeta, ORLEN Paczka' }, 'packeta'],
    [{ nazwaUslugi: 'Allegro One Box, DPD' }, 'dpd'],
    [{ nazwaUslugi: 'Allegro One Kurier - dostawa jutro' }, 'allegro-one'],
    [{ nazwaUslugi: 'Allegro Kurier DHL' }, 'dhl'],
    [{ nazwaUslugi: 'Allegro InPost Paczkomaty 24/7' }, 'inpost'],
    [{ nazwaUslugi: 'ORLEN Paczka' }, 'orlen'],
    [{ nazwaUslugi: 'Phone' }, null],
    [{ metoda: 'dpd' }, 'dpd'],
    [{ metoda: 'allegro_dpd' }, 'dpd'],
    [{ metoda: 'inpost_paczkomat' }, 'inpost'],
    [{ metoda: 'allegro_paczkomat' }, 'inpost'],
    [{ metoda: 'allegro_kurier' }, 'allegro-one'],
    [{ metoda: 'allegro_punkt' }, null],
    [{ metoda: 'allegro_inne' }, null],
    [{ kurier: 'allegro_wza' }, null],
    [{}, null],
  ])('%j → %s', (wejscie, klucz) => {
    expect(przewoznikPrzesylki(wejscie)?.klucz ?? null).toBe(klucz);
  });
  it.each([
    ['dpd', 'https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=X1'],
    ['inpost', 'https://inpost.pl/sledzenie-przesylek?number=X1'],
    ['dhl', 'https://www.dhl.com/pl-pl/home/sledzenie-przesylek.html?tracking-id=X1'],
    ['orlen', 'https://www.orlenpaczka.pl/sledz-paczke/?numer=X1'],
    ['allegro-one', 'https://allegro.pl/allegrodelivery/sledzenie-paczki?numer=X1'],
    ['packeta', 'https://tracking.packeta.com/pl/?id=X1'],
  ])('adresSledzenia(%s)', (klucz, adres) => {
    expect(adresSledzenia(klucz, 'X1')).toBe(adres);
  });
  it('linkDoSledzenia — DPD z typ=1 (ten sam co adresSledzenia, decyzja właściciela T1), InPost, WzA i Allegro bez linku', () => {
    expect(linkDoSledzenia('dpd', 'X1')).toBe('https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=X1');
    expect(linkDoSledzenia('inpost', 'X1')).toBe('https://inpost.pl/sledzenie-przesylek?number=X1');
    expect(linkDoSledzenia('allegro_wza', 'X1')).toBeNull();
    expect(linkDoSledzenia('allegro', 'X1')).toBeNull();
  });
});

describe('sledzeniePrzesylki dla WzA', () => {
  const surowa = (carrierId: string, carrierWaybill: string) => JSON.stringify({
    carrier: 'DPD', packages: [{ waybill: 'AL1' }], transportingInfo: { carrierId, carrierWaybill },
  });
  const dpd = { nazwa: 'klient-dpd' };
  const allegro = { nazwa: 'klient-allegro' };
  const wza = (id: string, wb: string, numer = 'AL1') => ({ kurier: 'allegro_wza', odpowiedz_surowa: surowa(id, wb), numer_listu: numer });

  it('podwykonawca DPD z kanałem → pytamy DPD jego numerem', () => {
    const w = sledzeniePrzesylki(wza('DPD', 'DW9'), { dpd, allegro } as any);
    expect(w).toEqual({ klient: dpd, numer: 'DW9', podwykonawca: 'DPD' });
    expect(w!.klient).toBe(dpd);
  });
  it('podwykonawca DPD, ale klient DPD bez śledzenia → odczyt Allegro numerem allegrowym', () => {
    const w = sledzeniePrzesylki(wza('DPD', 'DW9'), { dpd: { bezSledzenia: true }, allegro } as any);
    expect(w).toEqual({ klient: allegro, numer: 'AL1', podwykonawca: null, kontekst: { carrier: 'DPD' } });
  });
  it('podwykonawca DPD, brak klienta DPD → odczyt Allegro', () => {
    const w = sledzeniePrzesylki(wza('DPD', 'DW9'), { allegro } as any);
    expect(w).toEqual({ klient: allegro, numer: 'AL1', podwykonawca: null, kontekst: { carrier: 'DPD' } });
  });
  it('inny podwykonawca (nie DPD) → odczyt Allegro, nigdy numer podwykonawcy', () => {
    const w = sledzeniePrzesylki(wza('OTHER', 'OW9'), { dpd, allegro } as any);
    expect(w).toEqual({ klient: allegro, numer: 'AL1', podwykonawca: null, kontekst: { carrier: 'DPD' } });
  });
  it('bez klienta Allegro albo z numerem spoza pakietów → null', () => {
    expect(sledzeniePrzesylki(wza('OTHER', 'OW9'), { dpd } as any)).toBeNull();
    expect(sledzeniePrzesylki(wza('OTHER', 'OW9', 'ZZ'), { dpd, allegro } as any)).toBeNull();
  });
});
