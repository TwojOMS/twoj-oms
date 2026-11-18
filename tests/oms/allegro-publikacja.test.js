import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createAllegroClient } from '../../src/oms/allegro/client.js';
import { createSerwerOfertAllegro } from '../../deploy/proba/atrapy/allegro-oferty.mjs';

function klient() {
  const wolania = [];
  const k = createAllegroClient({
    ustawienia: { api: 'https://api.example.invalid', userAgent: 'test/1 (+https://example.invalid)' },
    tokeny: { waznyToken: async () => 'test' },
    fetchImpl: async (url, opcje) => {
      wolania.push({ url, opcje });
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ tasks: [] }) };
    },
  });
  return { k, wolania };
}

describe('komenda publikacji', () => {
  it('odrzuca nadmiar ofert i złą akcję przed żądaniem', async () => {
    const { k, wolania } = klient();
    await expect(
      k.komendaPublikacji(
        'uuid',
        Array.from({ length: 1001 }, (_, i) => String(i)),
        'END',
      ),
    ).rejects.toThrow();
    await expect(k.komendaPublikacji('uuid', ['1'], 'INNE')).rejects.toThrow();
    expect(wolania).toHaveLength(0);
  });

  it('ponawia ten sam PUT z UUID i czyta zadania publikacji', async () => {
    const { k, wolania } = klient();
    for (let i = 0; i < 2; i++) await k.komendaPublikacji('uuid-1', ['1', '2'], 'END');
    expect(wolania.map((w) => [w.opcje.method, new URL(w.url).pathname])).toEqual([
      ['PUT', '/sale/offer-publication-commands/uuid-1'],
      ['PUT', '/sale/offer-publication-commands/uuid-1'],
    ]);
    expect(JSON.parse(wolania[0].opcje.body)).toEqual({
      publication: { action: 'END' },
      offerCriteria: [{ offers: [{ id: '1' }, { id: '2' }], type: 'CONTAINS_OFFERS' }],
    });
    expect(wolania[1].opcje.body).toBe(wolania[0].opcje.body);
    expect(await k.wynikKomendy('publikacja', 'uuid-1')).toEqual([]);
    expect([wolania[2].opcje.method, new URL(wolania[2].url).pathname]).toEqual([
      'GET',
      '/sale/offer-publication-commands/uuid-1/tasks',
    ]);
  });

  it('atrapa kończy, odmawia wznowienia przy zerze i wznawia przy dodatnim stanie', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const serwer = createSerwerOfertAllegro({ db, kanal: 'allegro', env: { OMS_TRYB: 'proba' } });
      const a = createAllegroClient({
        ustawienia: { api: serwer.api, userAgent: 'test/1 (+https://example.invalid)' },
        tokeny: { waznyToken: async () => 'test' },
        fetchImpl: serwer.fetchImpl,
      });
      db.prepare('INSERT INTO atrapa_allegro_oferty VALUES (?, ?, ?)').run(
        'allegro',
        '1',
        JSON.stringify({ id: '1', stock: { available: 0 }, publication: { status: 'ACTIVE' } }),
      );
      await a.komendaPublikacji('end', ['1'], 'END');
      expect((await a.wynikKomendy('publikacja', 'end'))[0].status).toBe('SUCCESS');
      expect((await a.pobierzOferte('1')).publication.status).toBe('ENDED');
      await a.komendaPublikacji('zero', ['1'], 'ACTIVATE');
      expect((await a.wynikKomendy('publikacja', 'zero'))[0].status).toBe('FAIL');
      expect((await a.pobierzOferte('1')).publication.status).toBe('ENDED');
      await a.komendaIlosci('ilosc', [{ ofertaId: '1', ilosc: 2 }]);
      await a.komendaPublikacji('wznow', ['1'], 'ACTIVATE');
      expect((await a.wynikKomendy('publikacja', 'wznow'))[0].status).toBe('SUCCESS');
      expect((await a.pobierzOferte('1')).publication.status).toBe('ACTIVE');
    } finally {
      db.close();
    }
  });
});
