declare module "draco3dgltf" {
  interface Draco3DGLTF {
    createDecoderModule(): Promise<unknown>;
    createEncoderModule(): Promise<unknown>;
  }

  const draco3d: Draco3DGLTF;
  export default draco3d;
}
