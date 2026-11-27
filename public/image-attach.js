// 참고 이미지 첨부 유틸 (클립보드 붙여넣기 · 파일 선택 · 드래그&드롭 → 리사이즈된 base64)

const MAX_IMAGES = 4;
const MAX_EDGE = 1280;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('이미지를 읽지 못했습니다'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('올바른 이미지 파일이 아닙니다'));
    img.src = src;
  });
}

// 긴 변을 MAX_EDGE 이하로 줄여 전송 크기와 토큰 사용량을 절감한다
export async function prepareImageFile(file) {
  if (!file || !String(file.type || '').startsWith('image/')) {
    throw new Error('이미지 파일(PNG, JPG, WebP, GIF)만 첨부할 수 있습니다');
  }
  const src = await readAsDataUrl(file);
  const img = await loadImage(src);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);
  const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const outUrl = mime === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.86) : canvas.toDataURL('image/png');
  const data = outUrl.slice(outUrl.indexOf(',') + 1);
  return {
    name: file.name || `image-${Date.now()}.${mime === 'image/png' ? 'png' : 'jpg'}`,
    mime,
    data,
    width,
    height,
    bytes: Math.floor(data.length * 0.75),
    previewUrl: outUrl,
  };
}

export async function addImageFiles(list, files, onToast) {
  const arr = [...(files || [])].filter((f) => f && String(f.type || '').startsWith('image/'));
  if (!arr.length) return false;
  let added = 0;
  for (const f of arr) {
    if (list.length >= MAX_IMAGES) {
      onToast?.(`이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있습니다`, true);
      break;
    }
    try {
      list.push(await prepareImageFile(f));
      added++;
    } catch (e) {
      onToast?.(e.message, true);
    }
  }
  return added > 0;
}

export function extractClipboardImages(ev) {
  const items = [...(ev.clipboardData?.items || [])];
  return items.filter((it) => it.kind === 'file' && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
}

export function renderImageStrip(list, scopeKey, esc) {
  if (!list?.length) return '';
  return `<div class="img-strip">${list
    .map(
      (im, i) => `<div class="img-chip" title="${esc(im.name)} (${im.width}×${im.height}px)">
        <img src="${im.previewUrl}" alt="${esc(im.name)}">
        <span>${im.width}×${im.height}</span>
        <button type="button" class="img-del" data-img-del="${esc(scopeKey)}:${i}" title="첨부 제거">✕</button>
      </div>`,
    )
    .join('')}</div>`;
}

export function toPayloadImages(list) {
  return (list || []).map(({ mime, data, width, height, name }) => ({ mime, data, width, height, name }));
}
