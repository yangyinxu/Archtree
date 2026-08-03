export const avatarEditorSide = 512;
export const avatarUploadSide = 1024;

export interface AvatarImageSize {
  width: number;
  height: number;
}

export interface AvatarCropTransform {
  zoom: number;
  offsetX: number;
  offsetY: number;
}

const coverScale = (image: AvatarImageSize) => Math.max(
  avatarEditorSide / image.width,
  avatarEditorSide / image.height
);

export const avatarOffsetLimits = (image: AvatarImageSize, zoom: number) => {
  const scale = coverScale(image) * zoom;
  return {
    x: Math.max(0, (image.width * scale - avatarEditorSide) / 2),
    y: Math.max(0, (image.height * scale - avatarEditorSide) / 2)
  };
};

/** Keeps every visible crop pixel backed by the selected source image. */
export const clampAvatarTransform = (
  image: AvatarImageSize,
  transform: AvatarCropTransform
): AvatarCropTransform => {
  const zoom = Math.min(4, Math.max(1, transform.zoom));
  const limits = avatarOffsetLimits(image, zoom);
  return {
    zoom,
    offsetX: limits.x === 0 ? 0 : Math.min(limits.x, Math.max(-limits.x, transform.offsetX)),
    offsetY: limits.y === 0 ? 0 : Math.min(limits.y, Math.max(-limits.y, transform.offsetY))
  };
};

/** Maps editor-space pan and zoom back to the exact square source crop. */
export const avatarSourceRect = (
  image: AvatarImageSize,
  transform: AvatarCropTransform
) => {
  const safe = clampAvatarTransform(image, transform);
  const scale = coverScale(image) * safe.zoom;
  const sourceSide = avatarEditorSide / scale;
  return {
    x: image.width / 2 - safe.offsetX / scale - sourceSide / 2,
    y: image.height / 2 - safe.offsetY / scale - sourceSide / 2,
    side: sourceSide
  };
};

/** Draws the interactive square crop without relying on dynamic inline CSS. */
export const drawAvatarEditor = (
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  transform: AvatarCropTransform
) => {
  const context = canvas.getContext('2d');
  if (!context) return;
  const size = { width: image.naturalWidth, height: image.naturalHeight };
  const safe = clampAvatarTransform(size, transform);
  const scale = coverScale(size) * safe.zoom;
  const drawWidth = size.width * scale;
  const drawHeight = size.height * scale;

  context.clearRect(0, 0, avatarEditorSide, avatarEditorSide);
  context.fillStyle = '#080a10';
  context.fillRect(0, 0, avatarEditorSide, avatarEditorSide);
  context.drawImage(
    image,
    (avatarEditorSide - drawWidth) / 2 + safe.offsetX,
    (avatarEditorSide - drawHeight) / 2 + safe.offsetY,
    drawWidth,
    drawHeight
  );

  context.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  context.lineWidth = 1;
  for (const position of [avatarEditorSide / 3, avatarEditorSide * 2 / 3]) {
    context.beginPath();
    context.moveTo(position, 0);
    context.lineTo(position, avatarEditorSide);
    context.stroke();
    context.beginPath();
    context.moveTo(0, position);
    context.lineTo(avatarEditorSide, position);
    context.stroke();
  }
};

/** Encodes only the listener-confirmed crop as a metadata-free browser JPEG candidate. */
export const renderAvatarCrop = async (
  image: HTMLImageElement,
  transform: AvatarCropTransform
) => {
  const source = avatarSourceRect(
    { width: image.naturalWidth, height: image.naturalHeight },
    transform
  );
  const canvas = document.createElement('canvas');
  canvas.width = avatarUploadSide;
  canvas.height = avatarUploadSide;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot prepare profile photos.');
  context.fillStyle = '#000';
  context.fillRect(0, 0, avatarUploadSide, avatarUploadSide);
  context.drawImage(
    image,
    source.x,
    source.y,
    source.side,
    source.side,
    0,
    0,
    avatarUploadSide,
    avatarUploadSide
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('This browser could not encode the profile photo.'));
    }, 'image/jpeg', 0.88);
  });
};
