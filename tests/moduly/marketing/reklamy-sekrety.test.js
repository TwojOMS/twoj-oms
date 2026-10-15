import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMagazynSekretow } from '../../../src/moduly/marketing/uslugi/reklamy-sekrety.js';

const katalogi = [];
async function katalogTestowy() {
  const katalog = await mkdtemp(join(tmpdir(), 'oms-reklamy-sekrety-'));
  katalogi.push(katalog);
  return katalog;
}
afterEach(async () => {
  await Promise.all(katalogi.splice(0).map((katalog) => rm(katalog, { recursive: true, force: true })));
});

describe('magazyn sekretów reklam', () => {
  it('zapisuje token poza bazą pod niejawna referencją i odczytuje go po ref', async () => {
    const katalog = await katalogTestowy();
    const magazyn = createMagazynSekretow({ katalog });
    const sekret = 'sekret-testowy';
    const ref = await magazyn.zapisz({ typ: 'meta', polaczenieId: randomUUID(), tresc: sekret });

    expect(ref).toMatch(/^meta:[0-9a-f-]{36}$/);
    expect(JSON.stringify(ref)).not.toContain(sekret);
    expect(await magazyn.odczytaj(ref)).toBe(sekret);
    expect(await readFile(magazyn.sciezka(ref), 'utf8')).toBe(sekret);
    const pliki = await readdir(katalog);
    expect(pliki).toHaveLength(1);
    expect(pliki[0]).not.toContain(sekret);
    expect(await readFile(join(katalog, pliki[0]), 'utf8')).toBe(sekret);
    if (process.platform !== 'win32') {
      expect((await stat(join(katalog, pliki[0]))).mode & 0o777).toBe(0o600);
    }
  });

  it('odrzuca traversal i błędne typy/UUID bez ujawniania treści', async () => {
    const magazyn = createMagazynSekretow({ katalog: await katalogTestowy() });
    await expect(magazyn.odczytaj('../poza')).rejects.toThrow();
    expect(() => magazyn.sciezka('../poza')).toThrow();
    await expect(magazyn.zapisz({ typ: '../meta', polaczenieId: randomUUID(), tresc: 'tajne' })).rejects.toThrow();
    await expect(magazyn.zapisz({ typ: 'meta', polaczenieId: '../poza', tresc: 'tajne' })).rejects.toThrow();
    await magazyn.zapisz({ typ: 'meta', polaczenieId: randomUUID(), tresc: 'tajne' }).then((ref) =>
      expect(magazyn.odczytaj(`${ref}/../x`)).rejects.toThrow());
  });

  it('równoległe aktualizacje jednego połączenia nie zostawiają częściowego tokenu ani pliku tymczasowego', async () => {
    const katalog = await katalogTestowy();
    const magazyn = createMagazynSekretow({ katalog });
    const polaczenieId = randomUUID();
    const pierwszy = 'A'.repeat(20_000);
    const drugi = 'B'.repeat(25_000);
    const [refA, refB] = await Promise.all([
      magazyn.zapisz({ typ: 'meta', polaczenieId, tresc: pierwszy }),
      magazyn.zapisz({ typ: 'meta', polaczenieId, tresc: drugi }),
    ]);
    expect(refA).toBe(refB);
    expect([pierwszy, drugi]).toContain(await magazyn.odczytaj(refA));
    expect(await readdir(katalog)).toHaveLength(1);
  });
});
