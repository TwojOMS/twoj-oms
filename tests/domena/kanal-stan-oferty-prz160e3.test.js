import { describe, it, expect } from 'vitest';
import { stanKanalu, stanyKanalowZKolizjami, kanalyWymagajaceUwagi } from '../../src/domena/kanal-stan.js';

// PRZ-160 E3.02 (D42): zdrowe konto bez zakresow ofert. Wiazanie (ktore NADPISUJE dzialajaca
// pare tokenow) otwiera sie tylko, gdy aplikacja ma zakresy ofert I ktos kliknal
// „Chcę wystawiać oferty". Samo „aplikacja moze" nie wystarcza.

const zdrowy = (n = {}) => ({
  kanal: 'allegro_polcien',
  polaczony: true,
  zostaloDni: 89,
  refreshWygasaAt: '2027-02-10T06:00:00.000Z',
  ostatniBlad: null,
  brakujaceUprawnienia: [],
  kontoAllegro: '41000001',
  ...n,
});

describe('ponowna zgoda na oferty (D42)', () => {
  it('zdrowe konto, aplikacja ma oferty, kliknięto → wolno wiązać', () => {
    const s = stanKanalu(zdrowy({ brakOfert: true, aplikacjaMaOferty: true, chceOfert: true }));
    expect(s.wolnoWiazac).toBe(true);
    expect(s.zgodaOfertOtwarta).toBe(true);
    expect(s.zyje).toBe(true);
    expect(s.pilne).toBe(false);
    expect(s.powod).toBe('Kanał allegro_polcien: konto działa — ponowna zgoda doda wystawianie ofert.');
  });

  it('zdrowe konto bez kliknięcia → nie wolno wiązać', () => {
    const s = stanKanalu(zdrowy({ brakOfert: true, aplikacjaMaOferty: true, chceOfert: false }));
    expect(s.wolnoWiazac).toBe(false);
    expect(s.zgodaOfertOtwarta).toBe(false);
    expect(s.powod).toBeNull();
  });

  it('kliknięto, ale aplikacja nie ma zakresów ofert → nie wolno wiązać', () => {
    const s = stanKanalu(zdrowy({ brakOfert: true, aplikacjaMaOferty: false, chceOfert: true }));
    expect(s.wolnoWiazac).toBe(false);
  });

  it('konto ma już zgodę na oferty → kliknięcie nic nie otwiera', () => {
    const s = stanKanalu(zdrowy({ brakOfert: false, aplikacjaMaOferty: true, chceOfert: true }));
    expect(s.wolnoWiazac).toBe(false);
  });

  it('termin i braki wymaganych mają pierwszeństwo w powodzie', () => {
    const s = stanKanalu(zdrowy({
      zostaloDni: 3, brakOfert: true, aplikacjaMaOferty: true, chceOfert: true,
    }));
    expect(s.powod).toMatch(/wygasa/);
  });

  it('ta sama reguła w ocenie wszystkich kanałów, a pasek spraw jej nie widzi', () => {
    const lista = stanyKanalowZKolizjami([
      zdrowy({ brakOfert: true, aplikacjaMaOferty: true, chceOfert: true }),
      zdrowy({ kanal: 'allegro_drugi', kontoAllegro: '41000002', brakOfert: true, aplikacjaMaOferty: true }),
    ]);
    expect(lista.map((s) => s.wolnoWiazac)).toEqual([true, false]);
    expect(kanalyWymagajaceUwagi(lista)).toEqual([]);
  });
});
