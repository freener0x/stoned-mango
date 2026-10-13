// essentia.js 0.1.3 ships no typings for its ES builds; the engine and the spike only need these.
declare module 'essentia.js/dist/essentia-wasm.es.js' {
  export const EssentiaWASM: any;
}
declare module 'essentia.js/dist/essentia.js-core.es.js' {
  const Essentia: new (wasm: any, isDebug?: boolean) => any;
  export default Essentia;
}
