import { wzorzecNazw } from '../pomoc/skroty-nazw-firmy.js';
import { describe, expect, it } from 'vitest';
import { promptReklam } from '../../src/domena/prompt-reklam.js';

describe('prompty podłączenia reklam', () => {
  it.each(['ga4', 'google_ads', 'meta'])('%s daje tekst dla agenta bez danych firmy i sekretów', (typ) => {
    const prompt = promptReklam(typ);
    expect(prompt).toContain('TwójOMS');
    expect(prompt).toMatch(/lokaln|repo/i);
    expect(prompt).toMatch(/test|sprawdź/i);
    expect(prompt).toMatch(/odczyt/i);
    expect(wzorzecNazw([{"wzor": "\\p{L}{8}", "skrot": "3876cd847a24f6d3a8f3542919b9f6545e500e2eea8583bb58583508cefe9a57", "bezWielkosci": true}, {"wzor": "\\p{L}{8}", "skrot": "a2ac0b2e157811634f85a0cd5e7ec6ae46b6123e724924eba975ef822566f72e", "bezWielkosci": true}], /wrzesien30|\b\d{7,}\b|G-[A-Z0-9]{8,}/i).test(prompt)).toBe(false);
  });

  it('GA4 wymaga własnej właściwości połączonej z Ads i przypisania kanału', () => {
    const prompt = promptReklam('ga4');
    expect(prompt).toMatch(/GA4/);
    expect(prompt).toMatch(/Google Ads/);
    expect(prompt).toMatch(/kanał/);
    expect(prompt).toMatch(/klucz.*poza repo/i);
    expect(prompt).toMatch(/nie proś.*klucz.*rozmowie/i);
  });

  it('Google Ads API jest opcjonalne i nie może zmieniać reklam ani budżetów', () => {
    const prompt = promptReklam('google_ads');
    expect(prompt).toMatch(/opcjonal/);
    expect(prompt).toMatch(/produkcyjn/);
    expect(prompt).toMatch(/GA4/);
    expect(prompt).toMatch(/status.*budżet.*konwersj/i);
    expect(prompt).toMatch(/nie zmieniaj reklam ani budżetów/i);
  });

  it('Meta wymaga odczytu insights i odróżnienia braku emisji od braku uprawnień', () => {
    const prompt = promptReklam('meta');
    expect(prompt).toMatch(/tylko do odczytu/i);
    expect(prompt).toMatch(/insights/i);
    expect(prompt).toMatch(/brak emisji.*braku uprawnień/i);
    expect(prompt).toMatch(/zdarzeń zakupu/i);
    expect(prompt).toMatch(/poza repo i rozmową/i);
  });

  it('nie zwraca promptu dla nieznanego źródła', () => {
    expect(() => promptReklam('allegro_ads')).toThrow(/Nieznane źródło reklam/);
  });
});
