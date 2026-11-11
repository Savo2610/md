// Bilder vor dem Hochladen verkleinern: längste Seite höchstens 1920 px, als
// WebP. Aus einem 6-MB-Handyfoto werden so meist 200–400 KB.
// GIFs bleiben unverändert (sonst wäre die Animation weg).

const MAX_SIDE = 1920;

export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  if (!/^image\/(jpeg|png|webp|avif|heic|heif)$/.test(file.type)) throw new Error('Dieses Bildformat wird nicht unterstützt.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('Das Bild lässt sich im Browser nicht öffnen.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/webp', 0.84));
  if (!blob) throw new Error('Bild konnte nicht umgewandelt werden.');
  // Kleine PNG-Grafiken sind manchmal als Original kleiner.
  if (scale === 1 && file.size < blob.size && /png|jpeg|webp/.test(file.type)) return file;
  return blob;
}

export async function uploadImage(id: string, file: File, auth: Record<string, string>): Promise<string> {
  const blob = await prepareImage(file);
  const res = await fetch(`/api/docs/${encodeURIComponent(id)}/images`, {
    method: 'POST',
    headers: { 'content-type': blob.type, ...auth },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Hochladen fehlgeschlagen.');
  return data.url;
}
