import { describe, expect, it } from 'vitest';

import {
  cameraIntentFromKeys,
  isCameraCode,
  pointerModeLabel,
} from '../src/scene/camera-input';

describe('camera input mapping', () => {
  it('maps WASD and arrows to independent normalized axes', () => {
    expect(
      cameraIntentFromKeys(new Set(['KeyW', 'KeyD', 'ArrowLeft', 'ArrowDown'])),
    ).toEqual({ forward: 1, strafe: 1, yaw: -1, pitch: 1 });
  });

  it('cancels opposite held keys instead of accumulating speed', () => {
    expect(cameraIntentFromKeys(new Set(['KeyW', 'KeyS']))).toEqual({
      forward: 0,
      strafe: 0,
      yaw: 0,
      pitch: 0,
    });
  });

  it('recognizes only camera movement codes', () => {
    expect(isCameraCode('KeyW')).toBe(true);
    expect(isCameraCode('ArrowRight')).toBe(true);
    expect(isCameraCode('Enter')).toBe(false);
  });

  it('names the two pointer roles for accessible diagnostics', () => {
    expect(pointerModeLabel(false)).toBe('hover');
    expect(pointerModeLabel(true)).toBe('camera');
  });
});
