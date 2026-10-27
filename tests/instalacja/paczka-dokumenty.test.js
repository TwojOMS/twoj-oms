// PRZ-093: dokument, do którego odsyła instrukcja instalacji, musi być w paczce wydania.
// Zmierzone przed poprawką: docs/instalacja-docker.md odsyłał do docs/kurier-dpd.md, a paczka go nie pakowała.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { plikiPaczki } from '../../scripts/paczka-klienta.mjs';

describe('paczka wydania: dokumenty kurierów', () => {
  it('docs/kurier-dpd.md jest w paczce, a kolejne docs/kurier-*.md wchodzą wzorcem', () => {
    const w = plikiPaczki(['docs/kurier-dpd.md', 'docs/kurier-inpost.md', 'docs/kurier-inny-1.md', 'docs/kurier.md', 'docs/kurier-dpd.txt', 'docs/prz-kurier-dpd.md', 'docs/podkatalog/kurier-dpd.md', 'src/oms.js']);
    expect(w).toEqual(['docs/kurier-dpd.md', 'docs/kurier-inny-1.md', 'docs/kurier-inpost.md', 'src/oms.js']);
  });

  it('PRZ-094.04: docs/poczta-smtp.md (instrukcja poczty wychodzącej) jest w paczce i istnieje w repo', () => {
    expect(plikiPaczki(['docs/poczta-smtp.md', 'docs/poczta-smtp.txt', 'docs/poczta.md'])).toEqual(['docs/poczta-smtp.md']);
    expect(fs.existsSync(new URL('../../docs/poczta-smtp.md', import.meta.url))).toBe(true);
  });

  it('PRZ-121.05a: docs/modul-faktur.md jest w paczce i istnieje w repo', () => {
    expect(plikiPaczki(['docs/modul-faktur.md', 'docs/modul-faktur.txt'])).toEqual(['docs/modul-faktur.md']);
    expect(fs.existsSync(new URL('../../docs/modul-faktur.md', import.meta.url))).toBe(true);
  });

  it('każdy dokument docs/*.md wskazany w instrukcji instalacji Dockera, który istnieje w repo, jest w paczce', () => {
    const tresc = fs.readFileSync(new URL('../../docs/instalacja-docker.md', import.meta.url), 'utf8');
    // Bez przypinania konkretnej nazwy: kopia open source ma własną (autorską) instrukcję, która odsyła do innych
    // dokumentów (18.10: tylko aktualizacja-klienta-v0.md). Że docs/kurier-dpd.md wchodzi do paczki, pilnuje test wyżej.
    const wskazane = [...new Set([...tresc.matchAll(/docs\/[A-Za-z0-9_-]+\.md/g)].map(m => m[0]))]
      .filter(p => fs.existsSync(new URL(`../../${p}`, import.meta.url)));
    expect(wskazane.length).toBeGreaterThan(0);
    const wPaczce = plikiPaczki(wskazane);
    expect(wPaczce).toEqual([...wskazane].sort());
  });
});
