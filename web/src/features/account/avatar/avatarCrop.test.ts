import {
  avatarOffsetLimits,
  avatarSourceRect,
  clampAvatarTransform
} from './avatarCrop';

test('cover crop clamps landscape movement without exposing empty pixels', () => {
  const image = { width: 1000, height: 500 };
  expect(avatarOffsetLimits(image, 1)).toEqual({ x: 256, y: 0 });
  expect(clampAvatarTransform(image, {
    zoom: 0.5,
    offsetX: 999,
    offsetY: -999
  })).toEqual({ zoom: 1, offsetX: 256, offsetY: 0 });
});

test('maps the centered editor to a deterministic square source crop', () => {
  expect(avatarSourceRect(
    { width: 1000, height: 500 },
    { zoom: 1, offsetX: 0, offsetY: 0 }
  )).toEqual({ x: 250, y: 0, side: 500 });

  expect(avatarSourceRect(
    { width: 1000, height: 500 },
    { zoom: 2, offsetX: 0, offsetY: 0 }
  )).toEqual({ x: 375, y: 125, side: 250 });
});
