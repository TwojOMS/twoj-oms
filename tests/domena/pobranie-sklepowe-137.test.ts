// PRZ-137.01 — „pobranie ze sklepu” (decyzja właściciela 03.11: „jeżeli sklep ma aktywne paczkomaty pobranie
// to oms też powinien to obsługiwać”). Zamówienie ze sklepu za pobraniem jedzie z kwotą pobrania niezależnie
// od przełącznika „umowa na pobranie w InPoście”; przełącznik dotyczy tylko pobrania, które proponuje OMS
// (zamówienie ręczne, metoda albo pobranie zmienione na karcie). Plan: docs/plany/PRZ-137-pobranie-sklepowe.md, D1.
// Dane zmyślone.
import { describe, expect, it } from 'vitest';
import { czyKanalWbudowany } from '../../src/domena/kanaly.js';
import { pobranieSklepowe, wymagaUmowyPobrania } from '../../src/domena/kurier-nadania.js';
import { podzielDoNadania } from '../../src/domena/masowe.js';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';

const UMOWA = { umowyPobrania: ['inpost'] };
const POWOD = 'pobranie przez InPost wymaga umowy — włącz ją w Ustawieniach → Integracje albo zmień kuriera na karcie zamówienia';

// Zamówienie z WooCommerce „Pracowni Półcień”: paczkomat InPost za pobraniem, nieopłacone.
const zam = (nad: Record<string, unknown> = {}) => ({
  id: 37, numer: 'PC-137', sklep: 'polcien', metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'POL01A',
  anulowane: 0, oplacone_at: null, przesylki: [], pobranie: 1, kwota_pobrania: '212.90', ...nad,
});
const nadpisanie = (o: Record<string, unknown>) => JSON.stringify(o);

describe('czyKanalWbudowany', () => {
  it('ręczne i indywidualne to kanały OMS-u, sklepy nie', () => {
    expect(czyKanalWbudowany('reczne')).toBe(true);
    expect(czyKanalWbudowany('indywidualne')).toBe(true);
    expect(czyKanalWbudowany('polcien')).toBe(false);
    expect(czyKanalWbudowany('allegro_polcien')).toBe(false);
  });
});

describe('pobranieSklepowe (D1)', () => {
  it('sklep sprzedał paczkomat za pobraniem i nikt tego nie zmienił → sklepowe', () => {
    expect(pobranieSklepowe(zam())).toBe(true);
    expect(pobranieSklepowe(zam({ sklep: 'allegro_polcien', metoda_wysylki: 'allegro_paczkomat' }))).toBe(true);
  });

  it('zamówienie ręczne albo indywidualne → pobranie OMS-owe', () => {
    expect(pobranieSklepowe(zam({ sklep: 'reczne' }))).toBe(false);
    expect(pobranieSklepowe(zam({ sklep: 'indywidualne' }))).toBe(false);
  });

  it('brak kanału → nie zgadujemy, że to sklep (surowiej, nie luźniej)', () => {
    expect(pobranieSklepowe(zam({ sklep: undefined }))).toBe(false);
    expect(pobranieSklepowe(zam({ sklep: '' }))).toBe(false);
  });

  it('metoda zmieniona na karcie (DPD → paczkomat) → OMS-owe', () => {
    const z = zam({
      metoda_wysylki: 'dpd', punkt_odbioru: null,
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL01A' }),
    });
    expect(pobranieSklepowe(z)).toBe(false);
  });

  it('pobranie włączone na karcie przy sklepowej przedpłacie → OMS-owe', () => {
    const z = zam({
      pobranie: 0, kwota_pobrania: null,
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90' }),
    });
    expect(pobranieSklepowe(z)).toBe(false);
  });

  it('pobranie wyłączone na karcie → nie ma pobrania, więc nie ma też sklepowego', () => {
    const z = zam({ wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 0 }) });
    expect(pobranieSklepowe(z)).toBe(false);
  });

  it('zmieniony tylko punkt odbioru (i kwota) → dalej sklepowe', () => {
    const z = zam({ wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '200.00', punkt_odbioru: 'POL02B' }) });
    expect(pobranieSklepowe(z)).toBe(true);
  });

  it('sklep bez pobrania → nie sklepowe', () => {
    expect(pobranieSklepowe(zam({ pobranie: 0, kwota_pobrania: null }))).toBe(false);
  });
});

