// Testy nie mogą zależeć od katalogów jednej maszyny (12.11.2026: trzy testy kreatora ERLI miały
// OMS_ETYKIETY_KATALOG w /srv/praca/kierownik-petla/tmp/… — na VM 210 katalog istniał, więc bramka była
// zielona, a CI kopii publicznej padło na EACCES). Katalog roboczy testu zakłada się w os.tmpdir().
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const KORZEN = path.resolve(import.meta.dirname, '../..');
// Tylko ścieżki Linuksa, na których test mógłby czytać albo zapisywać (CI biegnie na Linuksie). Ścieżka laptopa
// w komentarzu i jako próbka w strażniku danych firmy (PRZ-060) niczego nie psuje — tę wycina buduj.sh kopii.
const SCIEZKI_MASZYNY = /\/srv\/praca\/|\/home\/adam\//;
const TEN_PLIK = path.resolve(import.meta.filename);

function plikiTestow(katalog) {
  const wynik = [];
  for (const wpis of fs.readdirSync(katalog, { withFileTypes: true })) {
    const pelna = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) wynik.push(...plikiTestow(pelna));
    else if (/\.(js|mjs|ts)$/.test(wpis.name) && pelna !== TEN_PLIK) wynik.push(pelna);
  }
  return wynik;
}

describe('strażnik ścieżek maszyny w testach', () => {
  it('żaden plik w tests/ nie wskazuje katalogu VM ani laptopa', () => {
    const trafienia = plikiTestow(path.join(KORZEN, 'tests'))
      .filter((plik) => SCIEZKI_MASZYNY.test(fs.readFileSync(plik, 'utf8')))
      .map((plik) => path.relative(KORZEN, plik).replaceAll('\\', '/'));
    expect(trafienia).toEqual([]);
  });
});
