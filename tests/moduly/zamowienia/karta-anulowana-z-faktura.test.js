// Zdanie na karcie zamówienia anulowanego po wystawieniu faktury.
// Migawka `nazwa-programu.test.js` wycina `section#faktura` (treść sekcji pilnują testy tabeli dokumentów),
// więc tego zdania nie widzi żaden inny test: tu sprawdzamy jego SENS (po znormalizowaniu białych znaków),
// a nie układ HTML — zmiana wcięcia nie może go czerwienić.
import { describe, it, expect, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const AUTH = { authorization: `Basic ${Buffer.from('t:h').toString('base64')}`, origin: 'http://localhost' };
const apki = [];
afterEach(async () => {
  for (const a of apki.splice(0)) await a.close();
});

function kartaAnulowanejZFaktura() {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ db, config: { auth: { user: 't', pass: 'h' } } });
  apki.push(app);
  const id = zapiszZamowienie(
    db,
    'pro',
    {
      zrodlo_id: 'w-174',
      numer: 'Z-174',
      klient: { first_name: 'Ida', last_name: 'Lampowa', company: 'Pracownia Półcień' },
      dostawa: {},
      metoda_wysylki: 'dpd',
      kwota_pobrania: null,
      chce_fakture: 1,
      nip: '5250000000',
      kwota_brutto: '249.00',
      koszt_dostawy_brutto: '0.00',
      status_woo: 'cancelled',
      oplacone_at: null,
      anulowane: 1,
      pozycje: [],
      utworzone_at: '2026-10-05T09:00:00',
    },
    {},
  );
  db.prepare(
    "INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, utworzona_at) VALUES (?, 'U-174', 'FV 3/10/2026', '2026-10-06T10:00:00.000Z')",
  ).run(id);
  return app.inject({ method: 'GET', url: `/zamowienia/${id}`, headers: AUTH });
}

const tekstBlokady = (html) => {
  const akapit = /<p class="pasek-blokada">\s*UWAGA: zamówienie anulowane[\s\S]*?<\/p>/u.exec(html)?.[0] ?? '';
  return akapit
    .replace(/<[^>]*>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
};

describe('karta zamówienia anulowanego z fakturą', () => {
  it('mówi, że anulowanie nie kasuje faktury: przed wysyłką do KSeF skasuj ją w programie, po wysyłce wystaw korektę', async () => {
    const r = await kartaAnulowanejZFaktura();
    expect(r.statusCode).toBe(200);
    const zdanie = tekstBlokady(r.body);
    expect(zdanie, 'akapit UWAGA na karcie').not.toBe('');
    expect(zdanie).toContain('faktura FV 3/10/2026 jest w inFakcie');
    expect(zdanie).toContain('anulowanie w sklepie jej NIE kasuje');
    expect(zdanie).toContain('Jeśli jeszcze nie poszła do KSeF, skasuj ją w inFakcie;');
    expect(zdanie).toContain('jeśli już poszła, wystaw KOREKTĘ.');
  });
});
