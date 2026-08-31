export interface CameraIntent {
  readonly forward: number;
  readonly strafe: number;
  readonly yaw: number;
  readonly pitch: number;
}

const CAMERA_CODES = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowLeft',
  'ArrowDown',
  'ArrowRight',
]);

export function isCameraCode(code: string): boolean {
  return CAMERA_CODES.has(code);
}

/** Convert held keys into normalized camera intent without DOM access. */
export function cameraIntentFromKeys(keys: ReadonlySet<string>): CameraIntent {
  return {
    forward: numberFor(keys.has('KeyW')) - numberFor(keys.has('KeyS')),
    strafe: numberFor(keys.has('KeyD')) - numberFor(keys.has('KeyA')),
    yaw: numberFor(keys.has('ArrowRight')) - numberFor(keys.has('ArrowLeft')),
    pitch: numberFor(keys.has('ArrowDown')) - numberFor(keys.has('ArrowUp')),
  };
}

export function pointerModeLabel(orbit: boolean): string {
  return orbit ? 'camera' : 'hover';
}

function numberFor(value: boolean): number {
  return value ? 1 : 0;
}
