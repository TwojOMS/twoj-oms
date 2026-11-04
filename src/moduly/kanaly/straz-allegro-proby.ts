import type {Srodowisko} from '../../core/kontrakty.ts';

/** PRZ-148.07 (decyzja właściciela 04.11): w trybie próby (piaskownica, demo, lokalny serwer wykonawcy) żadne zapytanie
 * nie idzie do allegro.pl. Allegro Sandbox tylko w jawnym profilu OMS_PROBA_ALLEGRO_SANDBOX=tak. */
export type ProfilAllegroProby='bez-allegro'|'sandbox';
export function profilAllegroProby(env:Srodowisko):ProfilAllegroProby{
 return env.OMS_PROBA_ALLEGRO_SANDBOX==='tak'?'sandbox':'bez-allegro';
}

const wDomenie=(host:string,domena:string)=>host===domena||host.endsWith('.'+domena);
function odmowa(host:string,powod:string):Error{
 const e=new Error(`Tryb próby: połączenie z ${host} zablokowane — ${powod}`);
 // core/http.ts przepuszcza odmowę hosta bez „błędu sieci” i bez ponowień: nic nie wyszło do sieci.
 e.name='OdmowaHosta';(e as Error&{code?:string}).code='OMS_PROBA_ALLEGRO';
 return e;
}

/** Transport kanałów w trybie próby: odmowa hosta Allegro, zanim cokolwiek wyjdzie do sieci. Inne hosty
 * (sklepy demo, atrapy) idą bez zmian. Bez wstrzykniętego fetch używa globalnego w chwili wywołania. */
export function strzezAllegroProby(o:{profil:ProfilAllegroProby;fetchImpl?:typeof fetch}):typeof fetch{
 const strzezony=(adres:string|URL|Request,init?:RequestInit):Promise<Response>=>{
  let host='';
  try{host=new URL(adres instanceof Request?adres.url:String(adres)).hostname.toLowerCase().replace(/\.$/,'');}catch{/* fetch sam odrzuci zły adres */}
  if(wDomenie(host,'allegrosandbox.pl')){
   if(o.profil!=='sandbox')return Promise.reject(odmowa(host,'Allegro Sandbox wymaga jawnego profilu OMS_PROBA_ALLEGRO_SANDBOX=tak.'));
  }else if(wDomenie(host,'allegro.pl')){
   return Promise.reject(odmowa(host,'piaskownica i serwer lokalny nie łączą się z prawdziwym Allegro (integracje działają na atrapach).'));
  }
  return (o.fetchImpl??globalThis.fetch)(adres,init);
 };
 return strzezony as typeof fetch;
}
