import { describe, it, expect } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapewnijOkres, rozpocznijFaktureOkresu } from '../../src/oms/db/okresy.js';

// PRZ-118.04 — strażnik rezerwacji faktury okresu pyta o identyfikator dokumentu przez `idDokumentuSql()`
// (`dokument_id`, zapasowo `infakt_uuid`). Okres ponownie otwarty (`otworzOkresPonownie` zdejmuje barierę
// stanu) z dokumentem bez numeru — inFakt oddał uuid bez numeru — to jedyny przypadek, w którym o drugim
// wystawieniu rozstrzyga sam identyfikator. Bez tego testu mutacja „tylko `dokument_id`” przechodziła
// wszystkie testy okresów (zmierzone przy 04).

function okresZDokumentem(kolumny) {
  const db = openOmsDb(':memory:');
  const okres = zapewnijOkres(db, { klientKlucz: 'nip:5250000000', rok: 2026, miesiac: 10 });
  const ustaw = Object.keys(kolumny).map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE okresy_rozliczeniowe SET ${ustaw}, stan = 'otwarty' WHERE id = @id`).run({ ...kolumny, id: okres.id });
  return { db, id: okres.id };
}

describe('rezerwacja faktury okresu — dokument już jest (PRZ-118.04)', () => {
  it('wiersz starego obrazu: sam infakt_uuid, bez numeru — odmowa', () => {
    const { db, id } = okresZDokumentem({ infakt_uuid: 'U-OKRES-STARY' });
    expect(() => rozpocznijFaktureOkresu(db, id)).toThrow(/zaczęło się już gdzie indziej/);
    expect(db.prepare('SELECT ksef_status FROM okresy_rozliczeniowe WHERE id = ?').get(id).ksef_status).toBeNull();
  });

  it('wiersz innego programu: sam dokument_id, bez numeru — odmowa', () => {
    const { db, id } = okresZDokumentem({ program: 'fakturownia', dokument_id: '4402' });
    expect(() => rozpocznijFaktureOkresu(db, id)).toThrow(/zaczęło się już gdzie indziej/);
  });

  it('okres bez dokumentu — rezerwacja przechodzi', () => {
    const { db, id } = okresZDokumentem({ program: null });
    expect(rozpocznijFaktureOkresu(db, id).ksef_status).toBe('w_toku');
  });
});
