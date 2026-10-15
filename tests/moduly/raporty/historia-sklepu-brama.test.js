import { describe, it, expect } from 'vitest';
import { decyzja } from '../../pomoc/import-sklep-parytet.js';

const zam = (nad = {}) => ({
  id: 1, number: '1', status: 'completed',
  billing: { email: 'k@klient.pl', first_name: 'Anna', last_name: 'Nowak', company: '' },
  ...nad,
});

describe('brama danych osobowych przy imporcie historii sklepu', () => {
  it('zwykle zamowienie idzie do zapisu', () => {
    expect(decyzja(zam()).akcja).toBe('zapisz');
  });

  it('ZAMOWIENIE WLASNE POMIJAMY TU, bo raport nie bedzie mial czym go poznac', () => {
    const w = decyzja(zam({ billing: { email: 'wlasciciel@example.com' } }));
    expect(w.akcja).toBe('pomin');
    expect(w.powod).toBe('testowe');
  });

  it('domena testowa i nazwa testowa tez', () => {
    expect(decyzja(zam({ billing: { email: 'x@example.com' } })).akcja).toBe('pomin');
    expect(decyzja(zam({ billing: { email: 'a@b.pl', company: 'Lumina' } })).akcja).toBe('pomin');
  });

  it('KLIENT WDT ZATRZYMUJE IMPORT — nie wolno zapisac go bez maila, bo ma 0% VAT', () => {
    const w = decyzja(zam({ billing: { email: 'info@alfatrend.sk' } }));
    expect(w.akcja).toBe('stop');
    expect(w.powod).toMatch(/WDT/);
  });

  it('status niebedacy sprzedaza pomijamy z nazwanym powodem', () => {
    expect(decyzja(zam({ status: 'cancelled' }))).toEqual({ akcja: 'pomin', powod: 'status cancelled' });
  });

  it('STATUS SPOZA OBU LIST ZATRZYMUJE IMPORT — cisza bylaby zgadywaniem o pieniadzach', () => {
    const w = decyzja(zam({ status: 'wc-jakis-wtyczkowy' }));
    expect(w.akcja).toBe('stop');
    expect(w.powod).toMatch(/Nieznany status/);
  });
});
