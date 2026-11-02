// PRZ-122.TFeb: wydzielone przypadki wspólne; ciała bez zmian.
import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const katalog = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));

  it('pliki XSD na dysku są bajt w bajt takie, jak w docs/ksef/README.md (podmiana adresów tylko w pamięci)', () => {
    const readme = readFileSync(katalog('docs/ksef/README.md'), 'utf8');
    const wiersze = [...readme.matchAll(/^\| `([^`]+\.xsd)` \|.*\| `([0-9a-f]{64})` \|$/gm)];
    expect(wiersze.length).toBe(5);
    for (const [, plik, sha] of wiersze) {
      const skrot = createHash('sha256').update(readFileSync(katalog(`docs/ksef/${plik}`))).digest('hex');
      expect(skrot, plik).toBe(sha);
    }
  });