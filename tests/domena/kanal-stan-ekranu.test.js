import { describe, it, expect } from 'vitest';
import { stanKanalu, kanalyWymagajaceUwagi, DNI_UPRZEDZENIA } from '../../src/domena/kanal-stan.js';

// Wejsciem jest DOKLADNIE to, co oddaje `stanDlaEkranu()` z allegro/tokeny.js — biala lista
// pol bez poswiadczen (niezmiennik 4.10).
const zdrowy = (n = {}) => ({
  kanal: 'allegro_szkicownia',
  polaczony: true,
  zostaloDni: 89,
  refreshWygasaAt: '2026-11-12T06:24:30.186Z',
  ostatniBlad: null,
  zaktualizowaneAt: '2026-08-14T06:24:30.186Z',
  ...n,
});

const BLAD_ZUZYTEGO = 'Odświeżenie tokenu odrzucone (HTTP 400, invalid_grant) — refresh token '
  + 'wygasł albo został już zużyty.';

describe('stan kanału na ekranie', () => {
  it('kanał zdrowy: żyje, bez ostrzeżenia', () => {
    const s = stanKanalu(zdrowy());
    expect(s.zyje).toBe(true);
    expect(s.pilne).toBe(false);
    expect(s.powod).toBeNull();
  });

  // ⚠️⚠️ ZAPISANY BLAD WYSTARCZA, ZEBY UZNAC KANAL ZA MARTWY — choćby termin był odległy.
  // 14.08.2026 dokladnie tak bylo: `refresh_wygasa_at` pokazywalo 89 dni, a kanal nie
  // odpowiadal od 7 godzin. Panel zapisal blad o 06:14 i NIC z nim nie zrobil.
  it('zapisany błąd tokenu to ŚMIERĆ kanału, mimo 89 dni do terminu', () => {
    const s = stanKanalu(zdrowy({ ostatniBlad: BLAD_ZUZYTEGO }));
    expect(s.zyje).toBe(false);
    expect(s.pilne).toBe(true);
    expect(s.zostaloDni).toBe(89);
  });

  it('kanał niepołączony też woła o pomoc', () => {
    const s = stanKanalu(zdrowy({ polaczony: false, zostaloDni: null, refreshWygasaAt: null }));
    expect(s.zyje).toBe(false);
    expect(s.pilne).toBe(true);
  });

  // ⚠️ ODWROTNIE TEZ: zblizajacy sie termin to UPRZEDZENIE, nie awaria. Kanal dziala
  // i pas w kolorze bledu klamalby o tym, co sie dzieje.
  it('kończący się refresh token uprzedza, ale kanał DALEJ ŻYJE', () => {
    const s = stanKanalu(zdrowy({ zostaloDni: DNI_UPRZEDZENIA }));
    expect(s.zyje).toBe(true);
    expect(s.pilne).toBe(false);
    expect(s.uprzedzenie).toBe(true);
    expect(s.powod).toMatch(/2026-11-12|listopad/i);
  });

  it('dzień po progu uprzedzenia jeszcze nie ma', () => {
    expect(stanKanalu(zdrowy({ zostaloDni: DNI_UPRZEDZENIA + 1 })).uprzedzenie).toBe(false);
  });

  // ⚠️⚠️ NAJWAZNIEJSZY TEST TEGO PLIKU. Ostrzezenie i przycisk licza sie TA SAMA regula —
  // rozjazd znaczy albo przycisk prowadzacy prosto w odmowe, albo ostrzezenie bez wyjscia
  // (niezmiennik 4.9).
  it('gdziekolwiek panel ostrzega, tam WOLNO wiązać', () => {
    for (const wejscie of [
      zdrowy({ ostatniBlad: BLAD_ZUZYTEGO }),
      zdrowy({ polaczony: false }),
      zdrowy({ zostaloDni: 3 }),
    ]) {
      const s = stanKanalu(wejscie);
      expect(`${s.pilne || s.uprzedzenie}`).toBe('true');
      expect(`wolnoWiazac=${s.wolnoWiazac}`).toBe('wolnoWiazac=true');
    }
  });

  // ⚠️ I ODWROTNIE — TO JEST BARIERA, NIE KOSMETYKA. Ponowne wiazanie NADPISUJE dzialajaca
  // pare i uniewaznia ja po stronie Allegro; cofnac sie z tego nie da. Przycisk przy zdrowym
  // kanale zaprasza do klikniecia „na wszelki wypadek" i zabija dzialajacy kanal.
  it('przy kanale ZDROWYM wiązać NIE WOLNO', () => {
    const s = stanKanalu(zdrowy());
    expect(s.wolnoWiazac).toBe(false);
  });

  // Powod jedzie na ekran do czlowieka i ma powiedziec, CO PRZESTALO DZIALAC — a nie tylko
  // „blad tokenu". Bez tego nie da sie ocenic, czy to pilne.
  it('powód martwego kanału nazywa SKUTKI, nie samą przyczynę', () => {
    const s = stanKanalu(zdrowy({ ostatniBlad: BLAD_ZUZYTEGO }));
    expect(s.powod).toMatch(/zamówień/i);
    expect(s.powod).toMatch(/status/i);
    expect(s.powod).toMatch(/paczk/i);
  });

  it('powód niesie nazwę kanału — przy dwóch kanałach to jedyna różnica na ekranie', () => {
    expect(stanKanalu(zdrowy({ ostatniBlad: BLAD_ZUZYTEGO })).powod).toContain('allegro_szkicownia');
  });

  // ⚠️ NIGDY POSWIADCZEN NA EKRAN (4.10). Wejscie ich nie ma, ale gdyby ktos kiedys wolal te
  // regule surowym wierszem z bazy, tresc dla czlowieka NIE MA prawa ich przepuscic.
  it('nie przepuszcza tokenów, nawet gdy dostanie surowy wiersz', () => {
    const s = stanKanalu({
      ...zdrowy({ ostatniBlad: BLAD_ZUZYTEGO }),
      access_token: 'eyJhbGciOiJSUzI1NiJ9.TAJNE',
      refresh_token: 'SEKRETNY-REFRESH',
    });
    expect(JSON.stringify(s)).not.toContain('TAJNE');
    expect(JSON.stringify(s)).not.toContain('SEKRETNY-REFRESH');
  });

  it('brak wejścia to stan wymagający uwagi, nie wyjątek', () => {
    expect(stanKanalu(null).pilne).toBe(true);
    expect(stanKanalu(undefined).zyje).toBe(false);
  });
});

