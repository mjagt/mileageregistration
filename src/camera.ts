// Live rear-camera preview and capture of the region inside the guide box.

let stream: MediaStream | null = null;

export async function startCamera(video: HTMLVideoElement): Promise<void> {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  video.srcObject = stream;
  await video.play();
}

export function stopCamera(video: HTMLVideoElement): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

export const cameraRunning = () => stream !== null;

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
