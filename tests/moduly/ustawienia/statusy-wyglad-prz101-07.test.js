import { it, expect } from 'vitest';
import { nowyPanel, BASIC, get } from '../../pomoc/konta-prz068.js';
import { PALETA_STATUSOW } from '../../../src/domena/statusy-konfiguracja.js';

it('wybór koloru pokazuje barwy palety przy nazwach w edycji i przy dodawaniu statusu', async () => {
  const { db, app } = nowyPanel();
  try {
    const ekran = await get(app, '/ustawienia/statusy', BASIC);
    expect(ekran.statusCode).toBe(200);
    const wybory = ekran.body.match(/<select\b[^>]*name="kolor"[^>]*>[\s\S]*?<\/select>/g);
    expect(wybory).toHaveLength(7);
    for (const wybor of wybory) {
      expect(wybor).toContain('class="ust-kolor"');
      for (const [klucz, p] of Object.entries(PALETA_STATUSOW)) {
        expect(wybor).toContain(`<option class="znacznik--${p.klasa}" value="${klucz}"`);
      }
    }
  } finally { await app.close(); db.close(); }
});
