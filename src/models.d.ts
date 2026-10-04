/** Weight files, embedded by esbuild's binary loader (see worker-build.mjs). */
declare module "*.bin" {
  const bytes: Uint8Array;
  export default bytes;
}
