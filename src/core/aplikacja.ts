import Fastify, { type FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ModulOms, PozycjaMenu, Srodowisko, StanZdrowia, Zegar, ZbudowanyModul } from './kontrakty.ts';
import { sprawdzModuly, kolejnoscBudowy } from './sprawdz-moduly.ts';
import { wykonajMigracje } from './baza.ts';
import { rozdajNoweUprawnienia } from './uprawnienia.ts';
import { sprawdzTrybProby } from './tryb.ts';
import { zaufaneProxy } from './zaufane-proxy.ts';
import { BladKonfiguracji, bladWalidatora } from './blad-konfiguracji.ts';
import { polaczenieBezpieczne } from './bezpieczenstwo/logowanie-wspolne.js';

export type Aplikacja = {
  app: FastifyInstance;
  zegary: readonly Zegar[];
  menu: readonly PozycjaMenu[];
  zdrowie: () => StanZdrowia;
  usluga: <T>(modul: string, nazwa: string) => T;
};

function przygotujModuly(moduly: readonly ModulOms[], env: Srodowisko) {
  const trustProxy = zaufaneProxy(env);
  sprawdzModuly(moduly);
  const kolejnosc = kolejnoscBudowy(moduly);
  sprawdzTrybProby(env, [...new Set(kolejnosc.flatMap((m) => m.kluczeIntegracji ?? []))]);
  const bledy: string[] = [];
  let pierwszyBlad: BladKonfiguracji | undefined;
  let nieoczekiwany = false;
  let przyczyna: unknown;
  const konfiguracje = new Map<string, unknown>();
  for (const m of kolejnosc) {
    try { konfiguracje.set(m.nazwa, m.konfiguracja(env)); }
    catch (e) {
      const blad = bladWalidatora(e);
      if (!blad) { nieoczekiwany = true; przyczyna ??= e; }
      else pierwszyBlad ??= blad;
      bledy.push(`[${m.nazwa}] ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (nieoczekiwany) throw new Error(`OMS nie wystartuje — konfiguracja:\n${bledy.join('\n')}`, { cause: przyczyna });
  if (pierwszyBlad) {
    const blad = new BladKonfiguracji(pierwszyBlad.zmienna,
      `OMS nie wystartuje — konfiguracja:\n${bledy.join('\n')}`, pierwszyBlad.wskazowka);
    blad.opisStartu = pierwszyBlad.opisStartu;
    throw blad;
  }
  return { kolejnosc, konfiguracje, trustProxy };
}

/** Walidacja przed otwarciem bazy; nie daje możliwości pominięcia walidacji przy budowie. */
export function sprawdzKonfiguracjeModulow(moduly: readonly ModulOms[], env: Srodowisko): void {
  przygotujModuly(moduly, env);
}

export async function zbudujAplikacje(o: {
  moduly: readonly ModulOms[];
  env: Srodowisko;
  db: DatabaseSync;
  teraz?: () => Date;
  log?: (...tekst: string[]) => void;
  nadpisania?: Readonly<Record<string, unknown>>;
}): Promise<Aplikacja> {
  const teraz = o.teraz ?? (() => new Date());
  const log = o.log ?? ((...tekst: string[]) => console.error(...tekst));
  const { kolejnosc, konfiguracje, trustProxy } = przygotujModuly(o.moduly, o.env);

  wykonajMigracje(o.db, kolejnosc, teraz);
  rozdajNoweUprawnienia(o.db, kolejnosc, teraz);

  const uslugi = new Map<string, unknown>();
  const usluga = <T>(modul: string, nazwa: string): T => {
    const klucz = `${modul}.${nazwa}`;
    if (o.nadpisania && Object.hasOwn(o.nadpisania, klucz)) return o.nadpisania[klucz] as T;
    if (!uslugi.has(klucz)) throw new Error(`Usługa „${klucz}" nie istnieje albo moduł „${modul}" nie jest zbudowany przed wołającym`);
    return uslugi.get(klucz) as T;
  };

  const zbudowane: ZbudowanyModul[] = [];
  for (const m of kolejnosc) {
    const z = m.zbuduj({ db: o.db, konfiguracja: konfiguracje.get(m.nazwa), teraz, log, usluga });
    for (const [nazwa, wartosc] of Object.entries(z.uslugi ?? {})) uslugi.set(`${m.nazwa}.${nazwa}`, wartosc);
    zbudowane.push(z);
  }

  const app = Fastify({ logger: false, requestTimeout: 0, trustProxy });
  // W rdzeniu, przed trasami i pluginami: także pliki statyczne, odmowy i błędy.
  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'DENY');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', "frame-ancestors 'none'");
    if (!reply.hasHeader('X-Content-Type-Options')) reply.header('X-Content-Type-Options', 'nosniff');
    if (!reply.hasHeader('Referrer-Policy')) reply.header('Referrer-Policy', 'same-origin');
    if (polaczenieBezpieczne(req) && !reply.hasHeader('Strict-Transport-Security')) {
      reply.header('Strict-Transport-Security', 'max-age=15552000');
    }
    return payload;
  });
  app.addHook('onRequest', async (req) => {
    if (!trustProxy && !ostrzezonoOProxy
      && (req.headers['x-forwarded-for'] !== undefined || req.headers['cf-connecting-ip'] !== undefined)) {
      ostrzezonoOProxy = true;
      log('Ostrzeżenie: brak OMS_TRUST_PROXY przy nagłówkach proxy; ustaw w OMS_TRUST_PROXY wyłącznie adresy IP lub CIDR zaufanego tunelu/proxy.');
    }
  });
  // Ten sam zebrany manifest zasila HTTP i publiczne Aplikacja.menu.
  const menu = kolejnosc.flatMap((m) => m.menu).toSorted((a, b) => a.kolejnosc - b.kolejnosc);
  app.decorate('menuOms', menu);
  try {
    for (const z of zbudowane) z.trasy?.(app);
    await app.ready();
  } catch (e) {
    await app.close();
    throw e;
  }

  return {
    app, usluga,
    zegary: zbudowane.flatMap((z) => z.zegary ?? []),
    menu,
    zdrowie: () => {
      const stany = zbudowane.map((z) => z.zdrowie?.() ?? { alarmy: [], uwagi: [] });
      return { alarmy: stany.flatMap((s) => s.alarmy), uwagi: stany.flatMap((s) => s.uwagi) };
    },
  };
}

let ostrzezonoOProxy = false;
