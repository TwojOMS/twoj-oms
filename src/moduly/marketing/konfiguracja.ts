import type {Srodowisko} from '../../core/kontrakty.ts';
export function konfiguracjaMarketingu(env:Srodowisko) {
 let meta:{token:string;konta:string[]}|null=null;
 if(env.META_TOKEN||env.META_KONTA){
  if(!env.META_TOKEN?.trim())throw Error('Brak wymaganej zmiennej: META_TOKEN');
  if(!env.META_KONTA?.trim())throw Error('Brak wymaganej zmiennej: META_KONTA');
  const konta=env.META_KONTA.split(',').map(s=>s.trim()).filter(Boolean);
  if(!konta.length||konta.some(k=>!/^act_\d+$/.test(k)))throw Error('META_KONTA: wpis nie wygląda na konto reklamowe (act_<id>)');
  meta={token:env.META_TOKEN,konta};
 }
 return {meta,ga4:env.GA4_KLUCZ?{sciezkaKlucza:env.GA4_KLUCZ.trim()}:null,
  reklamy:{katalogSekretow:env.OMS_REKLAMY_SEKRETY_DIR||'/data-oms/reklamy-sekrety'},proba:env.OMS_TRYB==='proba'};
}