describe('wymagaUmowyPobrania (D2)', () => {
  it('sklepowe pobranie do paczkomatu nie wymaga umowy firmy', () => {
    expect(wymagaUmowyPobrania(zam(), 'inpost_paczkomat', MODULY_KURIEROW, [])).toBe(false);
  });

  it('OMS-owe pobranie do paczkomatu: bez umowy tak, z umową nie', () => {
    const z = zam({ sklep: 'reczne' });
    expect(wymagaUmowyPobrania(z, 'inpost_paczkomat', MODULY_KURIEROW, [])).toBe(true);
    expect(wymagaUmowyPobrania(z, 'inpost_paczkomat')).toBe(true);
    expect(wymagaUmowyPobrania(z, 'inpost_paczkomat', MODULY_KURIEROW, ['dpd'])).toBe(true);
    expect(wymagaUmowyPobrania(z, 'inpost_paczkomat', MODULY_KURIEROW, ['inpost'])).toBe(false);
  });

  it('kurier z „umowa” (DPD) nigdy nie wymaga przełącznika', () => {
    expect(wymagaUmowyPobrania(zam({ sklep: 'reczne', metoda_wysylki: 'dpd' }), 'dpd', MODULY_KURIEROW, [])).toBe(false);
  });

  it('bez pobrania nie ma czego wymagać', () => {
    expect(wymagaUmowyPobrania(zam({ sklep: 'reczne', pobranie: 0, kwota_pobrania: null }), 'inpost_paczkomat', MODULY_KURIEROW, [])).toBe(false);
  });

  it('nazwa kuriera i rodzaj pobrania z podanego rejestru, nie na sztywno', () => {
    const rejestr: any = {
      ...MODULY_KURIEROW,
      inpost: { ...MODULY_KURIEROW.inpost, umiejetnosci: { ...MODULY_KURIEROW.inpost.umiejetnosci, pobranie: 'umowa' } },
    };
    expect(wymagaUmowyPobrania(zam({ sklep: 'reczne' }), 'inpost_paczkomat', rejestr, [])).toBe(false);
  });
});

describe('nadanie hurtem: pobranie sklepowe przy wyłączonym przełączniku', () => {
  it('Woo paczkomat za pobraniem → do nadania z uwagą o inkasie', () => {
    const { doNadania, pominiete, uwagi } = podzielDoNadania([zam()]);
    expect(pominiete).toEqual([]);
    expect(doNadania.map((z: any) => [z.metodaUzyta, z.rodzajFormularza])).toEqual([['inpost_paczkomat', 'paczkomat']]);
    expect(uwagi).toEqual([{ id: 37, numer: 'PC-137', tresc: 'za pobraniem — kurier zainkasuje 212.90 zł' }]);
  });

  it('Allegro paczkomat za pobraniem → naszym InPostem do nadania', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ sklep: 'allegro_polcien', metoda_wysylki: 'allegro_paczkomat' })]);
    expect(pominiete).toEqual([]);
    expect(doNadania[0].metodaUzyta).toBe('inpost_paczkomat');
  });

  it('sklepowe bez kwoty dalej odpada — paczka nie pojedzie bez cod', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ kwota_pobrania: null })]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toBe('pobranie bez kwoty — uzupełnij kwotę pobrania na karcie zamówienia');
  });

  it('zmieniony tylko punkt → do nadania', () => {
    const z = zam({ wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL02B' }) });
    const { doNadania, pominiete } = podzielDoNadania([z]);
    expect(pominiete).toEqual([]);
    expect(doNadania).toHaveLength(1);
  });

  it('ręczne paczkomat + pobranie → pominięte z neutralnym powodem', () => {
    for (const sklep of ['reczne', 'indywidualne']) {
      const { doNadania, pominiete } = podzielDoNadania([zam({ sklep })]);
      expect(doNadania).toEqual([]);
      expect(pominiete).toEqual([{ id: 37, numer: 'PC-137', powod: POWOD }]);
    }
  });

  it('ręczne paczkomat + pobranie z włączonym przełącznikiem → do nadania', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ sklep: 'reczne' })], UMOWA);
    expect(pominiete).toEqual([]);
    expect(doNadania).toHaveLength(1);
  });

  it('metoda zmieniona na karcie (DPD → paczkomat) → pominięte', () => {
    const z = zam({
      metoda_wysylki: 'dpd', punkt_odbioru: null,
      wysylka_reczna_json: nadpisanie({ metoda: 'inpost_paczkomat', pobranie: 1, kwota_pobrania: '212.90', punkt_odbioru: 'POL01A' }),
    });
    const { doNadania, pominiete } = podzielDoNadania([z]);
    expect(doNadania).toEqual([]);
    expect(pominiete).toEqual([{ id: 37, numer: 'PC-137', powod: POWOD }]);
  });

  it('powód nie zakłada DPD', () => {
    expect(POWOD).not.toMatch(/DPD/);
  });
});
