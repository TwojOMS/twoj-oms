import { describe, it, expect } from 'vitest';
import {
  SKU_PLACEHOLDERA, czyPozycjaPlaceholdera, czyIndywidualneZeSurowych,
} from '../../src/domena/indywidualne.js';

// Ksztalty odwzorowane z prawdziwej odpowiedzi WooCommerce (line_items z meta_data),
// a nie z obiektu zbudowanego pod teze.
const linia = (nad = {}) => ({
  id: 11, name: 'Szablon STOP', sku: 'PRO-1', quantity: 1,
  total: '81.30', total_tax: '18.70', meta_data: [], ...nad,
});

const zamowienie = (linie) => ({ id: 4242, number: '4242', line_items: linie });

describe('czyPozycjaPlaceholdera', () => {
  it('rozpoznaje SKU zaslepki panelu indywidualnego', () => {
    expect(czyPozycjaPlaceholdera(SKU_PLACEHOLDERA)).toBe(true);
  });

  // Wtyczka wstawia zaslepka i wysylke, i realizacje priorytetowa — warianty SKU
  // z przyrostkiem musza sie lapac tak samo. Raport robi to samo (startsWith).
  it('rozpoznaje warianty z przyrostkiem', () => {
    expect(czyPozycjaPlaceholdera('psm-zam-placeholder-wysylka')).toBe(true);
  });

  it('zwykly produkt sklepowy nie jest zaslepka', () => {
    expect(czyPozycjaPlaceholdera('PRO-1')).toBe(false);
    expect(czyPozycjaPlaceholdera(null)).toBe(false);
    expect(czyPozycjaPlaceholdera('')).toBe(false);
  });
});

describe('czyIndywidualneZeSurowych', () => {
  it('rozpoznaje po _zam_offer_id w meta pozycji', () => {
    const z = zamowienie([linia({ meta_data: [{ id: 1, key: '_zam_offer_id', value: 28311 }] })]);
    expect(czyIndywidualneZeSurowych(z)).toBe(true);
  });

  // Woo oddaje meta raz liczba, raz napisem — ta sama wartosc, dwa ksztalty.
  it('rozpoznaje _zam_offer_id podane jako napis', () => {
    const z = zamowienie([linia({ meta_data: [{ key: '_zam_offer_id', value: '28311' }] })]);
    expect(czyIndywidualneZeSurowych(z)).toBe(true);
  });

  it('rozpoznaje po SKU zaslepki, gdy meta nie ma', () => {
    expect(czyIndywidualneZeSurowych(zamowienie([linia({ sku: SKU_PLACEHOLDERA })]))).toBe(true);
  });

  it('wystarczy JEDNA pozycja ze znacznikiem', () => {
    const z = zamowienie([linia(), linia({ id: 12, sku: SKU_PLACEHOLDERA })]);
    expect(czyIndywidualneZeSurowych(z)).toBe(true);
  });

  // ⚠️ TO JEST TEST, KTORY MUSI GRYZC. Zamowienie z TEGO SAMEGO sklepu (szkicownia.pl),
  // ale zlozone zwyklym koszykiem, NIE jest indywidualne. Regula, ktora przepuszcza
  // wszystko z tego sklepu, jest bezuzyteczna i wlasnie tak bylaby napisana po skrocie.
  it('zwykle zamowienie sklepowe NIE jest indywidualne', () => {
    expect(czyIndywidualneZeSurowych(zamowienie([linia(), linia({ id: 12 })]))).toBe(false);
  });

  // Zero i pusty napis to „brak oferty", nie oferta o numerze zero.
  it('puste albo zerowe _zam_offer_id nie liczy sie jako znacznik', () => {
    expect(czyIndywidualneZeSurowych(zamowienie([linia({ meta_data: [{ key: '_zam_offer_id', value: 0 }] })]))).toBe(false);
    expect(czyIndywidualneZeSurowych(zamowienie([linia({ meta_data: [{ key: '_zam_offer_id', value: '' }] })]))).toBe(false);
  });

  // Uszkodzony albo niepelny ksztalt NIE ma prawa rzucic: te funkcje wola przeliczenie
  // przy starcie panelu i poller przy kazdej synchronizacji.
  it('brak line_items, null i smiec oddaja false zamiast rzucac', () => {
    expect(czyIndywidualneZeSurowych(null)).toBe(false);
    expect(czyIndywidualneZeSurowych({})).toBe(false);
    expect(czyIndywidualneZeSurowych({ line_items: 'bzdura' })).toBe(false);
    expect(czyIndywidualneZeSurowych({ line_items: [null, 7] })).toBe(false);
  });
});
