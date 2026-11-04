import { afterEach, describe, expect, it } from 'vitest';
import { czekaNaKsef, czyWierszWZakresieKsef } from '../../src/domena/ksef-oczekiwanie.js';
import { sprawyKarty } from '../../src/domena/sprawy-karty.js';
import { powodyOdmowyScalenia } from '../../src/domena/scalanie.js';
import { ustawKanalyAllegro } from '../../src/domena/moduly-kanalow.ts';

const TERAZ = Date.parse('2026-11-03T12:00:00Z');
const DATA = '2026-11-01T10:00:00Z';
const faktura = {
  numer: 'FV/1000001/2026', infakt_uuid: 'polcien-test',
  utworzona_at: DATA, ksef_odczyt: 'ok',
};
const zamowienie = (sklep, chce_fakture, zlecona = false) => ({
  sklep, chce_fakture, kwota_brutto: '0.00', koszt_dostawy_brutto: '0.00',
  pozycje: [], wplaty: [], przesylki: [],
  faktura: { ...faktura, ...(zlecona ? { ksef_zlecona_at: DATA } : {}) },
});
// Wyniki zapisane przed podmianą predykatów; żadna oczekiwana wartość nie pochodzi z modułu kanału.
const ALLEGRO = [{
  klucz: 'ksef', waga: 'blokada', kotwica: '#faktura',
  tekst: 'Faktura FV/1000001/2026 czeka na KSeF od 2026-11-01T10:00:00Z '
    + '— kupujący jej jeszcze nie ma. Wyślij ten dokument do KSeF w inFakcie albo, '
    + 'jeśli świadomie godzisz się na dokument bez tego numeru, wyślij go kupującemu '
    + 'przyciskiem „Wyślij do Allegro BEZ numeru KSeF” na tej karcie.',
}];
const PANEL = [{
  klucz: 'ksef', waga: 'blokada', kotwica: '#faktura',
  tekst: 'Panel zlecił wysyłkę faktury FV/1000001/2026 do KSeF, a numeru nie ma od '
    + '2026-11-01T10:00:00Z — inFakt odpowiada, że dokumentu tam jeszcze '
    + 'nie ma. Sprawdź ten dokument w inFakcie: albo zgłoszenie utknęło, albo organ je '
    + 'odrzucił. Panel sam wysyłki NIE ponowi — drugie zgłoszenie byłoby duplikatem, '
    + 'którego nie da się skasować.',
}];

afterEach(() => ustawKanalyAllegro([]));

describe('K07 — złoty wynik KSeF i spraw karty', () => {
  it.each([
    ['allegro_polcien', 1, false, true, true, ALLEGRO],
    ['allegro_polcien', 0, false, false, true, []],
    ['allegro_polcien', 0, true, true, true, PANEL],
    ['allegro_polcien', 1, true, true, true, ALLEGRO],
    ['sklep_polcien', 0, true, true, true, PANEL],
    ['sklep_polcien', 1, false, false, false, []],
    ['reczne', 1, false, false, false, []],
    ['reczne', 0, true, true, true, PANEL],
    ['nieznany_polcien', 1, false, false, false, []],
    ['', 1, false, false, false, []],
  ])('%s żądanie=%s panel=%s', (sklep, chce, panel, czeka, zakres, sprawy) => {
    const z = zamowienie(sklep, chce, panel);
    expect(czekaNaKsef(z)).toBe(czeka);
    expect(czyWierszWZakresieKsef({ sklep, zlecona_z_panelu: panel ? 1 : 0 })).toBe(zakres);
    expect(sprawyKarty(z, TERAZ)).toEqual(sprawy);
  });

  it('kanał Allegro z konfiguracji bez prefiksu ma ten sam wynik', () => {
    ustawKanalyAllegro(['polcien_test']);
    const z = zamowienie('polcien_test', 1);
    expect(czekaNaKsef(z)).toBe(true);
    expect(czyWierszWZakresieKsef(z)).toBe(true);
    expect(sprawyKarty(z, TERAZ)).toEqual(ALLEGRO);
  });

  it.each([
    ['allegro_polcien', 'Status nie dojechał do Allegro: test'],
    ['sklep_polcien', 'Status nie dojechał do sklepu: test'],
    ['reczne', 'Status nie dojechał do sklepu: test'],
  ])('dosłowny tekst synchronizacji %s', (sklep, tekst) => {
    expect(sprawyKarty({ ...zamowienie(sklep, 0), sync_woo_blad: 'test' }, TERAZ)).toEqual([
      { klucz: 'sync-sklep', waga: 'blokada', tekst, kotwica: '#status' },
    ]);
  });
});

describe('K07 — złoty wynik odmowy scalania', () => {
  it.each([
    ['allegro_polcien', 'sklep_polcien', [
      'Zamówienie P-1 jest z Allegro — zamówień z Allegro nie scalamy (tylko sklep i ręczne).',
    ]],
    ['sklep_polcien', 'reczne', []],
    ['sklep_polcien', 'sklep_polcien', []],
  ])('%s + %s', (pierwszy, drugi, wynik) => {
    expect(powodyOdmowyScalenia([
      { id: 1, numer: 'P-1', sklep: pierwszy },
      { id: 2, numer: 'P-2', sklep: drugi },
    ], { glowneId: 1 })).toEqual(wynik);
  });
});
