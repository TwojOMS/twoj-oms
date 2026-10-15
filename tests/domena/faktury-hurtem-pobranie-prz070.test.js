import { describe, it, expect } from 'vitest';
import { podzielDoFaktury, wariantFakturyHurtem, ETYKIETA_WARIANTU } from '../../src/domena/masowe.js';

// PRZ-070 (właściciel 14.10.2026): faktura hurtem obejmuje zamówienia za pobraniem — wariant
// z tej samej reguły, co formularz karty (terminFaktury + proponowanaDataSprzedazy).
const POZYCJA = { nazwa: 'STOP 70x100', sku: 'STOP-70', ilosc: 1, cena_brutto: '104.00', brutto_linii: '104.00' };
const zam = (n) => ({
  id: 1, numer: '1589', utworzone_at: '2026-10-13T13:13:48Z', okres_rozliczeniowy_id: null, anulowane: 0,
  chce_fakture: 1, nip: '1000001052', kwota_brutto: '104.00', pozycje: [POZYCJA], platnosci: [], faktura: null,
  wyslane_at: null, ...n,
});

describe('PRZ-070: faktura hurtem dla pobrania', () => {
  it('pobranie nieopłacone przechodzi wariantem „przy odbiorze”, data sprzedaży = dziś (brak wysyłki)', () => {
    const z = zam({ pobranie: 1, kwota_pobrania: '104.00' });
    expect(podzielDoFaktury([z]).doWystawienia).toHaveLength(1);
    expect(wariantFakturyHurtem(z, '2026-10-14')).toEqual({ termin: 'przy_odbiorze', dataSprzedazy: '2026-10-14' });
  });

  // ⚠️ Sklep zapisuje „wpłatę” z metodą „Za pobraniem” przy oznaczeniu zamówienia (pomiar
  // 31.08, zamówienie 1259) — suma wpłat kłamie, że zapłacono. Karta to odsiewa, hurt też.
  it('inkaso kuriera zapisane jako wpłata NIE robi z pobrania „zapłacone”', () => {
    const z = zam({
      pobranie: 1, kwota_pobrania: '104.00', wyslane_at: '2026-10-13T15:00:00Z',
      platnosci: [{ kwota: '104.00', data: '2026-10-13T15:00:02Z', metoda: 'Za pobraniem' }],
    });
    expect(wariantFakturyHurtem(z)).toEqual({ termin: 'przy_odbiorze', dataSprzedazy: '2026-10-13' });
  });

  it('pobranie przedpłacone przelewem przed wysyłką → „zapłacone” z datą przelewu', () => {
    const z = zam({
      pobranie: 1, kwota_pobrania: '104.00',
      platnosci: [{ kwota: '104.00', data: '2026-10-12T09:00:00Z', metoda: 'Przelew' }],
    });
    expect(wariantFakturyHurtem(z)).toEqual({ termin: 'zaplacone', dataSprzedazy: '2026-10-12' });
  });

  it('nieopłacone BEZ pobrania dalej odpada z dotychczasowym powodem', () => {
    const { doWystawienia, pominiete } = podzielDoFaktury([zam({})]);
    expect(doWystawienia).toEqual([]);
    expect(pominiete[0].powod).toMatch(/wpłat/i);
    expect(wariantFakturyHurtem(zam({})).powod).toMatch(/wpłat/i);
  });

  it('opłacone bez pobrania → „zapłacone” jak dotąd', () => {
    const z = zam({ platnosci: [{ kwota: '104.00', data: '2026-10-11T09:00:00Z' }] });
    expect(wariantFakturyHurtem(z)).toEqual({ termin: 'zaplacone', dataSprzedazy: '2026-10-11' });
  });

  it('nadpisanie z karty na pobranie (wartość efektywna) też idzie „przy odbiorze”', () => {
    const z = zam({ wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '104.00' }) });
    expect(wariantFakturyHurtem(z).termin).toBe('przy_odbiorze');
    expect(podzielDoFaktury([z]).doWystawienia).toHaveLength(1);
  });

  it('etykiety wariantów — te słowa widzi operator na podglądzie', () => {
    expect(ETYKIETA_WARIANTU).toEqual({ zaplacone: 'zapłacona', przy_odbiorze: 'za pobraniem — przy odbiorze' });
  });
});
