// Live rear-camera preview, zoom/torch control and capture of the region inside the guide box.

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;

// Capabilities that TypeScript's DOM lib doesn't describe yet.
interface ExtCaps {
  zoom?: { min: number; max: number; step?: number };
  torch?: boolean;
  focusMode?: string[];
}

/** Upper limit for the zoom slider. Beyond the camera's own zoom, the preview is enlarged in CSS. */
export const MAX_ZOOM = 10;

let hwZoom: { min: number; max: number; step: number } | null = null;
let currentHw = 1;
let torchOn = false;

export async function startCamera(video: HTMLVideoElement): Promise<void> {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    // Ask for as many pixels as the camera offers: the odometer is a small part of the frame.
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
  });
  track = stream.getVideoTracks()[0] ?? null;
  const caps = (track?.getCapabilities?.() ?? {}) as ExtCaps;
  hwZoom = caps.zoom && caps.zoom.max > 1 ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null;
  currentHw = (track?.getSettings() as { zoom?: number } | undefined)?.zoom ?? 1;
  torchOn = false;
  if (caps.focusMode?.includes('continuous')) {
    track!.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
  }
  video.srcObject = stream;
  await video.play();
}

export function stopCamera(video: HTMLVideoElement): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  track = null;
  hwZoom = null;
  video.srcObject = null;
  video.style.transform = '';
}

export const cameraRunning = () => stream !== null;

export const hasTorch = () => !!(track && (track.getCapabilities?.() as ExtCaps | undefined)?.torch);

export async function setTorch(on: boolean): Promise<boolean> {
  if (!track) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    torchOn = on;
  } catch {
    /* not supported */
  }
  return torchOn;
}

// Pinch/slider events arrive faster than the camera can apply them: only the latest value is applied.
let zoomBusy = false;
let zoomWanted: number | null = null;

/**
 * Zooms to `z` (1 = no zoom). Uses the camera's own zoom as far as it goes (real extra detail on
 * phones that zoom on the sensor or switch to a telephoto lens), then enlarges the preview in CSS.
 */
export async function setZoom(video: HTMLVideoElement, z: number): Promise<void> {
  z = Math.min(MAX_ZOOM, Math.max(1, z));
  let hw = 1;
  if (hwZoom) {
    hw = Math.min(hwZoom.max, Math.max(Math.max(1, hwZoom.min), z));
    hw = Math.round(hw / hwZoom.step) * hwZoom.step;
  }
  // The CSS part is applied right away so the preview follows the finger. getBoundingClientRect()
  // includes transforms, so captureGuide() keeps mapping the guide box correctly.
  const digital = z / hw;
  video.style.transform = digital > 1.001 ? `scale(${digital})` : '';
  if (!hwZoom || !track) return;
  zoomWanted = hw;
  if (zoomBusy) return;
  zoomBusy = true;
  try {
    while (zoomWanted !== null && track) {
      const target = zoomWanted;
      zoomWanted = null;
      if (Math.abs(target - currentHw) < 1e-3) continue;
      try {
        await track.applyConstraints({ advanced: [{ zoom: target } as MediaTrackConstraintSet] });
        currentHw = target;
      } catch {
        hwZoom = null; // camera refused: fall back to CSS zoom only
        video.style.transform = z > 1.001 ? `scale(${z})` : '';
      }
    }
  } finally {
    zoomBusy = false;
  }
}
/** Returns the part of the current video frame that lies under `guide` (video uses object-fit: cover). */
export function captureGuide(video: HTMLVideoElement, guide: HTMLElement): HTMLCanvasElement {
  const vr = video.getBoundingClientRect();
  const gr = guide.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * scale) / 2;
  const oy = (vr.height - vh * scale) / 2;

  const sx = Math.max(0, (gr.left - vr.left - ox) / scale);
  const sy = Math.max(0, (gr.top - vr.top - oy) / scale);
  const sw = Math.min(vw - sx, gr.width / scale);
  const sh = Math.min(vh - sy, gr.height / scale);

  const c = document.createElement('canvas');
  c.width = Math.round(sw);
  c.height = Math.round(sh);
  c.getContext('2d')!.drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
