import {afterEach,describe,expect,it,vi} from 'vitest';
import * as baza from '../../src/oms/db/db.ts';
import * as uruchomienie from '../../src/core/uruchomienie.ts';
import {main,uruchomOms} from '../../src/main.ts';
import * as katalogBazy from '../../src/core/katalog-bazy.ts';

const env={OMS_TRYB:'produkcja',OMS_USER:'operator',OMS_PASS:'fixture',
  OMS_SPRZEDAWCA_NIP:'1234563218',OMS_RACHUNEK:'34109010140000000000000000',
  OMS_PROFORMY_KATALOG:'C:/fixture/proformy',OMS_ETYKIETY_KATALOG:'C:/fixture/etykiety'};
afterEach(()=>vi.restoreAllMocks());

function granice(){
  vi.spyOn(katalogBazy,'sprawdzKatalogBazy').mockImplementation(()=>{});
  // Nie otwieramy domyślnej bazy ani portu; sprawdzamy argumenty przekazane
  // przez rzeczywisty entrypoint po rzeczywistej walidacji konfiguracji.
  const db=vi.spyOn(baza,'openOmsDb').mockReturnValue({} as ReturnType<typeof baza.openOmsDb>);
  const start=vi.spyOn(uruchomienie,'uruchomAplikacje').mockResolvedValue({zamknij:async()=>{}} as Awaited<ReturnType<typeof uruchomienie.uruchomAplikacje>>);
  return {db,start};
}

describe('entrypoint zachowuje frozen fallback pustych ustawień',()=>{
  it.each([undefined,'','C:/fixture/oms.sqlite'])('OMS_DB_PATH=%s wybiera trwałą ścieżkę domyślną albo jawną',async(wartosc)=>{
    const {db}=granice();
    await uruchomOms({...env,OMS_DB_PATH:wartosc,OMS_PORT:'0'},'127.0.0.1');
    expect(db).toHaveBeenCalledTimes(1);
    expect(db.mock.calls[0][0]).toBe(wartosc || '/data-oms/oms.sqlite');
    expect(db.mock.calls[0][0]).not.toBe('');
  });
  it.each([[undefined,3001],['',3001],['0',0],['3998',3998]] as const)('OMS_PORT=%s przekazuje port %s do rzeczywistej granicy startu',async(wartosc,oczekiwany)=>{
    const {start}=granice();
    await uruchomOms({...env,OMS_DB_PATH:'C:/fixture/oms.sqlite',OMS_PORT:wartosc},'127.0.0.1');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0]).toMatchObject({port:oczekiwany,host:'127.0.0.1'});
  });
  it('main raportuje ten sam port domyślny, na którym uruchamia aplikację',async()=>{
    const {start}=granice();const log=vi.spyOn(console,'log').mockImplementation(()=>{});
    const poprzednieEnv=process.env;
    const sigint=process.listeners('SIGINT'),sigterm=process.listeners('SIGTERM');
    try{
      process.env={...env,OMS_DB_PATH:'C:/fixture/oms.sqlite',OMS_PORT:''};
      await main();
      expect(start.mock.calls[0][0].port).toBe(3001);
      expect(log).toHaveBeenCalledWith('OMS na :3001');
    }finally{
      process.env=poprzednieEnv;
      for(const listener of process.listeners('SIGINT'))if(!sigint.includes(listener))process.removeListener('SIGINT',listener);
      for(const listener of process.listeners('SIGTERM'))if(!sigterm.includes(listener))process.removeListener('SIGTERM',listener);
    }
  });
});
