import { describe, it, expect } from 'vitest';
import { modelOswiadczenia } from '../../src/domena/oswiadczenie-wywozu.js';

const SPRZEDAWCA = {
  nazwa: 'Lumina Marek Zywiecki', ulica: '1 Maja 5', kod: '00-650', miasto: 'Pęki', nip: '1234563218',
};

const zamowienieWdt = (nad = {}) => ({
  numer: 'R/2026/031',
  nip: 'SK1000000001',
  klient: {
    company: 'Alfatrend s.r.o.', address_1: '1. mája 1', postcode: '01001', city: 'Žilina',
  },
  faktura: { numer: 'WDT/1/08/2026' },
  pozycje: [
    { nazwa: 'Lampa stołowa Kałamarz 30x45cm', ilosc: 2, cena_brutto: '40.24' },
    { nazwa: 'Kurier DPD', ilosc: 1, cena_brutto: '16.00' },
  ],
  ...nad,
});

describe('modelOswiadczenia', () => {
  it('składa strony, państwo z prefiksu i pozycje ILOŚCIOWE (bez kwot)', () => {
    const m = modelOswiadczenia(zamowienieWdt(), { sprzedawca: SPRZEDAWCA, dzis: '2026-08-26' });
    expect(m.sprzedawca.nip).toBe('PL1234563218');
    expect(m.nabywca.nip).toBe('SK1000000001');
    expect(m.nabywca.nazwa).toBe('Alfatrend s.r.o.');
    expect(m.panstwo).toBe('Słowacji');
    expect(m.kodPanstwa).toBe('SK');
    expect(m.fakturaNumer).toBe('WDT/1/08/2026');
    expect(m.pozycje).toEqual([
      { lp: 1, nazwa: 'Lampa stołowa Kałamarz 30x45cm', ilosc: 2 },
      { lp: 2, nazwa: 'Kurier DPD', ilosc: 1 },
    ]);
    // Dokument ilościowy: żadna kwota nie ma prawa przeciec do modelu.
    expect(JSON.stringify(m)).not.toContain('40.24');
  });

  it('NIP sprzedawcy z konfiguracji już z prefiksem nie dubluje PL', () => {
    const m = modelOswiadczenia(zamowienieWdt(), { sprzedawca: { ...SPRZEDAWCA, nip: 'PL1234563218' } });
    expect(m.sprzedawca.nip).toBe('PL1234563218');
  });

  it('zamówienie bez faktury daje fakturaNumer null — dokument da się przygotować wcześniej', () => {
    const m = modelOswiadczenia(zamowienieWdt({ faktura: undefined }), { sprzedawca: SPRZEDAWCA });
    expect(m.fakturaNumer).toBeNull();
  });

  it('odmawia dla nabywcy krajowego — to dokument wyłącznie WDT', () => {
    expect(() => modelOswiadczenia(zamowienieWdt({ nip: '1000001106' }), { sprzedawca: SPRZEDAWCA }))
      .toThrow(/WDT|VAT-UE/);
  });

  it('odmawia bez adresu sprzedawcy i bez pozycji — dokument połowiczny kłamie', () => {
    expect(() => modelOswiadczenia(zamowienieWdt(), { sprzedawca: { nip: '1234563218' } }))
      .toThrow(/sprzedawcy/i);
    expect(() => modelOswiadczenia(zamowienieWdt({ pozycje: [] }), { sprzedawca: SPRZEDAWCA }))
      .toThrow(/pozycji/i);
  });

  // Ręczna poprawka danych nabywcy na karcie wygrywa — ta sama reguła co faktura
  // (daneFaktury), więc dokument wywozu i faktura nazywają nabywcę tak samo.
  it('nadpisania ręczne nabywcy wchodzą do dokumentu', () => {
    const m = modelOswiadczenia(zamowienieWdt({
      klient_reczny_json: JSON.stringify({ firma: 'ALFATREND s. r. o. (oddział)' }),
    }), { sprzedawca: SPRZEDAWCA });
    expect(m.nabywca.nazwa).toBe('ALFATREND s. r. o. (oddział)');
  });
});
