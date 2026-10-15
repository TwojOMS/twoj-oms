#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { uruchomOms } from '../src/main.ts';
import { PLIKI_INSTALACJI, odczytajEnv, opcje } from './instalacja-wspolne.mjs';
async function main() {
  const { katalog, port } = opcje(process.argv.slice(2));
  const env = odczytajEnv(path.join(katalog, PLIKI_INSTALACJI.proba));
  if (!fs.existsSync(path.join(katalog, PLIKI_INSTALACJI.znacznik))
    || !fs.existsSync(path.join(katalog, PLIKI_INSTALACJI.baza))
    || env.OMS_TRYB !== 'proba' || env.OMS_KANALY !== '[]' || env.OMS_PORT !== String(port)
    || path.resolve(env.OMS_DB_PATH ?? '') !== path.join(katalog, PLIKI_INSTALACJI.baza)
    || path.resolve(env.OMS_PROFORMY_KATALOG ?? '') !== path.join(katalog, 'proformy')
    || path.resolve(env.OMS_ETYKIETY_KATALOG ?? '') !== path.join(katalog, 'etykiety')) {
    throw new Error('INSTALACJA_NIEZGODNY_KATALOG');
  }
  const { zamknij } = await uruchomOms(env, '127.0.0.1');
  console.log(`OMS próba: http://127.0.0.1:${port}/login`);
  const stop = () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    void zamknij().catch(() => { console.error('INSTALACJA_ZAMKNIECIE_ODMOWA'); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch(() => { console.error('INSTALACJA_OTWARCIE_ODMOWA'); process.exitCode = 1; });
