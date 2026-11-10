// CMS SignedData attached (RFC 5652), RSA/SHA256. Recibe la firma ya hecha (arca-signer.ts firma con el
// certificado propio del Core desde los secretos de Supabase). Verificado contra openssl cms -verify (10/11/2026).
const concat=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let i=0;for(const p of parts){out.set(p,i);i+=p.length;}return out;};
const hex=(s:string)=>Uint8Array.from(s.match(/../g)!.map(x=>parseInt(x,16)));
function der(tag:number,data:Uint8Array){let n=data.length;const a=[];while(n){a.unshift(n&255);n>>>=8;}const len=data.length<128?new Uint8Array([data.length]):new Uint8Array([128|a.length,...a]);return concat(new Uint8Array([tag]),len,data);}
const seq=(...p:Uint8Array[])=>der(48,concat(...p)),set=(...p:Uint8Array[])=>der(49,concat(...p));
function node(b:Uint8Array,start:number){let i=start+1,n=b[i++];if(n&128){const count=n&127;if(!count||count>4)throw Error('DER inválido');n=0;for(let j=0;j<count;j++)n=n*256+b[i++];}if(i+n>b.length)throw Error('DER truncado');return {start,value:i,end:i+n,tag:b[start]};}
function children(b:Uint8Array,parent:ReturnType<typeof node>){const out=[];let i=parent.value;while(i<parent.end){const n=node(b,i);out.push(n);i=n.end;}return out;}
export function signedCms(tra:string,signatureBase64:string,pemBase64:string) {
  const pem=atob(pemBase64),clean=pem.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const cert=Uint8Array.from(atob(clean),c=>c.charCodeAt(0));
  const root=node(cert,0);if(root.tag!==48||root.end!==cert.length)throw Error('Certificado DER inválido');
  const tbs=children(cert,children(cert,root)[0]),offset=tbs[0].tag===160?1:0;
  const serial=tbs[offset],issuer=tbs[offset+2],spki=children(cert,tbs[offset+5]);
  const algorithm=children(cert,spki[0])[0];
  if(Array.from(cert.slice(algorithm.start,algorithm.end)).join(',')!==Array.from(hex('06092a864886f70d010101')).join(','))throw Error('El certificado ARCA debe usar RSA.');
  const sha256=seq(hex('0609608648016503040201'),hex('0500'));
  const signer=seq(hex('020101'),seq(cert.slice(issuer.start,issuer.end),cert.slice(serial.start,serial.end)),sha256,seq(hex('06092a864886f70d010101'),hex('0500')),der(4,Uint8Array.from(atob(signatureBase64),c=>c.charCodeAt(0))));
  const data=seq(hex('06092a864886f70d010701'),der(160,der(4,new TextEncoder().encode(tra))));
  const signed=seq(hex('020101'),set(sha256),data,der(160,cert),set(signer));
  return btoa(String.fromCharCode(...seq(hex('06092a864886f70d010702'),der(160,signed))));
}
