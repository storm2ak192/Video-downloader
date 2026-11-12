import { audioBufferToWav } from "./audioExtractor.js";
const CHUNK_SECONDS=5,MAX_VIDEO_BYTES=100*1024*1024;
function request(worker,type,payload={},transfer=[],progress=null){
 const id="spleeter_"+Date.now()+"_"+Math.random().toString(36).slice(2,9);
 return new Promise((resolve,reject)=>{
  const message=e=>{const m=e.data||{};if(m.type==="progress"){progress?.(m);return;}if(m.id!==id)return;worker.removeEventListener("message",message);worker.removeEventListener("error",error);m.type==="error"?reject(new Error(m.message||"Spleeter failed.")):resolve(m);};
  const error=e=>{worker.removeEventListener("message",message);worker.removeEventListener("error",error);reject(new Error(e.message||"Spleeter worker crashed."));};
  worker.addEventListener("message",message);worker.addEventListener("error",error);worker.postMessage({id,type,...payload},transfer);
 });
}
function resample(input,sourceFrames,targetFrames){
 if(sourceFrames===targetFrames)return input;
 const out=new Float32Array(targetFrames*2),scale=(sourceFrames-1)/Math.max(1,targetFrames-1);
 for(let i=0;i<targetFrames;i++){const p=i*scale,l=Math.floor(p),r=Math.min(sourceFrames-1,l+1),mix=p-l;out[2*i]=input[2*l]*(1-mix)+input[2*r]*mix;out[2*i+1]=input[2*l+1]*(1-mix)+input[2*r+1]*mix;}
 return out;
}
export async function separateVideoAudioFile(file,onProgress=null,options={}){
 if(!file||!(file instanceof Blob))throw new Error("Choose a video file first.");
 if(file.size>MAX_VIDEO_BYTES)throw new Error("Spleeter in the browser is limited to 100 MB per video to reduce memory use.");
 if((navigator.deviceMemory||4)<=2&&file.size>50*1024*1024)throw new Error("This video is too large for the available browser memory. Try a shorter clip.");
 const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!AudioCtx)throw new Error("Web Audio API is not supported.");
 let ctx,worker;
 try{
  ctx=new AudioCtx({sampleRate:44100});
  let bytes=await file.arrayBuffer();let source;
  try{source=await ctx.decodeAudioData(bytes);}catch{throw new Error("Could not read the video's audio track. It may be silent or use an unsupported codec.");}finally{bytes=null;}
  worker=new Worker(new URL("./spleeter.worker.js",import.meta.url));
  await request(worker,"init",{},[],onProgress);
  const rate=source.sampleRate,total=source.length,chunkSize=Math.max(1,Math.floor(rate*CHUNK_SECONDS)),parts=[];
  let done=0;
  for(let start=0;start<total;start+=chunkSize){
   const n=Math.min(chunkSize,total-start),left=new Float32Array(n),right=new Float32Array(n);
   source.copyFromChannel(left,0,start);if(source.numberOfChannels>1)source.copyFromChannel(right,1,start);else right.set(left);
   const interleaved=new Float32Array(n*2);for(let i=0;i<n;i++){interleaved[2*i]=left[i];interleaved[2*i+1]=right[i];}
   const result=await request(worker,"process",{samples:interleaved,frames:n,sampleRate:rate},[interleaved.buffer],onProgress);
   parts.push(resample(result.samples,result.frames,n));done+=n;
   const percent=Math.min(100,Math.round(done/total*100));onProgress?.({stage:"separation",percent,message:"Separating vocals: "+percent+"%"});
  }
  const vocals=ctx.createBuffer(2,total,rate),l=vocals.getChannelData(0),r=vocals.getChannelData(1);let offset=0;
  for(const part of parts){const n=part.length/2;for(let i=0;i<n;i++){l[offset+i]=part[2*i];r[offset+i]=part[2*i+1];}offset+=n;}
  const blob=options.includeWav===false?null:audioBufferToWav(vocals,true);
  const audioSize=blob?.size||0;
  chunks.length=0;source=null;
  return {audioBuffer:vocals,blob,duration:vocals.duration,sampleRate:rate,audioSize,format:"audio/wav"};
 }finally{if(worker)worker.terminate();if(ctx){try{await ctx.close();}catch(_){}}}
}
export async function recordVideoFromFile(file,audioBuffer=null,onProgress=null,externalAudioContext=null){
 if(!file||!(file instanceof Blob))throw new Error("Choose a video file first.");
 if(!("MediaRecorder" in window))throw new Error("This browser does not support local video recording.");
 const url=URL.createObjectURL(file),video=document.createElement("video");video.muted=true;video.playsInline=true;video.preload="auto";video.src=url;
 let ctx=externalAudioContext,ownsContext=!externalAudioContext,source=null,stream=null,recorder=null,progressHandler=null;
 try{
  await new Promise((resolve,reject)=>{video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error("The browser cannot decode this video."));});
  const capture=video.captureStream||video.mozCaptureStream;if(typeof capture!=="function")throw new Error("This browser cannot capture local video. Try Chrome on Android or desktop.");
  stream=capture.call(video);const videoTracks=stream.getVideoTracks();if(!videoTracks.length)throw new Error("No video track is available.");
  const tracks=[...videoTracks];
  if(audioBuffer){const AudioCtx=window.AudioContext||window.webkitAudioContext;if(!ctx){ctx=new AudioCtx({sampleRate:audioBuffer.sampleRate});ownsContext=true;}await ctx.resume();const dest=ctx.createMediaStreamDestination();source=ctx.createBufferSource();source.buffer=audioBuffer;source.connect(dest);tracks.push(...dest.stream.getAudioTracks());}
  const output=new MediaStream(tracks),types=["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm"],mime=types.find(t=>MediaRecorder.isTypeSupported(t));
  if(!mime)throw new Error("No supported WebM encoder is available.");
  const chunks=[];recorder=new MediaRecorder(output,{mimeType:mime,videoBitsPerSecond:Math.min(10000000,Math.max(2500000,(video.videoWidth||1280)*(video.videoHeight||720)*4))});
  const stopped=new Promise((resolve,reject)=>{recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};recorder.onerror=e=>reject(e.error||new Error("Video recording failed."));recorder.onstop=resolve;});
  progressHandler=()=>{const percent=video.duration>0?Math.min(100,Math.round(video.currentTime/video.duration*100)):0;onProgress?.({stage:"recording",percent,message:"Creating output video: "+percent+"%"});};
  video.addEventListener("timeupdate",progressHandler);video.onended=()=>{if(recorder&&recorder.state!=="inactive")recorder.stop();};
  recorder.start(1000);if(source)source.start(0);await video.play();await stopped;
  const blob=new Blob(chunks,{type:mime});if(!blob.size)throw new Error("The browser created an empty video.");return {blob,mimeType:mime,duration:video.duration};
 }finally{
  if(progressHandler)video.removeEventListener("timeupdate",progressHandler);if(recorder&&recorder.state!=="inactive"){try{recorder.stop();}catch(_){}}
  if(source){try{source.stop();}catch(_){}try{source.disconnect();}catch(_){}}if(stream)stream.getTracks().forEach(t=>t.stop());
  video.pause();video.removeAttribute("src");video.load();URL.revokeObjectURL(url);if(ctx&&ownsContext){try{await ctx.close();}catch(_){}}
 }
}
