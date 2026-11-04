import { afterEach, beforeEach, expect, it } from 'vitest';
import { sprawdzZmianeMetody } from '../../src/domena/wysylka.js';
import { podzielDoNadania } from '../../src/domena/masowe.js';
import { uslugaInpost } from '../../src/domena/usluga-inpost.js';
import { kanalyAllegro, ustawKanalyAllegro } from '../../src/domena/moduly-kanalow.ts';

let poprzednie;
beforeEach(() => {
  poprzednie = kanalyAllegro();
  ustawKanalyAllegro(['rynek_polcien']);
});
afterEach(() => ustawKanalyAllegro(poprzednie));

const odmowaZmiany = 'To zamówienie przyszło z Allegro — paczki tego kanału nadajesz w Allegro, więc panel nie '
  + 'pozwala przestawić go na dostawę, którą sam nadaje (poszłaby DRUGA, płatna paczka do klienta, '
  + 'który już dostał swoją). Metodę wolno poprawić tylko w obrębie metod Allegro.';
const odmowaSklepowa = 'zamówienie z Allegro ma ręcznie ustawioną metodę sklepową — nadaj je z karty zamówienia';
const odmowaAllegrowa = 'metoda allegrowa przy zamówieniu spoza Allegro — popraw metodę na karcie zamówienia';

// Zapisane przed podmianą predykatów: oczekiwania nie korzystają z rejestru umiejętności.
it.each([
  ['allegro_polcien', 'allegro_paczkomat', null, null, 'inpost_paczkomat', 'paczkomat', 'inpost_locker_allegro', 'inpost_locker_allegro_smart'],
  ['allegro_polcien', 'inpost_paczkomat', odmowaZmiany, odmowaSklepowa, null, null, 'inpost_locker_allegro', 'inpost_locker_allegro_smart'],
  ['allegro_polcien', 'dpd', odmowaZmiany, odmowaSklepowa, null, null, 'inpost_locker_allegro', 'inpost_locker_allegro_smart'],
  ['rynek_polcien', 'allegro_paczkomat', null, null, 'inpost_paczkomat', 'paczkomat', 'inpost_locker_allegro', 'inpost_locker_allegro_smart'],
  ['rynek_polcien', 'inpost_paczkomat', odmowaZmiany, odmowaSklepowa, null, null, 'inpost_locker_allegro', 'inpost_locker_allegro_smart'],
  ['rynek_polcien', 'dpd', odmowaZmiany, odmowaSklepowa, null, null, 'inpost_locker_allegro', 'inpost_locker_allegro_smart'],
  ['sklep_polcien', 'allegro_paczkomat', null, odmowaAllegrowa, null, null, 'inpost_locker_standard', 'inpost_locker_standard'],
  ['sklep_polcien', 'inpost_paczkomat', null, null, 'inpost_paczkomat', 'paczkomat', 'inpost_locker_standard', 'inpost_locker_standard'],
  ['sklep_polcien', 'dpd', null, null, 'dpd', 'dpd', 'inpost_locker_standard', 'inpost_locker_standard'],
  ['reczne', 'allegro_paczkomat', null, odmowaAllegrowa, null, null, 'inpost_locker_standard', 'inpost_locker_standard'],
  ['reczne', 'inpost_paczkomat', null, null, 'inpost_paczkomat', 'paczkomat', 'inpost_locker_standard', 'inpost_locker_standard'],
  ['reczne', 'dpd', null, null, 'dpd', 'dpd', 'inpost_locker_standard', 'inpost_locker_standard'],
])('%s / %s — złoty wynik wysyłki', (sklep, metoda, bladZmiany, powod, metodaUzyta, rodzajFormularza, usluga, smart) => {
  const z = {
    id: 1000001, numer: 'POL-1', sklep, metoda_wysylki: metoda,
    punkt_odbioru: 'POL01M', pobranie: 0, przesylki: [],
    oplacone_at: '2026-11-03T09:00:00Z',
  };
  expect(sprawdzZmianeMetody(metoda, false, '', 'POL01M', z)).toEqual({
    blad: bladZmiany,
    nadpisanie: bladZmiany ? null : {
      metoda, pobranie: 0, ...(metoda === 'inpost_paczkomat' ? { punkt_odbioru: 'POL01M' } : {}),
    },
  });
  expect(podzielDoNadania([z])).toEqual({
    doNadania: powod ? [] : [{ ...z, metodaUzyta, rodzajFormularza }],
    pominiete: powod ? [{ id: 1000001, numer: 'POL-1', powod }] : [],
    uwagi: [],
  });
  expect(uslugaInpost(z)).toBe(usluga);
  expect(uslugaInpost({ ...z, surowe_json: '{"delivery":{"smart":true}}' })).toBe(smart);
});
