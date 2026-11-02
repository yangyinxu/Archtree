export interface VideoFrame { blob: Blob; time: number; duration: number; width: number; height: number }

/** Uses an early deterministic candidate, without claiming a particular Finder poster frame. */
export const videoCandidateTime = (duration: number) => Math.min(2, duration * 0.1);

/** Extracts only artwork, preserving portrait geometry and leaving the original video untouched. */
export function captureVideoFrame(video: HTMLVideoElement): Promise<VideoFrame> {
  return new Promise((resolve, reject) => {
    if (video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) { reject(new Error('decode')); return; }
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight), canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const time = video.currentTime;
      canvas.toBlob(blob => blob ? resolve({ blob, time, duration: video.duration, width: canvas.width, height: canvas.height }) : reject(new Error('canvas')), 'image/jpeg', .88);
    } catch { reject(new Error('canvas')); }
  });
}
