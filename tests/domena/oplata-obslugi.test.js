import { describe, it, expect } from 'vitest';
import {
  oplataDlaZamowienia, NAZWA_OBSLUGI, NAZWA_KURIERA,
} from '../../src/domena/oplata-obslugi.js';

const KLIENT = {
  klucz: 'przykladowa', rabatProcent: 30, progDarmowejDostawyGr: 50000,
  oplataObslugiGr: 400, oplataKurierskaGr: 1900,
};

describe('oplataDlaZamowienia', () => {
  it('etykieta klienta to oplata za obsluge', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: true, wartoscTowaruGr: 10000, klient: KLIENT }))
      .toEqual({ nazwa: NAZWA_OBSLUGI, kwotaGr: 400 });
  });

  it('nasza wysylka to oplata kurierska', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: false, wartoscTowaruGr: 10000, klient: KLIENT }))
      .toEqual({ nazwa: NAZWA_KURIERA, kwotaGr: 1900 });
  });

  it('powyzej progu nasza wysylka jest darmowa', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: false, wartoscTowaruGr: 60000, klient: KLIENT }))
      .toBeNull();
  });

  it('DOKLADNIE na progu juz darmowa', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: false, wartoscTowaruGr: 50000, klient: KLIENT }))
      .toBeNull();
  });

  it('grosz pod progiem jeszcze platna', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: false, wartoscTowaruGr: 49999, klient: KLIENT }))
      .toEqual({ nazwa: NAZWA_KURIERA, kwotaGr: 1900 });
  });

  it('prog NIE dotyczy etykiety klienta — tam nie ma czego zwalniac', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: true, wartoscTowaruGr: 90000, klient: KLIENT }))
      .toEqual({ nazwa: NAZWA_OBSLUGI, kwotaGr: 400 });
  });

  // Trzecia odpowiedz na pytanie „kto nadaje paczke": NIKT. Oplata jest cena za nadanie,
  // wiec bez nadania nie ma za co pobierac — a przy gotowce to kwota, ktora odbierajacy
  // musialby zainkasowac za usluge, ktorej nie bylo.
  it('odbior osobisty to brak oplaty — nikt nie nadaje paczki', () => {
    expect(oplataDlaZamowienia({
      etykietaKlienta: false, bezWysylki: true, wartoscTowaruGr: 20000, klient: KLIENT,
    })).toBeNull();
  });

  it('brak wysylki wygrywa nawet z etykieta klienta', () => {
    expect(oplataDlaZamowienia({
      etykietaKlienta: true, bezWysylki: true, wartoscTowaruGr: 20000, klient: KLIENT,
    })).toBeNull();
  });

  it('brak klienta zbiorczego to brak oplaty', () => {
    expect(oplataDlaZamowienia({ etykietaKlienta: true, wartoscTowaruGr: 10000, klient: null }))
      .toBeNull();
  });
});