// ⚠️⚠️ TEN OPIS POWSTAŁ, BO MUTACJA PRZEŻYŁA. Filtr stał wyrażeniem w trasie, a test
// sprawdzał jego KSZTAŁT w źródle — więc doklejone `.slice(0, 1)` przechodziło. Przy dwóch
// zepsutych kanałach drugi był niewidoczny, czyli dokładnie ta wada, którą pas naprawia
// (`poller.stan()` oddaje PIERWSZEGO pollera z błędem). Reguła wróciła do domeny.
describe('które kanały trafiają na ekran', () => {
  const martwy = (kanal) => stanKanalu({ kanal, polaczony: true, zostaloDni: 80, ostatniBlad: 'invalid_grant' });
  const wygasa = (kanal) => stanKanalu({ kanal, polaczony: true, zostaloDni: 3, refreshWygasaAt: '2026-08-17T00:00:00Z' });
  const zdrowy2 = (kanal) => stanKanalu({ kanal, polaczony: true, zostaloDni: 80, ostatniBlad: null });

  it('pokazuje WSZYSTKIE zepsute kanały, nie pierwszy z brzegu', () => {
    const w = kanalyWymagajaceUwagi([martwy('a'), martwy('b')]);
    expect(w.map((s) => s.kanal)).toEqual(['a', 'b']);
  });

  it('zdrowe odpadają', () => {
    expect(kanalyWymagajaceUwagi([zdrowy2('a'), martwy('b'), zdrowy2('c')]).map((s) => s.kanal)).toEqual(['b']);
  });

  // Awaria i uprzedzenie to dwie rozne pilnosci — kolejnosc jest trescia, nie estetyka.
  it('awarie stoją przed uprzedzeniami', () => {
    expect(kanalyWymagajaceUwagi([wygasa('a'), martwy('b')]).map((s) => s.kanal)).toEqual(['b', 'a']);
  });

  it('pusta lista i brak wejścia nie wywalają się', () => {
    expect(kanalyWymagajaceUwagi([])).toEqual([]);
    expect(kanalyWymagajaceUwagi(null)).toEqual([]);
  });
});
