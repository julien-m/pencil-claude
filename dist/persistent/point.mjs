/** Map a pointer in an object-fit:contain image to normalized renderer coordinates. */
export function imagePoint(rect, image, clientX, clientY) {
  if (!rect.width || !rect.height || !image.width || !image.height) return null;
  const scale = Math.min(rect.width / image.width, rect.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}
