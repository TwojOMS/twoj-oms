import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const TYPY = new Set(['ga4', 'meta', 'google_ads']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sprawdzId(typ, polaczenieId) {
  if (!TYPY.has(typ) || typeof polaczenieId !== 'string' || !UUID.test(polaczenieId)) {
    throw new Error('Nieprawidłowa referencja sekretu reklam');
  }
}

/** Sekret nie trafia do bazy. Referencja zawiera tylko typ i UUID lokalnego połączenia. */
export function createMagazynSekretow({ katalog }) {
  if (typeof katalog !== 'string' || !katalog.trim()) {
    throw new Error('Brak katalogu sekretów reklam');
  }

  function sciezkaPliku(typ, polaczenieId) {
    sprawdzId(typ, polaczenieId);
    return join(katalog, `${typ}-${polaczenieId.toLowerCase()}.secret`);
  }

  async function zapisz({ typ, polaczenieId, tresc }) {
    const docelowy = sciezkaPliku(typ, polaczenieId);
    if (typeof tresc !== 'string' || !tresc) throw new Error('Pusty sekret reklam');
    await mkdir(katalog, { recursive: true, mode: 0o700 });
    const tymczasowy = join(katalog, `.${typ}-${polaczenieId.toLowerCase()}.${randomUUID()}.tmp`);
    let uchwyt;
    try {
      uchwyt = await open(tymczasowy, 'wx', 0o600);
      await uchwyt.writeFile(tresc, 'utf8');
      await uchwyt.sync();
      await uchwyt.close();
      uchwyt = null;
      await rename(tymczasowy, docelowy);
    } catch {
      if (uchwyt) await uchwyt.close().catch(() => {});
      await unlink(tymczasowy).catch(() => {});
      throw new Error('Nie udało się zapisać sekretu reklam');
    }
    return `${typ}:${polaczenieId.toLowerCase()}`;
  }

  function sciezka(sekretRef) {
    if (typeof sekretRef !== 'string') throw new Error('Nieprawidłowa referencja sekretu reklam');
    const czesci = sekretRef.split(':');
    if (czesci.length !== 2) throw new Error('Nieprawidłowa referencja sekretu reklam');
    return sciezkaPliku(czesci[0], czesci[1]);
  }

  async function odczytaj(sekretRef) {
    const plik = sciezka(sekretRef);
    try {
      return await readFile(plik, 'utf8');
    } catch {
      throw new Error('Nie można odczytać sekretu reklam');
    }
  }

  return { zapisz, odczytaj, sciezka };
}
