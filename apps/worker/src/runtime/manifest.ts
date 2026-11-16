import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_PROTOCOL_VERSION } from '../../../../packages/contracts/src/node-control.js';

export type Manifest = {
  version: string;
  protocolVersion: number;
  nodeVersion: string;
  platform: string;
  arch: string;
};
type ManifestTarget = {
  version?: string;
  protocolVersion?: number;
  platform?: string;
  arch?: string;
};

export async function readManifest(root: string, target: ManifestTarget = {}): Promise<Manifest> {
  const manifest: Manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (
    (target.version !== undefined && manifest.version !== target.version) ||
    manifest.protocolVersion !== (target.protocolVersion ?? NODE_PROTOCOL_VERSION) ||
    manifest.platform !== (target.platform ?? process.platform) ||
    manifest.arch !== (target.arch ?? process.arch)
  )
    throw new Error('安装包版本、协议或平台不兼容');
  return manifest;
}
