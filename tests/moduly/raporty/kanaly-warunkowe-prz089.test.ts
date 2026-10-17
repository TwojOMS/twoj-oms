// PRZ-089 (decyzja 16.10.2026): czysta instalacja obcego człowieka zakładała granice raportu GDD
// i INDYWIDUALNE — kanały konkretnego wdrożenia autora. GDD powstaje WYŁĄCZNIE z tagu historii (tagGdd),
// INDYWIDUALNE wyłącznie z zamówień przez API panelu. Oba są teraz warunkowe; wdrożenie z historią
// (tagGdd i prefiksyIndywidualne w OMS_HISTORIA_KLASYFIKACJA) ma te same pięć kanałów co przedtem.
import { describe, it, expect } from 'vitest';
import { wczytajKlasyfikacje, kanalIndywidualnyWlaczony } from '../../../src/moduly/kanaly/klasyfikacja.ts';
import { planGranic } from '../../../scripts/produkcja-pierwszy-start.mjs';
import { envRaportowHistorycznyFixture } from '../../pomoc/raporty-historyczne-fixture.js';
import { definicjeKanalowHistoryczne } from '../../pomoc/kanaly-historyczne-fixture.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const raporty = (env: Record<string, string>) => [...wczytajKlasyfikacje(env, []).raporty].sort();
const historia = (h: object) => JSON.stringify({ konta: [], ...h });

describe('PRZ-089 kanały raportowe GDD i INDYWIDUALNE tylko z konfiguracji', () => {
  it('czysta instalacja: tylko kanały ogólne (ręczne, hurt, okres rozliczeniowy)', () => {
    expect(raporty({})).toEqual(['B2B', 'DROPSHIPPING', 'RECZNE']);
    expect(planGranic({ OMS_KANALY: '[]' }, new Date('2026-10-16T09:00:00Z')).plan.map(p => p.kanal)).toEqual(['B2B', 'DROPSHIPPING', 'RECZNE']);
  });
  it('GDD pojawia się z tagGdd', () => {
    expect(raporty({ OMS_HISTORIA_KLASYFIKACJA: historia({ tagGdd: 9 }) })).toEqual(['B2B', 'DROPSHIPPING', 'GDD', 'RECZNE']);
  });
  it('INDYWIDUALNE: jawnie OMS_KANAL_INDYWIDUALNY=1, a bez wpisu — gdy historia ma prefiksy indywidualne', () => {
    expect(raporty({ OMS_KANAL_INDYWIDUALNY: '1' })).toEqual(['B2B', 'DROPSHIPPING', 'INDYWIDUALNE', 'RECZNE']);
    expect(raporty({ OMS_HISTORIA_KLASYFIKACJA: historia({ prefiksyIndywidualne: ['28040|'] }) })).toEqual(['B2B', 'DROPSHIPPING', 'INDYWIDUALNE', 'RECZNE']);
    expect(kanalIndywidualnyWlaczony({})).toBe(false);
    expect(kanalIndywidualnyWlaczony({ OMS_KANAL_INDYWIDUALNY: '0' })).toBe(false);
  });
  it('sprzeczna albo błędna konfiguracja nie wstaje', () => {
    expect(() => wczytajKlasyfikacje({ OMS_KANAL_INDYWIDUALNY: '0', OMS_HISTORIA_KLASYFIKACJA: historia({ prefiksyIndywidualne: ['28040|'] }) }, []))
      .toThrow(/OMS_KANAL_INDYWIDUALNY/);
    expect(() => kanalIndywidualnyWlaczony({ OMS_KANAL_INDYWIDUALNY: 'tak' })).toThrow(/OMS_KANAL_INDYWIDUALNY/);
  });
  it('konfiguracja produkcji Szkicownia (fixture historii) — te same pięć kanałów algorytmicznych co przed PRZ-089', () => {
    const r = wczytajKlasyfikacje(envRaportowHistorycznyFixture, definicjeKanalowHistoryczne as any).raporty;
    for (const k of ['DROPSHIPPING', 'GDD', 'B2B', 'RECZNE', 'INDYWIDUALNE']) expect(r.has(k), k).toBe(true);
  });
  it('API panelu odmawia zamówienia z karty, gdy kanał indywidualny jest wyłączony', async () => {
    const naglowki = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost', host: 'localhost' };
    const cialo = { kartaId: 'karta-089', klient: { first_name: 'Jan', last_name: 'Testowy', email: 'jan@example.com', phone: '600000000' },
      dostawa: { first_name: 'Jan', last_name: 'Testowy', address_1: 'Długa 1', postcode: '30-001', city: 'Kraków' }, nip: null, chceFakture: false,
      kosztDostawyBrutto: '0.00', pozycje: [{ nazwa: 'Produkt', ilosc: 1, cena_brutto: '10.00' }] };
    for (const [wartosc, kod] of [['0', 503], ['1', 201]] as const) {
      const db = openOmsDb(':memory:');
      const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] }, env: { OMS_KANAL_INDYWIDUALNY: wartosc } });
      await app.ready();
      try {
        const r = await app.inject({ method: 'POST', url: '/api/zamowienia-z-karty', headers: naglowki, payload: cialo });
        expect(r.statusCode, `${wartosc}: ${r.body}`).toBe(kod);
        expect((db.prepare('SELECT COUNT(*) AS n FROM zamowienia').get() as any).n).toBe(kod === 201 ? 1 : 0);
      } finally { await app.close(); }
    }
  });
});
