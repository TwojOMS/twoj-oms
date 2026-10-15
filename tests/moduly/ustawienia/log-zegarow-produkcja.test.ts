import { it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { Socket } from 'node:net';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
const env={OMS_TRYB:'produkcja',OMS_USER:'operator',OMS_PASS:'atrapa',OMS_SPRZEDAWCA_NIP:'1234563218',
  OMS_RACHUNEK:'34109010140000000000000000',OMS_PROFORMY_KATALOG:tmpdir(),OMS_ETYKIETY_KATALOG:tmpdir(),
  OMS_KANALY:'[{"klucz":"rynek","typ":"allegro","prefiks":"RYNEK"}]',RYNEK_CLIENT_ID:'atrapa',RYNEK_CLIENT_SECRET:'atrapa',
  RYNEK_USER_AGENT:'Fixture/1.0 (+https://przyklad.invalid)',RYNEK_OD:'2026-01-01'};
it.each([
  ['poller','kanaly','poller','poller:'],
  ['pollerWiadomosci','wiadomosci','pollerWiadomosci','poller wiadomości:'],
  ['czuwaczFormulki','wiadomosci','czuwaczFormulki','autoresponder:'],
  ['czuwaczPrzesylek','wysylka','czuwaczPrzesylek','czuwacz przesyłek:',true],
  ['czuwaczPodjazdow','wysylka','czuwaczPodjazdow','czuwacz podjazdów:'],
] as const)('rzeczywisty zegar %s łapie awarię i przekazuje dwa argumenty do domyślnego loggera',async(nazwa,modul,usluga,prefiks,bijePuls: boolean=false)=>{
  const proby:string[]=[];
  const f=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{proby.push('fetch');throw Error('Sieć zabroniona');});
  const s=vi.spyOn(Socket.prototype,'connect').mockImplementation(()=>{proby.push('socket');throw Error('Sieć zabroniona');});
  const a=await zbudujOms({env});const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    const obiekt=a.usluga<any>(modul,usluga);
    const mock=vi.spyOn(obiekt,'przebieg');
    const zegar=a.zegary.find(z=>z.nazwa===nazwa)!;
    const puls=a.usluga<any>('faktury','puls');
    if(bijePuls){mock.mockResolvedValueOnce({pominiety:false});await zegar.przebieg();}
    const przed=puls.stan();mock.mockRejectedValue(Error('rzeczywista przyczyna fixture'));
    await expect(a.zegary.find(z=>z.nazwa===nazwa)!.przebieg()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(prefiks,'rzeczywista przyczyna fixture');
    if(bijePuls){
      expect(puls.stan().czuwaczPrzesylek.okAt).toBe(przed.czuwaczPrzesylek.okAt);
      expect(puls.stan().czuwaczPrzesylek.blad).toBe('rzeczywista przyczyna fixture');
    }else expect(puls.stan()).toEqual(przed);
    expect(proby).toEqual([]);
  }finally{await a.app.close();a.db.close();log.mockRestore();f.mockRestore();s.mockRestore();}
});

it('rzeczywisty magazyn loguje awarię miniatur dwoma argumentami i zachowuje katalog',async()=>{
  const proby:string[]=[];
  const f=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{proby.push('fetch');throw Error('Sieć zabroniona');});
  const s=vi.spyOn(Socket.prototype,'connect').mockImplementation(()=>{proby.push('socket');throw Error('Sieć zabroniona');});
  const a=await zbudujOms({env:{...env,OMS_KANALY:'[{"klucz":"sklep","typ":"woo","prefiks":"SKLEP"}]',
    SKLEP_URL:'https://sklep.invalid',SKLEP_CK:'atrapa',SKLEP_CS:'atrapa',SKLEP_OD:'2026-01-01',SKLEP_MAPOWANIE:'{"instancje":{},"poPozycji":[]}'}});
  const log=vi.spyOn(console,'error').mockImplementation(()=>{});
  try{
    const klient=a.usluga<any>('kanaly','klienciSklepow').sklep;
    vi.spyOn(klient,'pobierzWszystkieProdukty').mockResolvedValue([{id:123,name:'Produkt fixture',type:'simple',sku:'SKU',stock_quantity:3,price:'12',status:'publish'}]);
    vi.spyOn(klient,'pobierzMiniatury').mockRejectedValue(Error('awaria miniatur fixture'));
    const przebieg=a.usluga<any>('magazyn','magazyn');
    expect(przebieg.start()).toEqual({wystartowal:true});
    await vi.waitFor(()=>expect(przebieg.stan().trwa).toBe(false));
    expect(przebieg.stan().blad).toBeNull();
    expect(przebieg.stan().kanaly[0].blad).toBeNull();
    expect(a.db.prepare('SELECT nazwa FROM produkty_sklepowe WHERE produkt_id=123').get()).toEqual({nazwa:'Produkt fixture'});
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('magazyn: kanał sklep — nie udało się odczytać miniatur ze Store API (katalog wchodzi bez nich):','awaria miniatur fixture');
    expect(proby).toEqual([]);
  }finally{await a.app.close();a.db.close();log.mockRestore();f.mockRestore();s.mockRestore();}
});
