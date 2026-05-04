declare module "node:sea" {
  function isSea(): boolean;
  function getAsset(key: string): ArrayBuffer;
  function getAsset(key: string, encoding: string): string;
  function getAssetAsBlob(key: string, options?: { type?: string }): Blob;
  function getRawAsset(key: string): ArrayBuffer;
  function getAssetKeys(): string[];
}
