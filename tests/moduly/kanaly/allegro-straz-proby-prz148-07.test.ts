// PRZ-148.07 (decyzja właściciela 04.11): lokalny serwer wykonawcy, piaskownica i demo (OMS_TRYB=proba) nie wysyłają
// żadnego zapytania do allegro.pl ani allegrosandbox.pl poza jawnym profilem Sandbox (OMS_PROBA_ALLEGRO_SANDBOX=tak).
// Odmowa zapada na transporcie, zanim cokolwiek wyjdzie do sieci. Zwykła instalacja (produkcja) działa jak dotąd.
import {afterEach,expect,it,vi} from 'vitest';
import {fixtureAllegro,aktorAllegro} from '../../pomoc/allegro-konfigurator.ts';
import {createModulKanaly} from '../../../src/moduly/kanaly/modul.ts';
import {strzezAllegroProby} from '../../../src/moduly/kanaly/straz-allegro-proby.ts';
import {utworzHttp} from '../../../src/core/http.ts';

const bazy:ReturnType<typeof fixtureAllegro>[]=[];
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();for(const f of bazy.splice(0))f.db.close();});

/** Sieć udaje globalny fetch — dokładnie ten, którego używa moduł kanałów bez wstrzykniętego transportu. */
function siec(){
 const wywolania:string[]=[];
 const fetch=vi.fn(async(adres:string|URL|Request)=>{
  wywolania.push(String(adres instanceof Request?adres.url:adres));
  return Response.json({device_code:'KOD-POLCIEN',user_code:'ABC-123',verification_uri:'https://example.test/skojarz',expires_in:600,interval:5});
 });
 vi.stubGlobal('fetch',fetch);
 return wywolania;
}

/** Moduł kanałów jak w piaskownicy i na lokalnym serwerze: env decyduje o trybie, transport z globalnego fetch. */
function modul(env:Record<string,string>){
 const f=fixtureAllegro();bazy.push(f);
 const m=createModulKanaly([]);
 const konfiguracja=m.konfiguracja(env);
 const z=m.zbuduj({db:f.db,konfiguracja,teraz:f.teraz,log:()=>{},usluga:()=>()=>{}} as any);
 return (z as any).uslugi;
}
const para={clientId:'polcien-device-id',clientSecret:'SEKRET-POLCIEN'};

it('tryb próby bez profilu Sandbox: zapisanie aplikacji Device nie wysyła POST allegro.pl/auth/oauth/device',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const wywolania=siec();
 const u=modul({OMS_TRYB:'proba'});
 const wynik=await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktorAllegro);
 expect(wynik.ok).toBe(false);
 const sandbox=await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktorAllegro);
 expect(sandbox.ok).toBe(false);
 expect(wywolania).toEqual([]);
});

it('jawny profil Sandbox przepuszcza allegrosandbox.pl, a prawdziwe allegro.pl nadal blokuje',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 const wywolania=siec();
 const u=modul({OMS_TRYB:'proba',OMS_PROBA_ALLEGRO_SANDBOX:'tak'});
 await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktorAllegro);
 expect(wywolania).toContain('https://allegro.pl.allegrosandbox.pl/auth/oauth/device');
 wywolania.length=0;
 expect((await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktorAllegro)).ok).toBe(false);
 expect(wywolania).toEqual([]);
});

it('zwykła instalacja (produkcja) łączy się z allegro.pl jak dotąd — także z ustawionym profilem Sandbox',async()=>{
 for(const env of [{},{OMS_TRYB:'produkcja'},{OMS_PROBA_ALLEGRO_SANDBOX:'tak'}] as Record<string,string>[]){
  const wywolania=siec();
  const u=modul(env);
  await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktorAllegro);
  expect(wywolania,JSON.stringify(env)).toContain('https://allegro.pl/auth/oauth/device');
  vi.unstubAllGlobals();
 }
});

it('odmowa po polsku przechodzi przez transport HTTP bez „błędu sieci” i bez ponowień; inne hosty bez zmian',async()=>{
 const log=vi.fn();const siecWewn=vi.fn(async()=>new Response('ok'));
 const http=utworzHttp({fetchImpl:strzezAllegroProby({profil:'bez-allegro',fetchImpl:siecWewn}),ponowien:2,czekaj:async()=>{},log});
 for(const adres of ['https://api.allegro.pl/me','https://ALLEGRO.PL./auth/oauth/token','https://allegro.pl.allegrosandbox.pl/auth/oauth/device']){
  await expect(http(adres)).rejects.toThrow(/Tryb próby: połączenie z .* zablokowane/);
 }
 expect(siecWewn).not.toHaveBeenCalled();
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/błąd sieci/);
 // Hosty, które tylko przypominają Allegro, oraz sklepy demo nie są blokowane.
 for(const adres of ['https://sklep.example.test/wp-json/wc/v3/orders','https://notallegro.pl/','https://allegro.pl.example.test/'])expect((await http(adres)).status).toBe(200);
 expect(siecWewn).toHaveBeenCalledTimes(3);
});

it('wstrzyknięty transport bez atrapy autoryzacji (jak profil Sandbox w piaskownicy) też podlega straży',async()=>{
 vi.spyOn(console,'warn').mockImplementation(()=>{});
 for(const [env,oczekiwane] of [[{OMS_TRYB:'proba'},[]],[{OMS_TRYB:'proba',OMS_PROBA_ALLEGRO_SANDBOX:'tak'},['https://allegro.pl.allegrosandbox.pl/auth/oauth/device']]] as [Record<string,string>,string[]][]){
  const wywolania:string[]=[];
  const transport=vi.fn(async(adres:string|URL|Request)=>{wywolania.push(String(adres));return Response.json({device_code:'KOD-POLCIEN',user_code:'ABC-123',verification_uri:'https://example.test/skojarz',expires_in:600,interval:5});});
  const f=fixtureAllegro();bazy.push(f);
  const m=createModulKanaly([],false,{fetchImpl:transport as unknown as typeof fetch});
  const u=(m.zbuduj({db:f.db,konfiguracja:m.konfiguracja(env),teraz:f.teraz,log:()=>{},usluga:()=>()=>{}} as any) as any).uslugi;
  await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('produkcja',para,aktorAllegro);
  await u.aplikacjaAllegro.sprawdzIZapiszAplikacjeDevice('sandbox',para,aktorAllegro);
  expect(wywolania,JSON.stringify(env)).toEqual(oczekiwane);
 }
});
