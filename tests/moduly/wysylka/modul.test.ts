import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { createPuls } from '../../../src/core/puls.js';

describe('manifest wysylka', () => {
  it('zachowuje domyślny katalog etykiet i odmawia ze złym odstępem zegara', () => {
    expect(modulWysylka.konfiguracja({}).katalogEtykiet).toBe('/var/lib/panel/etykiety');
    expect(() => modulWysylka.konfiguracja({ OMS_ETYKIETY_KATALOG: '/tmp/etykiety', OMS_PRZESYLKI_ODSTEP_MS: '0' })).toThrow('OMS_PRZESYLKI_ODSTEP_MS');
  });

  it('składa prawdziwe usługi, kolejkę HTTP i dwa zegary bez nadania przy starcie', async () => {
    const db = openOmsDb();
    const nadaj = vi.fn();
    let teraz = new Date('2026-09-30T10:00:00Z');
    const puls = createPuls({ teraz: () => teraz });
    const uslugi: Record<string, unknown> = {
      'kanaly.klienciSklepow': { sklep: {} }, 'kanaly.klienciKanalow': { konto: { utworzPrzesylke: nadaj } },
      'rdzen.sprzedawca': { rachunek: '34109010140000000000000000' },
      'kanaly.config': { definicje: [], sklepy: {} }, 'faktury.infakt': null, 'faktury.puls': puls,
      'zamowienia.wczytajListe': () => [],
      'zamowienia.miniaturyEkranu': () => () => null,
    };
    const z = modulWysylka.zbuduj({ db,
      konfiguracja: modulWysylka.konfiguracja({ OMS_ETYKIETY_KATALOG: mkdtempSync(join(tmpdir(), 'prz-022-')) }),
      teraz: () => teraz, log: () => {},
      usluga: <T>(m: string, n: string) => {
        const key = `${m}.${n}`;
        if (!Object.hasOwn(uslugi, key)) throw new Error(key);
        return uslugi[key] as T;
      },
    });
    for (const [n, v] of Object.entries(z.uslugi ?? {})) uslugi[`wysylka.${n}`] = v;
    const app = Fastify();
    try {
      z.trasy?.(app);
      expect((await app.inject('/kolejka-druku')).json()).toEqual([]);
      expect(z.zegary?.map(x => x.nazwa)).toEqual(['czuwaczPrzesylek', 'czuwaczPodjazdow']);
      expect(z.uslugi?.nadanie).toHaveProperty('sprawdzPonownie');
      expect(nadaj).not.toHaveBeenCalled();
      await z.zegary?.find(x => x.nazwa === 'czuwaczPrzesylek')?.przebieg();
      expect(puls.stan()).toEqual({ czuwaczPrzesylek: { okAt: '2026-09-30T10:00:00.000Z' } });
      teraz = new Date('2026-09-30T14:00:00Z');
      expect(z.zdrowie?.().alarmy).toEqual([expect.stringContaining('czuwacz przesyłek: ostatni udany przebieg')]);
    } finally { await app.close(); db.close(); }
  });
});
