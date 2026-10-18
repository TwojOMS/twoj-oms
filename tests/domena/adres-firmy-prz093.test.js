// PRZ-093.08 — reguły adresu firmy: formularz Ustawienia → Firma i jedna kolejność źródeł (plik → baza → brak).
import { describe, it, expect } from 'vitest';
import { sprawdzFormularzFirmy, adresFirmyZZapisu, rozstrzygnijAdresFirmy } from '../../src/domena/adres-firmy.js';
import { adresFirmyZEnv, adresWPliku, adresKompletny } from '../../src/core/adres-firmy.ts';

const DOBRY = { nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL',
  telefon: '+48 500 600 700', email: 'biuro@fikcja.invalid' };

describe('sprawdzFormularzFirmy', () => {
  it('poprawny formularz: bez błędów, wartości przycięte', () => {
    const { ustawienia, bledy } = sprawdzFormularzFirmy({ ...DOBRY, nazwa: '  Pracownia   Zmyślona ' });
    expect(bledy).toEqual([]);
    expect(ustawienia).toEqual({ ...DOBRY, nazwa: 'Pracownia Zmyślona' });
  });
  it('wymagane: nazwa, ulica, kod, miasto', () => {
    const { bledy } = sprawdzFormularzFirmy({ kraj: 'PL' });
    expect(bledy).toEqual(['Podaj nazwę firmy.', 'Podaj ulicę z numerem.', 'Podaj miasto.', 'Podaj kod pocztowy.']);
  });
  it('kod PL: NN-NNN; pięć cyfr dostaje kreskę; inne postaci odrzucone', () => {
    expect(sprawdzFormularzFirmy({ ...DOBRY, kod: '00950' }).ustawienia.kod).toBe('00-950');
    for (const kod of ['0-0950', '00-95', 'AB-123', '00 950']) {
      expect(sprawdzFormularzFirmy({ ...DOBRY, kod }).bledy.join(' '), kod).toContain('NN-NNN');
    }
  });
  it('kod zagraniczny bez wzoru PL; kraj małymi literami → wielkie; zły kraj odrzucony', () => {
    const de = sprawdzFormularzFirmy({ ...DOBRY, kraj: 'de', kod: '10115' });
    expect(de.bledy).toEqual([]);
    expect(de.ustawienia.kraj).toBe('DE');
    expect(sprawdzFormularzFirmy({ ...DOBRY, kraj: 'Polska' }).bledy.join(' ')).toContain('dwuliterowy');
    expect(sprawdzFormularzFirmy({ ...DOBRY, kraj: '' }).ustawienia.kraj).toBe('PL');
  });
  it('e-mail i telefon opcjonalne, ale sprawdzane, gdy wpisane', () => {
    expect(sprawdzFormularzFirmy({ ...DOBRY, email: '', telefon: '' }).bledy).toEqual([]);
    expect(sprawdzFormularzFirmy({ ...DOBRY, email: 'biuro@' }).bledy.join(' ')).toContain('adres e-mail');
    expect(sprawdzFormularzFirmy({ ...DOBRY, telefon: 'zadzwoń' }).bledy.join(' ')).toContain('Telefon');
  });
});

describe('kolejność źródeł adresu firmy', () => {
  const zapis = { ustawienia: DOBRY, sekrety: {} };
  const PLIK = adresFirmyZEnv({ DPD_NADAWCA_NAZWA: 'Firma z Pliku', DPD_NADAWCA_ULICA: 'Plikowa 1', DPD_NADAWCA_KOD: '00-001', DPD_NADAWCA_MIASTO: 'Plikowo' });

  it('plik wygrywa nad bazą — baza nie jest nawet czytana', () => {
    let czytano = false;
    expect(rozstrzygnijAdresFirmy({ wPliku: true, zPliku: PLIK, zapis: () => { czytano = true; return zapis; } }))
      .toEqual({ adres: PLIK, zrodlo: 'plik' });
    expect(czytano).toBe(false);
  });
  it('bez pliku: adres z bazy w kształcie nadawcy (phone, email)', () => {
    expect(rozstrzygnijAdresFirmy({ wPliku: false, zPliku: adresFirmyZEnv({}), zapis: () => zapis })).toEqual({
      adres: { nazwa: 'Pracownia Zmyślona', ulica: 'Wymyślona 12', kod: '00-950', miasto: 'Nibylandia', kraj: 'PL',
        phone: '+48 500 600 700', email: 'biuro@fikcja.invalid' }, zrodlo: 'baza' });
  });
  it('bez pliku i bez bazy (albo z niepełnym zapisem) — brak adresu', () => {
    expect(rozstrzygnijAdresFirmy({ wPliku: false, zPliku: adresFirmyZEnv({}), zapis: () => null })).toEqual({ adres: null, zrodlo: null });
    expect(adresFirmyZZapisu({ ustawienia: { ...DOBRY, ulica: '' } })).toBeNull();
  });
  it('„adres w pliku” = choć jedno z czterech pól adresu; sam kraj, telefon czy e-mail się nie liczą', () => {
    expect(adresWPliku(adresFirmyZEnv({}))).toBe(false);
    expect(adresWPliku(adresFirmyZEnv({ DPD_NADAWCA_KRAJ: 'PL', DPD_NADAWCA_TELEFON: '1', DPD_NADAWCA_EMAIL: 'a@b.c' }))).toBe(false);
    for (const k of ['DPD_NADAWCA_NAZWA', 'DPD_NADAWCA_ULICA', 'DPD_NADAWCA_KOD', 'DPD_NADAWCA_MIASTO']) {
      expect(adresWPliku(adresFirmyZEnv({ [k]: 'x' })), k).toBe(true);
    }
    expect(adresKompletny(PLIK)).toBe(true);
    expect(adresKompletny({ ...PLIK, kod: '' })).toBe(false);
  });
});
