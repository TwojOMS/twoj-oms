import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BladKonfiguracji } from './blad-konfiguracji.ts';

export function sprawdzKatalogBazy(sciezka: string): void {
  if (sciezka === ':memory:') return;
  const katalog = dirname(resolve(sciezka));
  try {
    if (!statSync(katalog).isDirectory()) throw new BladKonfiguracji('OMS_DB_PATH', 'Rodzic ścieżki bazy nie jest katalogiem.');
    accessSync(katalog, constants.W_OK | constants.X_OK);
  } catch (e) {
    if (e instanceof BladKonfiguracji || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EROFS'].includes((e as NodeJS.ErrnoException).code ?? '')) {
      throw new BladKonfiguracji('OMS_DB_PATH', 'Katalog bazy nie istnieje lub nie jest zapisywalny.',
        'na plik w istniejącym katalogu z prawem zapisu; w Dockerze domyślny katalog /data-oms zapewnia wolumin.');
    }
    throw e;
  }
}
