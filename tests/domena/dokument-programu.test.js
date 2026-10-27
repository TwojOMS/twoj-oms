import { describe, it, expect } from 'vitest';
import { idDokumentu, programDokumentu, idDokumentuSql } from '../../src/domena/dokument-programu.js';

// PRZ-118.04 — jeden moduł czyta identyfikator dokumentu: `dokument_id` (od rdzen/0008), a gdy go
// nie ma — `infakt_uuid` (wiersz zapisany przez obraz sprzed PRZ-118 w oknie wycofania).

describe('idDokumentu', () => {
  it('dokument_id wygrywa z infakt_uuid', () => {
    expect(idDokumentu({ dokument_id: 'D-1', infakt_uuid: 'U-1' })).toBe('D-1');
  });
  it('bez dokument_id — zapas infakt_uuid (wiersz starego obrazu)', () => {
    expect(idDokumentu({ infakt_uuid: 'U-STARY' })).toBe('U-STARY');
    expect(idDokumentu({ dokument_id: null, infakt_uuid: 'U-STARY' })).toBe('U-STARY');
  });
  it('dokument programu innego niż inFakt (infakt_uuid pusty)', () => {
    expect(idDokumentu({ program: 'fakturownia', dokument_id: '4401', infakt_uuid: null })).toBe('4401');
  });
  it('oba brak → null; brak wiersza → null', () => {
    expect(idDokumentu({ dokument_id: null, infakt_uuid: null })).toBeNull();
    expect(idDokumentu({})).toBeNull();
    expect(idDokumentu(null)).toBeNull();
    expect(idDokumentu(undefined)).toBeNull();
  });
});

describe('programDokumentu', () => {
  it('zapisany program przy identyfikatorze', () => {
    expect(programDokumentu({ program: 'fakturownia', dokument_id: '4401' })).toBe('fakturownia');
    expect(programDokumentu({ program: 'infakt', dokument_id: 'U-1', infakt_uuid: 'U-1' })).toBe('infakt');
  });
  it('wiersz starego obrazu (sam infakt_uuid, bez program) → infakt', () => {
    expect(programDokumentu({ infakt_uuid: 'U-STARY' })).toBe('infakt');
    expect(programDokumentu({ program: null, dokument_id: null, infakt_uuid: 'U-STARY' })).toBe('infakt');
  });
  it('dokument_id bez program → infakt', () => {
    expect(programDokumentu({ dokument_id: 'U-2' })).toBe('infakt');
  });
  it('wiersz bez dokumentu → null, także gdy program jest zapisany (odpowiedź bez identyfikatora)', () => {
    expect(programDokumentu({ program: 'infakt', dokument_id: null, infakt_uuid: null })).toBeNull();
    expect(programDokumentu({ program: null, dokument_id: null, infakt_uuid: null })).toBeNull();
    expect(programDokumentu({})).toBeNull();
    expect(programDokumentu(null)).toBeNull();
  });
});

describe('idDokumentuSql', () => {
  it('z aliasem — dokładny napis', () => {
    expect(idDokumentuSql('f')).toBe('COALESCE(f.dokument_id, f.infakt_uuid)');
    expect(idDokumentuSql('okres_2')).toBe('COALESCE(okres_2.dokument_id, okres_2.infakt_uuid)');
  });
  it('bez aliasu — kolumny tabeli zapytania', () => {
    expect(idDokumentuSql()).toBe('COALESCE(dokument_id, infakt_uuid)');
  });
  it('alias spoza wzorca identyfikatora → wyjątek (bez wstrzykiwania SQL)', () => {
    for (const zly of ['', 'f.x', 'f; DROP TABLE faktury', '1f', 'f ', null, 7, {}]) {
      expect(() => idDokumentuSql(zly)).toThrow(/alias/);
    }
  });
});
