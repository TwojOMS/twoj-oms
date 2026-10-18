// PRZ-092 — reguły formularza kuriera DPD w Ustawieniach (czyste funkcje).
import { describe, it, expect } from 'vitest';
import { sprawdzFormularzDpd, opcjeKlientaDpd, ADRESY_DPD } from '../../src/domena/konfiguracja-dpd.js';
import { sledzeniePrzesylki } from '../../src/domena/sledzenie-przesylki.js';

const OK = { nazwa: 'DPD', login: '11112222', fid: '333444', haslo: 'h', typEtykiety: 'LBL_PRINTER' };

describe('sprawdzFormularzDpd', () => {
  it('poprawny formularz: bez błędów, przycięte pola, hasło dosłownie (spacje w środku hasła zostają)', () => {
    const w = sprawdzFormularzDpd({ ...OK, login: ' 11112222 ', haslo: 'a b ' });
    expect(w.bledy).toEqual([]);
    expect(w.ustawienia).toEqual({ nazwa: 'DPD', login: '11112222', fid: '333444', typEtykiety: 'LBL_PRINTER' });
    expect(w.sekrety).toEqual({ haslo: 'a b ', kanal: '' });
  });

  it('każde pole wymagane ma własny powód', () => {
    const w = sprawdzFormularzDpd({});
    expect(w.bledy).toEqual(['Podaj nazwę — dowolną, np. „DPD”.', 'Podaj login od DPD.',
      'Podaj główny numer klienta DPD (Master FID).', 'Wybierz typ etykiety.', 'Podaj hasło od DPD.']);
  });

  it('Master FID tylko cyfry; nieznany typ etykiety odrzucony; za długa nazwa', () => {
    expect(sprawdzFormularzDpd({ ...OK, fid: '12-34' }).bledy).toEqual(['Główny numer klienta DPD (Master FID) to same cyfry.']);
    expect(sprawdzFormularzDpd({ ...OK, typEtykiety: 'A6' }).bledy).toEqual(['Wybierz typ etykiety.']);
    expect(sprawdzFormularzDpd({ ...OK, nazwa: 'x'.repeat(61) }).bledy).toEqual(['Nazwa może mieć najwyżej 60 znaków.']);
  });

  it('puste hasło i kanał przy istniejącym zapisie = zostaw zapisane; samo białe hasło też', () => {
    const zapisane = { ustawienia: {}, sekrety: { haslo: 'stare', kanal: 'K1' } };
    const w = sprawdzFormularzDpd({ ...OK, haslo: '   ', kanal: '' }, zapisane);
    expect(w.bledy).toEqual([]);
    expect(w.sekrety).toEqual({ haslo: 'stare', kanal: 'K1' });
    expect(sprawdzFormularzDpd({ ...OK, haslo: 'nowe', kanal: 'K2' }, zapisane).sekrety).toEqual({ haslo: 'nowe', kanal: 'K2' });
  });
});

describe('opcjeKlientaDpd', () => {
  const zapis = { ustawienia: { login: 'l', fid: '1', typEtykiety: 'A4' }, sekrety: { haslo: 'h', kanal: '' } };
  it('bez kanału: brak usługi zdarzeń (OMS nadaje, nie śledzi)', () => {
    expect(opcjeKlientaDpd(zapis, { nazwa: 'N' })).toEqual({ url: ADRESY_DPD.url, login: 'l', haslo: 'h', fid: '1',
      infoUrl: '', channel: '', formatEtykiety: 'A4', nadawca: { nazwa: 'N' } });
  });
  it('z kanałem: adres usługi zdarzeń DPD Info', () => {
    const o = opcjeKlientaDpd({ ...zapis, sekrety: { haslo: 'h', kanal: 'K' } }, null);
    expect(o).toMatchObject({ infoUrl: ADRESY_DPD.infoUrl, channel: 'K' });
  });
});

// Recenzja PRZ-092 (P2): DPD z Ustawień bez kanału DPD Info ma `bezSledzenia: true`. Paczka WzA jadąca DPD nie może
// wtedy trafić do naszego klienta DPD (stałby błąd „brak konfiguracji usługi zdarzeń”) — śledzi ją Allegro, jak dotąd.
describe('śledzenie WzA a DPD bez kanału DPD Info', () => {
  const surowa = JSON.stringify({ carrier: 'DPD', carrierTrackingData: { carrierId: 'DPD', carrierWaybill: '1049419215075U' },
    packages: [{ waybill: 'AD0WZA1' }] });
  const paczka = { kurier: 'allegro_wza', numer_listu: 'AD0WZA1', odpowiedz_surowa: surowa };
  const allegro = { statusPrzesylki: () => {} };
  it('DPD bez śledzenia → Allegro; DPD ze śledzeniem → DPD numerem podwykonawcy', () => {
    expect(sledzeniePrzesylki(paczka, { dpd: { bezSledzenia: true }, allegro, allegro_wza: { bezSledzenia: true } }))
      .toMatchObject({ klient: allegro, numer: 'AD0WZA1' });
    const dpd = { bezSledzenia: false, statusPrzesylki: () => {} };
    expect(sledzeniePrzesylki(paczka, { dpd, allegro, allegro_wza: { bezSledzenia: true } }))
      .toMatchObject({ klient: dpd, numer: '1049419215075U' });
  });
});
