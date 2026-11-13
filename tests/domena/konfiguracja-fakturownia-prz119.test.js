// PRZ-119.05 — Fakturownia skonfigurowana w Ustawieniach: domena konta (jawna) + token API (sekret).
// Ekran powstaje w zmianie 06; tu domena formularza i opcje klienta z zapisu. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import {
  sprawdzFormularzFakturowni, opcjeKlientaFakturowni, EKRAN_FAKTUROWNI, ID_FAKTUROWNI,
} from '../../src/domena/konfiguracja-fakturownia.js';

const TOKEN = 'ZmyslonyTokenPolcien123/pracownia-polcien';

describe('PRZ-119.05 formularz Fakturowni', () => {
  it('poprawna domena i token: domena jawna, token sekretem, brzegi obcięte', () => {
    expect(sprawdzFormularzFakturowni({ domena: ' pracownia-polcien ', token: ` ${TOKEN}\n` })).toEqual({
      ustawienia: { domena: 'pracownia-polcien' }, sekrety: { token: TOKEN }, bledy: [],
    });
    expect(EKRAN_FAKTUROWNI).toBe('/ustawienia/integracje/fakturownia');
    expect(ID_FAKTUROWNI).toBe('fakturownia');
  });

  it('domena z ukośnikiem, kropką, @, wielkimi literami albo pusta → błąd, który nie cytuje wpisu', () => {
    for (const zla of ['pracownia/polcien', 'pracownia-polcien.fakturownia.pl', 'ktos@pracownia', 'Pracownia', '', '-zly']) {
      const w = sprawdzFormularzFakturowni({ domena: zla, token: TOKEN });
      expect(w.bledy).toHaveLength(1);
      expect(w.bledy[0]).toMatch(/domen/i);
      if (zla) expect(w.bledy[0].includes(zla)).toBe(false);
    }
  });

  it('brak tokenu: bez zapisu — błąd; z zapisem — zapisany zostaje (token nie wraca na ekran)', () => {
    expect(sprawdzFormularzFakturowni({ domena: 'pracownia-polcien' }).bledy).toEqual(['Podaj token API Fakturowni.']);
    const z = sprawdzFormularzFakturowni({ domena: 'pracownia-polcien', token: '' }, { sekrety: { token: TOKEN } });
    expect(z.bledy).toEqual([]);
    expect(z.sekrety.token).toBe(TOKEN);
  });

  it('token ze spacją w środku, za krótki albo za długi → błąd bez cytowania wartości', () => {
    for (const zly of ['abc def ghi jkl', 'krotki', 'x'.repeat(201)]) {
      const w = sprawdzFormularzFakturowni({ domena: 'pracownia-polcien', token: zly });
      expect(w.bledy).toHaveLength(1);
      expect(w.bledy[0].includes(zly)).toBe(false);
    }
  });

  it('opcje klienta z zapisu: token i domena, transport domyślny; obce pola zapisu ignorowane', () => {
    expect(opcjeKlientaFakturowni({ ustawienia: { domena: 'pracownia-polcien', adres: 'https://obcy.invalid' }, sekrety: { token: TOKEN } }))
      .toEqual({ token: TOKEN, domena: 'pracownia-polcien', fetchImpl: undefined });
    expect(opcjeKlientaFakturowni(null)).toEqual({ token: '', domena: '', fetchImpl: undefined });
  });
});
