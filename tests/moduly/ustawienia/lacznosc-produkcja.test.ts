import { it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import * as diagnostyka from '../../../src/oms/services/lacznosc.js';
import { Socket } from 'node:net';
import dns from 'node:dns/promises';
import { celeDiagnostyki } from '../../../src/moduly/ustawienia/cele-diagnostyki.ts';

const env={OMS_TRYB:'produkcja',OMS_DB_PATH:':memory:',OMS_USER:'operator',OMS_PASS:'atrapa',
  OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir(),
  OMS_KANALY:'[{"klucz":"sklep","typ":"woo","prefiks":"SKLEP"},{"klucz":"rynek","typ":"allegro","prefiks":"RYNEK"}]',
  SKLEP_URL:'https://sklep.invalid',SKLEP_CK:'atrapa',SKLEP_CS:'atrapa',SKLEP_OD:'2026-01-01',
  SKLEP_MAPOWANIE:'{"instancje":{},"poPozycji":[]}',RYNEK_CLIENT_ID:'atrapa',RYNEK_CLIENT_SECRET:'atrapa',
  RYNEK_USER_AGENT:'Fixture/1.0 (+https://przyklad.invalid)',RYNEK_OD:'2026-01-01',RYNEK_API:'https://rynek.invalid/api',
  INFAKT_API_KEY:'atrapa',KSEF_TOKEN:'atrapa',DPD_URL:'https://dpd.invalid/ws',DPD_LOGIN:'atrapa',DPD_PASSWORD:'atrapa',
  DPD_FID:'1',DPD_INFO_URL:'https://dpd-info.invalid/ws',DPD_INFO_CHANNEL:'atrapa',
  DPD_NADAWCA_NAZWA:'Fixture',DPD_NADAWCA_ULICA:'Testowa 1',DPD_NADAWCA_KOD:'00-001',DPD_NADAWCA_MIASTO:'Test',
  INPOST_TOKEN:'atrapa',INPOST_ORGANIZACJA:'1',INPOST_URL:'https://inpost.invalid/v1',GUS_KLUCZ:'atrapa',GUS_URL:'https://gus.invalid/ws'};

it.each([
  ['domyślne API dokumentów',{},'https://api.infakt.pl','https://api.ksef.mf.gov.pl/v2','https://inpost.invalid/v1','https://gus.invalid/ws'],
  ['własne API dokumentów',{INFAKT_API_URL:'https://infakt.invalid/api',KSEF_API:'https://ksef.invalid/v2/'},'https://infakt.invalid/api','https://ksef.invalid/v2','https://inpost.invalid/v1','https://gus.invalid/ws'],
  ['słownik domyślnych API',{INPOST_URL:undefined,GUS_URL:undefined},'https://api.infakt.pl','https://api.ksef.mf.gov.pl/v2','https://api-shipx-pl.easypack24.net/v1','https://wyszukiwarkaregon.stat.gov.pl/wsBIR/UslugaBIRzewnPubl.svc'],
] as const)('rzeczywisty bootstrap diagnozuje wszystkie aktywne usługi: %s',async(_nazwa,api,infakt,ksef,inpost,gus)=>{
  const proby:string[]=[];
  const fetchSpy=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{proby.push('fetch');throw Error('Sieć zabroniona');});
  const socketSpy=vi.spyOn(Socket.prototype,'connect').mockImplementation(()=>{proby.push('socket');throw Error('Sieć zabroniona');});
  const dnsSpy=vi.spyOn(dns,'lookup').mockImplementation(async()=>{proby.push('dns');throw Error('DNS zabroniony');});
  const pomiar=vi.spyOn(diagnostyka,'sprawdzLacznosc').mockResolvedValue([]);
  const a=await zbudujOms({env:{...env,...api}});
  try{
    await a.usluga<{sprawdz:()=>Promise<unknown>}>('ustawienia','lacznosc').sprawdz();
    expect(pomiar).toHaveBeenCalledTimes(1);
    expect(pomiar.mock.calls[0][0]?.cele).toEqual([
      {klucz:'sklep:sklep',nazwa:'Sklep sklep',url:'https://sklep.invalid',host:'sklep.invalid'},
      {klucz:'allegro:rynek',nazwa:'Allegro rynek',url:'https://rynek.invalid/api',host:'rynek.invalid'},
      {klucz:'infakt',nazwa:'inFakt',url:infakt,host:new URL(infakt).hostname},
      {klucz:'ksef',nazwa:'KSeF',url:ksef,host:new URL(ksef).hostname},
      {klucz:'dpd',nazwa:'DPD',url:'https://dpd.invalid/ws',host:'dpd.invalid'},
      {klucz:'inpost',nazwa:'InPost',url:inpost,host:new URL(inpost).hostname},
      {klucz:'gus',nazwa:'GUS (REGON)',url:gus,host:new URL(gus).hostname},
    ]);
    expect(JSON.stringify(pomiar.mock.calls[0][0])).not.toContain('atrapa');
    expect(proby).toEqual([]);
  }finally{await a.app.close();a.db.close();pomiar.mockRestore();fetchSpy.mockRestore();socketSpy.mockRestore();dnsSpy.mockRestore();}
});

it('opcjonalne moduły pomija wyłącznie konkretny brak config, pozostałe awarie propaguje',()=>{
  const minimalna=<T>(modul:string):T=>{
    if(modul==='kanaly')return {sklepy:{},kanaly:{}} as T;
    throw Error(`Usługa „${modul}.config" nie istnieje albo moduł „${modul}" nie jest zbudowany przed wołającym`);
  };
  expect(celeDiagnostyki(minimalna)).toEqual([]);
  expect(()=>celeDiagnostyki(<T>(modul:string):T=>{
    if(modul==='faktury')throw Error('rzeczywista awaria konfiguracji');
    return minimalna<T>(modul);
  })).toThrow('rzeczywista awaria konfiguracji');
  expect(()=>celeDiagnostyki(<T>(modul:string):T=>{
    if(modul==='faktury')throw Error('Usługa „faktury.config” nie istnieje — awaria innego pochodzenia');
    return minimalna<T>(modul);
  })).toThrow('awaria innego pochodzenia');
});
