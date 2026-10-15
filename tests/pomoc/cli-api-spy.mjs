import {writeFileSync} from 'node:fs';
// Osobny proces prawdziwego CLI; sieć zawsze zastępujemy, również w mutacjach.
let liczba=0;
globalThis.fetch=async()=>{
 liczba++;
 return new Response('[]',{status:200,headers:{'X-WP-TotalPages':'1','X-WP-Total':'0'}});
};
process.on('exit',()=>writeFileSync(process.env.OMS_TEST_API_SPY,String(liczba)));
