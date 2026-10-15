import { describe, expect, it } from 'vitest';
import { sprawdzNazweKanalu } from '../../src/domena/wiazanie-kanalu.js';
import { przeprowadzWiazanie } from '../../src/oms/allegro/wiazanie.js';

const wymaganeWskazowki = (komunikat) => {
  expect(komunikat).toContain('OMS_KANALY');
  expect(komunikat).toContain('prefiksu');
  for (const klucz of ['CLIENT_ID', 'CLIENT_SECRET', 'OD', 'USER_AGENT']) {
    expect(komunikat).toContain(klucz);
  }
  expect(komunikat).not.toContain('ALLEGRO_<KANAŁ>');
};

describe('komunikaty konfiguracji wiązania kanału', () => {
  it('rzeczywista pętla device flow prowadzi po invalid_client do OMS_KANALY i czterech kluczy prefiksu', async () => {
    const klient = {
      rozpocznijPowiazanie: async () => ({
        device_code: 'syntetyczny-device-code', user_code: 'KOD-TEST',
        verification_uri: 'https://przyklad.invalid/wiazanie', expires_in: 600, interval: 1,
      }),
      dokonczPowiazanie: async () => ({ gotowe: false, powod: 'invalid_client' }),
      stanDlaEkranu: () => ({}),
    };

    const wynik = await przeprowadzWiazanie({ tokeny: klient, spij: async () => {} });

    expect(wynik).toMatchObject({ gotowe: false, powod: 'invalid_client' });
    wymaganeWskazowki(wynik.komunikat);
  });

  it('brak skonfigurowanego kanału podaje tę samą deklarację, bez wymyślonego prefiksu', () => {
    wymaganeWskazowki(sprawdzNazweKanalu('syntetyczny-kanal', []));
  });
});
