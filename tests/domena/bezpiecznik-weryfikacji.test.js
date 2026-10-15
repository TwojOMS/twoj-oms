import { describe, it, expect } from 'vitest';
import {
  wolnoPytac, poOdpowiedzi, PROG_PUSTYCH, ODSTEP_SONDY_MS,
} from '../../src/domena/bezpiecznik-weryfikacji.js';

const T = (iso) => new Date(iso);
const TERAZ = T('2026-08-28T12:00:00Z');

const zamkniety = (kolejnePuste = 0) => ({
  kolejne_puste: kolejnePuste, ostatnia_proba_at: null, bezpiecznik_od: null,
});
const otwarty = (ostatniaProba) => ({
  kolejne_puste: PROG_PUSTYCH, ostatnia_proba_at: ostatniaProba, bezpiecznik_od: '2026-08-20T10:00:00Z',
});

describe('bezpiecznik odpytywania zasobu faktur Allegro', () => {
  describe('wolnoPytac', () => {
    it('pierwszy raz w życiu kanału — pytamy', () => {
      expect(wolnoPytac(undefined, TERAZ)).toBe(true);
    });

    it('bezpiecznik zamknięty — pytamy o każdy wiersz, tak jak dotąd', () => {
      expect(wolnoPytac(zamkniety(0), TERAZ)).toBe(true);
      expect(wolnoPytac(zamkniety(PROG_PUSTYCH - 1), TERAZ)).toBe(true);
    });

    it('bezpiecznik otwarty, pytaliśmy godzinę temu — NIE pytamy', () => {
      expect(wolnoPytac(otwarty('2026-08-28T11:00:00Z'), TERAZ)).toBe(false);
    });

    it('bezpiecznik otwarty, minęła doba — pytamy (sonda)', () => {
      expect(wolnoPytac(otwarty('2026-08-27T11:59:00Z'), TERAZ)).toBe(true);
    });

    it('bezpiecznik otwarty tuż przed dobą — jeszcze NIE pytamy', () => {
      const tuzPrzed = new Date(TERAZ.getTime() - ODSTEP_SONDY_MS + 1000).toISOString();
      expect(wolnoPytac(otwarty(tuzPrzed), TERAZ)).toBe(false);
    });

    it('bezpiecznik otwarty, ale nigdy nie było próby — pytamy', () => {
      expect(wolnoPytac(otwarty(null), TERAZ)).toBe(true);
    });
  });

  describe('poOdpowiedzi', () => {
    it('pusta odpowiedź podbija licznik, dopóki nie sięgnie progu', () => {
      const s = poOdpowiedzi(zamkniety(0), { pusta: true }, TERAZ);
      expect(s.kolejnePuste).toBe(1);
      expect(s.bezpiecznikOd).toBe(null);
    });

    it('próg pustych OTWIERA bezpiecznik', () => {
      const s = poOdpowiedzi(zamkniety(PROG_PUSTYCH - 1), { pusta: true }, TERAZ);
      expect(s.kolejnePuste).toBe(PROG_PUSTYCH);
      expect(s.bezpiecznikOd).toBe(TERAZ.toISOString());
    });

    it('kolejne puste NIE przesuwają daty otwarcia', () => {
      const s = poOdpowiedzi(otwarty('2026-08-28T11:00:00Z'), { pusta: true }, TERAZ);
      expect(s.bezpiecznikOd).toBe('2026-08-20T10:00:00Z');
    });

    it('NIEPUSTA odpowiedź zeruje licznik i ZAMYKA bezpiecznik', () => {
      const s = poOdpowiedzi(otwarty('2026-08-28T11:00:00Z'), { pusta: false }, TERAZ);
      expect(s.kolejnePuste).toBe(0);
      expect(s.bezpiecznikOd).toBe(null);
    });

    it('każda odpowiedź stempluje czas próby — na nim stoi odstęp sondy', () => {
      expect(poOdpowiedzi(zamkniety(0), { pusta: true }, TERAZ).ostatniaProbaAt).toBe(TERAZ.toISOString());
      expect(poOdpowiedzi(zamkniety(0), { pusta: false }, TERAZ).ostatniaProbaAt).toBe(TERAZ.toISOString());
    });

    it('brak zapisanego stanu zachowuje się jak licznik zerowy', () => {
      expect(poOdpowiedzi(undefined, { pusta: true }, TERAZ).kolejnePuste).toBe(1);
    });
  });

  describe('próg i odstęp', () => {
    it('próg jest większy niż jeden — działający zasób może raz oddać pustkę w wyścigu', () => {
      expect(PROG_PUSTYCH).toBeGreaterThan(1);
    });

    it('odstęp sondy to doba', () => {
      expect(ODSTEP_SONDY_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
