import { describe, it, expect } from 'vitest';
import { scanRepository, hash } from '../scripts/straznik-konfiguracji.mjs';
import fs from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = new URL('..', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('../docs/konfiguracja.json', import.meta.url), 'utf8'));
const scan = changed => scanRepository(repo, changed).errors.map(error => error.reason);
const kanaloweHelperyBezNadmiaru = () => {
  const changed = structuredClone(manifest);
  const primary = changed.straznik.plikiDynamiczne.find(file => file.path === 'src/moduly/kanaly/konfiguracja.ts');
  for (const read of primary.odczyty.filter(read => read.expression === 'env[n]')) read.names = ['<P>_MAPOWANIE','<P>_URL','<P>_CK','<P>_CS','<P>_CLIENT_ID','<P>_CLIENT_SECRET'];
  for (const read of changed.mapowaniaDynamiczne.filter(read => read.path === primary.path && read.line === 58 && read.expression === 'env[n]')) read.names = ['<P>_MAPOWANIE','<P>_URL','<P>_CK','<P>_CS','<P>_CLIENT_ID','<P>_CLIENT_SECRET'];
  return changed;
};

describe('wtórne metadane manifestu', () => {
  it('odrzuca historyczny odcisk LF pliku wtórnego', () => {
    const changed = structuredClone(manifest);
    changed.odciskiPlikowOdczytow.find(entry => entry.path === 'src/moduly/kanaly/kompletnosc.ts').sha256 = 'c9cafc1e476e76b86089647b2e661594a6f46b2bf130a8725e4529b64b212ede';
    expect(scan(changed)).toContain('META_HASH_NIEZGODNY:src/moduly/kanaly/kompletnosc.ts');
  });

  it('odrzuca usunięte przekazanie env helpera', () => {
    const changed = structuredClone(manifest);
    changed.przekazaniaEnv = changed.przekazaniaEnv.filter(entry => entry.callee !== 'parsujUserAgentAllegro');
    expect(scan(changed)).toContain('META_FORWARD_NIEZGODNY');
  });

  it('odrzuca błędne nazwy wtórnej mapy dynamicznej', () => {
    const changed = structuredClone(manifest);
    changed.mapowaniaDynamiczne[0].names = ['SMTP_PORT'];
    expect(scan(changed)).toContain('META_DYNAMIC_MAP_NIEZGODNA');
  });

  it('odrzuca zamianę nazw UA i OD między liniami dwóch helperów', () => {
    const changed = kanaloweHelperyBezNadmiaru();
    // PRZ-094.07: odczyty po wyrażeniu i nazwie, nie po numerze linii — każda zmiana nad helperami przesuwała linie
    // i test sam stawał się czerwony (24/29 → 25/30), choć strażnik działał.
    const helper = (nazwa) => changed.mapowaniaDynamiczne.find(read => read.path === 'src/moduly/kanaly/konfiguracja.ts'
      && read.expression === 'env[nazwa]' && read.names.length === 1 && read.names[0] === nazwa);
    const ua = helper('<P>_USER_AGENT');
    const od = helper('<P>_OD');
    expect(ua && od && ua.line !== od.line, 'oba helpery (UA, OD) muszą być w manifeście w różnych liniach').toBe(true);
    [ua.names, od.names] = [od.names, ua.names];
    expect(scan(changed)).toContain('META_DYNAMIC_POWIAZANIE_HELPERA_NIEZGODNE');
  });

  it('odrzuca zbyt szeroką mapę wymagane nawet gdy primary i secondary są zgodne', () => {
    const changed = kanaloweHelperyBezNadmiaru();
    const primary = changed.straznik.plikiDynamiczne.find(file => file.path === 'src/moduly/kanaly/konfiguracja.ts');
    for (const read of primary.odczyty.filter(read => read.expression === 'env[n]')) read.names.push('<P>_OD');
    // Po wyrażeniu, nie po linii (była 58, po PRZ-094.07 jest 104) — inaczej pętla po cichu nic nie zmienia.
    const helperyN = changed.mapowaniaDynamiczne.filter(read => read.path === primary.path && read.expression === 'env[n]');
    expect(helperyN.length).toBeGreaterThan(0);
    for (const read of helperyN) read.names.push('<P>_OD');
    expect(scan(changed)).toContain('META_DYNAMIC_POWIAZANIE_HELPERA_NIEZGODNE');
  });

  it('wiąże nazwę helpera tylko z argumentem odpowiadającym parametrowi env', () => {
    const prefix = 'oms-straznik-helper-';
    const taskTmp = path.resolve(tmpdir());
    const directory = mkdtempSync(path.join(taskTmp, prefix));
    const source = 'function helper(env,name,note){ return env[name]; }\nhelper(env, `${p}_URL`, `${p}_CK`);\n';
    const fixture = {
      prefiksy: { woo: ['URL','CK'], allegro: [] },
      zmienne: [
        { nazwa: '<P>_URL', dynamiczna: true, typyKanalow: ['woo'], zakres: 'produkt' },
        { nazwa: '<P>_CK', dynamiczna: true, typyKanalow: ['woo'], zakres: 'produkt' },
      ],
      straznik: { plikiDynamiczne: [{ path: 'src/a.ts', sha256: hash(source), odczyty: [{ expression: 'env[name]', names: ['<P>_URL'] }] }], przekazania: [] },
      odciskiPlikowOdczytow: [], dodatkoweDowody: [],
      mapowaniaDynamiczne: [{ path: 'src/a.ts', line: 1, expression: 'env[name]', names: ['<P>_URL'] }],
      przekazaniaEnv: [{ path: 'src/a.ts', line: 2, expression: 'env', callee: 'helper', call: 'helper(env, `${p}_URL`, `${p}_CK`)' }],
    };
    try { fs.mkdirSync(path.join(directory, 'src')); writeFileSync(path.join(directory, 'src/a.ts'), source); expect(scanRepository(directory, fixture).errors).toEqual([]); }
    finally {
      const resolved = path.resolve(directory);
      if (path.dirname(resolved) !== taskTmp || !path.basename(resolved).startsWith(prefix)) throw new Error('Niebezpieczna ścieżka fixture');
      rmSync(resolved, { recursive: true, force: true });
    }
  });
});
