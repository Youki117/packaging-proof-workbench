export function cfu(value,unit){
 const supers={'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9'};
 let raw=String(value??'').replace(/\s+/g,'').replace(/^10([⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/g,(_,power)=>'1×10^'+power.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>supers[c])).replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g,c=>supers[c]).replace(/^10\^(\d+)$/,'1×10^$1');
 const u=String(unit??'').replace(/\s+/g,'').replace(/克/g,'g').replace(/^(亿|万)\/g$/,'$1CFU/g');
 if(!/CFU\/g$/i.test(u)||!/^(?:(亿|万))?CFU\/g$/i.test(u))return null;
 const exponent=raw.match(/^([\d]+(?:\.\d+)?)(?:[×xX*]10\^?(\d+)|[eE]([+-]?\d+))$/);
 const number=exponent?Number(exponent[1])*10**Number(exponent[2]??exponent[3]):/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):NaN;
 const result=number*(u.startsWith('亿')?1e8:u.startsWith('万')?1e4:1);
 return Number.isFinite(result)&&result>=0?result:null;
}
