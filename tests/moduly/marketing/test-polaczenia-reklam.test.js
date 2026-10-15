import { describe, expect, it, vi } from 'vitest';
import { testPolaczenie } from '../../../src/moduly/marketing/uslugi/test-polaczenia-reklam.js';

const teraz = () => new Date('2026-09-23T10:00:00.000Z');
const baza = (nadpisania = {}) => ({
  typ: 'ga4', kontoId: 'moja-wlasciwosc', sekretRef: 'ref-testowy', kanal: 'moj-sklep',
  magazyn: { odczytaj: vi.fn().mockResolvedValue('sekret-testowy') },
  klienci: { ga4: vi.fn(() => ({ raportReklam: vi.fn().mockResolvedValue({ dni: [], waluta: 'PLN' }) })) },
  teraz, ...nadpisania,
});

describe('test połączenia reklam', () => {
  it('GA4 sprawdza odczyt, zachowuje pusty raport jako sukces i oddaje walutę', async () => {
    const args = baza();
    const wynik = await testPolaczenie(args);
    expect(args.magazyn.odczytaj).toHaveBeenCalledWith('ref-testowy');
    expect(args.klienci.ga4).toHaveBeenCalledWith({ sekret: 'sekret-testowy', sekretRef: 'ref-testowy', kontoId: 'moja-wlasciwosc' });
    expect(wynik).toEqual({ stan: 'dziala', waluta: 'PLN', strefa: null,
      pobranoAt: '2026-09-23T10:00:00.000Z', kodBledu: null, nastepnyKrok: null });
  });

  it('Meta sprawdza kampanie i dzienne insights, bez emisji nadal działa', async () => {
    const raportReklam = vi.fn().mockResolvedValue({ kampanie: [], dni: [], waluta: 'EUR', strefa: 'Europe/Warsaw' });
    const args = baza({ typ: 'meta', kontoId: 'act_123',
      klienci: { meta: vi.fn(() => ({ raportReklam })) } });
    const wynik = await testPolaczenie(args);
    expect(raportReklam).toHaveBeenCalledWith(expect.objectContaining({ konto: 'act_123' }));
    expect(wynik).toEqual({ stan: 'dziala', waluta: 'EUR', strefa: 'Europe/Warsaw',
      pobranoAt: '2026-09-23T10:00:00.000Z', kodBledu: null, nastepnyKrok: null });
  });

  it('403 z echem tokenu daje stały kod bez ujawnienia sekretu w wyniku i logu', async () => {
    const token = 'sekret-testowy';
    const blad = Object.assign(new Error(`Graph: Bearer ${token}`), { status: 403 });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wynik = await testPolaczenie(baza({ typ: 'meta', kontoId: 'act_123',
        klienci: { meta: () => ({ raportReklam: () => Promise.reject(blad) }) } }));
      expect(wynik.stan).toBe('brak_uprawnien');
      expect(wynik.kodBledu).toBe('BRAK_UPRAWNIEN');
      expect(wynik.nastepnyKrok).toMatch(/uprawnieni/i);
      expect(JSON.stringify(wynik)).not.toContain(token);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it('błąd z surową odpowiedzią i tokenem nie przechodzi do wyniku', async () => {
    const wynik = await testPolaczenie(baza({ klienci: { ga4: () => ({
      raportReklam: () => Promise.reject(new Error('API echo sekret-testowy, raw response')),
    }) } }));
    expect(wynik.kodBledu).toBe('BLAD_ODCZYTU');
    expect(JSON.stringify(wynik)).not.toContain('sekret-testowy');
    expect(JSON.stringify(wynik)).not.toContain('raw response');
  });

  it('brak sekretu daje bezpieczny stan tylko wybranego źródła', async () => {
    const wynik = await testPolaczenie(baza({ sekretRef: null }));
    expect(wynik.stan).toBe('niepodlaczone');
    expect(wynik.kodBledu).toBe('BRAK_KONFIGURACJI');
  });

  it('brak waluty w odpowiedzi nie udaje zerowego ani działającego raportu', async () => {
    const wynik = await testPolaczenie(baza({ klienci: { ga4: () => ({
      raportReklam: () => Promise.resolve({ dni: [], waluta: null }),
    }) } }));
    expect(wynik.stan).toBe('brak_konfiguracji');
    expect(wynik.waluta).toBeNull();
    expect(wynik.kodBledu).toBe('BRAK_WALUTY');
  });

  it('Google Ads API jest opcjonalne i nie próbuje czytać sekretu', async () => {
    const args = baza({ typ: 'google_ads' });
    const wynik = await testPolaczenie(args);
    expect(wynik.stan).toBe('niedostepne');
    expect(wynik.kodBledu).toBe('ADS_API_NIEDOSTEPNE');
    expect(wynik.nastepnyKrok).toMatch(/GA4/);
    expect(args.magazyn.odczytaj).not.toHaveBeenCalled();
  });
});
