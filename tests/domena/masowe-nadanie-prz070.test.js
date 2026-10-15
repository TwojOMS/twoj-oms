import { describe, it, expect } from 'vitest';
import { podzielDoNadania, rodzajFormularzaNadania } from '../../src/domena/masowe.js';

// PRZ-070 (właściciel 14.10.2026): hurt nadaje to, co umie karta — tymi samymi funkcjami
// (`metodaNadania`, `powodBrakuGotowosciNadania`). Do tego dnia przechodziło wyłącznie
// sklepowe DPD bez pobrania (zmierzone na produkcji: ok. połowa zamówień z 90 dni).
const zam = (nad = {}) => ({
  id: 1, numer: '1589', sklep: 'pro', metoda_wysylki: 'dpd', anulowane: 0,
  oplacone_at: '2026-10-13T10:00:00', przesylki: [], ...nad,
});

describe('PRZ-070: podział do nadania hurtem', () => {
  it('DPD za pobraniem idzie do nadania, z uwagą o kwocie zamiast „nie jest opłacone”', () => {
    const { doNadania, pominiete, uwagi } = podzielDoNadania([
      zam({ pobranie: 1, kwota_pobrania: '104.00', oplacone_at: null }),
    ]);
    expect(pominiete).toEqual([]);
    expect(doNadania).toHaveLength(1);
    expect(doNadania[0].metodaUzyta).toBe('dpd');
    expect(doNadania[0].rodzajFormularza).toBe('dpd');
    expect(uwagi).toEqual([{ id: 1, numer: '1589', tresc: 'za pobraniem — kurier zainkasuje 104.00 zł' }]);
  });

  // DPD bez kwoty nie wstawia <cod>: paczka pojechałaby jak przedpłacona, bez błędu nigdzie.
  it('pobranie bez kwoty odpada — paczka nie może pojechać bez <cod>', () => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ pobranie: 1, kwota_pobrania: null })]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toBe('pobranie bez kwoty — uzupełnij kwotę pobrania na karcie zamówienia');
  });

  // Recenzja D8 (P3-1): hurt sprawdza kwotę TĄ SAMĄ funkcją, co ekran nadania karty —
  // zero, pusty napis i zły zapis dałyby w DPD paczkę bez <cod>, bez żadnego błędu.
  it.each(['0.00', '', '104.', '1e2'])('pobranie DPD z niepoprawną kwotą „%s” odpada', (kwota) => {
    const { doNadania, pominiete } = podzielDoNadania([zam({ pobranie: 1, kwota_pobrania: kwota })]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toMatch(/^kwota pobrania jest niepoprawna — popraw ją na karcie zamówienia/);
  });

  it.each(['allegro_dpd', 'allegro_punkt', 'allegro_kurier', 'allegro_inne'])(
    'Allegro %s idzie drogą „Wysyłam z Allegro”',
    (metoda) => {
      const { doNadania, pominiete } = podzielDoNadania([zam({ sklep: 'allegro_szkicownia', metoda_wysylki: metoda })]);
      expect(pominiete).toEqual([]);
      expect(doNadania[0].metodaUzyta).toBe(metoda);
      expect(doNadania[0].rodzajFormularza).toBe('wza');
    },
  );

  it('Allegro DPD za pobraniem idzie — kwotę poda Allegro', () => {
    const { doNadania, uwagi } = podzielDoNadania([
      zam({
        sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_dpd', pobranie: 1, kwota_pobrania: '176.89', oplacone_at: null,
      }),
    ]);
    expect(doNadania).toHaveLength(1);
    expect(uwagi[0].tresc).toBe('za pobraniem — kwotę pobrania poda Allegro (w zamówieniu 176.89 zł)');
  });

  it('paczkomat z Allegro i ze sklepu idzie naszym InPostem', () => {
    const { doNadania } = podzielDoNadania([
      zam({ id: 1, numer: 'A', sklep: 'allegro_szkicownia', metoda_wysylki: 'allegro_paczkomat', punkt_odbioru: 'KRA01M' }),
      zam({ id: 2, numer: 'S', metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'WRO10B' }),
    ]);
    expect(doNadania.map((z) => [z.numer, z.metodaUzyta, z.rodzajFormularza])).toEqual([
      ['A', 'inpost_paczkomat', 'paczkomat'], ['S', 'inpost_paczkomat', 'paczkomat'],
    ]);
  });

  it('paczkomat bez kodu odpada z tym samym zdaniem co karta', () => {
    const { pominiete } = podzielDoNadania([zam({ metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: null })]);
    expect(pominiete[0].powod).toMatch(/nie ma kodu paczkomatu/);
  });

  it('pobranie do paczkomatu odpada — umowa z InPostem na pobranie niepotwierdzona', () => {
    const { doNadania, pominiete } = podzielDoNadania([
      zam({ metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'WRO10B', pobranie: 1, kwota_pobrania: '50.00' }),
    ]);
    expect(doNadania).toEqual([]);
    expect(pominiete[0].powod).toBe('pobranie do paczkomatu — nadaj z karty zamówienia (umowa z InPostem na pobranie jest niepotwierdzona)');
  });

  // ⚠️⚠️ PIENIĄDZE: druga, płatna paczka naszą umową do klienta, który ma dostawę u Allegro.
  it.each(['dpd', 'inpost_paczkomat', 'odbior_osobisty'])(
    'kanał Allegro z ręcznie ustawioną metodą „%s” odpada',
    (metoda) => {
      const { doNadania, pominiete } = podzielDoNadania([
        zam({ sklep: 'allegro_amarka', metoda_wysylki: metoda, punkt_odbioru: 'WRO10B' }),
      ]);
      expect(doNadania).toEqual([]);
      expect(pominiete[0].powod).toBe('zamówienie z Allegro ma ręcznie ustawioną metodę sklepową — nadaj je z karty zamówienia');
    },
  );

  it('metoda allegrowa przy zamówieniu ze sklepu odpada', () => {
    const { pominiete } = podzielDoNadania([zam({ sklep: 'pro', metoda_wysylki: 'allegro_dpd' })]);
    expect(pominiete[0].powod).toBe('metoda allegrowa przy zamówieniu spoza Allegro — popraw metodę na karcie zamówienia');
  });

  it('wartość EFEKTYWNA: nadpisanie z karty na pobranie wchodzi do uwagi', () => {
    const { uwagi } = podzielDoNadania([zam({
      wysylka_reczna_json: JSON.stringify({ metoda: 'dpd', pobranie: 1, kwota_pobrania: '99.00' }),
    })]);
    expect(uwagi[0].tresc).toBe('za pobraniem — kurier zainkasuje 99.00 zł');
  });

  it('rodzaj formularza dla metod użytych', () => {
    expect(rodzajFormularzaNadania('dpd')).toBe('dpd');
    expect(rodzajFormularzaNadania('inpost_paczkomat')).toBe('paczkomat');
    expect(rodzajFormularzaNadania('allegro_inne')).toBe('wza');
    expect(rodzajFormularzaNadania('odbior_osobisty')).toBeNull();
  });
});
