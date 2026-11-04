const format=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const dzien=(d:Date)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
export const DATA_STARTU_USTALONA='Data startu jest już ustalona — zamówień sprzed niej OMS nie pobierze.';
export function poczatekDniaWarszawa(w:string):string|null{
 if(!/^\d{4}-\d\d-\d\d$/.test(w))return null;
 const [y,m,d]=w.split('-').map(Number),base=Date.UTC(y,m-1,d);
 if(new Date(base).toISOString().slice(0,10)!==w)return null;
 let at=base;
 // Obliczamy przesunięcie strefy dla tej daty; obejmuje obie granice czasu letniego.
 for(let i=0;i<3;i++){
  const parts=Object.fromEntries(format.formatToParts(new Date(at)).map(p=>[p.type,p.value]));
  const asUtc=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
  at=base-(asUtc-at);
 }
 return new Date(at).toISOString();
}
export function zakresDatyStartu(teraz:Date):{min:string,max:string}{
 const max=dzien(teraz);const [y,m,d]=max.split('-').map(Number);
 const minD=Math.min(d,new Date(Date.UTC(y-1,m,0)).getUTCDate());
 const min=`${y-1}-${String(m).padStart(2,'0')}-${String(minD).padStart(2,'0')}`;
 return {min,max};
}
export function poprawnaDataStartu(odUtc:string,teraz:Date):boolean{
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(odUtc)||!Number.isFinite(Date.parse(odUtc)))return false;
 const data=dzien(new Date(odUtc)),{min,max}=zakresDatyStartu(teraz);
 return data>=min&&data<=max&&poczatekDniaWarszawa(data)===new Date(odUtc).toISOString();
}
