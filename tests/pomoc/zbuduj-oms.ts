import type { DatabaseSync } from 'node:sqlite';
import type { ModulOms, Srodowisko } from '../../src/core/kontrakty.ts';
import { zbudujAplikacje } from '../../src/core/aplikacja.ts';
import { sprawdzTrybProby } from '../../src/core/tryb.ts';
import { openOmsDb } from '../../src/oms/db/db.ts';

/** Jawna lista modułów i nadpisania usług; bez fałszywych usług produkcyjnych. */
export async function zbudujOms(o: {
  moduly: readonly ModulOms[]; env: Srodowisko; db?: DatabaseSync;
  teraz?: () => Date; log?: (tekst: string) => void;
  nadpisania?: Readonly<Record<string, unknown>>;
}) {
  sprawdzTrybProby(o.env,[...new Set(o.moduly.flatMap(m=>m.kluczeIntegracji??[]))]);
  const db = o.db ?? openOmsDb(':memory:', { moduly: o.moduly, teraz: o.teraz });
  try { return { ...await zbudujAplikacje({ ...o, db }), db }; }
  catch (error) { if (!o.db) db.close(); throw error; }
}
