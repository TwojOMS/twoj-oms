import { describe, it, expect } from 'vitest';
import { pobranieDoWysylki } from '../../src/domena/allegro-wysylka.js';

const KONTO = { ownerName: 'Lumina Marek Zywiecki', iban: '34109010140000000000000000' };
const COD = { amount: '83.99', currency: 'PLN', ownerName: null, iban: null };
const wolaj = (n = {}) => pobranieDoWysylki({ pobranieUslugi: true, cashOnDelivery: COD, limit: '6000', ...KONTO, ...n });

describe('pobranie przez Wysyłam z Allegro — pieniądze kupującego', () => {
  // ⚠️⚠️ NASZEGO KONTA W INKASIE NIE MA — poprawka po zgłoszeniu właściciela 11.08.2026:
  // „pobranie idzie na konto allegro a nie na nasze".
  //
  // Zmierzone na usłudze `13f26351-…`: `paymentType: WALLET_TRANSFER`, `forceRequireIban: false`.
  // Gotówkę inkasuje ALLEGRO i rozlicza przez portfel sprzedawcy — nie przewoźnik na nasz
  // rachunek. Pierwsza wersja tej reguły WYMAGAŁA naszego IBAN-u i bez niego odmawiała.
  it('składa inkaso z SAMĄ kwotą — bez naszego rachunku', () => {
    const w = wolaj();
    expect(w.wolno).toBe(true);
    expect(w.cashOnDelivery).toEqual({ amount: '83.99', currency: 'PLN' });
  });

  it('NIE przemyca naszego konta, nawet gdy jest w konfiguracji', () => {
    const w = wolaj();
    expect(w.cashOnDelivery).not.toHaveProperty('iban');
    expect(w.cashOnDelivery).not.toHaveProperty('ownerName');
    expect(JSON.stringify(w.cashOnDelivery)).not.toContain('6069');
  });

  // Pole zostaje OBSŁUGIWANE, bo `forceRequireIban` bywa `true` przy innych usługach —
  // wtedy konto jest warunkiem i jego brak MA być odmową. Rozstrzyga USŁUGA, nie my.
  it('gdy usługa WYMAGA konta — dokłada je, a bez niego odmawia', () => {
    const w = wolaj({ wymaganeKonto: true });
    expect(w.cashOnDelivery).toEqual({
      amount: '83.99', currency: 'PLN', ownerName: 'Lumina Marek Zywiecki', iban: 'PL34109010140000000000000000',
    });
    expect(wolaj({ wymaganeKonto: true, iban: '123' }).wolno).toBe(false);
    expect(wolaj({ wymaganeKonto: true, ownerName: ' ' }).wolno).toBe(false);
  });

  // ⚠️ USLUGA POBRANIOWA BEZ KWOTY = kurier nie inkasuje NIC, towar oddany za darmo.
  it.each([[null], [undefined], [{ amount: '0.00', currency: 'PLN' }], [{ amount: null }]])(
    'ODMAWIA usługi pobraniowej bez kwoty (%s)', (cod) => {
      expect(wolaj({ cashOnDelivery: cod }).wolno).toBe(false);
    },
  );

  // ⚠️ ODWROTNA NIEZGODNOSC, rownie grozna: zamowienie za pobraniem jedzie usluga
  // przedplacona, wiec kupujacy dostaje paczke i nikt nie prosi go o pieniadze.
  it('ODMAWIA usługi przedpłaconej, gdy zamówienie MA kwotę pobrania', () => {
    const w = pobranieDoWysylki({ pobranieUslugi: false, cashOnDelivery: COD, ...KONTO });
    expect(w.wolno).toBe(false);
    expect(w.powod).toMatch(/przedpłacona/i);
  });

  it('przesyłka przedpłacona bez kwoty daje JAWNE null, nie brak pola', () => {
    const w = pobranieDoWysylki({ pobranieUslugi: false, cashOnDelivery: null, ...KONTO });
    expect(w.wolno).toBe(true);
    expect(w.cashOnDelivery).toBeNull();
  });

  it('ODMAWIA ponad limit usługi — porównanie na groszach', () => {
    expect(wolaj({ cashOnDelivery: { amount: '6000.01', currency: 'PLN' } }).wolno).toBe(false);
    expect(wolaj({ cashOnDelivery: { amount: '6000.00', currency: 'PLN' } }).wolno).toBe(true);
  });

  it('ODMAWIA waluty innej niż PLN', () => {
    expect(wolaj({ cashOnDelivery: { amount: '83.99', currency: 'EUR' } }).wolno).toBe(false);
  });

  // ⚠️ Nadpisanie operatora NIE jest honorowane, ale tez NIE jest po cichu ignorowane:
  // kwota to zobowiazanie miedzy KUPUJACYM a Allegro.
  it('ODMAWIA, gdy operator wpisał INNĄ kwotę — i nazywa obie liczby', () => {
    const w = wolaj({ nadpisanieOperatora: '8399' });
    expect(w.wolno).toBe(false);
    expect(w.powod).toContain('8399');
    expect(w.powod).toContain('83.99');
  });

  // ⚠️ NIE WYSTARCZY, ZE PRZECHODZI — na etykiecie ma wylądować kwota ALLEGRO. Bez tych
  // asercji mutacja `amount: nadpisanieOperatora ?? …` przeżywała: przy pustym nadpisaniu
  // (`''`, czyli nietkniętym polu formularza) `??` nie zadziała i inkaso poszłoby PUSTE.
  it('zgodne nadpisanie przechodzi, a kwota ZOSTAJE ta z Allegro', () => {
    for (const nadpisanie of ['83.99', '83,99', '', null, undefined]) {
      const w = wolaj({ nadpisanieOperatora: nadpisanie });
      expect(`${JSON.stringify(nadpisanie)}: ${w.wolno}`).toBe(`${JSON.stringify(nadpisanie)}: true`);
      expect(`${JSON.stringify(nadpisanie)}: ${w.cashOnDelivery.amount}`)
        .toBe(`${JSON.stringify(nadpisanie)}: 83.99`);
    }
  });

  // Bez tych dwoch pieniadze z pobrania nie maja dokad wrocic.
  // ⚠️ Te asercje przeniosly sie ZA warunek `wymaganeKonto` (11.08.2026). Przy uslugach
  // `WALLET_TRANSFER` brak konta NIE JEST bledem — jest poprawnym stanem.
  it('przy usłudze wymagającej konta: zły IBAN to odmowa, spacje są normalizowane', () => {
    const zKontem = (n) => wolaj({ wymaganeKonto: true, ...n });
    expect(zKontem({ ownerName: '  ' }).wolno).toBe(false);
    expect(zKontem({ iban: '123' }).wolno).toBe(false);
    expect(zKontem({ iban: null }).wolno).toBe(false);
    expect(zKontem({ iban: 'PL34109010140000000000000000' }).wolno).toBe(true);
    expect(zKontem({ iban: '34 1090 1014 0000 0000 0000 0000' }).cashOnDelivery.iban)
      .toBe('PL34109010140000000000000000');
  });

  it('bez wymogu konta brak IBAN-u NIE JEST błędem', () => {
    expect(wolaj({ ownerName: null, iban: null }).wolno).toBe(true);
  });
});
