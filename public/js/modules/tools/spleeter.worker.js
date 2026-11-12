const MODEL_REVISION = "93ba771920ade509f8cbd6825b1a90856c797e08";
const MODEL_CACHE = "mori-spleeter-fp16-v1";
const MODELS = {
  vocals: {
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-fp16/resolve/" + MODEL_REVISION + "/vocals.fp16.onnx",
    sha256: "24cef84aedcd1fe87c0b743ef3370ad34dc1fabf6c9014d6128a75a538c7b668",
    path: "/models/vocals.fp16.onnx",
  },
  accompaniment: {
    url: "https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-fp16/resolve/" + MODEL_REVISION + "/accompaniment.fp16.onnx",
    sha256: "d14cea55793cc531a5875f5f4da08207d1c5ab9292e8e0099a104eecb014fcc0",
    path: "/models/accompaniment.fp16.onnx",
  },
};

let moduleInstance = null;
let engineHandle = 0;
let initPromise = null;

function send(type, id, extra = {}) { self.postMessage({ type, id, ...extra }); }
function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchModel(key) {
  const model = MODELS[key];
  const cache = "caches" in self ? await caches.open(MODEL_CACHE) : null;
  const cacheKey = new Request(model.url);
  let response = cache ? await cache.match(cacheKey) : null;
  if (!response) {
    send("progress", null, { stage: "model", message: "Downloading " + key + " model..." });
    response = await fetch(model.url, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error("Could not download Spleeter " + key + " model (HTTP " + response.status + ").");
    if (cache) await cache.put(cacheKey, response.clone());
  }
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  if (toHex(digest) !== model.sha256) {
    if (cache) await cache.delete(cacheKey);
    throw new Error("Spleeter " + key + " model checksum verification failed. Please retry.");
  }
  return new Uint8Array(bytes);
}

function allocateUtf8(mod, value) {
  const size = mod.lengthBytesUTF8(value) + 1;
  const ptr = mod._malloc(size);
  if (!ptr) throw new Error("Not enough browser memory to initialize Spleeter.");
  mod.stringToUTF8(value, ptr, size);
  return ptr;
}

async function initialize(id) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    send("progress", id, { stage: "runtime", message: "Loading local Spleeter engine..." });
    importScripts("/wasm/spleeter/mori-spleeter.js");
    if (typeof createMoriSpleeterModule !== "function") {
      throw new Error("Spleeter WebAssembly runtime is missing. The website needs its WASM build.");
    }
    moduleInstance = await createMoriSpleeterModule({
      locateFile(path) { return "/wasm/spleeter/" + path; },
      printErr(message) { console.error("[Mori Spleeter WASM]", message); },
    });
    const [vocals, accompaniment] = await Promise.all([fetchModel("vocals"), fetchModel("accompaniment")]);
    moduleInstance.FS.mkdir("/models");
    moduleInstance.FS.writeFile(MODELS.vocals.path, vocals);
    moduleInstance.FS.writeFile(MODELS.accompaniment.path, accompaniment);
    vocals.fill(0);
    accompaniment.fill(0);

    const vocalsPath = allocateUtf8(moduleInstance, MODELS.vocals.path);
    const accompanimentPath = allocateUtf8(moduleInstance, MODELS.accompaniment.path);
    try {
      engineHandle = moduleInstance._MoriSpleeterCreate(vocalsPath, accompanimentPath);
    } finally {
      moduleInstance._free(vocalsPath);
      moduleInstance._free(accompanimentPath);
    }
    if (!engineHandle) throw new Error("Spleeter could not initialize its local model.");
    send("ready", id, { message: "Spleeter is ready on this device." });
  })().catch((error) => {
    initPromise = null;
    moduleInstance = null;
    engineHandle = 0;
    throw error;
  });
  return initPromise;
}

async function processChunk(id, input, frames, sampleRate) {
  if (!moduleInstance || !engineHandle) throw new Error("Spleeter has not been initialized.");
  const samples = input instanceof Float32Array ? input : new Float32Array(input);
  const capacity = frames * 4;
  const inputPtr = moduleInstance._malloc(samples.length * 4);
  const outputPtr = moduleInstance._malloc(capacity * 4);
  const framesPtr = moduleInstance._malloc(4);
  const ratePtr = moduleInstance._malloc(4);
  if (!inputPtr || !outputPtr || !framesPtr || !ratePtr) {
    [inputPtr, outputPtr, framesPtr, ratePtr].forEach((ptr) => { if (ptr) moduleInstance._free(ptr); });
    throw new Error("Not enough memory for this audio segment.");
  }
  try {
    moduleInstance.HEAPF32.set(samples, inputPtr >>> 2);
    const status = moduleInstance._MoriSpleeterProcess(
      engineHandle, inputPtr, 2, frames, sampleRate, outputPtr, capacity, framesPtr, ratePtr,
    );
    if (status !== 0) throw new Error("Spleeter failed on an audio segment (code " + status + ").");
    const outputFrames = moduleInstance.getValue(framesPtr, "i32");
    const outputSampleRate = moduleInstance.getValue(ratePtr, "i32");
    if (!outputFrames || !outputSampleRate) throw new Error("Spleeter returned an empty audio segment.");
    const output = moduleInstance.HEAPF32.slice(outputPtr >>> 2, (outputPtr >>> 2) + outputFrames * 2);
    send("chunk", id, { samples: output, frames: outputFrames, sampleRate: outputSampleRate });
  } finally {
    moduleInstance._free(inputPtr);
    moduleInstance._free(outputPtr);
    moduleInstance._free(framesPtr);
    moduleInstance._free(ratePtr);
  }
}

self.onmessage = async (event) => {
  const data = event.data || {};
  try {
    if (data.type === "init") { await initialize(data.id); return; }
    if (data.type === "process") { await processChunk(data.id, data.samples, data.frames, data.sampleRate); return; }
    if (data.type === "dispose") {
      if (moduleInstance && engineHandle) moduleInstance._MoriSpleeterDestroy(engineHandle);
      engineHandle = 0;
      moduleInstance = null;
      initPromise = null;
      send("disposed", data.id);
    }
  } catch (error) {
    send("error", data.id, { message: error?.message || String(error) });
  }
};
