import { describe, it, expect } from 'vitest';
import { scanSources, scanRepository, expandChannelNames, hash } from '../scripts/straznik-konfiguracji.mjs';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync(new URL('../docs/konfiguracja.json', import.meta.url), 'utf8'));
const scan = text => scanSources(new Map([['src/sonda.ts', text]]), manifest);
describe('zamknięty manifest czytników środowiska', () => {
  for (const text of [
    'env.OMS_NIEZNANA', 'process.env["OMS_NIEZNANA"]',
    'const e = env; e.OMS_NIEZNANA',
    'const { OMS_NIEZNANA: x } = process.env;',
    'const { env: e } = ctx; e["OMS_NIEZNANA"]',
    'const e = {...env}; e.OMS_NIEZNANA',
    'const e = Object.assign({}, process.env); e.OMS_NIEZNANA',
    'const { ...e } = env; e.OMS_NIEZNANA',
    'let e; e=process.env; e.OMS_NIEZNANA',
    'function czytaj(e) { return e.OMS_NIEZNANA }; czytaj(env)',
    'const key="OMS_NIEZNANA"; env[key]',
    'const read=n=>env[n]; read("OMS_NIEZNANA")',
    'env[`${p}_NIEZNANY`]', 'env[`${p}_CK`]',
    'const x = nieznany(env); x.OMS_NIEZNANA',
    'function kopia(){return {...process.env}}; const e=kopia(); e.OMS_NIEZNANA',
    'const kopia=()=>process.env; kopia().OMS_NIEZNANA',
    'function f(e=env){return e.OMS_NIEZNANA}; f()',
    'const holder={cfg:process.env}; holder.cfg.OMS_NIEZNANA',
    'let e=env; e.OMS_NIEZNANA; e={};',
    'const {OMS_NIEZNANA:x}=process["env"];',
    'const modul={konfiguracja:(e)=>e.OMS_NIEZNANA};',
    'function config(e){return e.OMS_NIEZNANA}; const modul={konfiguracja:config};',
    'function config({OMS_NIEZNANA:x}){return x}; config(env);',
    'const modul={konfiguracja({OMS_NIEZNANA:x}){return x}};',
    'function config({OMS_NIEZNANA:x}=env){return x}; config();',
    'let x; ({OMS_NIEZNANA:x}=process.env);',
    'let e; ({...e}=process.env); e.OMS_NIEZNANA;',
    'Reflect.get(env,"OMS_NIEZNANA");',
    'const entries=Object.entries(env); const e=Object.fromEntries(entries); e.OMS_NIEZNANA;',
    'const key="OMS_NIEZNANA"; const {[key]:x}=env;',
    'const {OMS_PORT,...rest}=process["env"]; rest.OMS_NIEZNANA;',
    'function read(e){return e.OMS_NIEZNANA}; const f=read; f(process.env);',
    'const copy=structuredClone(env); copy.OMS_NIEZNANA;',
  ]) it('odrzuca '+text, () => expect(scan(text).errors.length).toBeGreaterThan(0));
  for (const text of ['env.OMS_PORT', 'const e=env; e["OMS_PORT"]', 'const {OMS_PORT:p}=env;', 'const e={...env}; e.OMS_PORT', 'function czytaj(e){return e.OMS_PORT}; czytaj(env)'])
    it('rozpoznaje '+text, () => expect(scan(text).errors).toEqual([]));
  it('zamyka sufiksy na właściwym typie', () => {
    const names = expandChannelNames([{typ:'woo',prefiks:'SHOP_X'}, {typ:'allegro',prefiks:'A_X'}], manifest);
    expect(names.has('SHOP_X_CK')).toBe(true); expect(names.has('SHOP_X_AUTH')).toBe(false);
    expect(names.has('A_X_AUTH')).toBe(true); expect(names.has('A_X_CK')).toBe(false);
    expect(names.has('SHOP_X_LITEROWKA')).toBe(false);
    expect(()=>expandChannelNames([{typ:'ftp',prefiks:'X'}],manifest)).toThrow();
    expect(()=>expandChannelNames([{typ:'woo',prefiks:'x'}],manifest)).toThrow();
  });
  it('skanuje aktualne pliki produktu, również nowe', () => expect(scanRepository(new URL('..',import.meta.url),manifest).errors).toEqual([]));
  for(const caller of ["import {get} from './b.ts'; get(env);", "import {get} from './b.ts'; const f=get; f(env);"])
    it('kontroluje niezmieniony caller i nowy reader w importowanym helperze: '+caller,()=>{
      const m=structuredClone(manifest);
      m.straznik.przekazania.push({path:'src/a.ts',sha256:hash(caller),expression:caller.includes('f=get')?'f(env)':'get(env)'});
      const source=new Map([['src/a.ts',caller],['src/b.ts','export function get(e){return e.OMS_PORT}']]);
      expect(scanSources(source,m).errors).toEqual([]);
      source.set('src/b.ts','export function get(e){return e.OMS_PORT + e.NIEZNANA}');
      expect(scanSources(source,m).errors.some(e=>e.path==='src/b.ts'&&e.reason.includes('NIEZNANA'))).toBe(true);
    });
});
