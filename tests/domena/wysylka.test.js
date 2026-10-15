import { describe, it, expect } from 'vitest';
import { rozpoznajMetodeWysylki } from '../../src/domena/wysylka.js';

// Mapa idzie instance_id -> nazwa metody: dwie rozne instancje (1 i 3) moga wskazywac
// na tego samego fizycznego kuriera (DPD), bo strefa Woo ma osobna instancje na
// "platna przesylke" i osobna na "darmowa dostawa nad progiem".
const mapa = { 1: 'dpd', 2: 'dpd_pobranie', 3: 'dpd' };
const zam = (linie) => ({ shipping_lines: linie });

describe('rozpoznajMetodeWysylki', () => {
  it('instancja 1 → dpd', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'flat_rate', instance_id: '1' }]), mapa)).toBe('dpd');
  });

  it('instancja 2 → dpd_pobranie', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'flat_rate', instance_id: '2' }]), mapa)).toBe('dpd_pobranie');
  });

  // Instancja 3 to darmowa dostawa nad progiem — ta sama fizyczna paczka DPD co instancja 1,
  // tylko inaczej oplacona. To wlasnie ten przypadek zmusil do odwrocenia mapy.
  it('instancja 3 (darmowa dostawa) → dpd', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'free_shipping', instance_id: '3' }]), mapa)).toBe('dpd');
  });

  // instance_id przychodzi ze sklepu raz jako string, raz jako liczba.
  it('instance_id liczbowy działa tak samo', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'flat_rate', instance_id: 2 }]), mapa)).toBe('dpd_pobranie');
  });

  // Tytul to tekst do zmiany jednym klikiem w wp-adminie — nie wolno na nim opierac decyzji.
  it('nieznana instancja → nieznana, mimo kuszącego tytułu', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'flat_rate', instance_id: '99', method_title: 'Kurier DPD' }]), mapa)).toBe('nieznana');
  });

  // Instancja spoza mapy (nie zdefiniowana w konfiguracji sklepu) → nieznana, nie zgadujemy.
  it('instancja nieobecna w mapie → nieznana', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'flat_rate', instance_id: '7' }]), mapa)).toBe('nieznana');
  });

  it('brak linii wysyłki → nieznana', () => {
    expect(rozpoznajMetodeWysylki(zam([]), mapa)).toBe('nieznana');
    expect(rozpoznajMetodeWysylki({}, mapa)).toBe('nieznana');
  });

  it('inna metoda (paczkomat) → nieznana, nie zgadujemy', () => {
    expect(rozpoznajMetodeWysylki(zam([{ method_id: 'easypack_parcel_machines', instance_id: '12' }]), mapa)).toBe('nieznana');
  });
});
