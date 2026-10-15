import {zbudujOms} from '../src/oms/bootstrap.ts';
const a=await zbudujOms({env:process.env});
try {
 const wynik=await a.usluga('marketing','czuwaczReklam').przebieg();
 process.stdout.write(`Reklamy: ${wynik.sukcesy} połączeń odczytanych, ${wynik.bledy} błędów.\n`);
 if(wynik.bledy)process.exitCode=1;
}finally{await a.app.close();a.db.close();}
