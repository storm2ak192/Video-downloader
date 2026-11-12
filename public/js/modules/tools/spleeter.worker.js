const MODEL_REVISION="93ba771920ade509f8cbd6825b1a90856c797e08";
const MODEL_CACHE="mori-spleeter-fp16-v1";
const MODELS={
 vocals:{url:\`https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-fp16/resolve/\${MODEL_REVISION}/vocals.fp16.onnx\`,sha256:"24cef84aedcd1fe87c0b743ef3370ad34dc1fabf6c9014d6128a75a538c7b668",path:"/models/vocals.fp16.onnx"},
 accompaniment:{url:\`https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-fp16/resolve/\${MODEL_REVISION}/accompaniment.fp16.onnx\`,sha256:"d14cea55793cc531a5875f5f4da08207d1c5ab9292e8e0099a104eecb014fcc0",path:"/models/accompaniment.fp16.onnx"}
};
let mod=null,engine=0,initPromise=null;
function send(type,id,extra={}){self.postMessage({type,id,...extra});}
function hex(buf){return Array.from(new Uint8Array(buf),b=>b.toString(16).padStart(2,"0")).join("");}
async function fetchModel(key){
 const model=MODELS[key],cache=("caches" in self)?await caches.open(MODEL_CACHE):null,keyReq=new Request(model.url);
 let response=cache?await cache.match(keyReq):null;
 if(!response){send("progress",null,{stage:"model",message:"Downloading "+key+" model..."});response=await fetch(model.url,{mode:"cors",credentials:"omit"});if(!response.ok)throw new Error("Could not download Spleeter "+key+" model (HTTP "+response.status+").");if(cache)await cache.put(keyReq,response.clone());}
 const bytes=await response.arrayBuffer(),digest=await crypto.subtle.digest("SHA-256",bytes);
 if(hex(digest)!==model.sha256){if(cache)await cache.delete(keyReq);throw new Error("Spleeter "+key+" model checksum verification failed. Please retry.");}
 return new Uint8Array(bytes);
}
function utf8(m,s){const n=m.lengthBytesUTF8(s)+1,p=m._malloc(n);if(!p)throw new Error("Not enough memory to initialize Spleeter.");m.stringToUTF8(s,p,n);return p;}
async function initialize(id){
 if(initPromise)return initPromise;
 initPromise=(async()=>{
  send("progress",id,{stage:"runtime",message:"Loading local Spleeter engine..."});
  importScripts("/wasm/spleeter/mori-spleeter.js");
  if(typeof createMoriSpleeterModule!=="function")throw new Error("Spleeter WebAssembly runtime is missing. The website needs its WASM build.");
  mod=await createMoriSpleeterModule({locateFile:p=>"/wasm/spleeter/"+p,printErr:m=>console.error("[Mori Spleeter]",m)});
  const [v,a]=await Promise.all([fetchModel("vocals"),fetchModel("accompaniment")]);
  mod.FS.mkdir("/models");mod.FS.writeFile(MODELS.vocals.path,v);mod.FS.writeFile(MODELS.accompaniment.path,a);v.fill(0);a.fill(0);
  const vp=utf8(mod,MODELS.vocals.path),ap=utf8(mod,MODELS.accompaniment.path);
  try{engine=mod._MoriSpleeterCreate(vp,ap);}finally{mod._free(vp);mod._free(ap);}
  if(!engine)throw new Error("Spleeter could not initialize its local model.");
  send("ready",id,{message:"Spleeter is ready on this device."});
 })().catch(e=>{initPromise=null;mod=null;engine=0;throw e;});
 return initPromise;
}
async function process(id,input,frames,rate){
 if(!mod||!engine)throw new Error("Spleeter has not been initialized.");
 const samples=input instanceof Float32Array?input:new Float32Array(input),capacity=frames*4;
 const ip=mod._malloc(samples.length*4),op=mod._malloc(capacity*4),fp=mod._malloc(4),rp=mod._malloc(4);
 if(!ip||!op||!fp||!rp){[ip,op,fp,rp].forEach(p=>{if(p)mod._free(p);});throw new Error("Not enough memory for this audio segment.");}
 try{
  mod.HEAPF32.set(samples,ip>>>2);
  const status=mod._MoriSpleeterProcess(engine,ip,2,frames,rate,op,capacity,fp,rp);
  if(status!==0)throw new Error("Spleeter failed on an audio segment (code "+status+").");
  const n=mod.getValue(fp,"i32"),sr=mod.getValue(rp,"i32");
  if(!n||!sr)throw new Error("Spleeter returned an empty segment.");
  const output=mod.HEAPF32.slice(op>>>2,(op>>>2)+n*2);
  send("chunk",id,{samples:output,frames:n,sampleRate:sr});
 }finally{mod._free(ip);mod._free(op);mod._free(fp);mod._free(rp);}
}
self.onmessage=async e=>{
 const d=e.data||{},id=d.id;
 try{
  if(d.type==="init"){await initialize(id);return;}
  if(d.type==="process"){await process(id,d.samples,d.frames,d.sampleRate);return;}
  if(d.type==="dispose"){if(mod&&engine)mod._MoriSpleeterDestroy(engine);engine=0;mod=null;initPromise=null;send("disposed",id);}
 }catch(err){send("error",id,{message:err?.message||String(err)});}
};
