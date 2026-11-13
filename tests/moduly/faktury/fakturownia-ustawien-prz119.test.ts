// PRZ-119.05 — klient Fakturowni z Ustawień: pośrednik czyta bieżący zapis przy każdym wywołaniu.
// Brak zapisu = odmowa 4xx bez wywołania fabryki; zmiana domeny/tokenu = nowy klient; piaskownica odmawia.
// Dane zmyślone („Pracownia Półcień”).
import { describe, it, expect, vi } from 'vitest';
import { fakturowniaZUstawien, odmowaFakturowniWProbie } from '../../../src/moduly/faktury/fakturownia-ustawien.ts';
import { METODY_FAKTUROWNI } from '../../../src/oms/fakturownia/client.js';

const TOKEN_A = 'ZmyslonyTokenPolcienA123';
const TOKEN_B = 'ZmyslonyTokenPolcienB456';
const zapis = (domena: string, token: string) => ({ ustawienia: { domena }, sekrety: { token } });

function fabrykaLiczaca() {
  const utworzone: any[] = [];
  const fabryka = vi.fn((opcje: any) => {
    utworzone.push(opcje);
    const nr = utworzone.length;
    return Object.fromEntries(METODY_FAKTUROWNI.map((m: string) => [m, async (...a: unknown[]) => ({ klient: nr, m, a })]));
  });
  return { fabryka, utworzone };
}

describe('PRZ-119.05 fakturowniaZUstawien', () => {
  it('ma wszystkie metody klienta Fakturowni', () => {
    const p = fakturowniaZUstawien({ wczytaj: () => null, fabryka: fabrykaLiczaca().fabryka });
    expect(Object.keys(p).sort()).toEqual([...METODY_FAKTUROWNI].sort());
  });

  it('brak zapisu albo brak domeny/tokenu → 400 z bezProgramu i adresem ekranu, fabryka nie wołana', async () => {
    for (const z of [null, zapis('', TOKEN_A), zapis('pracownia-polcien', '')]) {
      const { fabryka } = fabrykaLiczaca();
      const p = fakturowniaZUstawien({ wczytaj: () => z, fabryka });
      const blad: any = await p.wystaw({}).catch((e: unknown) => e);
      expect(blad).toBeInstanceOf(Error);
      expect(blad.status).toBe(400);
      expect(blad.bezProgramu).toBe(true);
      expect(blad.message).toContain('/ustawienia/integracje/fakturownia');
      expect(blad.message).toContain('Nic nie poszło do Fakturowni');
      expect(fabryka).not.toHaveBeenCalled();
    }
  });

  it('ten sam zapis = ten sam klient; zmiana tokenu albo domeny = nowy klient od następnego żądania', async () => {
    let biezacy = zapis('pracownia-polcien', TOKEN_A);
    const { fabryka, utworzone } = fabrykaLiczaca();
    const p = fakturowniaZUstawien({ wczytaj: () => biezacy, fabryka });
    expect((await p.pobierzFakture(7)).klient).toBe(1);
    expect((await p.pobierzFakture(8)).klient).toBe(1);
    biezacy = zapis('pracownia-polcien', TOKEN_B);
    expect((await p.pobierzFakture(9)).klient).toBe(2);
    biezacy = zapis('polcien-druga', TOKEN_B);
    const w = await p.pobierzFakture(10);
    expect(w).toEqual({ klient: 3, m: 'pobierzFakture', a: [10] });
    expect(utworzone.map((o) => [o.domena, o.token === TOKEN_B])).toEqual([
      ['pracownia-polcien', false], ['pracownia-polcien', true], ['polcien-druga', true],
    ]);
    expect(utworzone.every((o) => o.fetchImpl === undefined)).toBe(true);
  });

  it('piaskownica: każda metoda odmawia 400 z bezProgramu, bez żadnego żądania', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const k = odmowaFakturowniWProbie();
      expect(Object.keys(k).sort()).toEqual([...METODY_FAKTUROWNI].sort());
      for (const m of METODY_FAKTUROWNI) {
        const blad: any = await k[m]().catch((e: unknown) => e);
        expect(blad.status).toBe(400);
        expect(blad.bezProgramu).toBe(true);
        expect(blad.message).toMatch(/Piaskownica/);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
