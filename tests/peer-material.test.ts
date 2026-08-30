import type { Material, MeshBasicMaterial } from 'three/webgpu';
import { Color } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';

import { createPeerMesh } from '../src/scene/universe';

describe('peer instance material', () => {
  let mesh: ReturnType<typeof createPeerMesh> | undefined;

  afterEach(() => {
    mesh?.geometry.dispose();
    (mesh?.material as Material | undefined)?.dispose();
    mesh = undefined;
  });

  it('enables instance colors for semantic connected/discovered states', () => {
    mesh = createPeerMesh(false, new Color(0xc9ff70));

    const material = mesh.material as MeshBasicMaterial;
    expect(material.isMeshBasicMaterial).toBe(true);
    expect(material.color.equals(new Color(0xc9ff70))).toBe(true);
  });
});
