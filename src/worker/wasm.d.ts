/**
 * A WebAssembly module imported as a file.
 *
 * Workers cannot compile WebAssembly from bytes at runtime — `WebAssembly.instantiate` on a buffer is
 * refused by the embedder — so a module has to arrive as an import the bundler compiles at deploy time.
 * The plugin that builds this worker recognises the `.wasm` extension and emits the file as a compiled
 * module next to the bundle; this declaration is the type of what the import hands back.
 */
declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
