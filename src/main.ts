import type { Srodowisko } from './core/kontrakty.ts';
import { openOmsDb } from './oms/db/db.ts';
import { uruchomAplikacje } from './core/uruchomienie.ts';
import { modulyDla } from './moduly/lista.ts';
import { efektywnyTryb } from './core/tryb.ts';
import { sprawdzKonfiguracjeModulow } from './core/aplikacja.ts';

export async function uruchomOms(env: Srodowisko = process.env, host = '0.0.0.0') {
  const moduly = modulyDla(env);
  sprawdzKonfiguracjeModulow(moduly, env);
  const db = openOmsDb(env.OMS_DB_PATH || '/data-oms/oms.sqlite', { moduly });
  const port = Number(env.OMS_PORT || 3001);
  return uruchomAplikacje({ moduly, env, db, host, port });
}

export async function main() {
const port = Number(process.env.OMS_PORT || 3001);
const { zamknij } = await uruchomOms();
const zakoncz = () => {
  process.removeListener('SIGINT', zakoncz);
  process.removeListener('SIGTERM', zakoncz);
  void zamknij().catch((e: unknown) => { console.error(e); process.exitCode = 1; });
};
process.on('SIGINT', zakoncz);
process.on('SIGTERM', zakoncz);
console.log(`OMS na :${port}`);
console.log(`OMS tryb: ${efektywnyTryb(process.env)}`);
}
