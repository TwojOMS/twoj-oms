export function normalizujAdresSklepu(adres:unknown,_tryb:string):string|null {
 if(typeof adres!=='string'||adres.length>500||/[?#]/.test(adres))return null;
 try {
  const tekst=adres.trim();
  const url=new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(tekst)?tekst:'https://'+tekst);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return null;
  url.protocol='https:';
  url.hostname=url.hostname.replace(/\.$/,'');
  return url.href.replace(/\/+$/,'');
 } catch{return null;}
}
